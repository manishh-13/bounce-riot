import { describe, expect, it } from 'vitest';
import { BufferAttribute, Color, MeshStandardMaterial, PerspectiveCamera, Texture, Vector3 } from 'three';
import { ARENA_OWNER, FIXED_DT, GameSimulation, TUNING, waveHeightAt } from '../../src/game/simulation';
import type { GameState, Input, PlayerSpec, PlayerState, Wave } from '../../src/game/types';
import { PLAYER_COLORS } from '../../src/game/types';
import { FloorField, TrampolineFloor, type DecorWave } from '../../src/render/floor';
import { frameArena } from '../../src/render/framing';
import { colorHex } from '../../src/render/palette';

const IDLE: Input = { x: 0, z: 0, action: false };
const HOLD: Input = { x: 0, z: 0, action: true };

function humans(n: number): PlayerSpec[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, color: i, connected: true }));
}

function playing(n: number, options = {}): GameSimulation {
  const sim = new GameSimulation({ seed: 3, duration: 120, ...options });
  sim.setPlayers(humans(n));
  sim.start();
  ticks(sim, 180);
  expect(sim.state.phase).toBe('playing');
  return sim;
}

function ticks(sim: GameSimulation, n: number, inputs?: Record<string, Input>): void {
  for (let i = 0; i < n; i++) sim.step(FIXED_DT, inputs);
}

function player(sim: GameSimulation, id: string): PlayerState {
  const p = sim.state.players.find(q => q.id === id);
  if (!p) throw new Error(`missing ${id}`);
  return p;
}

function place(sim: GameSimulation, id: string, x: number, z: number): void {
  Object.assign(player(sim, id), { x, z, y: 0, vx: 0, vz: 0, vy: 0, grounded: true, invincible: 0 });
}

// A real slam wave from p0 at the centre, advanced until its crest is well inside the arena.
function slamWave(minRadius = 3): { sim: GameSimulation; wave: Wave } {
  const sim = playing(2);
  place(sim, 'p0', 0, 0);
  place(sim, 'p1', 0, 6);
  ticks(sim, 60, { p0: HOLD });
  sim.step(FIXED_DT, { p0: IDLE });
  let guard = 0;
  while (!sim.state.waves.some(w => w.owner === 'p0' && w.radius > minRadius) && guard++ < 300) ticks(sim, 1);
  const wave = sim.state.waves.find(w => w.owner === 'p0');
  if (!wave) throw new Error('no slam wave');
  expect(wave.radius).toBeGreaterThan(minRadius);
  expect(wave.radius).toBeLessThan(sim.state.arena.radius * 0.8);
  return { sim, wave };
}

function hazardWave(): { sim: GameSimulation; wave: Wave } {
  const sim = playing(2, { arena: 'aftershock' });
  let guard = 0;
  const ready = () => sim.state.waves.find(w => w.owner === ARENA_OWNER && w.radius > 1.5 && w.age > 0.1);
  while (!ready() && guard++ < 60 * 20) ticks(sim, 1);
  const wave = ready();
  if (!wave) throw new Error('no hazard wave');
  return { sim, wave };
}

// Waves only, so dents under grounded players never leak into wave-shape assertions.
function wavesOnly(state: GameState): GameState {
  return { ...state, players: [] };
}

function stateWith(sim: GameSimulation, patch: Partial<GameState>): GameState {
  return { ...sim.state, waves: [], players: [], ...patch };
}

function grounded(sim: GameSimulation, x: number, z: number, charge: number, extra: Partial<PlayerState> = {}): PlayerState {
  return { ...player(sim, 'p0'), x, z, y: 0, grounded: true, respawnIn: 0, charge, ...extra };
}

function decor(over: Partial<DecorWave> = {}): DecorWave {
  return { x: 0, z: 0, radius: 3, maxRadius: 20, power: 1, color: '#3366ff', ...over };
}

function tintAt(field: FloorField, x: number, z: number): Float32Array {
  const out = new Float32Array(4);
  field.tint(x, z, out, 0);
  return out;
}

function rgbOf(hex: string): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

function expectRgbClose(out: Float32Array, rgb: [number, number, number]): void {
  for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(rgb[i], 4);
}

