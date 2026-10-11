import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { acquireShared, releaseShared } from '../../src/render/character';
import { MascotMotion, approach, clampTo, walkTarget, type MascotMotionInput, type MascotPose } from '../../src/render/mascot-motion';

const TAU = Math.PI * 2;

const BOUNDS: Record<keyof MascotPose, [number, number]> = {
  stride: [0, TAU],
  walkWeight: [0, 1],
  turnLean: [-0.24, 0.24],
  airTuck: [0, 1],
  recovery: [0, 1],
  crouch: [0, 0.08],
  bob: [0, 0.04],
  armSwing: [-0.6, 0.6],
  shoulderLift: [0, 0.45],
  elbowBend: [0, 1.5],
  footLiftL: [0, 0.2],
  footLiftR: [0, 0.2],
  footStepL: [-0.18, 0.18],
  footStepR: [-0.18, 0.18],
  anklePitchL: [0, 0.9],
  anklePitchR: [0, 0.9],
  footSplay: [0, 0.14],
};

function input(over: Partial<MascotMotionInput> = {}): MascotMotionInput {
  return {
    dt: 1 / 60, speed: 0, grounded: true, charge: 0, slamming: false,
    vy: 0, turnRate: 0, landImpact: 0, reducedMotion: false, ...over,
  };
}

function expectSane(pose: MascotPose): void {
  for (const key of Object.keys(BOUNDS) as (keyof MascotPose)[]) {
    const [lo, hi] = BOUNDS[key];
    expect(Number.isFinite(pose[key]), `${key} is finite`).toBe(true);
    expect(pose[key], `${key} >= ${lo}`).toBeGreaterThanOrEqual(lo);
    expect(pose[key], `${key} <= ${hi}`).toBeLessThanOrEqual(hi);
  }
}

// step() hands back the same pose object every frame, so anything compared across runs is copied.
function snap(pose: MascotPose): MascotPose {
  return { ...pose };
}

function run(motion: MascotMotion, frames: number, over: Partial<MascotMotionInput> = {}): MascotPose {
  let pose = motion.pose;
  for (let i = 0; i < frames; i++) {
    pose = motion.step(input(over));
    expectSane(pose);
  }
  return pose;
}

describe('motion helpers', () => {
  it('clamps non-finite values into the range instead of leaking NaN', () => {
    expect(clampTo(Number.NaN, 0, 1)).toBe(0);
    expect(clampTo(Number.POSITIVE_INFINITY, -1, 1)).toBe(0);
    expect(clampTo(Number.NaN, 0.25, 1)).toBe(0.25);
    expect(clampTo(Number.NaN, -1, -0.5)).toBe(-1);
    expect(clampTo(5, 0, 1)).toBe(1);
    expect(clampTo(-5, 0, 1)).toBe(0);
    expect(clampTo(0.4, 0, 1)).toBe(0.4);
  });

  it('smooths exponentially towards the target, never past it', () => {
    const blend = (step: number) => 1 - Math.exp(-step);
    expect(approach(0, 1, 1 / 60, 10)).toBeCloseTo(blend(1 / 6), 12);
    expect(approach(0.25, 1, 1 / 60, 10)).toBeCloseTo(0.25 + 0.75 * blend(1 / 6), 12);
    // A huge dt is clamped to one 15 fps frame, so a stall cannot snap a pose onto its target.
    expect(approach(0, 1, 10, 10)).toBeCloseTo(blend(2 / 3), 12);
    const far = approach(0, 1, 10, 60);
    expect(far).toBeGreaterThan(0.98);
    expect(far).toBeLessThan(1);
    expect(approach(0, 1, -1, 10)).toBe(0);
    expect(approach(0, 1, 0, 10)).toBe(0);
    expect(approach(Number.NaN, 1, 1 / 60, 10)).toBeCloseTo(blend(1 / 6), 12);
    expect(approach(0.5, Number.NaN, 1, 1)).toBeLessThan(0.5);
    expect(approach(0.5, Number.NaN, 10, 60)).toBeLessThan(0.01);
    expect(approach(0, 1, 1 / 60, Number.NaN)).toBe(0);
  });

  it('composes exactly when a window is split into smaller steps', () => {
    const once = approach(0, 1, 1 / 30, 9);
    let twice = approach(0, 1, 1 / 60, 9);
    twice = approach(twice, 1, 1 / 60, 9);
    expect(twice).toBeCloseTo(once, 12);
    let eight = 0;
    for (let i = 0; i < 8; i++) eight = approach(eight, 1, 1 / 240, 9);
    expect(eight).toBeCloseTo(once, 12);
  });

  it('only weights a walk when grounded and actually moving', () => {
    expect(walkTarget(0, true)).toBe(0);
    expect(walkTarget(0.2, true)).toBe(0);
    expect(walkTarget(5, false)).toBe(0);
    expect(walkTarget(1.5, true)).toBeGreaterThan(0);
    expect(walkTarget(1.5, true)).toBeLessThan(1);
    expect(walkTarget(99, true)).toBe(1);
    expect(walkTarget(Number.NaN, true)).toBe(0);
  });
});

