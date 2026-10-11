import {
  CanvasTexture, CatmullRomCurve3, CylinderGeometry, DoubleSide, Group, InstancedMesh,
  LatheGeometry, Mesh, MeshStandardMaterial, Object3D, RepeatWrapping, SRGBColorSpace, SphereGeometry,
  TorusGeometry, TubeGeometry, Vector2, Vector3,
} from 'three';
import type { ArenaTheme, ResolvedQuality } from './palette';
import { LagoonWater, WATER_LEVEL } from './water';

function helix(radius: number, height: number, turns: number, tube: number, tubular: number, radial: number): TubeGeometry {
  const pts: Vector3[] = [];
  const n = Math.max(24, Math.round(turns * 16));
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = t * turns * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a) * radius, t * height, Math.sin(a) * radius));
  }
  return new TubeGeometry(new CatmullRomCurve3(pts), tubular, tube, radial, false);
}

function stripeTexture(a: string, b: string, stripes: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? b : a;
    ctx.fillRect(i * w, 0, w + 1, canvas.height);
    ctx.fillStyle = 'rgba(65,36,26,0.18)';
    ctx.fillRect(i * w, 0, 1.5, canvas.height);
    ctx.fillStyle = 'rgba(255,250,235,0.3)';
    ctx.fillRect(i * w + 2, 0, 1, canvas.height);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  return tex;
}

export class Stage {
  readonly group = new Group();
  readonly water: LagoonWater;
  private floats: { group: Group; y: number; phase: number }[] = [];
  private time = 0;

  constructor(theme: ArenaTheme, radius: number, quality: ResolvedQuality) {
    this.group.name = 'floating-stage';
    this.water = new LagoonWater(radius, quality);
    this.group.add(this.water.mesh);
    this.build(theme, radius, quality);
  }

  private build(theme: ArenaTheme, R: number, quality: ResolvedQuality): void {
    const hi = quality === 'high';
    const g = this.group;
    const rimTex = stripeTexture(theme.rimA, theme.rimB, 24);
    const rimMat = new MeshStandardMaterial({ map: rimTex, roughness: 0.32, metalness: 0.02 });
    const rim = new Mesh(new TorusGeometry(R + 0.36, 0.42, hi ? 20 : 12, hi ? 128 : 72), rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.scale.set(1, 1, 0.55);
    rim.position.y = 0.06;
    rim.castShadow = hi; rim.receiveShadow = true;
    g.add(rim);

    const frameMat = new MeshStandardMaterial({ color: theme.frame, roughness: 0.32, metalness: 0.12 });
    const frame = new Mesh(new CylinderGeometry(R + 0.72, R + 0.66, 0.42, hi ? 96 : 56, 1, true), frameMat);
    frame.position.y = -0.36;
    frame.material.side = DoubleSide;
    g.add(frame);
    const lip = new Mesh(new TorusGeometry(R + 0.7, 0.055, 8, hi ? 96 : 56), new MeshStandardMaterial({ color: theme.cream, roughness: 0.3 }));
    lip.rotation.x = -Math.PI / 2; lip.position.y = -0.57;
    g.add(lip);

    const springMat = new MeshStandardMaterial({ color: theme.spring, roughness: 0.28, metalness: 0.35 });
    const miniCount = hi ? 40 : 28;
    const mini = new InstancedMesh(helix(0.075, 0.25, 3.5, 0.02, hi ? 42 : 24, 5), springMat, miniCount);
    const dummy = new Object3D();
    for (let i = 0; i < miniCount; i++) {
      const a = (i / miniCount) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * (R + 0.42), -0.81, Math.sin(a) * (R + 0.42));
      dummy.updateMatrix(); mini.setMatrixAt(i, dummy.matrix);
    }
    g.add(mini);

    const profile = [[0, -0.91], [3.8, -0.89], [6.2, -0.85], [R + 0.4, -0.72], [R + 0.62, -0.69]];
    const curve = new CatmullRomCurve3(profile.map(([x, y]) => new Vector3(x, y, 0)));
    const points = curve.getPoints(hi ? 16 : 10).map(p => new Vector2(Math.max(0, p.x), p.y));
    const dish = new Mesh(new LatheGeometry(points, hi ? 72 : 40), new MeshStandardMaterial({ color: theme.dish, roughness: 0.38 }));
    g.add(dish);

    // A real inflatable pontoon replaces the tall springs and the foam pit.
    const pontoon = new Mesh(new TorusGeometry(R + 0.26, 0.64, hi ? 18 : 10, hi ? 112 : 64), new MeshStandardMaterial({ color: theme.rimB, roughness: 0.28, metalness: 0.02 }));
    pontoon.rotation.x = -Math.PI / 2;
    pontoon.scale.set(1, 1, 0.48);
    pontoon.position.y = -0.65;
    g.add(pontoon);
    const stripe = new Mesh(new TorusGeometry(R + 0.82, 0.06, 6, hi ? 112 : 64), new MeshStandardMaterial({ color: theme.accent, roughness: 0.4 }));
    stripe.rotation.x = -Math.PI / 2; stripe.position.y = -0.64;
    g.add(stripe);

    // Quiet scale cues outside the playing field. Shared geometry keeps the prop budget small.
    const floatGeo = new TorusGeometry(0.42, 0.13, hi ? 12 : 8, hi ? 32 : 20);
    const floatMat = new MeshStandardMaterial({ map: stripeTexture('#fff5dd', theme.accent, 8), roughness: 0.35 });
    const ballGeo = new SphereGeometry(0.17, hi ? 16 : 10, hi ? 10 : 6);
    const ballMat = new MeshStandardMaterial({ color: theme.spring, roughness: 0.3 });
    const locations = [[-11.2, 2.8, 1.1], [11, -1.8, 0.9], [-10, -8.7, 0.75], [10.5, 7.8, 0.8]];
    for (let i = 0; i < locations.length; i++) {
      const [x, z, scale] = locations[i];
      const prop = new Group();
      const ring = new Mesh(floatGeo, floatMat);
      ring.rotation.x = -Math.PI / 2;
      prop.add(ring);
      const ball = new Mesh(ballGeo, ballMat);
      ball.position.set(0.01, -0.015, 0.02); prop.add(ball);
      prop.position.set(x, WATER_LEVEL + 0.11, z);
      prop.rotation.y = i * 0.8;
      prop.scale.setScalar(scale);
      g.add(prop);
      this.floats.push({ group: prop, y: prop.position.y, phase: i * 1.7 });
    }
  }

  setMatchView(active: boolean): void { this.water.setMatchView(active); }
  splash(x: number, z: number, reducedMotion: boolean): void { this.water.splash(x, z, reducedMotion); }
  clear(): void { this.water.clear(); }

  update(dt: number, reducedMotion: boolean): void {
    this.water.update(dt, reducedMotion);
    if (reducedMotion) return;
    this.time += Math.max(0, Math.min(0.1, dt));
    for (const item of this.floats) {
      item.group.position.y = item.y + Math.sin(this.time * 1.2 + item.phase) * 0.045;
      item.group.rotation.x = Math.sin(this.time * 0.8 + item.phase) * 0.07;
      item.group.rotation.z = Math.cos(this.time * 0.7 + item.phase) * 0.06;
    }
  }
}
