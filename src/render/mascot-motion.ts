// Pose maths for the mascots: walk weight, turn lean, air pose and slam-landing recovery.
// Pure numbers only, no Three.js and no simulation access, so the renderer stays the only
// thing that knows about meshes and the whole lot is unit-testable off a GPU.

const TAU = Math.PI * 2;
// A stall or a tab wake-up can hand us a huge dt; clamping keeps one frame from snapping a pose.
const MAX_DT = 1 / 15;

export interface MascotMotionInput {
  dt: number;
  speed: number;
  grounded: boolean;
  charge: number;
  slamming: boolean;
  vy: number;
  turnRate: number;
  landImpact: number;
  reducedMotion: boolean;
}

export interface MascotPose {
  stride: number;
  walkWeight: number;
  turnLean: number;
  airTuck: number;
  recovery: number;
  crouch: number;
  bob: number;
  armSwing: number;
  shoulderLift: number;
  elbowBend: number;
  footLiftL: number;
  footLiftR: number;
  footStepL: number;
  footStepR: number;
  // Positive lifts the toe.
  anklePitchL: number;
  anklePitchR: number;
  footSplay: number;
}

export function clampTo(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo > 0 || hi < 0 ? lo : 0;
  return value < lo ? lo : value > hi ? hi : value;
}

// True exponential smoothing: the blend is 1 - e^(-rate*dt), so splitting a window into smaller
// steps composes to exactly the same result and the pose reads the same at 30 fps and at 240 fps.
export function approach(current: number, target: number, dt: number, rate: number): number {
  const c = Number.isFinite(current) ? current : 0;
  const t = Number.isFinite(target) ? target : 0;
  const step = clampTo(dt, 0, MAX_DT) * clampTo(rate, 0, 120);
  return c + (t - c) * -Math.expm1(-step);
}

export function walkTarget(speed: number, grounded: boolean): number {
  if (!grounded) return 0;
  const s = clampTo(speed, 0, 40);
  return s < 0.25 ? 0 : clampTo((s - 0.25) / 3.25, 0, 1);
}

function liftFraction(lift: number): number {
  return clampTo(lift / 0.1, 0, 1);
}

export class MascotMotion {
  readonly pose: MascotPose = {
    stride: 0, walkWeight: 0, turnLean: 0, airTuck: 0, recovery: 0, crouch: 0, bob: 0,
    armSwing: 0, shoulderLift: 0, elbowBend: 0,
    footLiftL: 0, footLiftR: 0, footStepL: 0, footStepR: 0,
    anklePitchL: 0, anklePitchR: 0, footSplay: 0,
  };
  private weight = 0;
  private lean = 0;
  private tuck = 0;
  private recovery = 0;

  constructor(phase = 0) {
    this.pose.stride = Number.isFinite(phase) ? ((phase % TAU) + TAU) % TAU : 0;
  }

  reset(): void {
    this.weight = 0; this.lean = 0; this.tuck = 0; this.recovery = 0;
    this.write(0);
  }

  // Called once per rendered frame; the returned pose is reused, so read it before the next step.
  step(input: MascotMotionInput): MascotPose {
    const dt = clampTo(input.dt, 0, MAX_DT);
    const speed = clampTo(input.speed, 0, 40);
    const charge = clampTo(input.charge, 0, 1);
    const reduced = input.reducedMotion;

    const target = walkTarget(speed, input.grounded);
    this.weight = approach(this.weight, target, dt, target > this.weight ? 14 : 8);

    if (input.grounded && target > 0.02) {
      const cadence = 4 + speed * 3.2;
      this.pose.stride = (this.pose.stride + dt * cadence) % TAU;
    }

    // Lean into the turn, the way a runner plants a shoulder; decoration, so reduced motion drops it.
    const turn = clampTo(input.turnRate, -12, 12);
    const leanTarget = reduced ? 0 : clampTo(-turn * 0.05 * (0.3 + 0.7 * this.weight), -0.24, 0.24);
    this.lean = approach(this.lean, leanTarget, dt, 9);

    // Air pose: tuck the knees climbing, reach out falling. Readability, not decoration, so it stays on.
    const vy = clampTo(input.vy, -40, 40);
    const tuckTarget = input.grounded ? 0 : clampTo(0.4 + vy * 0.055, 0, 1);
    this.tuck = approach(this.tuck, tuckTarget, dt, input.grounded ? 11 : 7);

    const impact = clampTo(input.landImpact, 0, 40);
    if (impact > 0) {
      const kick = clampTo(impact / 11, 0.22, 1) * (input.slamming ? 1 : 0.85) * (reduced ? 0.5 : 1);
      if (kick > this.recovery) this.recovery = kick;
    }
    this.recovery = clampTo(this.recovery - dt * (reduced ? 5.2 : 2.6), 0, 1);

    this.write(charge);
    return this.pose;
  }

  private write(charge: number): void {
    const p = this.pose;
    const sw = Math.sin(p.stride);
    const w = clampTo(this.weight, 0, 1);
    const tuck = clampTo(this.tuck, 0, 1);
    const rec = clampTo(this.recovery, 0, 1);

    p.walkWeight = w;
    p.turnLean = clampTo(this.lean, -0.24, 0.24);
    p.airTuck = tuck;
    p.recovery = rec;
    // Knees absorb the landing, then push back up.
    p.crouch = clampTo(rec * rec * 0.075, 0, 0.08);
    p.bob = clampTo(Math.abs(sw) * 0.035 * w, 0, 0.04);

    p.armSwing = clampTo(sw * 0.55 * w, -0.6, 0.6);
    p.shoulderLift = clampTo(w * 0.1 + rec * 0.3, 0, 0.45);
    p.elbowBend = clampTo(
      0.22 + w * 0.45 * (0.5 + 0.5 * Math.cos(p.stride)) + tuck * 0.5 + rec * 0.7 + charge * 0.4,
      0, 1.5,
    );

    const lift = 0.075 * w;
    p.footLiftL = clampTo(Math.max(0, sw) * lift + tuck * 0.09 + rec * 0.025, 0, 0.2);
    p.footLiftR = clampTo(Math.max(0, -sw) * lift + tuck * 0.09 + rec * 0.025, 0, 0.2);
    p.footStepL = clampTo(sw * 0.13 * w - tuck * 0.03, -0.18, 0.18);
    p.footStepR = clampTo(-sw * 0.13 * w - tuck * 0.03, -0.18, 0.18);
    // Toe-up only, and only while the foot is off the floor, so a boot can never pitch through it.
    p.anklePitchL = clampTo(liftFraction(p.footLiftL) * 0.5 + tuck * 0.4 + rec * 0.3, 0, 0.9);
    p.anklePitchR = clampTo(liftFraction(p.footLiftR) * 0.5 + tuck * 0.4 + rec * 0.3, 0, 0.9);
    p.footSplay = clampTo(rec * 0.1 + tuck * 0.025, 0, 0.14);
  }
}