describe('FloorField waves', () => {
  it('is flat and untinted with no state and no decor, and clears stale waves on the next update', () => {
    const field = new FloorField();
    field.update(null, []);
    expect(field.radius).toBe(7.1);
    for (const [x, z] of [[0, 0], [3, 1], [-5, 4]]) {
      expect(field.height(x, z)).toBe(0);
      expect(tintAt(field, x, z)[3]).toBe(0);
    }
    field.update(null, [decor()]);
    expect(field.height(3, 0)).toBeGreaterThan(0);
    field.update(null, []);
    expect(field.height(3, 0)).toBe(0);
    expect(tintAt(field, 3, 0)[3]).toBe(0);
  });

  it('peaks on the simulation crest, reads at least as tall as the physics, with a trailing trough and nothing ahead', () => {
    const { sim, wave } = slamWave();
    const field = new FloorField();
    field.update(wavesOnly(sim.state), []);
    expect(field.radius).toBe(sim.state.arena.radius);

    let bestD = 0, best = -Infinity;
    for (let d = 0.05; d < wave.radius + 2.5; d += 0.02) {
      const h = field.height(wave.x - d, wave.z);
      expect(Number.isFinite(h)).toBe(true);
      if (h > best) { best = h; bestD = d; }
    }
    expect(Math.abs(bestD - wave.radius)).toBeLessThan(0.15);

    const crest = field.height(wave.x - wave.radius, wave.z);
    const physics = waveHeightAt(sim.state, wave.x - wave.radius, wave.z);
    expect(physics).toBeGreaterThan(0.05);
    expect(crest).toBeGreaterThan(physics * 0.9);
    expect(crest).toBeLessThan(1.5);

    const trough = field.height(wave.x - (wave.radius - 0.75), wave.z);
    expect(trough).toBeLessThan(0);
    expect(Math.abs(trough)).toBeLessThan(crest * 0.5);
    expect(Math.abs(field.height(wave.x - (wave.radius + 1.5), wave.z))).toBeLessThan(crest * 0.01);
  });

  it('caps wave count so extra waves beyond the cap never add height', () => {
    const at = (n: number) => {
      const f = new FloorField();
      f.update(null, Array.from({ length: n }, () => decor()));
      return f.height(3, 0);
    };
    expect(at(24)).toBeGreaterThan(at(12));
    expect(at(40)).toBe(at(24));
    expect(Number.isFinite(at(200))).toBe(true);
  });

  it('ignores expired, non-finite and not-yet-born waves and fades waves near their end', () => {
    const { sim, wave } = slamWave();
    const field = new FloorField();
    const sample = (w: Partial<Wave>) => {
      field.update(stateWith(sim, { waves: [{ ...wave, ...w }] }), []);
      return field.height(wave.x - (w.radius ?? wave.radius), wave.z);
    };
    const live = sample({});
    expect(live).toBeGreaterThan(0);
    expect(sample({ maxRadius: wave.radius })).toBe(0);
    expect(sample({ maxRadius: wave.radius - 0.1 })).toBe(0);
    expect(sample({ age: 0 })).toBe(0);
    expect(sample({ power: -2 })).toBe(0);
    expect(sample({ power: Number.NaN })).toBe(0);
    const fading = sample({ maxRadius: wave.radius + 0.5 });
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(live * 0.5);

    field.update(stateWith(sim, { waves: [{ ...wave, radius: Number.NaN }] }), []);
    expect(field.height(1, 1)).toBe(0);
    field.update(null, [decor({ radius: Number.POSITIVE_INFINITY })]);
    expect(field.height(3, 0)).toBe(0);
    field.update(null, [decor({ radius: 3, maxRadius: 0 })]);
    expect(field.height(3, 0)).toBeGreaterThan(0);
    field.update(null, [decor({ radius: 11, maxRadius: 0 })]);
    expect(field.height(7, 0)).toBe(0);
  });

  it('pins the rim: zero height and tint at and beyond the frame, attenuated just inside it', () => {
    const field = new FloorField();
    const R = field.radius;
    field.update(null, [decor({ radius: R + 0.1 }), decor({ x: -4, radius: 6 })]);
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      for (const d of [R + 0.06, R + 0.3, R + 2]) {
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        expect(field.height(x, z)).toBe(0);
        expect(tintAt(field, x, z)[3]).toBe(0);
      }
    }
    const inner = new FloorField();
    inner.update(null, [decor({ radius: 3 })]);
    const rim = new FloorField();
    rim.update(null, [decor({ radius: R * 0.95 })]);
    expect(rim.height(R * 0.95, 0)).toBeGreaterThan(0);
    expect(rim.height(R * 0.95, 0)).toBeLessThan(inner.height(3, 0) * 0.5);
  });
});

