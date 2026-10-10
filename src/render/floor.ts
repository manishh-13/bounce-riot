import {
  BufferAttribute, BufferGeometry, CanvasTexture, Color, DynamicDrawUsage, Mesh, MeshStandardMaterial,
  SRGBColorSpace, type Texture,
} from 'three';
import type { GameState, Wave } from '../game/types';
import { colorHex, type ArenaTheme } from './palette';

const MAX_WAVES = 24;
const MAX_DENTS = 8;
const HAZARD_COLOR = '#ff6a3d';
const VISUAL_GAIN = 1.5;

export interface DecorWave { x: number; z: number; radius: number; maxRadius: number; power: number; color: string; }

// Analytic trampoline surface: the same function drives the mesh, the decals and the characters' feet,
// so what players see under them matches what the simulation's waves are doing.
export class FloorField {
  radius = 7.1;
  private wx = new Float32Array(MAX_WAVES);
  private wz = new Float32Array(MAX_WAVES);
  private wr = new Float32Array(MAX_WAVES);
  private ww = new Float32Array(MAX_WAVES);
  private wa = new Float32Array(MAX_WAVES);
  private wt = new Float32Array(MAX_WAVES);
  private wc = new Float32Array(MAX_WAVES * 3);
  private waveCount = 0;
  private dx = new Float32Array(MAX_DENTS);
  private dz = new Float32Array(MAX_DENTS);
  private ds = new Float32Array(MAX_DENTS);
  private dd = new Float32Array(MAX_DENTS);
  private dt = new Float32Array(MAX_DENTS);
  private dc = new Float32Array(MAX_DENTS * 3);
  private dentCount = 0;
  private tmp = new Color();

  update(state: GameState | null, decor: DecorWave[]): void {
    this.radius = state?.arena?.radius || 7.1;
    this.waveCount = 0;
    this.dentCount = 0;
    if (state) for (const w of state.waves) this.addWave(w);
    for (const d of decor) this.pushWave(d.x, d.z, d.radius, d.maxRadius, d.power, d.color);
    if (!state) return;
    for (const p of state.players) {
      if (this.dentCount >= MAX_DENTS) break;
      if (p.respawnIn > 0 || !p.grounded) continue;
      if (p.x * p.x + p.z * p.z > this.radius * this.radius) continue;
      const c = clamp01(p.charge);
      const i = this.dentCount++;
      this.dx[i] = p.x; this.dz[i] = p.z;
      this.ds[i] = 0.7 + 0.5 * c;
      this.dd[i] = -(0.06 + 0.3 * c);
      this.dt[i] = 0.32 * c;
      this.tmp.set(colorHex(p.color));
      this.dc[i * 3] = this.tmp.r; this.dc[i * 3 + 1] = this.tmp.g; this.dc[i * 3 + 2] = this.tmp.b;
    }
  }

  private addWave(w: Wave): void {
    const color = w.owner === '__arena__' || w.color < 0 ? HAZARD_COLOR : colorHex(w.color);
    this.pushWave(w.x, w.z, w.radius, w.maxRadius, w.power, color, w.age);
  }

  // Mirrors waveHeightAt() in simulation.ts (sigma = waveBand / 2, 0.35 * effective power, end fade) with a
  // visual gain and a small trailing trough so the crest reads clearly on a TV.
  private pushWave(x: number, z: number, r: number, maxR: number, power: number, color: string, age = 1): void {
    if (this.waveCount >= MAX_WAVES || !Number.isFinite(r)) return;
    const max = maxR > 0 ? maxR : 10;
    if (r >= max) return;
    const eff = Math.max(0, power || 0) * (1 - 0.35 * Math.min(1, r / (2 * this.radius)));
    const fade = clamp01((max - r) / 2) * clamp01(age / 0.08);
    const i = this.waveCount++;
    this.wx[i] = x; this.wz[i] = z; this.wr[i] = r;
    this.ww[i] = 0.45;
    this.wa[i] = 0.35 * VISUAL_GAIN * eff * fade;
    this.wt[i] = Math.min(0.9, (0.4 + 0.6 * eff) * fade);
    this.tmp.set(color);
    this.wc[i * 3] = this.tmp.r; this.wc[i * 3 + 1] = this.tmp.g; this.wc[i * 3 + 2] = this.tmp.b;
  }

