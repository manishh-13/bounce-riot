import {
  BufferAttribute, BufferGeometry, CapsuleGeometry, CatmullRomCurve3, Color, ConeGeometry,
  CylinderGeometry, Group, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, ShaderMaterial,
  SphereGeometry, Sprite, SpriteMaterial, TorusGeometry, Vector2, Vector3, type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PlayerState } from '../game/types';
import { shade } from './palette';
import type { FloorField } from './floor';
import { clamp01 } from './floor';

export type Expression = 'happy' | 'determined' | 'surprised' | 'sad' | 'joy' | 'dizzy';
export type Reaction = 'hit' | 'ko' | 'ride' | 'cheer' | 'land';

const PROFILE: [number, number][] = [
  [0.0, 0.07], [0.27, 0.09], [0.42, 0.2], [0.485, 0.4], [0.48, 0.6], [0.44, 0.8], [0.34, 0.97], [0.18, 1.075], [0.0, 1.1],
];

function profileRadius(y: number): number {
  for (let i = 1; i < PROFILE.length; i++) {
    const [r0, y0] = PROFILE[i - 1], [r1, y1] = PROFILE[i];
    if (y <= y1) return r0 + ((y - y0) / (y1 - y0)) * (r1 - r0);
  }
  return 0;
}

function colored(geo: BufferGeometry, hex: string): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const c = new Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new BufferAttribute(arr, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

function onSurface(geo: BufferGeometry, theta: number, y: number, out = 0, tilt = 0): BufferGeometry {
  const r = profileRadius(y) + out;
  geo.applyMatrix4(new Matrix4().makeRotationX(-tilt));
  geo.applyMatrix4(new Matrix4().makeTranslation(0, 0, r));
  geo.applyMatrix4(new Matrix4().makeRotationY(theta));
  geo.applyMatrix4(new Matrix4().makeTranslation(0, y, 0));
  return geo;
}

function ellipsoid(sx: number, sy: number, sz: number, seg = 16): BufferGeometry {
  const g = new SphereGeometry(1, seg, Math.max(8, Math.round(seg * 0.7)));
  g.scale(sx, sy, sz);
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!m) throw new Error('Bounce Riot renderer: failed to build character geometry.');
  return m;
}

interface Shared {
  body: BufferGeometry; belly: BufferGeometry; eyes: BufferGeometry; cheeks: BufferGeometry; brow: BufferGeometry;
  smile: BufferGeometry; mouthO: BufferGeometry; arm: BufferGeometry; foot: BufferGeometry; crown: BufferGeometry;
  shield: BufferGeometry; accessories: BufferGeometry[]; vcMat: MeshStandardMaterial; cheekMat: MeshStandardMaterial;
  darkMat: MeshStandardMaterial; crownMat: MeshStandardMaterial;
}
let shared: Shared | null = null;
let sharedUsers = 0;

const EYE_THETA = 0.34;
const EYE_Y = 0.69;

