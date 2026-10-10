import {
  AmbientLight, CanvasTexture, DirectionalLight, Fog, HemisphereLight, Material, Mesh, NeutralToneMapping,
  Object3D, PCFSoftShadowMap, PerspectiveCamera, Scene, SRGBColorSpace, Texture, Vector3, WebGLRenderer,
} from 'three';
import type { GameEvent, GameState, PlayerState } from '../game/types';
import { BadgeCache } from './badges';
import { acquireShared, Mascot, releaseShared } from './character';
import { ImpactPops, Particles, PARTICLE_POOL, WarningRings, type Burst } from './effects';
import { ARENA_OWNER } from '../game/simulation';
import { createFloorTexture, FloorField, TrampolineFloor, type DecorWave } from './floor';
import { frameArena } from './framing';
import { colorHex, slotOf, themeFor, type Quality, type ResolvedQuality } from './palette';
import { Stage } from './stage';

export interface ArenaSceneOptions { reducedMotion?: boolean; quality?: Quality; }

const PAGE_BG = '#f5efdf';
const FLOOR_EXTENT = 7.45;
const Q = {
  high: { dprCap: 1.75, maxPixels: 1920 * 1080 * 1.6, shadows: true, shadowSize: 2048, rings: 44, segs: 120, particles: PARTICLE_POOL, floorTex: 1024 },
  low: { dprCap: 1, maxPixels: 1600 * 900, shadows: false, shadowSize: 1024, rings: 26, segs: 72, particles: 150, floorTex: 512 },
} as const;

