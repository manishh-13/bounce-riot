import {
  CanvasTexture, CatmullRomCurve3, Color, CylinderGeometry, DoubleSide, Group, IcosahedronGeometry, InstancedMesh,
  LatheGeometry, Mesh, MeshStandardMaterial, Object3D, RepeatWrapping, SRGBColorSpace, TorusGeometry, TubeGeometry,
  Vector2, Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { ArenaTheme, ResolvedQuality } from './palette';

const FOAM_COLORS = ['#f88e6f', '#ffd05a', '#65cbaa', '#78a9ef', '#b28ae9', '#f5a1c8', '#f5dfb3'];

function helix(radius: number, height: number, turns: number, tube: number, tubular: number, radial: number): TubeGeometry {
  const pts: Vector3[] = [];
  const n = Math.max(24, Math.round(turns * 16));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = t * turns * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a) * radius, t * height, Math.sin(a) * radius));
  }
  return new TubeGeometry(new CatmullRomCurve3(pts), tubular, tube, radial, false);
}

function stripeTexture(a: string, b: string, stripes: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? b : a;
    ctx.fillRect(i * w, 0, w + 1, canvas.height);
    ctx.fillStyle = 'rgba(80,40,30,0.18)';
    ctx.fillRect(i * w, 0, 2, canvas.height);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  return tex;
}

export class Stage {
  readonly group = new Group();
  private clouds!: InstancedMesh;
  private foam!: InstancedMesh;
  private cloudBase: { x: number; y: number; z: number; s: number; phase: number }[] = [];
  private dummy = new Object3D();
  private time = 0;

  constructor(theme: ArenaTheme, radius: number, quality: ResolvedQuality) {
    this.group.name = 'stage';
    this.build(theme, radius, quality);
  }