function buildShared(hi: boolean): Shared {
  const seg = hi ? 40 : 24;
  const curve = new CatmullRomCurve3(PROFILE.map(([r, y]) => new Vector3(r, y, 0)));
  const pts = curve.getPoints(hi ? 30 : 18).map((p) => new Vector2(Math.max(0, p.x), p.y));
  const body = new LatheGeometry(pts, seg);
  body.computeVertexNormals();

  const belly = onSurface(ellipsoid(0.27, 0.25, 0.08, hi ? 20 : 12), 0, 0.36, -0.035, 0.12);

  const eyeParts: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const th = side * EYE_THETA;
    eyeParts.push(colored(onSurface(ellipsoid(0.085, 0.115, 0.05, hi ? 16 : 10), th, EYE_Y, -0.01), '#ffffff'));
    eyeParts.push(colored(onSurface(ellipsoid(0.058, 0.08, 0.035, hi ? 14 : 8), th * 0.9, EYE_Y - 0.012, 0.025), '#241a1a'));
    eyeParts.push(colored(onSurface(ellipsoid(0.022, 0.024, 0.012, 8), th * 0.78, EYE_Y + 0.03, 0.055), '#ffffff'));
  }
  const eyes = merge(eyeParts);
  // Eyes scale vertically for blinks, so the pivot must sit at eye height.
  eyes.translate(0, -EYE_Y, 0);

  const cheeks = merge([-1, 1].map((s) => onSurface(ellipsoid(0.06, 0.035, 0.02, 10), s * 0.62, 0.57, 0.0)));

  const brow = new CapsuleGeometry(0.024, 0.09, 4, 8);
  brow.rotateZ(Math.PI / 2);

  const smile = new TorusGeometry(0.065, 0.02, 6, 14, Math.PI);
  smile.rotateZ(Math.PI);
  const mouthO = ellipsoid(0.045, 0.055, 0.025, 12);

  const arm = new CapsuleGeometry(0.075, 0.13, 4, 10);
  arm.translate(0, -0.12, 0);
  const foot = ellipsoid(0.14, 0.085, 0.19, hi ? 16 : 10);
  foot.translate(0, 0.075, 0.035);

  const crownParts: BufferGeometry[] = [colored(new CylinderGeometry(0.2, 0.18, 0.12, 16, 1, true), '#ffc93c')];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spike = new ConeGeometry(0.055, 0.14, 6);
    spike.translate(Math.sin(a) * 0.18, 0.12, Math.cos(a) * 0.18);
    crownParts.push(colored(spike, '#ffc93c'));
    const gem = ellipsoid(0.028, 0.028, 0.028, 6);
    gem.translate(Math.sin(a) * 0.2, 0.02, Math.cos(a) * 0.2);
    crownParts.push(colored(gem, i % 2 ? '#ff5e7a' : '#5fb4ff'));
  }
  const crown = merge(crownParts);
  crown.translate(0, 1.13, 0);

  const shield = new SphereGeometry(0.82, hi ? 24 : 14, hi ? 16 : 10);
  shield.translate(0, 0.58, 0);

  return {
    body, belly, eyes, cheeks, brow, smile, mouthO, arm, foot, crown, shield,
    accessories: buildAccessories(hi),
    vcMat: new MeshStandardMaterial({ vertexColors: true, roughness: 0.38 }),
    cheekMat: new MeshStandardMaterial({ color: '#ff8f9c', roughness: 0.7, transparent: true, opacity: 0.75, depthWrite: false }),
    darkMat: new MeshStandardMaterial({ color: '#3a2324', roughness: 0.6 }),
    crownMat: new MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.45, emissive: '#7a4b00', emissiveIntensity: 0.25 }),
  };
}