  private pin(x: number, z: number): number {
    const d = Math.sqrt(x * x + z * z);
    return 1 - smooth(this.radius * 0.86, this.radius + 0.05, d);
  }

  height(x: number, z: number): number {
    const pin = this.pin(x, z);
    if (pin <= 0) return 0;
    let h = 0;
    for (let i = 0; i < this.waveCount; i++) {
      const ddx = x - this.wx[i], ddz = z - this.wz[i];
      const u = (Math.sqrt(ddx * ddx + ddz * ddz) - this.wr[i]) / this.ww[i];
      if (u > 3 || u < -4.5) continue;
      const v = u + 1.6;
      h += this.wa[i] * (Math.exp(-u * u) - 0.3 * Math.exp(-v * v));
    }
    for (let i = 0; i < this.dentCount; i++) {
      const ddx = x - this.dx[i], ddz = z - this.dz[i];
      const q = (ddx * ddx + ddz * ddz) / (this.ds[i] * this.ds[i]);
      if (q < 9) h += this.dd[i] * Math.exp(-q);
    }
    return h * pin;
  }

  // Writes rgb + weight into out[o..o+3]; weight 0 means untinted floor.
  tint(x: number, z: number, out: Float32Array, o: number): void {
    let r = 0, g = 0, b = 0, wsum = 0;
    for (let i = 0; i < this.waveCount; i++) {
      const ddx = x - this.wx[i], ddz = z - this.wz[i];
      const u = (Math.sqrt(ddx * ddx + ddz * ddz) - this.wr[i]) / (this.ww[i] * 0.8);
      if (u > 2.6 || u < -2.6) continue;
      const k = this.wt[i] * Math.exp(-u * u);
      r += this.wc[i * 3] * k; g += this.wc[i * 3 + 1] * k; b += this.wc[i * 3 + 2] * k; wsum += k;
    }
    for (let i = 0; i < this.dentCount; i++) {
      if (this.dt[i] <= 0) continue;
      const ddx = x - this.dx[i], ddz = z - this.dz[i];
      const q = (ddx * ddx + ddz * ddz) / (this.ds[i] * this.ds[i] * 0.8);
      if (q > 6) continue;
      const k = this.dt[i] * Math.exp(-q);
      r += this.dc[i * 3] * k; g += this.dc[i * 3 + 1] * k; b += this.dc[i * 3 + 2] * k; wsum += k;
    }
    if (wsum <= 1e-4) { out[o + 3] = 0; return; }
    const pin = this.pin(x, z);
    out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum;
    out[o + 3] = Math.min(0.85, wsum) * pin;
  }
}

export class TrampolineFloor {
  readonly mesh: Mesh;
  private geometry!: BufferGeometry;
  private baseXZ!: Float32Array;
  private tintArray!: Float32Array;
  private material: MeshStandardMaterial;
  private extent = 7.4;
  private idle = true;

