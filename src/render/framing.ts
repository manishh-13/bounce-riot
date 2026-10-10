import { MathUtils, PerspectiveCamera, Vector3 } from 'three';

const pts: Vector3[] = [];
const tmp = new Vector3();

function samplePoints(radius: number): Vector3[] {
  pts.length = 0;
  const n = 32;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a) * (radius + 0.95), 0.35, Math.sin(a) * (radius + 0.95)));
    pts.push(new Vector3(Math.cos(a) * (radius + 0.75), -1.05, Math.sin(a) * (radius + 0.75)));
    if (i % 4 === 0) pts.push(new Vector3(Math.cos(a) * radius * 0.85, 2.0, Math.sin(a) * radius * 0.85));
  }
  return pts;
}

function bounds(cam: PerspectiveCamera, points: Vector3[]): [number, number, number, number] {
  cam.updateMatrixWorld(true);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    tmp.copy(p).project(cam);
    if (tmp.x < minX) minX = tmp.x; if (tmp.x > maxX) maxX = tmp.x;
    if (tmp.y < minY) minY = tmp.y; if (tmp.y > maxY) maxY = tmp.y;
  }
  return [minX, maxX, minY, maxY];
}

// Fixed camera on the +Z/+Y side with zero X rotation, distance solved so the whole stage fits any aspect.
export function frameArena(cam: PerspectiveCamera, aspect: number, radius: number): { position: Vector3; target: Vector3 } {
  cam.aspect = aspect;
  const portrait = MathUtils.clamp((1.35 - aspect) / 0.8, 0, 1);
  cam.fov = MathUtils.lerp(30, 38, portrait);
  cam.updateProjectionMatrix();
  const elev = MathUtils.degToRad(MathUtils.lerp(52, 64, portrait));
  const dir = new Vector3(0, Math.sin(elev), Math.cos(elev));
  const target = new Vector3(0, -0.2, 0);
  const points = samplePoints(radius);
  const marginX = 0.95, marginY = 0.9;
  let dist = 24;
  for (let iter = 0; iter < 4; iter++) {
    let lo = 6, hi = 120;
    for (let s = 0; s < 22; s++) {
      const mid = (lo + hi) / 2;
      cam.position.copy(target).addScaledVector(dir, mid);
      cam.lookAt(target);
      const [x0, x1, y0, y1] = bounds(cam, points);
      const h = (y1 - y0) / 2;
      if (Math.max(Math.abs(x0), Math.abs(x1)) <= marginX && h <= marginY) hi = mid; else lo = mid;
    }
    dist = hi;
    cam.position.copy(target).addScaledVector(dir, dist);
    cam.lookAt(target);
    const [, , y0, y1] = bounds(cam, points);
    const centre = (y0 + y1) / 2;
    const worldPerNdc = Math.tan(MathUtils.degToRad(cam.fov / 2)) * dist;
    target.z -= (centre * worldPerNdc) / Math.sin(elev);
  }
  cam.position.copy(target).addScaledVector(dir, dist);
  cam.lookAt(target);
  return { position: cam.position.clone(), target };
}