describe('FloorField dents', () => {
  it('dents under grounded players, deeper with charge, and skips airborne, respawning and off-floor players', () => {
    const sim = playing(2);
    const field = new FloorField();
    const depth = (p: PlayerState) => {
      field.update(stateWith(sim, { players: [p] }), []);
      const h = field.height(p.x, p.z);
      expect(Number.isFinite(h)).toBe(true);
      return h;
    };
    const idle = depth(grounded(sim, 1, 1, 0));
    const full = depth(grounded(sim, 1, 1, 1));
    expect(idle).toBeLessThan(0);
    expect(full).toBeLessThan(idle);
    expect(full).toBeGreaterThan(-1);
    expect(depth(grounded(sim, 1, 1, 5))).toBe(full);
    expect(depth(grounded(sim, 1, 1, Number.NaN))).toBe(idle);
    expect(depth(grounded(sim, 1, 1, 1, { grounded: false }))).toBe(0);
    expect(depth(grounded(sim, 1, 1, 1, { respawnIn: 1 }))).toBe(0);
    field.update(stateWith(sim, { players: [grounded(sim, 7.5, 0, 1)] }), []);
    expect(field.height(7.0, 0)).toBe(0);
  });

  it('caps dents so a crowd on one spot cannot dig an unbounded hole', () => {
    const sim = playing(2);
    const at = (n: number) => {
      const f = new FloorField();
      f.update(stateWith(sim, { players: Array.from({ length: n }, () => grounded(sim, 0, 0, 1)) }), []);
      return f.height(0, 0);
    };
    expect(at(8)).toBeLessThan(at(4));
    expect(at(12)).toBe(at(8));
  });

  it('tints a charging dent in the player colour and leaves an uncharged dent untinted', () => {
    const sim = playing(2);
    const field = new FloorField();
    field.update(stateWith(sim, { players: [grounded(sim, 2, -1, 0)] }), []);
    expect(tintAt(field, 2, -1)[3]).toBe(0);
    for (const color of [0, 3, 0x12ab34]) {
      field.update(stateWith(sim, { players: [grounded(sim, 2, -1, 1, { color })] }), []);
      const out = tintAt(field, 2, -1);
      expect(out[3]).toBeGreaterThan(0);
      expectRgbClose(out, rgbOf(colorHex(color)));
    }
  });
});

describe('FloorField tint', () => {
  it('paints a player wave in its owner colour along the crest only', () => {
    const { sim, wave } = slamWave();
    const field = new FloorField();
    field.update(wavesOnly(sim.state), []);
    const crest = tintAt(field, wave.x - wave.radius, wave.z);
    expect(crest[3]).toBeGreaterThan(0.1);
    expectRgbClose(crest, rgbOf(colorHex(player(sim, 'p0').color)));
    expect(tintAt(field, wave.x - wave.radius - 2.5, wave.z)[3]).toBe(0);
    expect(tintAt(field, wave.x - wave.radius + 0.4, wave.z)[3]).toBeLessThan(crest[3]);
  });

  it('paints arena-owned hazard waves in a hazard colour that is not any player colour', () => {
    const { sim, wave } = hazardWave();
    expect(wave.color).toBeLessThan(0);
    const field = new FloorField();
    field.update(wavesOnly(sim.state), []);
    const out = tintAt(field, wave.x + wave.radius, wave.z);
    expect(out[3]).toBeGreaterThan(0);
    const hazard: [number, number, number] = [out[0], out[1], out[2]];
    for (const hex of PLAYER_COLORS) {
      const rgb = rgbOf(hex);
      expect(Math.max(...rgb.map((v, i) => Math.abs(v - hazard[i])))).toBeGreaterThan(0.02);
    }

    const ownedNegative = new FloorField();
    ownedNegative.update(stateWith(sim, { waves: [{ ...wave, owner: 'p1' }] }), []);
    expectRgbClose(tintAt(ownedNegative, wave.x + wave.radius, wave.z), hazard);
    const ownedByArena = new FloorField();
    ownedByArena.update(stateWith(sim, { waves: [{ ...wave, color: 2 }] }), []);
    expectRgbClose(tintAt(ownedByArena, wave.x + wave.radius, wave.z), hazard);
  });

  it('keeps tint channels and weight bounded however many waves and dents overlap', () => {
    const sim = playing(2);
    const field = new FloorField();
    const waves = Array.from({ length: 30 }, (_, i) => decor({ radius: 2.5 + (i % 5) * 0.1, power: 5, color: PLAYER_COLORS[i % 8] }));
    const players = Array.from({ length: 10 }, (_, i) => grounded(sim, 2.5, 0, 1, { color: i % 8 }));
    field.update(stateWith(sim, { players }), waves);
    const out = new Float32Array(8).fill(Number.NaN);
    let maxW = 0;
    for (let x = -8; x <= 8; x += 0.25) {
      for (let z = -8; z <= 8; z += 0.5) {
        field.tint(x, z, out, 4);
        const w = out[7];
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
        if (w > 0) for (let k = 4; k < 7; k++) { expect(out[k]).toBeGreaterThanOrEqual(-1e-6); expect(out[k]).toBeLessThanOrEqual(1 + 1e-6); }
        maxW = Math.max(maxW, w);
        const h = field.height(x, z);
        expect(Number.isFinite(h)).toBe(true);
        expect(Math.abs(h)).toBeLessThan(30 * 0.35 * 1.5 * 5 + 10);
      }
    }
    expect(Number.isNaN(out[0])).toBe(true);
    expect(maxW).toBeGreaterThan(0.5);
  });
});