function buildAccessories(hi: boolean): BufferGeometry[] {
  const s = hi ? 16 : 10;
  const top = 1.1;
  const out: BufferGeometry[] = [];
  {
    const band = new TorusGeometry(profileRadius(0.9) + 0.01, 0.045, 8, hi ? 32 : 20);
    band.rotateX(Math.PI / 2); band.translate(0, 0.9, 0);
    const stripe = new TorusGeometry(profileRadius(0.9) + 0.03, 0.018, 6, hi ? 32 : 20);
    stripe.rotateX(Math.PI / 2); stripe.translate(0, 0.9, 0);
    const tuft = new ConeGeometry(0.07, 0.2, 8); tuft.rotateZ(-0.4); tuft.translate(0.03, top + 0.06, 0);
    const tuft2 = new ConeGeometry(0.06, 0.16, 8); tuft2.rotateZ(0.5); tuft2.translate(-0.06, top + 0.03, 0.02);
    out.push(merge([colored(band, '#fffaf0'), colored(stripe, '#ff4b3a'), colored(tuft, '#c8392b'), colored(tuft2, '#c8392b')]));
  }
  {
    const dome = new SphereGeometry(0.36, s, s, 0, Math.PI * 2, 0, Math.PI / 2); dome.scale(1, 0.62, 1); dome.translate(0, 0.9, 0);
    const brim = new CylinderGeometry(0.26, 0.26, 0.03, s); brim.scale(1, 1, 0.75); brim.translate(0, 0.92, 0.32);
    const button = ellipsoid(0.04, 0.03, 0.04, 8); button.translate(0, 1.13, 0);
    out.push(merge([colored(dome, '#ffd23f'), colored(brim, '#ffb21f'), colored(button, '#2f5fd9')]));
  }
  {
    const cone = new ConeGeometry(0.17, 0.38, s); cone.rotateZ(-0.18); cone.translate(0.04, top + 0.14, 0);
    const pom = ellipsoid(0.065, 0.065, 0.065, 10); pom.translate(0.075, top + 0.34, 0);
    const ring = new TorusGeometry(0.15, 0.025, 6, s); ring.rotateX(Math.PI / 2); ring.translate(0.0, top - 0.02, 0);
    out.push(merge([colored(cone, '#ff6fa8'), colored(pom, '#ffffff'), colored(ring, '#ffffff')]));
  }
  {
    const parts: BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const ear = new ConeGeometry(0.12, 0.24, 4); ear.rotateY(Math.PI / 4); ear.scale(1, 1, 0.5); ear.rotateZ(-side * 0.45);
      ear.translate(side * 0.22, 1.02, 0);
      const inner = new ConeGeometry(0.065, 0.14, 4); inner.rotateY(Math.PI / 4); inner.scale(1, 1, 0.4); inner.rotateZ(-side * 0.45);
      inner.translate(side * 0.21, 1.0, 0.045);
      parts.push(colored(ear, '#8d63e8'), colored(inner, '#ffb6d0'));
    }
    out.push(merge(parts));
  }
  {
    const stem = new CylinderGeometry(0.018, 0.024, 0.16, 6); stem.translate(0, top + 0.06, 0);
    const leafA = ellipsoid(0.12, 0.03, 0.06, 10); leafA.rotateZ(0.5); leafA.translate(0.1, top + 0.16, 0);
    const leafB = ellipsoid(0.1, 0.028, 0.05, 10); leafB.rotateZ(-0.6); leafB.translate(-0.08, top + 0.13, 0);
    out.push(merge([colored(stem, '#3f9a5f'), colored(leafA, '#7fdc5a'), colored(leafB, '#62c447')]));
  }
  {
    const lobeA = new ConeGeometry(0.11, 0.18, 10); lobeA.rotateZ(Math.PI / 2); lobeA.translate(0.1, 0, 0);
    const lobeB = new ConeGeometry(0.11, 0.18, 10); lobeB.rotateZ(-Math.PI / 2); lobeB.translate(-0.1, 0, 0);
    const knot = ellipsoid(0.05, 0.05, 0.05, 8);
    const bow = merge([colored(lobeA, '#ff3f7f'), colored(lobeB, '#ff3f7f'), colored(knot, '#ffd1e3')]);
    bow.rotateZ(0.35); bow.translate(0.2, 1.02, 0.08);
    out.push(bow);
  }
  {
    const stem = new CylinderGeometry(0.015, 0.015, 0.24, 6); stem.rotateZ(0.15); stem.translate(-0.015, top + 0.1, 0);
    const ball = ellipsoid(0.065, 0.065, 0.065, 12); ball.translate(-0.035, top + 0.24, 0);
    const base = ellipsoid(0.05, 0.025, 0.05, 8); base.translate(0, top - 0.01, 0);
    out.push(merge([colored(stem, '#4a3a33'), colored(ball, '#3f8cff'), colored(base, '#4a3a33')]));
  }
  {
    const parts: BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const ear = ellipsoid(0.06, 0.2, 0.035, 12); ear.rotateZ(-side * 0.22); ear.translate(side * 0.13, top + 0.12, 0);
      const inner = ellipsoid(0.032, 0.14, 0.02, 10); inner.rotateZ(-side * 0.22); inner.translate(side * 0.13, top + 0.12, 0.022);
      parts.push(colored(ear, '#ffffff'), colored(inner, '#ffb0c4'));
    }
    out.push(merge(parts));
  }
  return out;
}

export function acquireShared(hi: boolean): Shared {
  if (!shared) shared = buildShared(hi);
  sharedUsers++;
  return shared;
}

