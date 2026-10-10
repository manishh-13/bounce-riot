import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, DynamicDrawUsage, Mesh, NormalBlending,
  PlaneGeometry, Points, ShaderMaterial, SRGBColorSpace, Sprite, SpriteMaterial,
} from 'three';
import type { FloorField } from './floor';

export const PARTICLE_POOL = 360;

const P_VERT = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute float aAngle;
  attribute float aShape;
  attribute vec3 aColor;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAngle;
  varying float vShape;
  void main() {
    vColor = aColor; vAlpha = aAlpha; vAngle = aAngle; vShape = aShape;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = min(aSize * uScale / -mv.z, 96.0);
    gl_Position = projectionMatrix * mv;
  }`;
const P_FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAngle;
  varying float vShape;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float c = cos(vAngle), s = sin(vAngle);
    p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
    float a;
    vec3 col = vColor;
    if (vShape < 0.5) {
      float d = length(p);
      a = 1.0 - smoothstep(0.55, 1.0, d);
      col = mix(vColor, vec3(1.0), 0.25 * (1.0 - d));
    } else if (vShape < 1.5) {
      vec2 q = abs(p);
      a = (1.0 - smoothstep(0.75, 0.9, q.x)) * (1.0 - smoothstep(0.38, 0.5, q.y));
    } else {
      vec2 q = abs(p);
      float star = max(1.0 - smoothstep(0.08, 0.2, q.x) * 1.0 - q.y * 0.9, 1.0 - smoothstep(0.08, 0.2, q.y) - q.x * 0.9);
      a = clamp(star, 0.0, 1.0);
      col = mix(vColor, vec3(1.0), 0.2);
    }
    a *= vAlpha;
    if (a < 0.02) discard;
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }`;

export interface Burst {
  x: number; y: number; z: number; count: number; color: string; color2?: string; speed: number; up: number;
  size: number; life: number; gravity: number; shape: 0 | 1 | 2; spread?: number; drag?: number; ring?: boolean;
}

export class Particles {
  readonly points: Points;
  private geo = new BufferGeometry();
  private pos = new Float32Array(PARTICLE_POOL * 3);
  private vel = new Float32Array(PARTICLE_POOL * 3);
  private col = new Float32Array(PARTICLE_POOL * 3);
  private size = new Float32Array(PARTICLE_POOL);
  private baseSize = new Float32Array(PARTICLE_POOL);
  private alpha = new Float32Array(PARTICLE_POOL);
  private angle = new Float32Array(PARTICLE_POOL);
  private spin = new Float32Array(PARTICLE_POOL);
  private shape = new Float32Array(PARTICLE_POOL);
  private life = new Float32Array(PARTICLE_POOL);
  private maxLife = new Float32Array(PARTICLE_POOL);
  private grav = new Float32Array(PARTICLE_POOL);
  private drag = new Float32Array(PARTICLE_POOL);
  private live = 0;
  private cursor = 0;
  private material: ShaderMaterial;
  private tmp = new Color();
  private tmp2 = new Color();
  cap = PARTICLE_POOL;

  constructor() {
    const attr = (a: Float32Array, n: number) => { const b = new BufferAttribute(a, n); b.setUsage(DynamicDrawUsage); return b; };
    this.geo.setAttribute('position', attr(this.pos, 3));
    this.geo.setAttribute('aColor', attr(this.col, 3));
    this.geo.setAttribute('aSize', attr(this.size, 1));
    this.geo.setAttribute('aAlpha', attr(this.alpha, 1));
    this.geo.setAttribute('aAngle', attr(this.angle, 1));
    this.geo.setAttribute('aShape', attr(this.shape, 1));
    this.material = new ShaderMaterial({
      vertexShader: P_VERT, fragmentShader: P_FRAG, transparent: true, depthWrite: false, blending: NormalBlending,
      uniforms: { uScale: { value: 500 } },
    });
    this.points = new Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.geo.setDrawRange(0, 0);
  }

