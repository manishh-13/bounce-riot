import { describe, expect, it } from 'vitest';
import { Box3, BufferGeometry, InstancedMesh, Matrix4, Mesh, Texture, Vector3, type Material } from 'three';
import { CoveScenery } from '../../src/render/cove';
import { seeded } from '../../src/render/materials';

describe('handcrafted cove', () => {
  it('uses seeded paint and scenery, never simulation randomness', () => {
    const a = seeded(2718), b = seeded(2718), c = seeded(17);
    const first = Array.from({ length: 200 }, a);
    expect(first).toEqual(Array.from({ length: 200 }, b));
    expect(first).not.toEqual(Array.from({ length: 200 }, c));
    expect(first.every(v => v >= 0 && v < 1 && Number.isFinite(v))).toBe(true);
  });

  for (const quality of ['low', 'high'] as const) {
    it(`${quality} builds six batched scenery draws with finite geometry outside the playable ring`, () => {
      const wood = new Texture();
      const scenery = new CoveScenery(quality, wood);
      const meshes = scenery.group.children as Mesh[];
      expect(meshes).toHaveLength(6);
      scenery.group.updateMatrixWorld(true);
      let triangles = 0;
      const transform = new Matrix4(), world = new Vector3();
      for (const mesh of meshes) {
        const g = mesh.geometry as BufferGeometry;
        const pos = g.getAttribute('position');
        for (let i = 0; i < pos.count; i++) expect([pos.getX(i), pos.getY(i), pos.getZ(i)].every(Number.isFinite)).toBe(true);
        const count = mesh instanceof InstancedMesh ? mesh.count : 1;
        triangles += (g.getIndex()?.count ?? pos.count) / 3 * count;
        g.computeBoundingBox();
        for (let instance = 0; instance < count; instance++) {
          if (mesh instanceof InstancedMesh) mesh.getMatrixAt(instance, transform); else transform.identity();
          for (let i = 0; i < pos.count; i++) {
            world.fromBufferAttribute(pos, i).applyMatrix4(transform).applyMatrix4(mesh.matrixWorld);
            expect(Math.hypot(world.x, world.z)).toBeGreaterThan(8.4);
          }
        }
      }
      expect(triangles).toBeLessThan(quality === 'low' ? 12_000 : 20_000);
      const bounds = new Box3().setFromObject(scenery.group);
      expect(bounds.min.x).toBeLessThan(-10);
      expect(bounds.max.x).toBeGreaterThan(10);
      const geometries = new Set<BufferGeometry>(), materials = new Set<Material>();
      for (const mesh of meshes) { geometries.add(mesh.geometry); (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(m => materials.add(m)); }
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); wood.dispose();
    });
  }
});