export function releaseShared(): void {
  sharedUsers = Math.max(0, sharedUsers - 1);
  if (sharedUsers > 0 || !shared) return;
  const s = shared;
  shared = null;
  for (const g of [s.body, s.belly, s.eyes, s.cheeks, s.brow, s.smile, s.mouthO, s.arm, s.foot, s.crown, s.shield, ...s.accessories]) g.dispose();
  for (const m of [s.vcMat, s.cheekMat, s.darkMat, s.crownMat]) m.dispose();
}

const DECAL_VERT = /* glsl */`
  varying vec2 vP;
  void main() {
    vP = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const DECAL_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uFacing;
  uniform float uCharge;
  uniform float uShadow;
  uniform float uShadowA;
  uniform float uRingA;
  uniform float uWin;
  uniform float uTime;
  varying vec2 vP;
  float band(float d, float r, float w) { return 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.025, abs(d - r)); }
  void main() {
    float c = cos(uFacing), s = sin(uFacing);
    vec2 p = vec2(vP.x * c - vP.y * s, vP.x * s + vP.y * c);
    float d = length(p);
    vec4 col = vec4(0.0);
    float win = uWin * (1.0 - smoothstep(0.55, 1.2, d)) * (0.55 + 0.15 * sin(uTime * 3.0 - d * 6.0));
    col = mix(col, vec4(1.0, 0.86, 0.36, 1.0), win);
    float sh = (1.0 - smoothstep(uShadow * 0.35, uShadow, d)) * uShadowA;
    col.rgb = mix(col.rgb, vec3(0.16, 0.12, 0.2), sh / max(col.a + sh, 0.001));
    col.a = max(col.a, sh);
    // A dark keyline makes every player ring readable on all three fabrics.
    float keyline = band(d, 0.57, 0.16) * uRingA;
    col = mix(col, vec4(0.025, 0.07, 0.055, 1.0), keyline * 0.78);
    float ring = band(d, 0.56, 0.085) * uRingA;
    col = mix(col, vec4(uColor, 1.0), ring);
    float ang = atan(p.x, p.y);
    float fill = step(abs(ang), uCharge * 3.14159);
    float arc = band(d, 0.7, 0.11) * fill * step(0.01, uCharge);
    vec3 hot = mix(uColor, vec3(1.0, 0.97, 0.85), smoothstep(0.85, 1.0, uCharge) * 0.6);
    col = mix(col, vec4(hot, 1.0), arc * 0.95);
    vec2 q = p - vec2(0.0, 0.9);
    float tri = step(q.y, 0.0) * step(-0.17, q.y) * step(abs(q.x), (q.y + 0.17) * 1.25);
    float chevA = tri * (0.75 + 0.25 * uCharge) * uRingA;
    col = mix(col, vec4(uColor, 1.0), chevA);
    if (col.a < 0.01) discard;
    gl_FragColor = col;
    #include <colorspace_fragment>
  }`;

const SHIELD_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
    gl_FragColor = vec4(mix(vec3(1.0), uColor, 0.4), (0.06 + f * 0.6) * uAlpha);
    #include <colorspace_fragment>
  }`;
const SHIELD_VERT = /* glsl */`
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalMatrix * normal;
    vV = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

export interface MascotFrame {
  field: FloorField; dt: number; time: number; reducedMotion: boolean; phase: string; winner: boolean; loser: boolean;
  facing: number; shadowMap: boolean;
}

const DECAL_SIZE = 2.4;
const DECAL_SEG = 8;

