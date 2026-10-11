import {
  BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, DoubleSide, Group, IcosahedronGeometry,
  InstancedMesh, Mesh, MeshStandardMaterial, Object3D, TubeGeometry, Vector3, type Texture,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ResolvedQuality } from './palette';
import { seeded } from './materials';
import { WATER_LEVEL } from './water';

function leaf(length: number, width: number, angle: number, x: number, y: number, z: number, hue: string): BufferGeometry {
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  const color = new Color(hue);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8, w = Math.sin(t * Math.PI) * width;
    for (const side of [-1, 0, 1]) {
      const across = side * w;
      const forward = t * length;
      positions.push(x + Math.cos(angle) * forward - Math.sin(angle) * across,
        y + Math.sin(t * Math.PI) * length * 0.16 - t * t * length * 0.25 + (side === 0 ? 0.085 : 0),
        z + Math.sin(angle) * forward + Math.cos(angle) * across);
      const light = side === 0 ? 1.08 : side < 0 ? 0.92 : 0.78;
      colors.push(color.r * light, color.g * light, color.b * light);
    }
  }
  for (let i = 0; i < 8; i++) for (let side = 0; side < 2; side++) {
    const a = i * 3 + side, b = a + 1, c = a + 3, d = a + 4;
    indices.push(a, b, c, b, d, c);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

/** A low-poly, handmade cove outside the playable radius. No scenery participates in physics. */
export class CoveScenery {
  readonly group = new Group();

  constructor(quality: ResolvedQuality, wood: Texture) {
    this.group.name = 'handcrafted-cove';
    const hi = quality === 'high';
    const random = seeded(2718), dummy = new Object3D(), color = new Color();
    const islands = [
      [-14.8, -8, 3.4, 2.2], [14, -9.5, 3.6, 2.4], [-16, 6.8, 4.0, 2.8], [16.5, 5.8, 3.4, 2.2], [0.8, -20, 6.4, 2.2],
    ];
    const sand = new InstancedMesh(new IcosahedronGeometry(1, hi ? 2 : 1), new MeshStandardMaterial({ color: '#cbb084', roughness: 1 }), islands.length);
    const stone = new InstancedMesh(new IcosahedronGeometry(1, hi ? 2 : 1), new MeshStandardMaterial({ roughness: 0.94, flatShading: true }), islands.length * 4);
    const shrubs = new InstancedMesh(new IcosahedronGeometry(1, 1), new MeshStandardMaterial({ roughness: 0.95, flatShading: true }), islands.length * 3);
    let rockIndex = 0, shrubIndex = 0;
    for (let i = 0; i < islands.length; i++) {
      const [x, z, sx, sz] = islands[i];
      dummy.position.set(x, WATER_LEVEL - 0.3, z); dummy.rotation.set(0, i * 0.65, 0); dummy.scale.set(sx, 0.63, sz);
      dummy.updateMatrix(); sand.setMatrixAt(i, dummy.matrix);
      for (let k = 0; k < 4; k++) {
        const px = x + (random() - 0.5) * sx, pz = z + (random() - 0.5) * sz;
        const s = 0.65 + random() * 1.15;
        dummy.position.set(px, WATER_LEVEL + s * 0.35, pz);
        dummy.rotation.set(random() * 0.4, random() * 6.28, random() * 0.3); dummy.scale.set(s * 1.2, s * 0.85, s);
        dummy.updateMatrix(); stone.setMatrixAt(rockIndex, dummy.matrix);
        stone.setColorAt(rockIndex++, color.set(['#767e68', '#8a826d', '#646f62', '#a69477'][k]));
      }
      for (let k = 0; k < 3; k++) {
        dummy.position.set(x + (random() - 0.5) * sx * 1.25, WATER_LEVEL + 0.4, z + (random() - 0.5) * sz);
        dummy.rotation.set(0.1, random() * 6.28, 0.2); dummy.scale.set(0.65 + random() * 0.3, 0.55 + random() * 0.25, 0.75);
        dummy.updateMatrix(); shrubs.setMatrixAt(shrubIndex, dummy.matrix);
        shrubs.setColorAt(shrubIndex++, color.set(['#426747', '#638252', '#33583e'][k]));
      }
    }
    this.group.add(sand, stone, shrubs);

    const trunks: BufferGeometry[] = [], leaves: BufferGeometry[] = [];
    for (const [i, island] of islands.entries()) {
      if (i === 4) continue;
      const [x, z] = island;
      const height = i < 2 ? 3.2 : 2.9, bend = x > 0 ? -0.75 : 0.75;
      const curve = new CatmullRomCurve3([
        new Vector3(x, WATER_LEVEL + 0.2, z), new Vector3(x + bend * 0.3, height * 0.45 - 1, z + 0.3),
        new Vector3(x + bend, height - 1, z + 0.45),
      ]);
      trunks.push(new TubeGeometry(curve, hi ? 12 : 8, 0.17, 6, false));
      for (let j = 0; j < 7; j++) leaves.push(leaf(2.1 + random() * 0.5, 0.4, j * Math.PI * 2 / 7 + i, x + bend, height - 0.9, z + 0.45, j % 2 ? '#65864c' : '#456d40'));
    }
    const trunkGeo = mergeGeometries(trunks, false)!;
    const leafGeo = mergeGeometries(leaves, false)!;
    trunks.forEach(g => g.dispose()); leaves.forEach(g => g.dispose());
    this.group.add(new Mesh(trunkGeo, new MeshStandardMaterial({ color: '#8a6845', map: wood, roughness: 0.9 })));
    const foliage = new Mesh(leafGeo, new MeshStandardMaterial({ vertexColors: true, roughness: 1, side: DoubleSide }));
    this.group.add(foliage);

    // A little weathered jetty supplies scale and a visual route into the cove.
    const boards = new InstancedMesh(new RoundedBoxGeometry(1, 1, 1, 1, 0.07), new MeshStandardMaterial({ map: wood, roughness: 0.85 }), 12);
    for (let i = 0; i < 12; i++) {
      dummy.position.set(-12.6, WATER_LEVEL + 0.38, -1.5 + i * 0.58);
      dummy.rotation.set(0, -0.18, (random() - 0.5) * 0.025); dummy.scale.set(2.3, 0.22, 0.52);
      dummy.updateMatrix(); boards.setMatrixAt(i, dummy.matrix);
    }
    this.group.add(boards);
  }
}
