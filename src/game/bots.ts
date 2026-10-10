import type { GameState, Input, PlayerState } from './types';

const NEUTRAL: Input = { x: 0, z: 0, action: false };
const SURF_BAND_HALF = 0.45;

/**
 * Autonomous practice bot. All randomness comes from the simulation's seeded rng and the brain is
 * ticked in roster order, so bot behaviour is fully reproducible for a given seed.
 */
export class BotBrain {
  private moveX = 0;
  private moveZ = 0;
  private decideIn = 0;
  private holdTicks = 0;
  private tapTicks = 0;
  private targetId: string | null = null;
  private readonly consideredWaves: number[] = [];
  readonly skill: number;
  readonly aggression: number;

  constructor(private readonly id: string, rng: () => number) {
    this.skill = 0.5 + rng() * 0.35;
    this.aggression = 0.35 + rng() * 0.4;
    this.decideIn = Math.floor(rng() * 10);
  }

  reset(): void {
    this.holdTicks = 0;
    this.tapTicks = 0;
    this.moveX = 0;
    this.moveZ = 0;
    this.targetId = null;
    this.consideredWaves.length = 0;
  }

  think(state: GameState, self: PlayerState, rng: () => number): Input {
    if (self.respawnIn > 0 || self.y < -0.05) {
      this.reset();
      return NEUTRAL;
    }
    const radius = state.arena.radius;
    const dist = Math.hypot(self.x, self.z);

    if (this.tapTicks > 0) {
      this.tapTicks--;
      return { x: this.moveX, z: this.moveZ, action: this.tapTicks > 0 };
    }

    if (this.holdTicks > 0) {
      // The simulation cancels a charge when we get knocked airborne; stop "holding" so the next press is fresh.
      if (!self.grounded && !self.slamming && self.actionHeld === 0) {
        this.holdTicks = 0;
        return { x: this.moveX, z: this.moveZ, action: false };
      }
      this.holdTicks--;
      this.steer(state, self, 0.8);
      return { x: this.moveX, z: this.moveZ, action: this.holdTicks > 0 };
    }

    if (self.grounded && this.trySurf(state, self, rng)) {
      this.tapTicks = 2;
      return { x: this.moveX, z: this.moveZ, action: true };
    }

    if (dist > radius - 1.5) {
      const inv = 1 / Math.max(dist, 1e-6);
      this.moveX = -self.x * inv;
      this.moveZ = -self.z * inv;
      this.decideIn = Math.min(this.decideIn, 4);
    }

    if (--this.decideIn <= 0) {
      this.decideIn = 8 + Math.floor(rng() * 8);
      const target = this.pickTarget(state, self);
      this.targetId = target?.id ?? null;
      this.steer(state, self, 1);
      if (target && self.grounded && self.cooldown <= 0 && dist < radius - 1.6) {
        const gap = Math.hypot(target.x - self.x, target.z - self.z);
        const targetRim = Math.hypot(target.x, target.z) / radius;
        if (gap < 4.6 && rng() < this.aggression * (0.55 + targetRim)) {
          this.holdTicks = 14 + Math.floor(rng() * 46);
          return { x: this.moveX, z: this.moveZ, action: true };
        }
      }
      if (self.grounded && rng() < 0.04) {
        this.tapTicks = 2;
        return { x: this.moveX, z: this.moveZ, action: true };
      }
    }
    return { x: this.moveX, z: this.moveZ, action: false };
  }

  private trySurf(state: GameState, self: PlayerState, rng: () => number): boolean {
    for (const wave of state.waves) {
      if (wave.owner === this.id || wave.hitIds.includes(self.id) || this.consideredWaves.includes(wave.id)) continue;
      const gap = Math.hypot(self.x - wave.x, self.z - wave.z) - SURF_BAND_HALF - wave.radius;
      if (gap <= 0) continue;
      const eta = gap / state.arena.waveSpeed;
      if (eta > 0.08 && eta < 0.26) {
        this.consideredWaves.push(wave.id);
        if (this.consideredWaves.length > 24) this.consideredWaves.shift();
        if (rng() < this.skill) return true;
      }
    }
    return false;
  }

  private pickTarget(state: GameState, self: PlayerState): PlayerState | null {
    let best: PlayerState | null = null;
    let bestScore = Infinity;
    for (const other of state.players) {
      if (other.id === self.id || other.respawnIn > 0 || other.y < -0.05 || other.invincible > 0) continue;
      const gap = Math.hypot(other.x - self.x, other.z - self.z);
      const score = gap - (other.id === this.targetId ? 1 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = other;
      }
    }
    return best;
  }

  private steer(state: GameState, self: PlayerState, weight: number): void {
    const radius = state.arena.radius;
    const target = this.targetId ? state.players.find(p => p.id === this.targetId) : undefined;
    let goalX = 0;
    let goalZ = 0;
    if (target && target.respawnIn <= 0) {
      const dx = target.x - self.x;
      const dz = target.z - self.z;
      const gap = Math.hypot(dx, dz) || 1;
      goalX = target.x - (dx / gap) * 2;
      goalZ = target.z - (dz / gap) * 2;
    }
    const goalDist = Math.hypot(goalX, goalZ);
    const limit = radius - 1.9;
    if (goalDist > limit) {
      goalX *= limit / goalDist;
      goalZ *= limit / goalDist;
    }
    const dx = goalX - self.x;
    const dz = goalZ - self.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.3) {
      this.moveX = 0;
      this.moveZ = 0;
      return;
    }
    const speed = Math.min(1, len / 1.5) * weight;
    this.moveX = (dx / len) * speed;
    this.moveZ = (dz / len) * speed;
  }
}