export class Mascot {
  readonly root = new Group();
  readonly decal: Mesh;
  readonly badge: Sprite;
  private yaw = new Group();
  private squashG = new Group();
  private tiltG = new Group();
  private bodyMat: MeshStandardMaterial;
  private bellyMat: MeshStandardMaterial;
  private limbMat: MeshStandardMaterial;
  private footMat: MeshStandardMaterial;
  private browMat: MeshStandardMaterial;
  private eyes: Mesh;
  private browL: Mesh;
  private browR: Mesh;
  private smile: Mesh;
  private mouthO: Mesh;
  private armL = new Group();
  private armR = new Group();
  private footL: Mesh;
  private footR: Mesh;
  private crown: Mesh;
  private shield: Mesh;
  private decalMat: ShaderMaterial;
  private shieldMat: ShaderMaterial;
  private colorHex = '';
  private squash = 0;
  private squashVel = 0;
  private prevGrounded = true;
  private prevVy = 0;
  private walk = 0;
  private yawNow = 0;
  private blinkIn = 2 + Math.random() * 3;
  private blinkT = 0;
  private reactKind: Reaction | null = null;
  private reactT = 0;
  private seed = Math.random() * 10;
  private visibleScale = 0;
  feetY = 0;
  topY = 1.2;

  constructor(private sh: Shared, color: string, slot: number) {
    this.bodyMat = new MeshStandardMaterial({ roughness: 0.34 });
    // Shape the silhouette in the existing material, without an outline pass or extra mesh.
    this.bodyMat.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        float facing = abs(dot(normalize(normal), normalize(vViewPosition)));
        outgoingLight *= mix(0.64, 1.0, smoothstep(0.06, 0.55, facing));
        #include <opaque_fragment>`);
    };
    this.bellyMat = new MeshStandardMaterial({ roughness: 0.55 });
    this.limbMat = new MeshStandardMaterial({ roughness: 0.45 });
    this.footMat = new MeshStandardMaterial({ roughness: 0.5 });
    this.browMat = new MeshStandardMaterial({ roughness: 0.6 });
    this.setColor(color);

    const cast = <T extends Mesh>(m: T, c = true) => { m.castShadow = c; return m; };
    this.root.add(this.yaw);
    this.yaw.add(this.tiltG);
    this.tiltG.add(this.squashG);
    this.squashG.add(cast(new Mesh(sh.body, this.bodyMat)));
    this.squashG.add(new Mesh(sh.belly, this.bellyMat));
    this.eyes = new Mesh(sh.eyes, sh.vcMat);
    this.eyes.position.y = EYE_Y;
    this.squashG.add(this.eyes);
    this.squashG.add(new Mesh(sh.cheeks, sh.cheekMat));
    const browAt = (side: number) => {
      const holder = new Group();
      const th = side * EYE_THETA * 0.95, y = EYE_Y + 0.15;
      const r = profileRadius(y) + 0.005;
      holder.position.set(Math.sin(th) * r, y, Math.cos(th) * r);
      holder.rotation.y = th;
      const m = new Mesh(sh.brow, this.browMat);
      holder.add(m);
      this.squashG.add(holder);
      return m;
    };
    this.browL = browAt(-1);
    this.browR = browAt(1);
    const mouthY = 0.53, mr = profileRadius(mouthY);
    this.smile = new Mesh(sh.smile, sh.darkMat);
    this.smile.position.set(0, mouthY, mr - 0.005);
    this.smile.rotation.x = -0.15;
    this.mouthO = new Mesh(sh.mouthO, sh.darkMat);
    this.mouthO.position.set(0, mouthY - 0.01, mr - 0.01);
    this.mouthO.visible = false;
    this.squashG.add(this.smile, this.mouthO);
    for (const [arm, side] of [[this.armL, -1], [this.armR, 1]] as const) {
      arm.position.set(side * 0.43, 0.5, 0.02);
      arm.add(cast(new Mesh(sh.arm, this.limbMat)));
      this.squashG.add(arm);
    }
    const acc = new Mesh(sh.accessories[slot % sh.accessories.length], sh.vcMat);
    acc.castShadow = true;
    this.squashG.add(acc);
    this.crown = new Mesh(sh.crown, sh.crownMat);
    this.crown.visible = false;
    this.squashG.add(this.crown);
    this.footL = cast(new Mesh(sh.foot, this.footMat));
    this.footR = cast(new Mesh(sh.foot, this.footMat));
    this.footL.position.x = -0.18; this.footR.position.x = 0.18;
    this.yaw.add(this.footL, this.footR);

