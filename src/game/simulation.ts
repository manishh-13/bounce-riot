import { BotBrain } from './bots';
import {
  MAX_PLAYERS,
  type ArenaConfig,
  type ArenaId,
  type GameEvent,
  type GameOptions,
  type GameState,
  type Input,
  type PlayerSpec,
  type PlayerState,
  type Wave,
} from './types';

export const ARENAS: Record<ArenaId, ArenaConfig> = {
  springyard: { id: 'springyard', name: 'Springyard', radius: 7.1, gravity: 24, waveSpeed: 9, description: 'Classic bounce: steady gravity and steady waves.' },
  moonbounce: { id: 'moonbounce', name: 'Moonbounce', radius: 7.1, gravity: 14, waveSpeed: 7, description: 'Low gravity: floaty hops, slower waves, longer surf windows.' },
  aftershock: { id: 'aftershock', name: 'Aftershock', radius: 7.1, gravity: 28, waveSpeed: 11, description: 'Heavy and fast. The floor quakes every few seconds: watch the warning ring.' },
};

export const ARENA_OWNER = '__arena__';
export const DURATIONS = [30, 60, 90, 120] as const;
export const DEFAULT_DURATION = 90;

/** step() advances in fixed 60 Hz ticks; a single call is clamped to MAX_FRAME seconds (15 ticks). */
export const FIXED_DT = 1 / 60;
export const MAX_FRAME = 0.25;

export const SCORING = { knockout: 2, selfFall: -1, minScore: 0, creditWindow: 4 } as const;

export const TUNING = {
  playerRadius: 0.45,
  moveSpeed: 6.2,
  chargeMoveFactor: 0.35,
  slamAirMoveFactor: 0.55,
  groundResponse: 12,
  airResponse: 3,
  stunGroundResponse: 1.6,
  stunAirResponse: 0.5,
  tapTicks: 12,
  chargeTime: 0.8,
  pressBuffer: 0.12,
  hopHeight: 0.9,
  slamHeightMin: 1.3,
  slamHeightMax: 2.9,
  slamFastFall: 2,
  slamPowerMin: 0.35,
  cooldownBase: 0.9,
  cooldownCharge: 0.7,
  waveBand: 0.9,
  waveDecay: 0.35,
  waveCap: 24,
  knockBase: 1.5,
  knockScale: 13,
  knockLiftBase: 0.1,
  knockLiftScale: 0.5,
  stunBase: 0.45,
  stunScale: 0.35,
  groundContactHeight: 0.15,
  rideMaxHeight: 1.8,
  rideHeightBase: 0.9,
  rideHeightScale: 0.8,
  rideCooldownRefund: 0.35,
  bumpRestitution: 0.5,
  bumpCreditSpeed: 3,
  bumpEventSpeed: 5,
  koDepth: -3,
  respawnDelay: 1.4,
  respawnInvincible: 1.5,
  respawnDrop: 1.2,
  countdown: 3,
  maxHorizontalSpeed: 24,
  maxVerticalSpeed: 30,
  eventBuffer: 64,
} as const;

const HAZARDS: Partial<Record<ArenaId, { min: number; max: number; telegraph: number; power: number; spread: number }>> = {
  aftershock: { min: 6, max: 9, telegraph: 1, power: 0.6, spread: 0.55 },
};

const TICK = FIXED_DT;
const MAX_TICKS_PER_STEP = Math.round(MAX_FRAME / TICK);
const NEUTRAL: Input = { x: 0, z: 0, action: false };
const DEPARTED_CAP = 32;

interface Runtime {
  input: Input;
  prevAction: boolean;
  holding: boolean;
  holdTicks: number;
  needRelease: boolean;
  buffer: number;
  pendingCancel: boolean;
  falling: boolean;
  benched: boolean;
  brain: BotBrain | null;
}

interface PendingHazard { x: number; z: number; t: number; }

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finite(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function sanitizeInput(raw: unknown): Input {
  if (!raw || typeof raw !== 'object') return { ...NEUTRAL };
  const r = raw as Record<string, unknown>;
  let x = clamp(finite(r.x), -1, 1);
  let z = clamp(finite(r.z), -1, 1);
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  return { x, z, action: r.action === true, cancel: r.cancel === true };
}

function sanitizeName(raw: unknown, index: number): string {
  // eslint-disable-next-line no-control-regex
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16) : '';
  return name || `Player ${index + 1}`;
}

/** Wave strength after distance falloff; 1.0 = full charge at the epicentre. */
export function waveEffectivePower(wave: Wave, arena: ArenaConfig): number {
  return wave.power * (1 - TUNING.waveDecay * Math.min(1, wave.radius / (2 * arena.radius)));
}