describe('MascotMotion', () => {
  it('keeps every pose channel finite and in range across a long mixed run', () => {
    const motion = new MascotMotion(1.3);
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 2000; i++) {
      const pose = motion.step({
        dt: rand() * 0.2,
        speed: rand() * 12,
        grounded: rand() > 0.4,
        charge: rand() * 1.4,
        slamming: rand() > 0.8,
        vy: (rand() - 0.5) * 30,
        turnRate: (rand() - 0.5) * 40,
        landImpact: rand() > 0.9 ? rand() * 25 : 0,
        reducedMotion: rand() > 0.5,
      });
      expectSane(pose);
      expect(pose.stride).toBeLessThan(TAU);
    }
  });

  it('survives non-finite inputs and a zero dt', () => {
    const motion = new MascotMotion(Number.NaN);
    expectSane(motion.pose);
    expectSane(motion.step(input({ dt: Number.NaN, speed: Number.NaN, vy: Number.NaN, turnRate: Number.NaN, charge: Number.NaN, landImpact: Number.NaN })));
    expectSane(motion.step(input({ dt: 0, speed: 4 })));
    expectSane(motion.step(input({ dt: Number.POSITIVE_INFINITY, speed: 4 })));
    expectSane(motion.step(input({ speed: 4 })));
  });

  it('builds a walk when running and settles back to a stand', () => {
    const motion = new MascotMotion();
    const walking = snap(run(motion, 120, { speed: 4 }));
    expect(walking.walkWeight).toBeGreaterThan(0.9);
    expect(walking.stride).toBeGreaterThan(0);
    const strideBefore = walking.stride;

    const standing = snap(run(motion, 120, { speed: 0 }));
    expect(standing.walkWeight).toBeLessThan(0.02);
    expect(standing.bob).toBeLessThan(0.002);
    expect(Math.abs(standing.armSwing)).toBeLessThan(0.02);
    // A standing mascot freezes its stride instead of sliding its boots on the spot.
    expect(standing.stride).toBe(strideBefore);
    expect(run(motion, 30, { speed: 0 }).stride).toBe(strideBefore);
  });

  it('leans into a turn, mirrors the lean with the turn and drops it for reduced motion', () => {
    const left = snap(run(new MascotMotion(), 60, { speed: 4, turnRate: 3 }));
    const right = snap(run(new MascotMotion(), 60, { speed: 4, turnRate: -3 }));
    expect(Math.abs(left.turnLean)).toBeGreaterThan(0.05);
    expect(left.turnLean).toBeCloseTo(-right.turnLean, 6);

    const reduced = snap(run(new MascotMotion(), 60, { speed: 4, turnRate: 3, reducedMotion: true }));
    expect(reduced.turnLean).toBe(0);
    expect(reduced.walkWeight).toBeCloseTo(left.walkWeight, 6);
    expect(Math.abs(reduced.armSwing)).toBeLessThanOrEqual(0.6);
  });

  it('tucks in the air and clears the tuck on the ground', () => {
    const motion = new MascotMotion();
    const rising = snap(run(motion, 40, { grounded: false, vy: 8 }));
    expect(rising.airTuck).toBeGreaterThan(0.5);
    expect(rising.footLiftL).toBeGreaterThan(0.05);
    expect(rising.footLiftR).toBeGreaterThan(0.05);
    expect(rising.anklePitchL).toBeGreaterThan(0.2);
    expect(rising.walkWeight).toBe(0);

    const falling = snap(run(new MascotMotion(), 40, { grounded: false, vy: -9 }));
    expect(falling.airTuck).toBeLessThan(rising.airTuck);
    expect(run(motion, 60, {}).airTuck).toBeLessThan(0.02);
  });

  it('recovers from a slam landing: a dip that decays, restrained for reduced motion', () => {
    const motion = new MascotMotion();
    const hit = snap(motion.step(input({ landImpact: 12, slamming: true })));
    expect(hit.recovery).toBeGreaterThan(0.8);
    expect(hit.crouch).toBeGreaterThan(0.03);
    expect(hit.elbowBend).toBeGreaterThan(0.6);
    expect(hit.footSplay).toBeGreaterThan(0.05);

    const mid = snap(run(motion, 10, {}));
    expect(mid.recovery).toBeLessThan(hit.recovery);
    const after = snap(run(motion, 90, {}));
    expect(after.recovery).toBe(0);
    expect(after.crouch).toBe(0);

    const soft = snap(new MascotMotion().step(input({ landImpact: 3 })));
    expect(soft.recovery).toBeGreaterThan(0);
    expect(soft.recovery).toBeLessThan(hit.recovery);

    const reduced = snap(new MascotMotion().step(input({ landImpact: 12, slamming: true, reducedMotion: true })));
    expect(reduced.recovery).toBeLessThan(hit.recovery * 0.6);
    const reducedDecay = new MascotMotion();
    reducedDecay.step(input({ landImpact: 12, slamming: true, reducedMotion: true }));
    expect(run(reducedDecay, 20, { reducedMotion: true }).recovery).toBe(0);
  });

  it('reads the same over one short window however finely it is stepped', () => {
    const over = { speed: 3.2, turnRate: 2.4, charge: 0.4, landImpact: 0 };
    // Warm both to a settled run first, so the window measures the integrator and not the ramp-in.
    const warm = () => {
      const m = new MascotMotion(0.5);
      for (let i = 0; i < 180; i++) m.step(input({ dt: 1 / 60, ...over }));
      return m;
    };
    const coarse = warm();
    const fine = warm();
    expect(coarse.pose.walkWeight).toBeCloseTo(fine.pose.walkWeight, 12);

    coarse.step(input({ dt: 1 / 30, ...over }));
    for (let i = 0; i < 8; i++) fine.step(input({ dt: 1 / 240, ...over }));
    for (const key of Object.keys(BOUNDS) as (keyof MascotPose)[]) {
      expect(coarse.pose[key], `${key} matches over one window`).toBeCloseTo(fine.pose[key], 8);
    }
  });

  it('reads the same whether a stretch of time arrives in one step or many', () => {
    const coarse = new MascotMotion(0.5);
    const fine = new MascotMotion(0.5);
    const over = { speed: 3.2, turnRate: 2.4, charge: 0.4 };
    for (let i = 0; i < 30; i++) {
      coarse.step(input({ dt: 1 / 30, ...over }));
      fine.step(input({ dt: 1 / 120, ...over }));
      fine.step(input({ dt: 1 / 120, ...over }));
      fine.step(input({ dt: 1 / 120, ...over }));
      fine.step(input({ dt: 1 / 120, ...over }));
    }
    for (const key of Object.keys(BOUNDS) as (keyof MascotPose)[]) {
      // Lean is driven by the walk weight, so a cold start leaves a tiny second-order difference.
      expect(coarse.pose[key], `${key} matches across step sizes`).toBeCloseTo(fine.pose[key], 4);
    }
    expect(coarse.pose.stride).toBeCloseTo(fine.pose.stride, 4);
  });

  it('resets to a neutral pose', () => {
    const motion = new MascotMotion(2);
    run(motion, 60, { speed: 5, turnRate: 3, landImpact: 9 });
    motion.reset();
    expectSane(motion.pose);
    expect(motion.pose.walkWeight).toBe(0);
    expect(motion.pose.turnLean).toBe(0);
    expect(motion.pose.recovery).toBe(0);
    expect(motion.pose.crouch).toBe(0);
    expect(motion.pose.elbowBend).toBeCloseTo(0.22, 6);
  });
});