    this.shieldMat = new ShaderMaterial({
      vertexShader: SHIELD_VERT, fragmentShader: SHIELD_FRAG, transparent: true, depthWrite: false,
      uniforms: { uColor: { value: new Color(color) }, uAlpha: { value: 0 } },
    });
    this.shield = new Mesh(sh.shield, this.shieldMat);
    this.shield.visible = false;
    this.shield.renderOrder = 3;
    this.root.add(this.shield);

    this.decalMat = new ShaderMaterial({
      vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      uniforms: {
        uColor: { value: new Color(color) }, uFacing: { value: 0 }, uCharge: { value: 0 }, uShadow: { value: 0.5 },
        uShadowA: { value: 0.4 }, uRingA: { value: 1 }, uWin: { value: 0 }, uTime: { value: 0 },
      },
    });
    const dg = new PlaneGeometry(DECAL_SIZE, DECAL_SIZE, DECAL_SEG, DECAL_SEG);
    dg.rotateX(-Math.PI / 2);
    dg.deleteAttribute('normal'); dg.deleteAttribute('uv');
    this.decal = new Mesh(dg, this.decalMat);
    this.decal.renderOrder = 1;
    this.decal.frustumCulled = false;

    this.badge = new Sprite(new SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
    this.badge.renderOrder = 10;
    this.badge.center.set(0.5, 0);
  }

  setColor(color: string): void {
    if (color === this.colorHex) return;
    this.colorHex = color;
    this.bodyMat.color.set(color);
    this.limbMat.color.copy(shade(color, 0.04));
    this.bellyMat.color.copy(shade(color, 0.2)).lerp(new Color('#fff4e0'), 0.55);
    this.footMat.color.copy(shade(color, -0.2));
    this.browMat.color.copy(shade(color, -0.32));
    (this.decalMat?.uniforms.uColor.value as Color | undefined)?.set(color);
    (this.shieldMat?.uniforms.uColor.value as Color | undefined)?.set(color);
  }

  setBadge(tex: Texture, aspect: number): void {
    const m = this.badge.material;
    if (m.map !== tex) { m.map = tex; m.needsUpdate = true; }
    this.badge.scale.set(0.63 * aspect, 0.63, 1);
  }

  react(kind: Reaction): void {
    this.reactKind = kind;
    this.reactT = kind === 'ko' ? 1.1 : kind === 'cheer' ? 1.6 : 0.7;
    if (kind === 'hit') this.squashVel -= 3;
    if (kind === 'ride') this.squashVel += 2.5;
    if (kind === 'land') this.squashVel -= 2.4;
  }