function supportsWebGL(): string | null {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'This browser or device has WebGL turned off or unavailable.';
    (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export class ArenaScene {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(32, 16 / 9, 0.5, 140);
  private camBase = new Vector3();
  private camTarget = new Vector3();
  private key: DirectionalLight;
  private field = new FloorField();
  private floor: TrampolineFloor;
  private stage: Stage | null = null;
  private floorTextures = new Map<string, CanvasTexture>();
  private themeId = '';
  private mascots = new Map<string, Mascot>();
  private badges = new BadgeCache();
  private particles = new Particles();
  private pops: ImpactPops;
  private rings: WarningRings;
  private reducedMotion: boolean;
  private quality: Quality;
  private resolved: ResolvedQuality;
  private time = 0;
  private shake = 0;
  private seen = new Set<number>();
  private lastState: GameState | null = null;
  private lastTick = -1;
  private lastRound = -1;
  private lastPhase = '';
  private celebrated = -1;
  private decor: (DecorWave & { speed: number })[] = [];
  private decorTimer = 0.6;
  private slowTime = 0;
  private frameAvg = 1 / 60;
  private frame = 0;
  private lost = false;
  private disposed = false;
  private width = 0;
  private height = 0;
  private resizeObserver: ResizeObserver | null = null;
  private radius = 7.1;

  constructor(private container: HTMLElement, options: ArenaSceneOptions = {}) {
    this.reducedMotion = !!options.reducedMotion;
    this.quality = options.quality ?? 'auto';
    this.resolved = this.resolveQuality(this.quality);
    const problem = supportsWebGL();
    if (problem) throw new Error(`Bounce Riot needs WebGL to draw the arena. ${problem} Try a current Chrome or Edge, or enable hardware acceleration.`);
    try {
      this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', stencil: false });
    } catch (err) {
      throw new Error(`Bounce Riot could not start WebGL: ${err instanceof Error ? err.message : String(err)}`);
    }
    const r = this.renderer;
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = NeutralToneMapping;
    r.toneMappingExposure = 0.96;
    r.setClearColor(PAGE_BG, 0);
    r.shadowMap.type = PCFSoftShadowMap;
    const canvas = r.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    container.appendChild(canvas);

    this.scene.fog = new Fog(PAGE_BG, 30, 62);
    // A directional toy-studio look: less flat fill preserves colour on a bright TV.
    const hemi = new HemisphereLight('#fff6e8', '#518f80', 0.95);
    const ambient = new AmbientLight('#fff6e8', 0.12);
    this.key = new DirectionalLight('#fff6ea', 2.65);
    this.key.position.set(-6, 15, 9);
    this.key.target.position.set(0, 0, 0);
    const cam = this.key.shadow.camera;
    cam.left = -9.5; cam.right = 9.5; cam.top = 9.5; cam.bottom = -9.5; cam.near = 4; cam.far = 34;
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.03;
    this.key.shadow.radius = 3;
    const fill = new DirectionalLight('#cce9ff', 0.7);
    fill.position.set(9, 6, -8);
    this.scene.add(hemi, ambient, this.key, this.key.target, fill);

    this.floor = new TrampolineFloor(this.floorTexture('springyard'), Q[this.resolved].rings, Q[this.resolved].segs);
    this.floor.build(Q[this.resolved].rings, Q[this.resolved].segs, FLOOR_EXTENT);
    this.scene.add(this.floor.mesh);
    this.scene.add(this.particles.points);
    this.pops = new ImpactPops(this.scene, 6);
    this.rings = new WarningRings(this.scene, 3);
    this.setTheme('springyard');
    this.applyQuality();
    acquireShared(this.resolved === 'high');

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.resize();
  }

  setQuality(quality: Quality): void {
    this.quality = quality;
    const next = this.resolveQuality(quality);
    this.slowTime = 0;
    if (next === this.resolved) { this.applyPixelRatio(); return; }
    this.resolved = next;
    this.applyQuality();
    this.rebuildStage();
  }

  resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.width = w; this.height = h;
    this.applyPixelRatio();
    this.renderer.setSize(w, h, false);
    const { position, target } = frameArena(this.camera, w / h, this.radius);
    this.camBase.copy(position);
    this.camTarget.copy(target);
    const fog = this.scene.fog as Fog;
    const dist = position.distanceTo(target);
    fog.near = dist + 6;
    fog.far = dist + 24;
    this.particles.setViewport(h * this.renderer.getPixelRatio(), this.camera.fov);
  }

  render(state: GameState, dt: number): void {
    if (this.disposed || this.lost || !state) return;
    const step = Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
    this.time += step;
    this.frame++;
    this.trackPerformance(dt);

    const radius = state.arena?.radius || 7.1;
    if (Math.abs(radius - this.radius) > 1e-3) { this.radius = radius; this.resize(); }
    this.setTheme(state.arena?.id ?? 'springyard');
    this.syncStream(state);
    this.updateDecor(state, step);
    this.field.update(state, this.decor);
    const active = state.waves.length > 0 || this.decor.length > 0 || state.players.some((p) => p.grounded && p.respawnIn <= 0);
    this.floor.update(this.field, active, this.resolved === 'high' || this.frame % 2 === 0);

    this.updateMascots(state, step);
    this.processEvents(state);
    this.celebrate(state);
    this.particles.update(step, this.field);
    this.pops.update(step, this.reducedMotion);
    this.rings.update(step, this.field);
    this.stage?.update(step, this.reducedMotion);

    this.camera.position.copy(this.camBase);
    if (!this.reducedMotion && this.shake > 0.001) {
      const s = this.shake;
      this.camera.position.x += Math.sin(this.time * 61) * s * 0.6;
      this.camera.position.y += Math.sin(this.time * 47 + 1.3) * s * 0.5;
    }
    this.shake *= Math.exp(-step * 9);
    this.camera.lookAt(this.camTarget);
    this.lastPhase = state.phase;
    this.renderer.render(this.scene, this.camera);
  }

  getStats(): { calls: number; triangles: number; points: number; geometries: number; textures: number; quality: ResolvedQuality; pixelRatio: number } {
    const info = this.renderer.info;
    return {
      calls: info.render.calls, triangles: info.render.triangles, points: info.render.points,
      geometries: info.memory.geometries, textures: info.memory.textures, quality: this.resolved, pixelRatio: this.renderer.getPixelRatio(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onLost, false);
    canvas.removeEventListener('webglcontextrestored', this.onRestored, false);
    for (const m of this.mascots.values()) { m.dispose(); releaseShared(); }
    this.mascots.clear();
    releaseShared();
    this.particles.dispose();
    this.pops.dispose();
    this.rings.dispose();
    this.floor.dispose();
    this.disposeTree(this.scene);
    for (const t of this.floorTextures.values()) t.dispose();
    this.floorTextures.clear();
    this.badges.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  private onLost = (e: Event) => { e.preventDefault(); this.lost = true; };
  private onRestored = () => { this.lost = false; this.resize(); };

  private resolveQuality(q: Quality): ResolvedQuality {
    if (q !== 'auto') return q;
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : undefined;
    if (nav && ((nav.hardwareConcurrency && nav.hardwareConcurrency <= 4) || (nav.deviceMemory && nav.deviceMemory <= 2))) return 'low';
    return 'high';
  }

  private applyPixelRatio(): void {
    const cfg = Q[this.resolved];
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const area = Math.max(1, this.width * this.height);
    const ratio = Math.max(0.75, Math.min(dpr, cfg.dprCap, Math.sqrt(cfg.maxPixels / area)));
    if (Math.abs(this.renderer.getPixelRatio() - ratio) > 0.01) {
      this.renderer.setPixelRatio(ratio);
      if (this.width) this.renderer.setSize(this.width, this.height, false);
    }
  }

  private applyQuality(): void {
    const cfg = Q[this.resolved];
    const wasShadows = this.renderer.shadowMap.enabled;
    this.renderer.shadowMap.enabled = cfg.shadows;
    this.key.castShadow = cfg.shadows;
    if (this.key.shadow.mapSize.x !== cfg.shadowSize) {
      this.key.shadow.mapSize.set(cfg.shadowSize, cfg.shadowSize);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.floor.build(cfg.rings, cfg.segs, FLOOR_EXTENT);
    this.particles.cap = cfg.particles;
    this.particles.clear();
    if (wasShadows !== cfg.shadows) this.scene.traverse((o) => {
      const mat = (o as Mesh).material as Material | Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => (m.needsUpdate = true)); else if (mat) mat.needsUpdate = true;
    });
    if (this.themeId) {
      const old = this.floorTextures.get(this.themeId);
      this.floorTextures.delete(this.themeId);
      this.floor.setTexture(this.floorTexture(this.themeId));
      old?.dispose();
    }
    this.applyPixelRatio();
  }

  private trackPerformance(dt: number): void {
    if (this.quality !== 'auto' || this.resolved === 'low' || !(dt > 0) || dt > 0.5) return;
    this.frameAvg += (dt - this.frameAvg) * 0.05;
    // Downgrade only (never flip back) so a TV that struggles settles instead of oscillating.
    if (this.frameAvg > 1 / 38) this.slowTime += dt; else this.slowTime = Math.max(0, this.slowTime - dt * 0.5);
    if (this.slowTime > 3) {
      this.resolved = 'low';
      this.slowTime = 0;
      this.applyQuality();
      this.rebuildStage();
    }
  }

  private floorTexture(id: string): CanvasTexture {
    let tex = this.floorTextures.get(id);
    if (!tex) {
      const aniso = Math.min(8, this.renderer?.capabilities.getMaxAnisotropy() ?? 1);
      tex = createFloorTexture(themeFor(id), Q[this.resolved].floorTex, this.radius, FLOOR_EXTENT, aniso);
      this.floorTextures.set(id, tex);
    }
    return tex;
  }

  private setTheme(id: string): void {
    if (id === this.themeId) return;
    this.themeId = id;
    this.floor.setTexture(this.floorTexture(id));
    this.rebuildStage();
  }

  private rebuildStage(): void {
    if (this.stage) {
      this.scene.remove(this.stage.group);
      this.disposeTree(this.stage.group);
    }
    this.stage = new Stage(themeFor(this.themeId), this.radius, this.resolved);
    this.scene.add(this.stage.group);
  }

  private disposeTree(root: Object3D): void {
    const textures = new Set<Texture>();
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
      for (const m of mats) {
        for (const v of Object.values(m)) if (v instanceof Texture && !(v instanceof CanvasTexture && this.isSharedTexture(v))) textures.add(v);
        m.dispose();
      }
    });
    textures.forEach((t) => t.dispose());
  }

  private isSharedTexture(t: Texture): boolean {
    for (const f of this.floorTextures.values()) if (f === t) return true;
    return false;
  }

  // Host swaps between a demo and a real simulation; event ids are only unique per stream.
  private syncStream(state: GameState): void {
    const swapped = state !== this.lastState;
    const rewound = state.tick < this.lastTick || state.round !== this.lastRound;
    if (swapped || rewound) {
      this.seen.clear();
      if (swapped && state.events.length > 12) for (const e of state.events) this.seen.add(e.id);
      this.decor.length = 0;
      if (swapped) {
        this.particles.clear(); this.pops.clear(); this.rings.clear(); this.shake = 0;
        this.celebrated = state.phase === 'results' ? state.round : -1;
      }
    }
    this.lastState = state;
    this.lastTick = state.tick;
    this.lastRound = state.round;
  }

  private updateDecor(state: GameState, dt: number): void {
    const idle = state.phase === 'lobby' && state.waves.length === 0;
    for (const d of this.decor) d.radius += d.speed * dt;
    for (let i = this.decor.length - 1; i >= 0; i--) if (this.decor[i].radius >= this.decor[i].maxRadius) this.decor.splice(i, 1);
    if (!idle) return;
    this.decorTimer -= dt;
    if (this.decorTimer > 0 || this.decor.length >= 3) return;
    this.decorTimer = this.reducedMotion ? 4.5 : 2.6;
    const k = Math.floor(this.time * 7) % 8;
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const centre = this.frame % 3 === 0;
    this.decor.push({
      x: centre ? 0 : Math.cos(a) * this.radius * 0.64, z: centre ? 0 : Math.sin(a) * this.radius * 0.64,
      radius: 0, maxRadius: this.radius * 0.9, power: this.reducedMotion ? 0.25 : 0.42, color: colorHex(k), speed: 2.6,
    });
  }

  private facingFor(p: PlayerState): number {
    return Number.isFinite(p.facing) ? p.facing : 0;
  }

  private updateMascots(state: GameState, dt: number): void {
    const present = new Set<string>();
    const inUse = new Set<CanvasTexture>();
    let leaderId: string | null = null;
    if (state.phase === 'results') leaderId = null;
    else if (state.phase === 'playing' || state.phase === 'paused') {
      let top = 0, tie = false;
      for (const p of state.players) { if (p.score > top) { top = p.score; leaderId = p.id; tie = false; } else if (p.score === top && top > 0) tie = true; }
      if (tie) leaderId = null;
    }
    const winners = new Set(state.phase === 'results' ? state.winnerIds : []);
    state.players.forEach((p, index) => {
      present.add(p.id);
      const hex = colorHex(p.color);
      const slot = slotOf(p.color, index);
      let m = this.mascots.get(p.id);
      if (!m) {
        m = new Mascot(acquireShared(this.resolved === 'high'), hex, slot);
        this.mascots.set(p.id, m);
        this.scene.add(m.root, m.decal, m.badge);
      }
      m.setColor(hex);
      const tex = this.badges.get({
        name: p.name, color: hex, number: slot + 1, offline: p.connected === false, bot: !!p.bot,
        leader: winners.has(p.id) || p.id === leaderId,
      });
      inUse.add(tex);
      m.setBadge(tex, this.badges.aspect);
      m.update(p, {
        field: this.field, dt, time: this.time, reducedMotion: this.reducedMotion, phase: state.phase,
        winner: winners.has(p.id), loser: state.phase === 'results' && winners.size > 0 && !winners.has(p.id),
        facing: this.facingFor(p), shadowMap: this.renderer.shadowMap.enabled,
      });
    });
    for (const [id, m] of this.mascots) if (!present.has(id)) { m.dispose(); releaseShared(); this.mascots.delete(id); }
    this.badges.sweep(inUse);
  }

  private player(state: GameState, id: string | undefined): PlayerState | undefined {
    return id ? state.players.find((p) => p.id === id) : undefined;
  }

  private processEvents(state: GameState): void {
    const next = new Set<number>();
    for (const e of state.events) {
      next.add(e.id);
      if (this.seen.has(e.id)) continue;
      this.effectFor(state, e);
    }
    this.seen = next;
  }

  private effectFor(state: GameState, e: GameEvent): void {
    const p = this.player(state, e.playerId);
    const color = p ? colorHex(p.color) : '#ffffff';
    const power = Math.max(0.2, Math.min(2.5, e.power || 1));
    const y = this.field.height(e.x, e.z) + 0.1;
    const rm = this.reducedMotion;
    const low = this.resolved === 'low';
    const n = (count: number) => Math.max(2, Math.round(count * (low ? 0.55 : 1) * (rm ? 0.5 : 1)));
    const emit = (b: Omit<Burst, 'count'> & { count: number }) => this.particles.emit({ ...b, count: n(b.count) });
    switch (e.type) {
      case 'hop':
        if (!low) emit({ x: e.x, y, z: e.z, count: 5, color: '#fffaf0', speed: 1.4, up: 0.6, size: 0.3, life: 0.45, gravity: 1, shape: 0, ring: true, spread: 0.3 });
        break;
      case 'slam':
        emit({ x: e.x, y, z: e.z, count: 10 + 8 * power, color, color2: '#fff4d7', speed: 3.5 + power, up: 1.2, size: 0.38, life: 0.6, gravity: 2, shape: 0, ring: true, spread: 0.5 });
        emit({ x: e.x, y: y + 0.2, z: e.z, count: 6 * power, color, color2: '#ffe08a', speed: 2, up: 4, size: 0.22, life: 0.8, gravity: 9, shape: 2, drag: 0.8 });
        this.addShake(0.08 * power);
        this.mascots.get(e.playerId)?.react('land');
        break;
      case 'hit': {
        const attacker = this.player(state, e.otherId);
        const hitColor = attacker ? colorHex(attacker.color) : e.otherId === ARENA_OWNER ? '#ff7a3d' : color;
        const hy = (this.mascots.get(e.playerId)?.feetY ?? y) + 0.7;
        this.pops.spawn(e.x, hy, e.z, rm ? 0.8 : 0.9 + 0.5 * power, hitColor);
        emit({ x: e.x, y: hy, z: e.z, count: 6 + 8 * power, color: hitColor, color2: '#ffffff', speed: 3, up: 2.5, size: 0.24, life: 0.6, gravity: 6, shape: 2, drag: 1 });
        this.addShake(0.05 + 0.06 * power);
        this.mascots.get(e.playerId)?.react('hit');
        break;
      }
      case 'ride':
        emit({ x: e.x, y: y + 0.4, z: e.z, count: 8, color: '#ffe08a', color2: color, speed: 1.4, up: 2.5, size: 0.25, life: 0.7, gravity: 3, shape: 2 });
        this.mascots.get(e.playerId)?.react('ride');
        break;
      case 'ko': {
        const fx = e.x * 1.04, fz = e.z * 1.04;
        this.pops.spawn(fx, -0.2, fz, rm ? 1 : 1.7, color);
        emit({ x: fx, y: -0.4, z: fz, count: 22, color, color2: '#fff1c4', speed: 4.5, up: 6, size: 0.3, life: 1.1, gravity: 9, shape: 1, drag: 0.7 });
        emit({ x: fx, y: -0.6, z: fz, count: 10, color: '#ffffff', speed: 2.5, up: 2.5, size: 0.7, life: 0.9, gravity: 0.5, shape: 0, spread: 0.5 });
        this.addShake(0.16);
        const scorer = this.player(state, e.otherId);
        if (scorer) this.mascots.get(scorer.id)?.react('ko');
        break;
      }
      case 'respawn':
        emit({ x: e.x, y: y + 0.2, z: e.z, count: 12, color: '#ffffff', color2: color, speed: 2.4, up: 1.6, size: 0.5, life: 0.7, gravity: 1, shape: 0, ring: true, spread: 0.4 });
        this.rings.spawn(e.x, e.z, 1.2, color, 0.6);
        break;
      case 'start':
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          emit({ x: Math.cos(a) * 3, y: 0.3, z: Math.sin(a) * 3, count: 8, color: colorHex(i * 2), color2: colorHex(i * 2 + 1), speed: 1.5, up: 5, size: 0.28, life: 1.1, gravity: 8, shape: 1, drag: 0.6 });
        }
        break;
      case 'finish':
        this.celebrate(state, true);
        break;
      case 'hazard':
        if (e.power <= 0) {
          this.rings.spawn(e.x, e.z, 2.6, '#ff6a3d', 1.0, true);
          break;
        }
        this.rings.spawn(e.x, e.z, 3.2, '#ffb03d', 0.9);
        emit({ x: e.x, y, z: e.z, count: 20, color: '#ff8a4c', color2: '#fff1d8', speed: 4.5, up: 2.2, size: 0.55, life: 0.9, gravity: 2, shape: 0, ring: true, spread: 0.6 });
        emit({ x: e.x, y: y + 0.2, z: e.z, count: 10, color: '#ffd166', color2: '#ff6a3d', speed: 2, up: 6, size: 0.25, life: 0.9, gravity: 10, shape: 2, drag: 0.6 });
        this.addShake(0.2 * power);
        break;
    }
  }

  private celebrate(state: GameState, force = false): void {
    const entering = state.phase === 'results' && this.lastPhase !== 'results';
    if (!(entering || force) || this.celebrated === state.round) return;
    this.celebrated = state.round;
    const winners = state.winnerIds.map((id) => this.player(state, id)).filter((p): p is PlayerState => !!p);
    const count = this.reducedMotion ? 10 : this.resolved === 'low' ? 18 : 30;
    const spots = winners.length ? winners : [undefined];
    for (const w of spots.slice(0, 4)) {
      const x = w?.x ?? 0, z = w?.z ?? 0;
      const c = w ? colorHex(w.color) : '#ffc93c';
      this.particles.emit({ x, y: 2.6, z, count, color: c, color2: '#ffc93c', speed: 2.6, up: 3.5, size: 0.3, life: 2.2, gravity: 3.2, shape: 1, drag: 0.9, spread: 0.6 });
      if (!this.reducedMotion) this.pops.spawn(x, 2.2, z, 1.3, c);
      this.mascots.get(w?.id ?? '')?.react('cheer');
    }
  }

  private addShake(amount: number): void {
    if (this.reducedMotion) return;
    this.shake = Math.min(0.25, this.shake + amount);
  }
}

export type { Quality } from './palette';