/** Analytic floor displacement so the renderer's spring floor matches what the simulation resolves. */
export function waveHeightAt(state: Pick<GameState, 'waves' | 'arena'>, x: number, z: number): number {
  let h = 0;
  const sigma = TUNING.waveBand * 0.5;
  for (const w of state.waves) {
    const off = Math.hypot(x - w.x, z - w.z) - w.radius;
    if (off > 2 || off < -2) continue;
    const fade = clamp((w.maxRadius - w.radius) / 2, 0, 1) * clamp(w.age / 0.08, 0, 1);
    h += 0.35 * waveEffectivePower(w, state.arena) * fade * Math.exp(-(off / sigma) * (off / sigma));
  }
  return clamp(h, 0, 0.8);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class GameSimulation {
  readonly state: GameState;
  private rng: () => number;
  private seed: number;
  private accumulator = 0;
  private resumePhase: 'countdown' | 'playing' = 'playing';
  private countdownTicks = 0;
  private playTicks = 0;
  private nextEventId = 1;
  private nextWaveId = 1;
  private hazardTimer = 0;
  private pendingHazard: PendingHazard | null = null;
  private readonly runtime = new Map<string, Runtime>();
  private readonly departed = new Map<string, PlayerState>();

  constructor(options: GameOptions = {}) {
    this.seed = 1;
    this.rng = mulberry32(this.seed);
    this.state = {
      phase: 'lobby', players: [], waves: [], events: [],
      elapsed: 0, duration: DEFAULT_DURATION, remaining: DEFAULT_DURATION, countdown: 0,
      arena: { ...ARENAS.springyard }, winnerIds: [], round: 0, tick: 0,
    };
    this.applyOptions(options);
  }

  setOptions(options: GameOptions): void {
    if (this.state.phase !== 'lobby' && this.state.phase !== 'results') return;
    this.applyOptions(options);
  }

  setPlayers(specs: PlayerSpec[]): void {
    if (!Array.isArray(specs)) return;
    const s = this.state;
    const inRound = s.phase !== 'lobby';
    const seen = new Set<string>();
    const clean: PlayerSpec[] = [];
    for (const raw of specs) {
      if (clean.length >= MAX_PLAYERS) break;
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
      const id = raw.id.trim().slice(0, 64);
      if (!id || id === ARENA_OWNER || seen.has(id)) continue;
      seen.add(id);
      clean.push({ id, name: sanitizeName(raw.name, clean.length), color: raw.color, bot: raw.bot === true, connected: raw.connected !== false });
    }
    const used = new Set(clean.map(c => c.color).filter(c => Number.isInteger(c) && c >= 0));
    for (const c of clean) {
      if (!Number.isInteger(c.color) || c.color < 0) {
        let free = 0;
        while (used.has(free) && free < MAX_PLAYERS - 1) free++;
        c.color = free;
        used.add(free);
      }
    }

    const previous = new Map(s.players.map(p => [p.id, p]));
    const next: PlayerState[] = [];
    for (const spec of clean) {
      let p = previous.get(spec.id);
      let fresh = false;
      if (!p) {
        const back = inRound ? this.departed.get(spec.id) : undefined;
        this.departed.delete(spec.id);
        p = back ?? this.makePlayer(spec);
        fresh = true;
      }
      p.name = spec.name;
      p.color = spec.color;
      p.bot = spec.bot;
      p.connected = spec.connected;
      let rt = this.runtime.get(p.id);
      if (!rt) {
        rt = this.makeRuntime();
        this.runtime.set(p.id, rt);
      }
      if (p.bot && !rt.brain) rt.brain = new BotBrain(p.id, this.rng);
      if (!p.bot) rt.brain = null;
      if (fresh && (s.phase === 'playing' || s.phase === 'paused')) this.hide(p, rt, 0.6);
      next.push(p);
    }
    for (const old of s.players) {
      if (seen.has(old.id)) continue;
      this.runtime.delete(old.id);
      if (inRound) {
        this.departed.set(old.id, old);
        if (this.departed.size > DEPARTED_CAP) this.departed.delete(this.departed.keys().next().value as string);
      }
    }
    s.players = next;
    if (s.phase === 'lobby' || s.phase === 'countdown' || (s.phase === 'paused' && this.resumePhase === 'countdown')) this.layout();
  }

  start(): void {
    const s = this.state;
    s.round++;
    s.phase = 'countdown';
    s.waves = [];
    s.winnerIds = [];
    s.elapsed = 0;
    s.remaining = s.duration;
    s.countdown = TUNING.countdown;
    this.countdownTicks = Math.round(TUNING.countdown / TICK);
    this.playTicks = 0;
    this.accumulator = 0;
    this.departed.clear();
    this.pendingHazard = null;
    this.scheduleHazard();
    for (const p of s.players) this.resetStats(p);
    this.layout();
  }

  pause(): void {
    const s = this.state;
    if (s.phase !== 'countdown' && s.phase !== 'playing') return;
    this.resumePhase = s.phase;
    s.phase = 'paused';
    this.accumulator = 0;
    for (const p of s.players) this.cancelHold(p, this.rt(p), true);
  }

  resume(): void {
    if (this.state.phase !== 'paused') return;
    this.state.phase = this.resumePhase;
    this.accumulator = 0;
  }

  reset(): void {
    const s = this.state;
    s.phase = 'lobby';
    s.waves = [];
    s.winnerIds = [];
    s.elapsed = 0;
    s.remaining = s.duration;
    s.countdown = 0;
    this.playTicks = 0;
    this.accumulator = 0;
    this.pendingHazard = null;
    this.departed.clear();
    for (const p of s.players) this.resetStats(p);
    this.layout();
  }

  /**
   * Advance by dt seconds (invalid dt counts as 0, clamped to MAX_FRAME) in fixed 60 Hz ticks.
   * inputs is keyed by player id; a connected human with no entry this call is treated as neutral.
   * Bots ignore inputs; disconnected humans are neutral.
   */
  step(dt: number, inputs?: Record<string, Input>): void {
    const frame = clamp(finite(dt), 0, MAX_FRAME);
    for (const p of this.state.players) {
      const rt = this.rt(p);
      const raw = inputs && typeof inputs === 'object' && Object.hasOwn(inputs, p.id) ? inputs[p.id] : undefined;
      rt.input = sanitizeInput(raw);
      // A cancel must survive a step() that is too short to run a tick.
      if (rt.input.cancel) rt.pendingCancel = true;
    }
    if (this.state.phase === 'paused') return;
    this.accumulator += frame;
    let ticks = 0;
    while (this.accumulator >= TICK - 1e-9 && ticks < MAX_TICKS_PER_STEP) {
      this.accumulator -= TICK;
      ticks++;
      this.tick();
      if ((this.state.phase as string) === 'paused') break;
    }
    this.accumulator = clamp(this.accumulator, 0, TICK);
  }

  private applyOptions(options: GameOptions): void {
    if (!options || typeof options !== 'object') return;
    const s = this.state;
    if (typeof options.duration === 'number' && (DURATIONS as readonly number[]).includes(options.duration)) {
      s.duration = options.duration;
      if (s.phase === 'lobby') s.remaining = s.duration;
    }
    if (typeof options.arena === 'string' && Object.hasOwn(ARENAS, options.arena)) {
      s.arena = { ...ARENAS[options.arena] };
      if (s.phase === 'lobby') this.layout();
    }
    if (typeof options.seed === 'number' && Number.isFinite(options.seed)) {
      this.seed = Math.floor(Math.abs(options.seed)) >>> 0;
      this.rng = mulberry32(this.seed);
      for (const p of s.players) {
        const rt = this.rt(p);
        if (p.bot) rt.brain = new BotBrain(p.id, this.rng);
      }
    }
  }

  private makePlayer(spec: PlayerSpec): PlayerState {
    return {
      id: spec.id, name: spec.name, color: spec.color, bot: spec.bot, connected: spec.connected,
      x: 0, z: 0, y: 0, vx: 0, vz: 0, vy: 0, facing: 0, charge: 0, cooldown: 0, grounded: true,
      score: 0, knockouts: 0, falls: 0, rides: 0, respawnIn: 0, invincible: 0, hitFlash: 0,
      lastHitBy: null, lastHitAt: 0, actionHeld: 0, slamming: false, slamPower: 0,
    };
  }

  private makeRuntime(): Runtime {
    return { input: { ...NEUTRAL }, prevAction: false, holding: false, holdTicks: 0, needRelease: true, buffer: 0, pendingCancel: false, falling: false, benched: false, brain: null };
  }

  private rt(p: PlayerState): Runtime {
    let rt = this.runtime.get(p.id);
    if (!rt) {
      rt = this.makeRuntime();
      this.runtime.set(p.id, rt);
    }
    return rt;
  }

  private resetStats(p: PlayerState): void {
    p.score = 0; p.knockouts = 0; p.falls = 0; p.rides = 0;
    p.respawnIn = 0; p.invincible = 0; p.hitFlash = 0; p.cooldown = 0;
    p.lastHitBy = null; p.lastHitAt = 0; p.slamming = false; p.slamPower = 0;
    const rt = this.rt(p);
    rt.falling = false;
    rt.benched = false;
    rt.brain?.reset();
    this.cancelHold(p, rt, true);
  }

  private layout(): void {
    const s = this.state;
    const n = s.players.length;
    const r = s.arena.radius * 0.45;
    s.players.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / Math.max(n, 1);
      p.x = r * Math.sin(angle);
      p.z = r * Math.cos(angle);
      p.y = 0; p.vx = 0; p.vy = 0; p.vz = 0;
      p.grounded = true;
      p.facing = Math.atan2(-p.x, -p.z);
      p.respawnIn = 0;
      const rt = this.rt(p);
      rt.falling = false;
      rt.benched = false;
    });
  }

  private emit(type: GameEvent['type'], playerId: string, x: number, z: number, power: number, otherId?: string): void {
    const event: GameEvent = { id: this.nextEventId++, type, playerId, x, z, power };
    if (otherId !== undefined) event.otherId = otherId;
    const events = this.state.events;
    events.push(event);
    if (events.length > TUNING.eventBuffer) events.splice(0, events.length - TUNING.eventBuffer);
  }

  private cancelHold(p: PlayerState, rt: Runtime, requireRelease: boolean): void {
    rt.holding = false;
    rt.holdTicks = 0;
    rt.buffer = 0;
    rt.needRelease = requireRelease && rt.prevAction;
    p.charge = 0;
    p.actionHeld = 0;
  }

  private hide(p: PlayerState, rt: Runtime, delay: number): void {
    p.respawnIn = delay;
    p.y = TUNING.koDepth;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.grounded = false;
    p.slamming = false;
    p.slamPower = 0;
    rt.falling = false;
    this.cancelHold(p, rt, true);
  }

  private alive(p: PlayerState, rt: Runtime): boolean {
    return p.respawnIn <= 0 && !rt.falling && !rt.benched;
  }

  private creditActive(p: PlayerState): boolean {
    return p.lastHitBy !== null && this.state.elapsed - p.lastHitAt <= SCORING.creditWindow;
  }

  private inputFor(p: PlayerState, rt: Runtime): Input {
    if (p.bot) return rt.brain ? rt.brain.think(this.state, p, this.rng) : NEUTRAL;
    if (p.connected === false) return { x: 0, z: 0, action: false, cancel: rt.holding };
    const cancel = rt.pendingCancel;
    rt.pendingCancel = false;
    return cancel ? { ...rt.input, cancel } : { ...rt.input, cancel: false };
  }

  private tick(): void {
    const s = this.state;
    s.tick++;
    switch (s.phase) {
      case 'lobby':
        this.advanceWaves(false);
        break;
      case 'countdown':
        this.tickCountdown();
        break;
      case 'playing':
        this.tickPlaying();
        break;
      case 'results':
        this.settle();
        this.advanceWaves(false);
        break;
      default:
        break;
    }
  }

  private tickCountdown(): void {
    const s = this.state;
    for (const p of s.players) {
      const rt = this.rt(p);
      const inp = p.bot ? NEUTRAL : this.inputFor(p, rt);
      if (Math.hypot(inp.x, inp.z) > 0.2) p.facing = Math.atan2(inp.x, inp.z);
      rt.prevAction = inp.action && !inp.cancel;
    }
    this.countdownTicks--;
    s.countdown = Math.max(0, this.countdownTicks * TICK);
    if (this.countdownTicks <= 0) {
      s.phase = 'playing';
      s.countdown = 0;
      for (const p of s.players) this.cancelHold(p, this.rt(p), true);
      this.emit('start', '', 0, 0, 0);
    }
  }

  private tickPlaying(): void {
    const s = this.state;
    const g = s.arena.gravity;

    for (const p of s.players) {
      const rt = this.rt(p);
      const present = p.bot || p.connected !== false;
      if (rt.benched) {
        if (present) rt.benched = false;
        else continue;
      }
      if (!present && this.alive(p, rt) && !this.creditActive(p)) {
        this.hide(p, rt, TUNING.respawnDelay);
        rt.benched = true;
        continue;
      }
      if (p.respawnIn > 0 && !rt.falling) {
        p.respawnIn -= TICK;
        if (p.respawnIn <= 1e-9) {
          if (present) this.respawn(p, rt);
          else {
            this.hide(p, rt, TUNING.respawnDelay);
            rt.benched = true;
          }
        }
      }
    }

    for (const p of s.players) {
      const rt = this.rt(p);
      if (!this.alive(p, rt)) continue;
      const inp = this.inputFor(p, rt);
      this.control(p, rt, inp, g);
    }

    for (const p of s.players) {
      const rt = this.rt(p);
      if (p.respawnIn > 0 || rt.benched) continue;
      this.integrate(p, rt, g, true);
    }

    this.collide();
    this.advanceWaves(true);

    for (const p of s.players) {
      const rt = this.rt(p);
      if (rt.falling && p.y <= TUNING.koDepth) this.knockOut(p, rt);
    }

    this.tickHazards();

    for (const p of s.players) {
      p.cooldown = Math.max(0, p.cooldown - TICK);
      p.invincible = Math.max(0, p.invincible - TICK);
      p.hitFlash = Math.max(0, p.hitFlash - TICK);
      this.guard(p);
    }

    this.playTicks++;
    s.elapsed = this.playTicks * TICK;
    const total = Math.round(s.duration / TICK);
    s.remaining = Math.max(0, (total - this.playTicks) * TICK);
    if (this.playTicks >= total) this.finish();
  }

  private control(p: PlayerState, rt: Runtime, inp: Input, g: number): void {
    if (inp.cancel) {
      this.cancelHold(p, rt, false);
      rt.prevAction = false;
    } else {
      const action = inp.action;
      if (!action) rt.needRelease = false;
      const press = action && !rt.prevAction;
      rt.prevAction = action;
      if (press && !rt.needRelease) {
        if (p.grounded && !p.slamming) this.beginHold(p, rt);
        else rt.buffer = TUNING.pressBuffer;
      } else if (rt.holding) {
        if (!p.grounded) this.cancelHold(p, rt, action);
        else if (action) {
          rt.holdTicks++;
          if (rt.holdTicks >= TUNING.tapTicks && p.cooldown <= 0) p.charge = Math.min(1, p.charge + TICK / TUNING.chargeTime);
        } else {
          const ticks = rt.holdTicks;
          const charge = p.charge;
          this.cancelHold(p, rt, false);
          if (ticks < TUNING.tapTicks) this.hop(p, g);
          else if (p.cooldown <= 0) this.leap(p, g, charge);
        }
      }
      p.actionHeld = rt.holding ? rt.holdTicks * TICK : 0;
    }

    const charging = rt.holding && rt.holdTicks >= TUNING.tapTicks;
    const factor = charging ? TUNING.chargeMoveFactor : p.slamming ? TUNING.slamAirMoveFactor : 1;
    const tx = inp.x * TUNING.moveSpeed * factor;
    const tz = inp.z * TUNING.moveSpeed * factor;
    const stunned = p.hitFlash > 0;
    const steering = Math.hypot(inp.x, inp.z) > 0.05;
    if (p.grounded || steering) {
      const response = p.grounded
        ? (stunned ? TUNING.stunGroundResponse : TUNING.groundResponse)
        : (stunned ? TUNING.stunAirResponse : TUNING.airResponse);
      const k = 1 - Math.exp(-response * TICK);
      p.vx += (tx - p.vx) * k;
      p.vz += (tz - p.vz) * k;
    }
    if (Math.hypot(inp.x, inp.z) > 0.2) p.facing = Math.atan2(inp.x, inp.z);
  }

  private beginHold(p: PlayerState, rt: Runtime): void {
    rt.holding = true;
    rt.holdTicks = 1;
    rt.buffer = 0;
    p.charge = 0;
  }

  private hop(p: PlayerState, g: number): void {
    p.vy = Math.sqrt(2 * g * TUNING.hopHeight);
    p.grounded = false;
    this.emit('hop', p.id, p.x, p.z, 0.3);
  }

  private leap(p: PlayerState, g: number, charge: number): void {
    const height = TUNING.slamHeightMin + (TUNING.slamHeightMax - TUNING.slamHeightMin) * charge;
    p.vy = Math.sqrt(2 * g * height);
    p.vx *= 0.5;
    p.vz *= 0.5;
    p.grounded = false;
    p.slamming = true;
    p.slamPower = TUNING.slamPowerMin + (1 - TUNING.slamPowerMin) * charge;
    p.invincible = 0;
  }

  private integrate(p: PlayerState, rt: Runtime, g: number, live: boolean): void {
    const R = this.state.arena.radius;
    let gravity = g;
    if (p.slamming && p.vy < 0) gravity *= 1 + TUNING.slamFastFall;
    if (!p.grounded || rt.falling) p.vy -= gravity * TICK;
    p.x += p.vx * TICK;
    p.z += p.vz * TICK;
    p.y += p.vy * TICK;
    const d = Math.hypot(p.x, p.z);
    const overFloor = d <= R;

    if (rt.falling) {
      if (d < R + 0.01) {
        const nx = d > 1e-6 ? p.x / d : 1;
        const nz = d > 1e-6 ? p.z / d : 0;
        p.x = nx * (R + 0.01);
        p.z = nz * (R + 0.01);
        const inward = p.vx * nx + p.vz * nz;
        if (inward < 0) {
          p.vx -= inward * nx;
          p.vz -= inward * nz;
        }
      }
      if (p.y < TUNING.koDepth) p.y = TUNING.koDepth;
      return;
    }

    if (!overFloor && p.y <= 0) {
      rt.falling = true;
      p.grounded = false;
      p.slamming = false;
      p.slamPower = 0;
      this.cancelHold(p, rt, true);
      return;
    }
    if (overFloor && p.y <= 0 && p.vy <= 0) {
      const wasAir = !p.grounded;
      p.y = 0;
      p.vy = 0;
      p.grounded = true;
      if (wasAir && p.slamming) {
        if (live) this.slamWave(p);
        p.slamming = false;
        p.slamPower = 0;
      }
      if (wasAir && live && rt.buffer > 0 && !rt.needRelease) {
        rt.buffer = 0;
        if (rt.prevAction) this.beginHold(p, rt);
        else this.hop(p, g);
      }
    } else if (p.y > 0) {
      p.grounded = false;
    }
    rt.buffer = Math.max(0, rt.buffer - TICK);
  }

  private slamWave(p: PlayerState): void {
    const power = p.slamPower;
    this.spawnWave(p.id, p.x, p.z, power, p.color);
    const charge = (power - TUNING.slamPowerMin) / (1 - TUNING.slamPowerMin);
    p.cooldown = TUNING.cooldownBase + TUNING.cooldownCharge * charge;
    p.vx *= 0.3;
    p.vz *= 0.3;
    this.emit('slam', p.id, p.x, p.z, power);
  }

  private spawnWave(owner: string, x: number, z: number, power: number, color: number): void {
    const s = this.state;
    s.waves.push({
      id: this.nextWaveId++, owner, x, z, radius: 0, prevRadius: 0, power, age: 0,
      maxRadius: s.arena.radius + Math.hypot(x, z) + 1, hitIds: owner === ARENA_OWNER ? [] : [owner], color,
    });
    if (s.waves.length > TUNING.waveCap) s.waves.splice(0, s.waves.length - TUNING.waveCap);
  }

  private collide(): void {
    const s = this.state;
    const players = s.players;
    const minD = TUNING.playerRadius * 2;
    for (let i = 0; i < players.length; i++) {
      const a = players[i];
      const ra = this.rt(a);
      if (!this.alive(a, ra)) continue;
      for (let j = i + 1; j < players.length; j++) {
        const b = players[j];
        const rb = this.rt(b);
        if (!this.alive(b, rb) || Math.abs(a.y - b.y) > 0.9) continue;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let dist = Math.hypot(dx, dz);
        if (dist >= minD) continue;
        if (dist < 1e-6) {
          const angle = (i * 7 + j * 13) * 0.7;
          dx = Math.sin(angle);
          dz = Math.cos(angle);
          dist = 0;
        } else {
          dx /= dist;
          dz /= dist;
        }
        const overlap = minD - dist;
        const aFixed = a.invincible > 0 && b.invincible <= 0;
        const bFixed = b.invincible > 0 && a.invincible <= 0;
        const shareA = aFixed ? 0 : bFixed ? 1 : 0.5;
        const shareB = 1 - shareA;
        a.x -= dx * overlap * shareA;
        a.z -= dz * overlap * shareA;
        b.x += dx * overlap * shareB;
        b.z += dz * overlap * shareB;
        const towardA = a.vx * dx + a.vz * dz;
        const towardB = -(b.vx * dx + b.vz * dz);
        const closing = towardA + towardB;
        if (closing <= 0) continue;
        const impulse = (1 + TUNING.bumpRestitution) * closing * 1.2;
        a.vx -= dx * impulse * shareA;
        a.vz -= dz * impulse * shareA;
        b.vx += dx * impulse * shareB;
        b.vz += dz * impulse * shareB;
        if (closing < TUNING.bumpCreditSpeed) continue;
        const [attacker, victim] = towardA >= towardB ? [a, b] : [b, a];
        if (victim.invincible > 0) continue;
        victim.lastHitBy = attacker.id;
        victim.lastHitAt = s.elapsed;
        if (closing >= TUNING.bumpEventSpeed) this.emit('hit', victim.id, (a.x + b.x) / 2, (a.z + b.z) / 2, Math.min(1, closing / 12), attacker.id);
      }
    }
  }

  private advanceWaves(live: boolean): void {
    const s = this.state;
    const g = s.arena.gravity;
    const half = TUNING.waveBand / 2;
    const impulses = new Map<string, { kx: number; kz: number; lift: number; stun: number; attacker: string | null; best: number; rode: boolean }>();

    for (const w of s.waves) {
      w.prevRadius = w.radius;
      w.radius += s.arena.waveSpeed * TICK;
      w.age += TICK;
      if (!live) continue;
      const inner = w.prevRadius - half;
      const outer = w.radius + half;
      const eff = waveEffectivePower(w, s.arena);
      for (const p of s.players) {
        const rt = this.rt(p);
        if (!this.alive(p, rt) || w.hitIds.includes(p.id)) continue;
        const dx = p.x - w.x;
        const dz = p.z - w.z;
        const d = Math.hypot(dx, dz);
        if (d < inner || d > outer) continue;
        w.hitIds.push(p.id);
        if (p.invincible > 0) continue;
        let nx: number;
        let nz: number;
        if (d > 0.05) {
          nx = dx / d;
          nz = dz / d;
        } else {
          const angle = w.id * 2.39996;
          nx = Math.sin(angle);
          nz = Math.cos(angle);
        }
        let imp = impulses.get(p.id);
        if (!imp) {
          imp = { kx: 0, kz: 0, lift: 0, stun: 0, attacker: null, best: -1, rode: false };
          impulses.set(p.id, imp);
        }
        const owner = w.owner === ARENA_OWNER ? null : w.owner;
        if (!imp.rode && (p.grounded || p.y <= TUNING.groundContactHeight)) {
          const speed = TUNING.knockBase + TUNING.knockScale * eff;
          imp.kx += nx * speed;
          imp.kz += nz * speed;
          imp.lift = Math.max(imp.lift, Math.sqrt(2 * g * (TUNING.knockLiftBase + TUNING.knockLiftScale * eff)));
          imp.stun = Math.max(imp.stun, TUNING.stunBase + TUNING.stunScale * eff);
          if (owner && eff > imp.best) {
            imp.best = eff;
            imp.attacker = owner;
          }
          this.emit('hit', p.id, p.x, p.z, eff, owner ?? ARENA_OWNER);
        } else if (p.y <= TUNING.rideMaxHeight && imp.lift === 0 && !imp.rode) {
          imp.rode = true;
          p.vy = Math.max(p.vy, 0) * 0.25 + Math.sqrt(2 * g * (TUNING.rideHeightBase + TUNING.rideHeightScale * eff));
          p.rides++;
          p.cooldown = Math.max(0, p.cooldown - TUNING.rideCooldownRefund);
          this.emit('ride', p.id, p.x, p.z, eff, owner ?? ARENA_OWNER);
        }
      }
    }

    for (const [id, imp] of impulses) {
      if (imp.lift === 0) continue;
      const p = s.players.find(q => q.id === id);
      if (!p) continue;
      const rt = this.rt(p);
      p.vx = p.vx * 0.3 + imp.kx;
      p.vz = p.vz * 0.3 + imp.kz;
      p.vy = imp.lift;
      p.grounded = false;
      p.hitFlash = Math.max(p.hitFlash, imp.stun);
      if (imp.attacker) {
        p.lastHitBy = imp.attacker;
        p.lastHitAt = s.elapsed;
      }
      this.cancelHold(p, rt, rt.prevAction);
    }

    if (s.waves.some(w => w.radius > w.maxRadius)) s.waves = s.waves.filter(w => w.radius <= w.maxRadius);
  }

  private knockOut(p: PlayerState, rt: Runtime): void {
    const s = this.state;
    const attacker = this.creditActive(p) && p.lastHitBy !== p.id ? s.players.find(q => q.id === p.lastHitBy) : undefined;
    p.falls++;
    if (attacker) {
      attacker.score += SCORING.knockout;
      attacker.knockouts++;
      this.emit('ko', p.id, p.x, p.z, SCORING.knockout, attacker.id);
    } else {
      p.score = Math.max(SCORING.minScore, p.score + SCORING.selfFall);
      this.emit('ko', p.id, p.x, p.z, SCORING.selfFall);
    }
    p.lastHitBy = null;
    this.hide(p, rt, TUNING.respawnDelay);
  }

  private respawn(p: PlayerState, rt: Runtime): void {
    const s = this.state;
    const r = s.arena.radius * 0.38;
    let bestX = 0;
    let bestZ = r;
    let bestScore = -1;
    for (let k = 0; k < 8; k++) {
      const angle = k * (Math.PI / 4) + 0.3;
      const x = r * Math.sin(angle);
      const z = r * Math.cos(angle);
      let nearest = Infinity;
      for (const q of s.players) {
        if (q === p || !this.alive(q, this.rt(q))) continue;
        nearest = Math.min(nearest, Math.hypot(q.x - x, q.z - z));
      }
      if (this.pendingHazard) nearest = Math.min(nearest, Math.hypot(this.pendingHazard.x - x, this.pendingHazard.z - z) + 1);
      if (nearest > bestScore + 1e-9) {
        bestScore = nearest;
        bestX = x;
        bestZ = z;
      }
    }
    p.x = bestX; p.z = bestZ; p.y = TUNING.respawnDrop;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.grounded = false;
    p.respawnIn = 0;
    p.invincible = TUNING.respawnInvincible;
    p.hitFlash = 0;
    p.lastHitBy = null;
    p.facing = Math.atan2(-p.x, -p.z);
    rt.falling = false;
    rt.benched = false;
    this.cancelHold(p, rt, true);
    this.emit('respawn', p.id, p.x, p.z, 0);
  }

  private scheduleHazard(): void {
    const h = HAZARDS[this.state.arena.id];
    this.hazardTimer = h ? h.min + this.rng() * (h.max - h.min) : 0;
  }

  private tickHazards(): void {
    const s = this.state;
    const h = HAZARDS[s.arena.id];
    if (!h) return;
    if (this.pendingHazard) {
      this.pendingHazard.t -= TICK;
      if (this.pendingHazard.t <= 1e-9) {
        const { x, z } = this.pendingHazard;
        this.pendingHazard = null;
        this.spawnWave(ARENA_OWNER, x, z, h.power, -1);
        this.emit('hazard', ARENA_OWNER, x, z, h.power);
        this.scheduleHazard();
      }
      return;
    }
    this.hazardTimer -= TICK;
    if (this.hazardTimer > 0) return;
    const angle = this.rng() * Math.PI * 2;
    const dist = Math.sqrt(this.rng()) * s.arena.radius * h.spread;
    this.pendingHazard = { x: dist * Math.sin(angle), z: dist * Math.cos(angle), t: h.telegraph };
    this.emit('hazard', ARENA_OWNER, this.pendingHazard.x, this.pendingHazard.z, 0);
  }

  private settle(): void {
    const g = this.state.arena.gravity;
    for (const p of this.state.players) {
      const rt = this.rt(p);
      if (p.respawnIn > 0 || rt.benched) continue;
      if (!rt.falling) {
        const k = 1 - Math.exp(-TUNING.groundResponse * TICK);
        if (p.grounded) {
          p.vx -= p.vx * k;
          p.vz -= p.vz * k;
        }
      }
      this.integrate(p, rt, g, false);
      this.guard(p);
    }
  }

  private finish(): void {
    const s = this.state;
    s.phase = 'results';
    s.remaining = 0;
    const ranked = [...s.players].sort((a, b) => b.score - a.score || b.knockouts - a.knockouts || a.falls - b.falls);
    const top = ranked[0];
    s.winnerIds = top ? ranked.filter(p => p.score === top.score && p.knockouts === top.knockouts && p.falls === top.falls).map(p => p.id) : [];
    for (const p of s.players) this.cancelHold(p, this.rt(p), true);
    this.pendingHazard = null;
    this.emit('finish', s.winnerIds[0] ?? '', 0, 0, top?.score ?? 0);
  }

  private guard(p: PlayerState): void {
    const hs = Math.hypot(p.vx, p.vz);
    if (hs > TUNING.maxHorizontalSpeed) {
      p.vx *= TUNING.maxHorizontalSpeed / hs;
      p.vz *= TUNING.maxHorizontalSpeed / hs;
    }
    p.vy = clamp(p.vy, -TUNING.maxVerticalSpeed, TUNING.maxVerticalSpeed);
    const fields = [p.x, p.z, p.y, p.vx, p.vz, p.vy, p.facing, p.charge, p.cooldown, p.invincible, p.hitFlash, p.respawnIn];
    if (fields.every(Number.isFinite)) return;
    p.facing = 0; p.charge = 0; p.cooldown = 0; p.invincible = 0; p.hitFlash = 0;
    p.x = 0; p.z = 0;
    this.hide(p, this.rt(p), TUNING.respawnDelay);
  }
}