  private build(theme: ArenaTheme, R: number, quality: ResolvedQuality): void {
    const hi = quality === 'high';
    const g = this.group;

    const rimTex = stripeTexture(theme.rimA, theme.rimB, 24);
    const rimMat = new MeshStandardMaterial({ map: rimTex, roughness: 0.46 });
    const rim = new Mesh(new TorusGeometry(R + 0.36, 0.42, hi ? 20 : 12, hi ? 128 : 72), rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.scale.set(1, 1, 0.55);
    rim.position.y = 0.06;
    rim.castShadow = hi; rim.receiveShadow = true;
    g.add(rim);

    const frameMat = new MeshStandardMaterial({ color: theme.frame, roughness: 0.45, metalness: 0.05 });
    const frame = new Mesh(new CylinderGeometry(R + 0.72, R + 0.66, 0.42, hi ? 96 : 56, 1, true), frameMat);
    frame.position.y = -0.36;
    frame.material.side = DoubleSide;
    g.add(frame);
    const lip = new Mesh(new TorusGeometry(R + 0.7, 0.07, 8, hi ? 96 : 56), new MeshStandardMaterial({ color: theme.rimB, roughness: 0.5 }));
    lip.rotation.x = -Math.PI / 2; lip.position.y = -0.58;
    g.add(lip);

    const springMat = new MeshStandardMaterial({ color: theme.spring, roughness: 0.32, metalness: 0.25 });
    const miniCount = hi ? 40 : 28;
    const mini = new InstancedMesh(helix(0.09, 0.42, 4, 0.025, hi ? 48 : 28, 5), springMat, miniCount);
    for (let i = 0; i < miniCount; i++) {
      const a = (i / miniCount) * Math.PI * 2;
      this.dummy.position.set(Math.cos(a) * (R + 0.45), -1.02, Math.sin(a) * (R + 0.45));
      this.dummy.rotation.set(0, 0, 0); this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      mini.setMatrixAt(i, this.dummy.matrix);
    }
    g.add(mini);

    const dishProfile: Vector2[] = [];
    const prof = [[0.0, -2.35], [1.6, -2.3], [3.4, -2.05], [5.2, -1.6], [6.6, -1.18], [R + 0.55, -1.05], [R + 0.72, -0.98]];
    const curve = new CatmullRomCurve3(prof.map(([x, y]) => new Vector3(x, y, 0)));
    for (const p of curve.getPoints(hi ? 24 : 14)) dishProfile.push(new Vector2(Math.max(0, p.x), p.y));
    const dishMat = new MeshStandardMaterial({ color: theme.dish, roughness: 0.7 });
    const dish = new Mesh(new LatheGeometry(dishProfile, hi ? 72 : 40), dishMat);
    g.add(dish);
    const band = new Mesh(new TorusGeometry(R + 0.62, 0.11, 8, hi ? 96 : 56), new MeshStandardMaterial({ color: theme.accent, roughness: 0.5 }));
    band.rotation.x = -Math.PI / 2; band.position.y = -1.04;
    g.add(band);

    const pillarCount = 6;
    const pillars = new InstancedMesh(helix(0.62, 9.8, 10, 0.12, hi ? 360 : 180, hi ? 8 : 5), springMat, pillarCount + 1);
    for (let i = 0; i <= pillarCount; i++) {
      const a = (i / pillarCount) * Math.PI * 2 + Math.PI / 6;
      const rr = i === pillarCount ? 0 : 4.4;
      this.dummy.position.set(Math.cos(a) * rr, -12, Math.sin(a) * rr);
      this.dummy.rotation.set(0, a, 0);
      this.dummy.scale.set(i === pillarCount ? 1.5 : 1, 1, i === pillarCount ? 1.5 : 1);
      this.dummy.updateMatrix();
      pillars.setMatrixAt(i, this.dummy.matrix);
    }
    g.add(pillars);

    const foamCount = hi ? 110 : 56;
    this.foam = new InstancedMesh(new RoundedBoxGeometry(1, 1, 1, hi ? 3 : 2, 0.22), new MeshStandardMaterial({ roughness: 0.9 }), foamCount);
    const col = new Color();
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < foamCount; i++) {
      const a = rnd() * Math.PI * 2, rr = 1.5 + Math.sqrt(rnd()) * 12;
      const s = 0.65 + rnd() * 0.5;
      this.dummy.position.set(Math.cos(a) * rr, -12.5 - rnd() * 1.5, Math.sin(a) * rr);
      this.dummy.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      this.foam.setMatrixAt(i, this.dummy.matrix);
      this.foam.setColorAt(i, col.set(FOAM_COLORS[i % FOAM_COLORS.length]));
    }
    g.add(this.foam);

    const puffs = hi ? 7 : 5;
    const clusters: [number, number, number, number][] = [
      [-15, -3.5, 2, 1.6], [15.5, -4, 1, 1.7], [-12, -6, 9, 1.3], [12, -6.5, 9, 1.2], [-18, -1, -8, 1.8],
      [18, -1.5, -7, 1.9], [-7, -0.5, -17, 1.7], [8, 0.2, -18, 2], [0, -2, -22, 2.2], [-20, -7, 13, 1.4], [20, -7.5, 13, 1.4],
    ];
    const used = hi ? clusters : clusters.slice(0, 8);
    this.clouds = new InstancedMesh(new IcosahedronGeometry(1, hi ? 3 : 2), new MeshStandardMaterial({ color: '#ffffff', roughness: 1, emissive: '#fff3e6', emissiveIntensity: 0.32 }), used.length * puffs);
    let k = 0;
    for (const [cx, cy, cz, cs] of used) {
      for (let p = 0; p < puffs; p++) {
        const t = p / (puffs - 1) - 0.5;
        const s = cs * (1.15 - Math.abs(t) * 1.1) * (0.85 + rnd() * 0.3);
        this.cloudBase.push({ x: cx + t * cs * 4.2, y: cy + s * 0.25 + rnd() * 0.3, z: cz + (rnd() - 0.5) * cs, s, phase: rnd() * 6.28 });
        k++;
      }
    }
    this.clouds.count = k;
    this.placeClouds(0);
    g.add(this.clouds);
  }

  private placeClouds(t: number): void {
    for (let i = 0; i < this.cloudBase.length; i++) {
      const c = this.cloudBase[i];
      this.dummy.position.set(c.x + Math.sin(t * 0.08 + c.phase) * 0.5, c.y + Math.sin(t * 0.3 + c.phase) * 0.08, c.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(c.s, c.s * 0.78, c.s);
      this.dummy.updateMatrix();
      this.clouds.setMatrixAt(i, this.dummy.matrix);
    }
    this.clouds.instanceMatrix.needsUpdate = true;
  }

  update(dt: number, reducedMotion: boolean): void {
    if (reducedMotion) return;
    this.time += dt;
    this.placeClouds(this.time);
  }
}