  update(p: PlayerState, f: MascotFrame): void {
    const dt = f.dt;
    const hidden = p.respawnIn > 0;
    this.visibleScale += ((hidden ? 0 : 1) - this.visibleScale) * Math.min(1, dt * (hidden ? 18 : 10));
    const vis = this.visibleScale > 0.02;
    this.root.visible = vis; this.decal.visible = vis; this.badge.visible = vis;
    if (!vis) { this.prevGrounded = true; this.squash = 0; this.squashVel = 0; return; }

    const charge = clamp01(p.charge);
    const speed = Math.hypot(p.vx, p.vz);
    const inside = p.x * p.x + p.z * p.z < f.field.radius * f.field.radius;
    const floorH = inside ? f.field.height(p.x, p.z) : 0;
    let feet = p.grounded ? floorH : p.y + floorH * clamp01(1 - p.y / 1.2);
    let hop = 0;
    if (f.winner && f.phase === 'results' && !f.reducedMotion) hop = Math.abs(Math.sin(f.time * 4.2 + this.seed)) * 0.55;
    feet += hop;
    this.feetY = feet;

    if (p.grounded && !this.prevGrounded) this.squashVel -= Math.min(1, Math.abs(this.prevVy) / 9) * 5 + 0.8;
    if (!p.grounded && this.prevGrounded) this.squashVel += 3;
    this.prevGrounded = p.grounded;
    this.prevVy = p.vy;

    let target = 0;
    if (p.grounded) target = -0.34 * charge;
    else target = Math.min(0.22, Math.abs(p.vy) * 0.022);
    if (p.slamming) target = 0.3;
    if (f.phase === 'lobby' || f.phase === 'results') target += f.reducedMotion ? 0 : Math.sin(f.time * 2.3 + this.seed) * 0.025;
    const k = 170, c = 13;
    this.squashVel += (-(this.squash - target) * k - this.squashVel * c) * dt;
    this.squash += this.squashVel * dt;
    this.squash = Math.max(-0.45, Math.min(0.4, this.squash));
    const sy = 1 + this.squash, sxz = 1 - this.squash * 0.55;
    const vs = this.visibleScale;
    this.squashG.scale.set(sxz * vs, sy * vs, sxz * vs);

    let diff = f.facing - this.yawNow;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.yawNow += diff * Math.min(1, dt * 12);
    this.yaw.rotation.y = this.yawNow;

    const moveAmt = Math.min(1, speed / 3.5);
    if (p.grounded) this.walk += dt * (4 + speed * 3.2) * (moveAmt > 0.05 ? 1 : 0);
    const sw = Math.sin(this.walk);
    const bob = p.grounded ? Math.abs(sw) * 0.035 * moveAmt : 0;
    this.tiltG.position.y = bob;
    let lean = Math.min(0.22, speed * 0.04) + charge * 0.16;
    if (p.slamming) lean = -0.1;
    this.tiltG.rotation.x += (lean - this.tiltG.rotation.x) * Math.min(1, dt * 10);
    let roll = 0;
    if (p.hitFlash > 0) roll = f.reducedMotion ? 0.08 : Math.sin(f.time * 28) * 0.18 * clamp01(p.hitFlash * 2);
    const falling = !inside && p.y < -0.3;
    if (falling && !f.reducedMotion) roll = Math.sin(f.time * 9) * 0.5;
    if (charge >= 0.98 && !f.reducedMotion) roll += Math.sin(f.time * 47) * 0.025;
    this.tiltG.rotation.z = roll;

    const footLift = p.grounded ? 1 : 0;
    this.footL.position.set(-0.18, footLift * Math.max(0, sw) * 0.07 * moveAmt + (p.grounded ? 0 : 0.05), sw * 0.12 * moveAmt);
    this.footR.position.set(0.18, footLift * Math.max(0, -sw) * 0.07 * moveAmt + (p.grounded ? 0 : 0.05), -sw * 0.12 * moveAmt);
    const footSquash = 1 - Math.min(0, this.squash) * 0.6;
    this.footL.scale.set(footSquash, 1, 1); this.footR.scale.set(footSquash, 1, 1);

    if (this.reactT > 0) this.reactT -= dt;
    const reacting = this.reactT > 0 ? this.reactKind : null;
    let expr: Expression = 'happy';
    let armsUp = 0;
    if (charge > 0.05) { expr = 'determined'; armsUp = -0.35 * charge; }
    if (!p.grounded) { armsUp = 0.55 + Math.min(0.5, Math.max(0, p.vy) * 0.05); if (p.vy < -6) expr = 'surprised'; }
    if (p.slamming) { expr = 'determined'; armsUp = 1.0; }
    if (p.hitFlash > 0 || reacting === 'hit') expr = 'surprised';
    if (falling) { expr = 'dizzy'; armsUp = 1.1 + Math.sin(f.time * 14) * (f.reducedMotion ? 0 : 0.4); }
    if (reacting === 'ride' || reacting === 'ko' || reacting === 'cheer') { expr = 'joy'; armsUp = 1.15; }
    if (f.phase === 'results') {
      if (f.winner) { expr = 'joy'; armsUp = 1.2 + (f.reducedMotion ? 0 : Math.sin(f.time * 8 + this.seed) * 0.25); }
      else if (f.loser) expr = 'sad';
    }
    this.applyExpression(expr, f);

    const swing = p.grounded ? sw * 0.5 * moveAmt : 0;
    const base = 0.32 + armsUp * 2.1;
    this.armL.rotation.set(swing, 0, -base);
    this.armR.rotation.set(-swing, 0, base);

    this.crown.visible = f.winner && f.phase === 'results';
    const flash = clamp01(p.hitFlash * 2.5);
    const glow = charge * (f.reducedMotion ? 0.3 : 0.25 + 0.12 * Math.sin(f.time * 10));
    this.bodyMat.emissive.set(this.colorHex).multiplyScalar(glow).lerp(new Color(1, 1, 1), flash * 0.5);
    this.limbMat.emissive.copy(this.bodyMat.emissive);

    const inv = p.invincible > 0;
    this.shield.visible = inv;
    if (inv) this.shieldMat.uniforms.uAlpha.value = clamp01(p.invincible * 2) * (f.reducedMotion ? 0.8 : 0.7 + 0.3 * Math.sin(f.time * 5));

    this.root.position.set(p.x, feet, p.z);
    this.topY = feet + 1.12 * sy + (this.crown.visible ? 0.3 : 0.18);
    this.badge.position.set(p.x, this.topY + 0.19, p.z);
    (this.badge.material as SpriteMaterial).opacity = p.connected === false ? 0.6 : 1;

    this.updateDecal(p, f, floorH, inside, charge);
  }