  setViewport(heightPx: number, fovDeg: number): void {
    this.material.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(b: Burst): void {
    const n = Math.min(b.count, this.cap);
    this.tmp.set(b.color);
    this.tmp2.set(b.color2 ?? b.color);
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.cap;
      if (this.life[i] <= 0) this.live++;
      const a = b.ring ? (k / n) * Math.PI * 2 + Math.random() * 0.3 : Math.random() * Math.PI * 2;
      const sp = b.speed * (b.ring ? 0.85 + Math.random() * 0.3 : 0.35 + Math.random() * 0.65);
      const spread = b.spread ?? 0.15;
      this.pos[i * 3] = b.x + Math.cos(a) * spread;
      this.pos[i * 3 + 1] = b.y;
      this.pos[i * 3 + 2] = b.z + Math.sin(a) * spread;
      this.vel[i * 3] = Math.cos(a) * sp;
      this.vel[i * 3 + 1] = b.up * (0.6 + Math.random() * 0.6);
      this.vel[i * 3 + 2] = Math.sin(a) * sp;
      const c = Math.random() < 0.5 ? this.tmp : this.tmp2;
      this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
      this.baseSize[i] = b.size * (0.7 + Math.random() * 0.6);
      this.angle[i] = Math.random() * 6.28;
      this.spin[i] = (Math.random() - 0.5) * (b.shape === 1 ? 14 : 3);
      this.shape[i] = b.shape;
      this.maxLife[i] = this.life[i] = b.life * (0.75 + Math.random() * 0.5);
      this.grav[i] = b.gravity;
      this.drag[i] = b.drag ?? 1.5;
    }
  }

  update(dt: number, field: FloorField): void {
    if (this.live <= 0) { this.geo.setDrawRange(0, 0); return; }
    let live = 0, maxIndex = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      live++; maxIndex = i + 1;
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const x = this.pos[i * 3], z = this.pos[i * 3 + 2];
      if (x * x + z * z < field.radius * field.radius) {
        const floor = field.height(x, z) + 0.05;
        if (this.pos[i * 3 + 1] < floor) { this.pos[i * 3 + 1] = floor; this.vel[i * 3 + 1] *= -0.3; this.vel[i * 3] *= 0.6; this.vel[i * 3 + 2] *= 0.6; }
      }
      this.angle[i] += this.spin[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(1, t * 3);
      this.size[i] = this.baseSize[i] * (this.shape[i] === 0 ? 0.6 + (1 - t) * 0.7 : 1);
    }
    this.live = live;
    this.geo.setDrawRange(0, maxIndex);
    for (const k of ['position', 'aColor', 'aSize', 'aAlpha', 'aAngle', 'aShape']) (this.geo.attributes[k] as BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0); this.alpha.fill(0); this.size.fill(0); this.live = 0; this.geo.setDrawRange(0, 0);
  }

  dispose(): void { this.geo.dispose(); this.material.dispose(); }
}

function starTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const spikes = 9;
  const path = (ro: number, ri: number) => {
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 ? ri : ro * (0.85 + ((i * 37) % 7) / 40);
      ctx.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
    }
    ctx.closePath();
  };
  ctx.lineJoin = 'round';
  path(60, 32); ctx.fillStyle = '#ffffff'; ctx.fill();
  path(50, 26); ctx.fillStyle = '#ffd84d'; ctx.fill();
  path(30, 16); ctx.fillStyle = '#fff6d2'; ctx.fill();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

interface Pop { sprite: Sprite; t: number; life: number; size: number; }

export class ImpactPops {
  private pool: Pop[] = [];
  private tex = starTexture();