describe('TrampolineFloor geometry', () => {
  const RINGS = 12, SEGMENTS = 24;

  function floor(): TrampolineFloor {
    return new TrampolineFloor(new Texture(), RINGS, SEGMENTS);
  }

  function attr(f: TrampolineFloor, name: string): BufferAttribute {
    return f.mesh.geometry.getAttribute(name) as BufferAttribute;
  }

  function activeField(): FloorField {
    const field = new FloorField();
    field.update(null, [decor({ radius: 3, power: 1.2 }), decor({ x: 2, z: -1, radius: 1.5, color: '#ffcc00' })]);
    return field;
  }

  it('builds in Node without a DOM: finite, in-range indexes, UVs and upward unit normals', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    const f = floor();
    const count = 1 + RINGS * SEGMENTS;
    const pos = attr(f, 'position');
    expect(pos.count).toBe(count);
    expect(attr(f, 'tint').itemSize).toBe(4);
    expect(attr(f, 'tint').count).toBe(count);

    const index = f.mesh.geometry.getIndex();
    expect(index).not.toBeNull();
    expect(index!.count).toBe(3 * SEGMENTS + 6 * SEGMENTS * (RINGS - 1));
    for (let i = 0; i < index!.count; i++) {
      const v = index!.getX(i);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(count);
    }

    const uv = attr(f, 'uv');
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0); expect(uv.getX(i)).toBeLessThanOrEqual(1);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0); expect(uv.getY(i)).toBeLessThanOrEqual(1);
    }

    const n = attr(f, 'normal');
    for (let i = 0; i < n.count; i++) {
      const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
      expect(len).toBeCloseTo(1, 4);
      expect(n.getY(i)).toBeGreaterThan(0.999);
    }
    const sphere = f.mesh.geometry.boundingSphere;
    expect(sphere && Number.isFinite(sphere.radius) && sphere.radius > 7).toBe(true);
    expect(f.mesh.receiveShadow).toBe(true);
  });

  it('follows the field when active, then flattens and clears tint once when it goes idle', () => {
    const f = floor();
    const field = activeField();
    f.update(field, true);
    const pos = attr(f, 'position');
    const tint = attr(f, 'tint');
    let moved = 0, tinted = 0;
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBeCloseTo(field.height(pos.getX(i), pos.getZ(i)), 6);
      if (pos.getY(i) !== 0) moved++;
      if (tint.getW(i) > 0) tinted++;
    }
    expect(moved).toBeGreaterThan(0);
    expect(tinted).toBeGreaterThan(0);
    const n = attr(f, 'normal');
    for (let i = 0; i < n.count; i++) {
      expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 4);
      expect(n.getY(i)).toBeGreaterThan(0);
    }

    f.update(field, false);
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBe(0);
      expect(tint.getW(i)).toBe(0);
      expect(attr(f, 'normal').getY(i)).toBeGreaterThan(0.999);
    }
    const posVersion = pos.version, tintVersion = tint.version;
    f.update(field, false);
    expect(pos.version).toBe(posVersion);
    expect(tint.version).toBe(tintVersion);

    f.update(field, true);
    expect(pos.version).toBeGreaterThan(posVersion);
    expect(Array.from({ length: pos.count }, (_, i) => pos.getY(i)).some(y => y !== 0)).toBe(true);
  });

  it('skips normal recompute only when asked and still recomputes when flattening', () => {
    const f = floor();
    const field = activeField();
    f.update(field, true);
    const normal = attr(f, 'normal');
    const v = normal.version;
    f.update(field, true, false);
    expect(normal.version).toBe(v);
    f.update(field, false, false);
    expect(normal.version).toBeGreaterThan(v);
  });

  it('rebuilds at a new resolution, disposing the old geometry and re-arming the idle pass', () => {
    const f = floor();
    f.update(activeField(), false);
    const old = f.mesh.geometry;
    let disposed = false;
    old.addEventListener('dispose', () => { disposed = true; });
    f.build(6, 16, 8);
    expect(disposed).toBe(true);
    expect(f.mesh.geometry).not.toBe(old);
    const pos = attr(f, 'position');
    expect(pos.count).toBe(1 + 6 * 16);
    let maxR = 0;
    for (let i = 0; i < pos.count; i++) maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getZ(i)));
    expect(maxR).toBeCloseTo(8, 5);
    const v = pos.version;
    f.update(activeField(), false);
    expect(pos.version).toBeGreaterThan(v);
  });

  it('swaps the texture without rebuilding geometry and disposes cleanly', () => {
    const f = floor();
    const geometry = f.mesh.geometry;
    const material = f.mesh.material as MeshStandardMaterial;
    const next = new Texture();
    const version = material.version;
    f.setTexture(next);
    expect(material.map).toBe(next);
    expect(material.version).toBeGreaterThan(version);
    expect(f.mesh.geometry).toBe(geometry);
    expect(() => f.dispose()).not.toThrow();
  });
});