// The boot and the mitt arm are merged into the shared geometry, so these bounds are what keeps
// feetY alignment and the old silhouette honest without a GPU in the loop.
describe('mascot limb geometry', () => {
  function bounds(geo: BufferGeometry) {
    geo.computeBoundingBox();
    const box = geo.boundingBox;
    if (!box) throw new Error('no bounding box');
    return box;
  }

  it('keeps the boot sole on the old foot bottom and inside the old footprint', () => {
    const shared = acquireShared(false);
    const box = bounds(shared.foot);
    expect(box.min.y).toBeCloseTo(-0.01, 6);
    expect(box.max.x).toBeLessThanOrEqual(0.146);
    expect(box.min.z).toBeGreaterThanOrEqual(-0.17);
    expect(box.max.z).toBeLessThanOrEqual(0.25);
    releaseShared();
  });

  it('hangs the mitt arm from the shoulder in one geometry, within a hand-sized radius', () => {
    const shared = acquireShared(false);
    const box = bounds(shared.arm);
    expect(box.max.y).toBeLessThanOrEqual(0.05);
    expect(box.min.y).toBeGreaterThan(-0.32);
    expect(box.min.y).toBeLessThan(-0.26);
    expect(Math.max(Math.abs(box.min.x), box.max.x)).toBeLessThanOrEqual(0.09);
    releaseShared();
  });
});