  constructor(texture: Texture, rings: number, segments: number) {
    this.material = new MeshStandardMaterial({ map: texture, roughness: 0.82, metalness: 0 });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute vec4 tint;\nvarying vec4 vTint;\n' + shader.vertexShader.replace(
        '#include <color_vertex>', '#include <color_vertex>\n  vTint = tint;');
      shader.fragmentShader = 'varying vec4 vTint;\n' + shader.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, vTint.rgb, vTint.a);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vTint.rgb * vTint.a * 0.22;');
    };
    this.mesh = new Mesh(undefined, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'trampoline-floor';
    this.build(rings, segments);
  }

  setTexture(texture: Texture): void {
    this.material.map = texture;
    this.material.needsUpdate = true;
  }

  build(rings: number, segments: number, extent = this.extent): void {
    this.extent = extent;
    this.geometry?.dispose();
    const count = 1 + rings * segments;
    const pos = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    this.baseXZ = new Float32Array(count * 2);
    this.tintArray = new Float32Array(count * 4);
    let v = 1;
    uv[0] = 0.5; uv[1] = 0.5;
    for (let r = 1; r <= rings; r++) {
      const rad = (r / rings) * extent;
      for (let s = 0; s < segments; s++, v++) {
        const a = (s / segments) * Math.PI * 2;
        const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
        this.baseXZ[v * 2] = x; this.baseXZ[v * 2 + 1] = z;
        pos[v * 3] = x; pos[v * 3 + 2] = z;
        uv[v * 2] = 0.5 + x / (2 * extent);
        uv[v * 2 + 1] = 0.5 - z / (2 * extent);
      }
    }
    const index: number[] = [];
    for (let s = 0; s < segments; s++) index.push(0, 1 + ((s + 1) % segments), 1 + s);
    for (let r = 1; r < rings; r++) {
      const a0 = 1 + (r - 1) * segments, b0 = 1 + r * segments;
      for (let s = 0; s < segments; s++) {
        const s1 = (s + 1) % segments;
        const a = a0 + s, b = a0 + s1, c = b0 + s, d = b0 + s1;
        index.push(a, b, c, b, d, c);
      }
    }
    const g = new BufferGeometry();
    const posAttr = new BufferAttribute(pos, 3); posAttr.setUsage(DynamicDrawUsage);
    const tintAttr = new BufferAttribute(this.tintArray, 4); tintAttr.setUsage(DynamicDrawUsage);
    g.setAttribute('position', posAttr);
    g.setAttribute('uv', new BufferAttribute(uv, 2));
    g.setAttribute('tint', tintAttr);
    g.setIndex(index);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this.geometry = g;
    this.mesh.geometry = g;
    this.idle = false;
  }

  update(field: FloorField, active: boolean, normals = true): void {
    // Skip the CPU pass entirely while the membrane is flat and nothing is pressing on it.
    if (!active && this.idle) return;
    const pos = this.geometry.attributes.position as BufferAttribute;
    const arr = pos.array as Float32Array;
    const n = arr.length / 3;
    for (let i = 0; i < n; i++) {
      const x = this.baseXZ[i * 2], z = this.baseXZ[i * 2 + 1];
      arr[i * 3 + 1] = active ? field.height(x, z) : 0;
      if (active) field.tint(x, z, this.tintArray, i * 4); else this.tintArray[i * 4 + 3] = 0;
    }
    pos.needsUpdate = true;
    this.geometry.attributes.tint.needsUpdate = true;
    if (normals || !active) this.geometry.computeVertexNormals();
    this.idle = !active;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export function createFloorTexture(theme: ArenaTheme, size: number, radius: number, extent: number, anisotropy: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Bounce Riot renderer: 2D canvas unavailable for floor markings.');
  const c = size / 2;
  const px = (world: number) => (world / extent) * c;
  const R = px(radius);
  ctx.fillStyle = theme.floorOuter;
  ctx.fillRect(0, 0, size, size);
  const grad = ctx.createRadialGradient(c, c, 0, c, c, R);
  grad.addColorStop(0, theme.floorInner);
  grad.addColorStop(0.75, theme.floorInner);
  grad.addColorStop(1, theme.floorOuter);
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(c, c, R * 1.05, 0, Math.PI * 2); ctx.fill();

  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = theme.cream;
  for (let i = 0; i < 16; i += 2) {
    const a0 = (i / 16) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 1) / 16) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, R * 0.9, a0, a1); ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  ctx.strokeStyle = theme.line;
  ctx.lineCap = 'round';
  ctx.lineWidth = px(0.09);
  for (const f of [0.36, 0.64]) { ctx.beginPath(); ctx.arc(c, c, R * f, 0, Math.PI * 2); ctx.stroke(); }

  ctx.fillStyle = theme.line;
  const dots = 64;
  for (let i = 0; i < dots; i++) {
    const a = (i / dots) * Math.PI * 2;
    ctx.beginPath(); ctx.arc(c + Math.cos(a) * R * 0.85, c + Math.sin(a) * R * 0.85, px(0.055), 0, Math.PI * 2); ctx.fill();
  }

  const blocks = 32;
  const inner = R * 0.9, outer = R * 1.02;
  for (let i = 0; i < blocks; i++) {
    const a0 = (i / blocks) * Math.PI * 2, a1 = ((i + 1) / blocks) * Math.PI * 2;
    ctx.fillStyle = i % 2 ? theme.cream : theme.accent;
    ctx.beginPath(); ctx.arc(c, c, outer, a0, a1); ctx.arc(c, c, inner, a1, a0, true); ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = theme.line; ctx.lineWidth = px(0.05);
  ctx.beginPath(); ctx.arc(c, c, inner, 0, Math.PI * 2); ctx.stroke();

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const sx = c + Math.cos(a) * R * 0.64, sy = c + Math.sin(a) * R * 0.64;
    ctx.fillStyle = theme.cream; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(sx, sy, px(0.3), 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = theme.floorOuter;
    ctx.beginPath(); ctx.arc(sx, sy, px(0.17), 0, Math.PI * 2); ctx.fill();
  }

  drawEmblem(ctx, theme, c, px);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

function drawEmblem(ctx: CanvasRenderingContext2D, theme: ArenaTheme, c: number, px: (w: number) => number): void {
  const r = px(1.35);
  ctx.fillStyle = theme.cream;
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = theme.accent; ctx.lineWidth = px(0.14);
  ctx.beginPath(); ctx.arc(c, c, r - px(0.16), 0, Math.PI * 2); ctx.stroke();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (theme.emblem === 'spring') {
    ctx.strokeStyle = theme.accent; ctx.lineWidth = px(0.16);
    ctx.beginPath();
    const w = px(0.55), h = px(1.3), steps = 5;
    for (let i = 0; i <= steps; i++) {
      const y = c - h / 2 + (i / steps) * h;
      const x = c + (i % 2 ? w : -w) * (i === 0 || i === steps ? 0 : 1);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = theme.accent2;
    for (const dy of [-1, 1]) { ctx.beginPath(); ctx.ellipse(c, c + dy * h * 0.56, px(0.42), px(0.12), 0, 0, Math.PI * 2); ctx.fill(); }
  } else if (theme.emblem === 'moon') {
    ctx.fillStyle = theme.accent2;
    ctx.beginPath(); ctx.arc(c, c, px(0.7), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = theme.cream;
    ctx.beginPath(); ctx.arc(c + px(0.32), c - px(0.22), px(0.6), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = theme.accent;
    star(ctx, c - px(0.5), c - px(0.55), px(0.2));
    star(ctx, c + px(0.55), c + px(0.5), px(0.15));
  } else {
    const ringR = r - px(0.16);
    const n = 16;
    ctx.lineWidth = px(0.22); ctx.lineCap = 'butt';
    for (let i = 0; i < n; i++) {
      ctx.strokeStyle = i % 2 ? theme.accent2 : theme.accent2 + '00';
      if (i % 2 === 0) continue;
      ctx.beginPath(); ctx.arc(c, c, ringR - px(0.25), (i / n) * Math.PI * 2, ((i + 1) / n) * Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 ? px(0.32) : px(0.7);
      ctx.lineTo(c + Math.cos(a) * rr, c + Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fill();
}

export function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function clamp01(v: number): number {
  return v > 1 ? 1 : v < 0 || !Number.isFinite(v) ? 0 : v;
}