  private applyExpression(expr: Expression, f: MascotFrame): void {
    let brow = 0, browY = 0;
    let mouthO = false, smileScale = 1, frown = false;
    let eyeY = 1;
    if (expr === 'determined') { brow = 0.45; browY = -0.015; smileScale = 0.65; }
    else if (expr === 'surprised') { brow = -0.25; browY = 0.035; mouthO = true; eyeY = 1.12; }
    else if (expr === 'sad') { brow = -0.4; frown = true; smileScale = 0.8; eyeY = 0.85; }
    else if (expr === 'joy') { brow = -0.15; browY = 0.03; smileScale = 1.35; eyeY = 0.45; }
    else if (expr === 'dizzy') { brow = -0.35; browY = 0.04; mouthO = true; eyeY = 1.15; }
    this.blinkIn -= f.dt;
    if (this.blinkIn <= 0) { this.blinkT = 0.13; this.blinkIn = 2.2 + Math.random() * 3.5; }
    if (this.blinkT > 0) { this.blinkT -= f.dt; eyeY = Math.min(eyeY, 0.12); }
    this.eyes.scale.y += (eyeY - this.eyes.scale.y) * Math.min(1, f.dt * 20);
    this.browR.rotation.z = brow; this.browL.rotation.z = -brow;
    this.browR.position.y = browY; this.browL.position.y = browY;
    this.mouthO.visible = mouthO;
    this.smile.visible = !mouthO;
    this.smile.scale.set(smileScale, frown ? -smileScale * 0.8 : smileScale, 1);
  }

  private updateDecal(p: PlayerState, f: MascotFrame, floorH: number, inside: boolean, charge: number): void {
    const u = this.decalMat.uniforms;
    const height = Math.max(0, this.feetY - floorH);
    this.decal.visible = inside && this.root.visible;
    if (!this.decal.visible) return;
    u.uFacing.value = this.yawNow;
    u.uCharge.value = charge;
    u.uShadow.value = 0.5 + height * 0.12;
    u.uShadowA.value = (f.shadowMap ? 0.3 : 0.48) * Math.max(0.15, 1 - height / 4);
    u.uRingA.value = p.connected === false ? 0.4 : 1;
    u.uWin.value = f.winner && f.phase === 'results' ? 1 : 0;
    u.uTime.value = f.time;
    this.decal.position.set(p.x, 0, p.z);
    const pos = this.decal.geometry.attributes.position as BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < pos.count; i++) arr[i * 3 + 1] = f.field.height(p.x + arr[i * 3], p.z + arr[i * 3 + 2]) + 0.025;
    pos.needsUpdate = true;
  }

  dispose(): void {
    for (const m of [this.bodyMat, this.bellyMat, this.limbMat, this.footMat, this.browMat, this.decalMat, this.shieldMat, this.badge.material]) m.dispose();
    this.decal.geometry.dispose();
    this.root.removeFromParent(); this.decal.removeFromParent(); this.badge.removeFromParent();
  }
}
