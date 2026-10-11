import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3, type Vector4 } from 'three';
import { LagoonWater, SPLASH_LIMIT, WATER_LEVEL } from '../../src/render/water';
import { frameArena } from '../../src/render/framing';

function free(water: LagoonWater): void { water.mesh.geometry.dispose(); water.material.dispose(); }

describe('lagoon water', () => {
  it('is a single two-triangle surface below the playing field, without a browser or remote textures', () => {
    const water = new LagoonWater(7.1, 'low');
    expect(water.mesh.name).toBe('lagoon-water');
    expect(water.mesh.position.y).toBe(WATER_LEVEL);
    expect(WATER_LEVEL).toBeLessThan(-1);
    expect(water.mesh.geometry.getIndex()!.count).toBe(6);
    expect(water.material.toneMapped).toBe(false);
    expect(water.material.defines.HIGH_WATER).toBe(0);
    expect(water.material.uniforms.uRadius.value).toBe(7.1);
    // The full-screen cove is opaque and occludes props or players below the surface.
    expect(water.material.transparent).toBe(false);
    expect(water.material.depthWrite).toBe(true);
    expect(water.material.uniforms).not.toHaveProperty('uFull');
    free(water);
  });

  it('caps time increments, ignores invalid values and freezes decorations for reduced motion', () => {
    const water = new LagoonWater(7.1, 'high');
    expect(water.material.defines.HIGH_WATER).toBe(1);
    water.update(0.025, false);
    expect(water.material.uniforms.uTime.value).toBeCloseTo(0.025);
    water.update(3, false);
    expect(water.material.uniforms.uTime.value).toBeCloseTo(0.125);
    for (const dt of [-1, Number.NaN, Number.POSITIVE_INFINITY]) water.update(dt, false);
    expect(water.material.uniforms.uTime.value).toBeCloseTo(0.125);
    water.update(0.1, true);
    expect(water.material.uniforms.uTime.value).toBeCloseTo(0.125);
    free(water);
  });

  it('recycles a fixed splash pool, rejects invalid positions, and clears old round ripples', () => {
    const water = new LagoonWater(7.1, 'low');
    const pool = water.material.uniforms.uSplashes.value as Vector4[];
    expect(pool).toHaveLength(SPLASH_LIMIT);
    const vectors = [...pool];
    water.splash(Number.NaN, 4, false);
    water.splash(1, Number.POSITIVE_INFINITY, false);
    water.splash(1, 4, true);
    expect(pool.every(item => item.w === 0)).toBe(true);
    water.update(0.05, false);
    for (let i = 0; i < SPLASH_LIMIT * 3; i++) water.splash(i, -i, false);
    expect(pool).toHaveLength(SPLASH_LIMIT);
    pool.forEach((item, i) => {
      expect(item).toBe(vectors[i]);
      expect(item.x).toBe(SPLASH_LIMIT * 2 + i);
      expect(item.y).toBe(-(SPLASH_LIMIT * 2 + i));
      expect(item.z).toBeCloseTo(0.05);
      expect(item.w).toBe(1);
    });
    water.clear();
    expect(pool.every(item => item.w === 0)).toBe(true);
    water.splash(8, 0, false);
    water.update(0.05, true);
    expect(pool.every(item => item.w === 0)).toBe(true);
    free(water);
  });
});

function boardBounds(camera: PerspectiveCamera, radius: number, y = 0) {
  camera.updateMatrixWorld(true);
  let left = Infinity, right = -Infinity, top = -Infinity, bottom = Infinity;
  for (let i = 0; i < 128; i++) {
    const a = i * Math.PI / 64;
    const p = new Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius).project(camera);
    expect([p.x, p.y, p.z].every(Number.isFinite)).toBe(true);
    left = Math.min(left, p.x); right = Math.max(right, p.x);
    top = Math.max(top, p.y); bottom = Math.min(bottom, p.y);
  }
  return { left, right, top, bottom };
}

describe('readable match view', () => {
  for (const aspect of [16 / 9, 4 / 3, 9 / 16]) {
    it(`keeps the entire board and floating base in frame at aspect ${aspect}`, () => {
      const camera = new PerspectiveCamera(32, aspect, 0.5, 140);
      frameArena(camera, aspect, 7.1, true);
      for (const y of [0.35, -0.96]) {
        const b = boardBounds(camera, 8.05, y);
        expect(b.left).toBeGreaterThan(-0.97);
        expect(b.right).toBeLessThan(0.97);
        expect(b.top).toBeLessThan(0.85);
        expect(b.bottom).toBeGreaterThan(-0.95);
      }
      const floor = boardBounds(camera, 7.1);
      // The top of the playing field stays below the score row on a TV.
      if (aspect >= 1.6) {
        expect(floor.top).toBeLessThan(0.65);
        expect((floor.right - floor.left) / 2).toBeGreaterThan(0.49);
      }
    });
  }

  it('moves the title-screen diorama right of the compact menu and pulls it farther back', () => {
    const title = new PerspectiveCamera(32, 16 / 9, 0.5, 140);
    const normal = new PerspectiveCamera(32, 16 / 9, 0.5, 140);
    const a = frameArena(title, 16 / 9, 7.1, false, true);
    const b = frameArena(normal, 16 / 9, 7.1, false);
    expect(a.position.distanceTo(a.target)).toBeGreaterThan(b.position.distanceTo(b.target));
    expect(a.target.x).toBeLessThan(-3);
    const board = boardBounds(title, 7.1);
    expect(board.left).toBeGreaterThan(-0.3);
    expect(board.right).toBeLessThan(0.96);
  });

  it('leaves scenery around the board rather than the oversized lagoon framing', () => {
    const camera = new PerspectiveCamera(32, 16 / 9, 0.5, 140);
    frameArena(camera, 16 / 9, 7.1, true);
    const b = boardBounds(camera, 7.1);
    // The enlarged lagoon view was 757px wide; the user asked for more breathing room.
    const width = (b.right - b.left) / 2 * 1280;
    expect(width).toBeGreaterThan(635);
    expect(width).toBeLessThan(710);
  });
});