describe('frameArena', () => {
  const RADIUS = 7.1;

  function stagePoints(radius: number): Vector3[] {
    const pts: Vector3[] = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      pts.push(new Vector3(Math.cos(a) * (radius + 0.95), 0.35, Math.sin(a) * (radius + 0.95)));
      pts.push(new Vector3(Math.cos(a) * (radius + 0.75), -1.05, Math.sin(a) * (radius + 0.75)));
      pts.push(new Vector3(Math.cos(a) * radius * 0.85, 2.0, Math.sin(a) * radius * 0.85));
    }
    return pts;
  }

  function ndcBounds(cam: PerspectiveCamera, pts: Vector3[]) {
    cam.updateMatrixWorld(true);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, zMax = -Infinity;
    for (const p of pts) {
      const q = p.clone().project(cam);
      x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
      y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
      zMax = Math.max(zMax, Math.abs(q.z));
    }
    return { x0, x1, y0, y1, zMax };
  }

  const cases: [string, number][] = [['16:9', 16 / 9], ['4:3', 4 / 3], ['portrait 9:16', 9 / 16]];

  for (const [label, aspect] of cases) {
    it(`fits the whole stage, centred and snug, at ${label}`, () => {
      const cam = new PerspectiveCamera(45, 1, 0.1, 400);
      const { position, target } = frameArena(cam, aspect, RADIUS);
      expect(cam.aspect).toBe(aspect);
      expect(position).not.toBe(cam.position);
      expect(position.equals(cam.position)).toBe(true);
      for (const v of [position.x, position.y, position.z, target.x, target.y, target.z]) expect(Number.isFinite(v)).toBe(true);
      expect(position.x).toBeCloseTo(0, 6);
      expect(target.x).toBeCloseTo(0, 6);
      expect(position.y).toBeGreaterThan(target.y);
      expect(position.z).toBeGreaterThan(target.z);
      expect(cam.rotation.y).toBeCloseTo(0, 6);
      expect(cam.rotation.z).toBeCloseTo(0, 6);

      const b = ndcBounds(cam, stagePoints(RADIUS));
      expect(b.x0).toBeGreaterThanOrEqual(-0.95 - 1e-3);
      expect(b.x1).toBeLessThanOrEqual(0.95 + 1e-3);
      expect(b.y0).toBeGreaterThan(-1);
      expect(b.y1).toBeLessThan(1);
      expect(b.zMax).toBeLessThan(1);
      expect(Math.abs(b.x0 + b.x1)).toBeLessThan(1e-3);
      expect(Math.abs((b.y0 + b.y1) / 2)).toBeLessThan(0.05);
      const snugX = Math.max(-b.x0, b.x1) > 0.9;
      const snugY = (b.y1 - b.y0) / 2 > 0.85;
      expect(snugX || snugY).toBe(true);
    });
  }

  it('widens the lens and backs off for portrait, and scales distance with the arena', () => {
    const wide = new PerspectiveCamera();
    const tall = new PerspectiveCamera();
    const w = frameArena(wide, 16 / 9, RADIUS);
    const t = frameArena(tall, 9 / 16, RADIUS);
    expect(tall.fov).toBeGreaterThan(wide.fov);
    expect(t.position.distanceTo(t.target)).toBeGreaterThan(w.position.distanceTo(w.target));

    const big = frameArena(new PerspectiveCamera(), 16 / 9, RADIUS * 1.5);
    expect(big.position.distanceTo(big.target)).toBeGreaterThan(w.position.distanceTo(w.target));
    const again = frameArena(new PerspectiveCamera(), 16 / 9, RADIUS);
    expect(again.position.distanceTo(w.position)).toBeLessThan(1e-9);
  });
});