  constructor(parent: { add: (o: Sprite) => void }, count = 6) {
    for (let i = 0; i < count; i++) {
      const sprite = new Sprite(new SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, depthTest: false }));
      sprite.visible = false;
      sprite.renderOrder = 8;
      parent.add(sprite);
      this.pool.push({ sprite, t: 0, life: 0, size: 1 });
    }
  }

  spawn(x: number, y: number, z: number, size: number, tint: string): void {
    const pop = this.pool.reduce((a, b) => (a.t / (a.life || 1) >= b.t / (b.life || 1) ? a : b));
    pop.sprite.position.set(x, y, z);
    pop.sprite.material.color.set(tint).lerp(new Color('#ffffff'), 0.6);
    pop.sprite.material.rotation = Math.random() * 0.6 - 0.3;
    pop.t = 0; pop.life = 0.42; pop.size = size;
    pop.sprite.visible = true;
  }

  update(dt: number, reducedMotion: boolean): void {
    for (const p of this.pool) {
      if (!p.sprite.visible) continue;
      p.t += dt;
      const k = p.t / p.life;
      if (k >= 1) { p.sprite.visible = false; continue; }
      const grow = reducedMotion ? 1 : k < 0.3 ? 0.4 + (k / 0.3) * 0.8 : 1.2 - (k - 0.3) * 0.3;
      p.sprite.scale.setScalar(p.size * grow);
      p.sprite.material.opacity = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    }
  }

  clear(): void { for (const p of this.pool) p.sprite.visible = false; }

  dispose(): void {
    for (const p of this.pool) { p.sprite.material.dispose(); p.sprite.removeFromParent(); }
    this.tex.dispose();
  }
}

const RING_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uT;
  uniform float uAlpha;
  uniform float uWarn;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float r = mix(mix(0.15, 0.95, uT), mix(0.95, 0.2, uT), uWarn);
    float ring = 1.0 - smoothstep(0.0, 0.06, abs(d - r));
    float fill = (1.0 - smoothstep(r - 0.02, r, d)) * 0.18;
    float stripes = step(0.5, fract(atan(vUv.y - 0.5, vUv.x - 0.5) * 2.546));
    float a = (ring * (0.6 + 0.4 * stripes) + fill) * uAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;
const RING_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

interface Ring { mesh: Mesh<PlaneGeometry, ShaderMaterial>; t: number; life: number; warn: boolean; }

// Flat warning rings for hazard aftershocks: drawn just above the membrane, not part of the height field.
export class WarningRings {
  private pool: Ring[] = [];
  private geo = new PlaneGeometry(1, 1);

  constructor(parent: { add: (o: Mesh) => void }, count = 3) {
    this.geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < count; i++) {
      const mat = new ShaderMaterial({
        vertexShader: RING_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false, blending: AdditiveBlending,
        uniforms: { uColor: { value: new Color('#ff7a3d') }, uT: { value: 0 }, uAlpha: { value: 0 }, uWarn: { value: 0 } },
      });
      const mesh = new Mesh(this.geo, mat);
      mesh.visible = false; mesh.renderOrder = 2;
      parent.add(mesh);
      this.pool.push({ mesh, t: 0, life: 1, warn: false });
    }
  }

  spawn(x: number, z: number, size: number, color: string, life = 1.1, warn = false): void {
    const r = this.pool.reduce((a, b) => (a.t / a.life >= b.t / b.life ? a : b));
    r.mesh.position.set(x, 0.12, z);
    r.mesh.scale.set(size * 2, 1, size * 2);
    r.mesh.material.uniforms.uColor.value.set(color);
    r.mesh.material.uniforms.uWarn.value = warn ? 1 : 0;
    r.t = 0; r.life = life; r.warn = warn; r.mesh.visible = true;
  }

  update(dt: number, field: FloorField): void {
    for (const r of this.pool) {
      if (!r.mesh.visible) continue;
      r.t += dt;
      const k = r.t / r.life;
      if (k >= 1) { r.mesh.visible = false; continue; }
      r.mesh.position.y = field.height(r.mesh.position.x, r.mesh.position.z) + 0.1;
      if (r.warn) {
        r.mesh.material.uniforms.uT.value = (k * 2) % 1;
        r.mesh.material.uniforms.uAlpha.value = 0.85 * Math.min(1, (1 - k) * 4);
      } else {
        r.mesh.material.uniforms.uT.value = 1 - Math.pow(1 - k, 2);
        r.mesh.material.uniforms.uAlpha.value = (1 - k) * 0.9;
      }
    }
  }

  clear(): void { for (const r of this.pool) r.mesh.visible = false; }

  dispose(): void {
    for (const r of this.pool) { r.mesh.material.dispose(); r.mesh.removeFromParent(); }
    this.geo.dispose();
  }
}
