import {
  BufferAttribute, BufferGeometry, CanvasTexture, CatmullRomCurve3, CylinderGeometry, DoubleSide, Group, InstancedMesh,
  Mesh, MeshStandardMaterial, Object3D, RingGeometry, SphereGeometry, TorusGeometry, TubeGeometry, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ArenaTheme, ResolvedQuality } from './palette';
import { LagoonWater, WATER_LEVEL } from './water';
import { CoveScenery } from './cove';
import { woodTexture } from './materials';

function helix(radius: number, height: number, turns: number, tube: number, tubular: number, radial: number): TubeGeometry {
  const points: Vector3[] = [];
  const count = Math.max(24, Math.round(turns * 16));
  for (let i = 0; i <= count; i++) {
    const t = i / count, angle = t * turns * Math.PI * 2;
    points.push(new Vector3(Math.cos(angle) * radius, t * height, Math.sin(angle) * radius));
  }
  return new TubeGeometry(new CatmullRomCurve3(points), tubular, tube, radial, false);
}

/** Separate wooden staves, merged into one draw. The original playing radius stays untouched. */
function woodenRim(radius: number, high: boolean): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const count = 24, angle = Math.PI * 2 / count;
  for (let i = 0; i < count; i++) {
    const start = i * angle + 0.0025;
    const geometry = new RingGeometry(radius + 0.03, radius + 0.77, high ? 6 : 4, 1, start, angle - 0.005);
    geometry.rotateX(-Math.PI / 2);
    const pos = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
    const colors = new Float32Array(pos.count * 3);
    const shade = 0.88 + (i * 17 % 11) / 55;
    for (let p = 0; p < pos.count; p++) {
      const x = pos.getX(p), z = pos.getZ(p), distance = Math.hypot(x, z);
      const a = Math.atan2(-z, x);
      const local = ((a - start + Math.PI * 4) % (Math.PI * 2)) / angle;
      uv.setXY(p, local, (distance - radius) / 0.8);
      colors[p * 3] = colors[p * 3 + 1] = colors[p * 3 + 2] = shade;
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    parts.push(geometry);
  }
  const geometry = mergeGeometries(parts, false)!;
  parts.forEach(part => part.dispose());
  return geometry;
}

export class Stage {
  readonly group = new Group();
  readonly water: LagoonWater;
  private floats: { group: Group; y: number; phase: number }[] = [];
  private time = 0;

  constructor(theme: ArenaTheme, radius: number, quality: ResolvedQuality) {
    this.group.name = 'handcrafted-stage';
    this.water = new LagoonWater(radius, quality);
    this.group.add(this.water.mesh);
    const wood = woodTexture(quality === 'high' ? 512 : 256);
    this.build(theme, radius, quality, wood);
    this.group.add(new CoveScenery(quality, wood).group);
  }

  private build(theme: ArenaTheme, radius: number, quality: ResolvedQuality, wood: CanvasTexture): void {
    const high = quality === 'high';
    const group = this.group, dummy = new Object3D();
    const rim = new Mesh(woodenRim(radius, high), new MeshStandardMaterial({ map: wood, vertexColors: true, roughness: 0.8 }));
    rim.position.y = 0.03; rim.receiveShadow = true;
    rim.name = 'wooden-arena-rim';
    group.add(rim);

    const frame = new Mesh(new CylinderGeometry(radius + 0.74, radius + 0.66, 0.58, high ? 96 : 64, 1, true), new MeshStandardMaterial({ map: wood, color: '#b99b71', roughness: 0.87, side: DoubleSide }));
    frame.position.y = -0.3; frame.name = 'wooden-arena-frame'; group.add(frame);
    const rope = new Mesh(new TorusGeometry(radius + 0.75, 0.075, 6, high ? 112 : 72), new MeshStandardMaterial({ color: '#e4cca2', roughness: 1 }));
    rope.rotation.x = -Math.PI / 2; rope.position.y = 0.005; group.add(rope);
    const lip = new Mesh(new TorusGeometry(radius + 0.68, 0.055, 6, high ? 96 : 64), new MeshStandardMaterial({ color: '#72513a', roughness: 0.88 }));
    lip.rotation.x = -Math.PI / 2; lip.position.y = -0.59; group.add(lip);

    const hardware = new MeshStandardMaterial({ color: '#6b7770', roughness: 0.49, metalness: 0.3 });
    const bolts = new InstancedMesh(new CylinderGeometry(0.065, 0.065, 0.028, 6), hardware, 24);
    for (let i = 0; i < 24; i++) {
      const angle = (i + 0.5) * Math.PI / 12;
      dummy.position.set(Math.cos(angle) * (radius + 0.52), 0.06, Math.sin(angle) * (radius + 0.52));
      dummy.rotation.set(0, angle, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); bolts.setMatrixAt(i, dummy.matrix);
    }
    group.add(bolts);

    const springCount = high ? 32 : 24;
    const springs = new InstancedMesh(helix(0.07, 0.22, 3.5, 0.018, high ? 36 : 22, 5), hardware, springCount);
    for (let i = 0; i < springCount; i++) {
      const angle = i * Math.PI * 2 / springCount;
      dummy.position.set(Math.cos(angle) * (radius + 0.35), -0.84, Math.sin(angle) * (radius + 0.35));
      dummy.rotation.set(0, angle, 0); dummy.updateMatrix(); springs.setMatrixAt(i, dummy.matrix);
    }
    group.add(springs);

    const float = new Mesh(new TorusGeometry(radius + 0.19, 0.51, high ? 14 : 9, high ? 112 : 72), new MeshStandardMaterial({ color: theme.frame, roughness: 0.78 }));
    float.rotation.x = -Math.PI / 2; float.scale.set(1, 1, 0.56); float.position.y = -0.71; group.add(float);

    const buoyGeometry = new SphereGeometry(0.2, high ? 16 : 10, high ? 10 : 6);
    const buoyMaterial = new MeshStandardMaterial({ color: '#dfaa59', roughness: 0.7 });
    const ringGeometry = new TorusGeometry(0.43, 0.115, high ? 12 : 8, high ? 32 : 20);
    const ringMaterial = new MeshStandardMaterial({ color: theme.accent, roughness: 0.73 });
    for (const [i, [x, z]] of [[-9.9, 5], [10.9, -5]].entries()) {
      const prop = new Group();
      const ring = new Mesh(ringGeometry, ringMaterial); ring.rotation.x = -Math.PI / 2; prop.add(ring);
      const buoy = new Mesh(buoyGeometry, buoyMaterial); prop.add(buoy);
      prop.position.set(x, WATER_LEVEL + 0.12, z); group.add(prop);
      this.floats.push({ group: prop, y: prop.position.y, phase: i * 1.7 });
    }
  }

  splash(x: number, z: number, reducedMotion: boolean): void { this.water.splash(x, z, reducedMotion); }
  clear(): void { this.water.clear(); }

  update(dt: number, reducedMotion: boolean): void {
    this.water.update(dt, reducedMotion);
    if (reducedMotion) return;
    this.time += Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    for (const item of this.floats) {
      item.group.position.y = item.y + Math.sin(this.time * 1.2 + item.phase) * 0.035;
      item.group.rotation.x = Math.sin(this.time * 0.8 + item.phase) * 0.06;
      item.group.rotation.z = Math.cos(this.time * 0.7 + item.phase) * 0.05;
    }
  }
}
