import { describe, expect, it } from 'vitest';
import { ARENAS, ARENA_OWNER, FIXED_DT, GameSimulation, SCORING, TUNING, waveHeightAt } from '../../src/game/simulation';
import type { ArenaId, GameEvent, Input, PlayerSpec, PlayerState } from '../../src/game/types';

const ARENA_IDS: ArenaId[] = ['springyard', 'moonbounce', 'aftershock'];

const IDLE: Input = { x: 0, z: 0, action: false };
const HOLD: Input = { x: 0, z: 0, action: true };

function humans(n: number): PlayerSpec[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, color: i, connected: true }));
}

function bots(n: number): PlayerSpec[] {
  return Array.from({ length: n }, (_, i) => ({ id: `b${i}`, name: `Bot ${i}`, color: i, bot: true }));
}

function playing(specs: PlayerSpec[], options = {}): GameSimulation {
  const sim = new GameSimulation({ seed: 3, duration: 120, ...options });
  sim.setPlayers(specs);
  sim.start();
  ticks(sim, 180);
  expect(sim.state.phase).toBe('playing');
  return sim;
}

function ticks(sim: GameSimulation, n: number, inputs?: Record<string, Input>): void {
  for (let i = 0; i < n; i++) sim.step(FIXED_DT, inputs);
}

function player(sim: GameSimulation, id: string): PlayerState {
  const p = sim.state.players.find(q => q.id === id);
  if (!p) throw new Error(`missing ${id}`);
  return p;
}

function place(sim: GameSimulation, id: string, x: number, z: number): void {
  const p = player(sim, id);
  Object.assign(p, { x, z, y: 0, vx: 0, vz: 0, vy: 0, grounded: true, invincible: 0 });
}

/** Collects events the way the renderer does: by id, never reprocessing. */
function collector(sim: GameSimulation) {
  let last = Math.max(0, ...sim.state.events.map(e => e.id));
  const seen: GameEvent[] = [];
  return {
    seen,
    pull() {
      for (const e of sim.state.events) if (e.id > last) { seen.push(e); last = e.id; }
      return seen;
    },
  };
}

/** Holds action for holdTicks ticks then releases (release happens on the following tick). */
function pressFor(sim: GameSimulation, id: string, holdTicks: number, others: Record<string, Input> = {}, move: Partial<Input> = {}): void {
  ticks(sim, holdTicks, { ...others, [id]: { ...HOLD, ...move } });
  sim.step(FIXED_DT, { ...others, [id]: { ...IDLE, ...move } });
}

describe('options, input and roster validation', () => {
  it('exposes three circular arenas of the agreed size', () => {
    expect(Object.keys(ARENAS).sort()).toEqual(['aftershock', 'moonbounce', 'springyard']);
    for (const a of Object.values(ARENAS)) expect(a.radius).toBeCloseTo(7.1);
    expect(ARENAS.moonbounce.gravity).toBeLessThan(ARENAS.springyard.gravity);
  });

  it('accepts only 30/60/90/120 durations and locks options outside lobby/results', () => {
    const sim = new GameSimulation({ duration: 45 as number, arena: 'nope' as never });
    expect(sim.state.duration).toBe(90);
    expect(sim.state.arena.id).toBe('springyard');
    for (const d of [30, 60, 90, 120]) {
      sim.setOptions({ duration: d });
      expect(sim.state.duration).toBe(d);
      expect(sim.state.remaining).toBe(d);
    }
    sim.setOptions({ duration: Number.NaN, arena: 'moonbounce' });
    expect(sim.state.duration).toBe(120);
    expect(sim.state.arena.id).toBe('moonbounce');
    sim.setPlayers(humans(2));
    sim.start();
    sim.setOptions({ duration: 30, arena: 'aftershock' });
    expect(sim.state.duration).toBe(120);
    expect(sim.state.arena.id).toBe('moonbounce');
  });

  it('ignores invalid dt and caps a huge frame at 15 ticks', () => {
    const sim = new GameSimulation();
    sim.setPlayers(humans(2));
    for (const dt of [Number.NaN, -1, Number.POSITIVE_INFINITY, undefined as unknown as number]) sim.step(dt);
    expect(sim.state.tick).toBe(0);
    sim.step(10);
    expect(sim.state.tick).toBe(15);
  });

  it('sanitizes NaN, oversized and garbage input without producing non-finite state', () => {
    const sim = playing(humans(2));
    const bad = [
      { x: Number.NaN, z: Number.POSITIVE_INFINITY, action: 'yes' },
      { x: 50, z: -50, action: true },
      null,
      'junk',
      { x: '1', z: {}, action: 1 },
    ] as unknown as Input[];
    for (const input of bad) ticks(sim, 20, { p0: input, p1: input });
    sim.step(FIXED_DT, null as unknown as Record<string, Input>);
    sim.step(FIXED_DT, { __proto__: { p0: HOLD } } as unknown as Record<string, Input>);
    for (const p of sim.state.players) {
      for (const v of [p.x, p.y, p.z, p.vx, p.vy, p.vz, p.facing, p.charge]) expect(Number.isFinite(v)).toBe(true);
      expect(Math.hypot(p.vx, p.vz)).toBeLessThanOrEqual(TUNING.maxHorizontalSpeed + 1e-9);
    }
  });

  it('caps the roster at 8, dedupes ids, sanitizes names and assigns free colors', () => {
    const sim = new GameSimulation();
    const specs = [
      { id: 'a', name: '  \u0007Alice the very long named one  ', color: 2 },
      { id: 'a', name: 'dup', color: 3 },
      { id: '', name: 'empty', color: 1 },
      { id: ARENA_OWNER, name: 'arena', color: 1 },
      { id: 'b', name: '', color: Number.NaN },
      ...humans(10),
    ] as PlayerSpec[];
    sim.setPlayers(specs);
    const s = sim.state;
    expect(s.players).toHaveLength(8);
    expect(new Set(s.players.map(p => p.id)).size).toBe(8);
    expect(s.players[0].name).toBe('Alice the very l');
    expect(s.players[1].name).toBe('Player 2');
    expect(s.players[1].color).toBe(6);
    expect(s.players.some(p => p.id === ARENA_OWNER)).toBe(false);
    sim.setPlayers('nope' as unknown as PlayerSpec[]);
    expect(s.players).toHaveLength(8);
  });

  it('preserves state for existing players and restores a player who rejoins mid-round', () => {
    const sim = playing(humans(3));
    player(sim, 'p1').score = 4;
    player(sim, 'p1').knockouts = 2;
    sim.setPlayers(humans(3).map(p => (p.id === 'p0' ? { ...p, name: 'Renamed' } : p)));
    expect(player(sim, 'p1').score).toBe(4);
    expect(player(sim, 'p0').name).toBe('Renamed');
    sim.setPlayers(humans(3).filter(p => p.id !== 'p1'));
    expect(sim.state.players.map(p => p.id)).toEqual(['p0', 'p2']);
    ticks(sim, 30);
    sim.setPlayers(humans(3));
    const back = player(sim, 'p1');
    expect(back.score).toBe(4);
    expect(back.knockouts).toBe(2);
    expect(back.respawnIn).toBeGreaterThan(0);
    ticks(sim, 60);
    expect(back.respawnIn).toBe(0);
    expect(back.invincible).toBeGreaterThan(0);
    sim.reset();
    expect(back.score).toBe(0);
  });

  it('benches a disconnected human (no fall, no penalty) and respawns them on reconnect', () => {
    const sim = playing(humans(2));
    player(sim, 'p0').score = 3;
    sim.setPlayers(humans(2).map(p => (p.id === 'p0' ? { ...p, connected: false } : p)));
    ticks(sim, 600);
    const p0 = player(sim, 'p0');
    expect(p0.respawnIn).toBeGreaterThan(0);
    expect(p0.falls).toBe(0);
    expect(p0.score).toBe(3);
    sim.setPlayers(humans(2));
    ticks(sim, Math.ceil(TUNING.respawnDelay / FIXED_DT) + 1);
    expect(p0.respawnIn).toBe(0);
    expect(p0.invincible).toBeGreaterThan(0);
  });
});

describe('phases', () => {
  it('runs a 3 s countdown with frozen players and ignores an action held through it', () => {
    const sim = new GameSimulation({ duration: 30 });
    sim.setPlayers(humans(2));
    sim.start();
    expect(sim.state.phase).toBe('countdown');
    expect(sim.state.countdown).toBe(3);
    const start = { x: player(sim, 'p0').x, z: player(sim, 'p0').z };
    ticks(sim, 179, { p0: { x: 1, z: 0, action: true } });
    expect(sim.state.phase).toBe('countdown');
    expect(player(sim, 'p0').x).toBe(start.x);
    expect(player(sim, 'p0').z).toBe(start.z);
    expect(player(sim, 'p0').facing).toBeCloseTo(Math.PI / 2);
    const events = collector(sim);
    ticks(sim, 1, { p0: HOLD });
    expect(sim.state.phase).toBe('playing');
    expect(events.pull().map(e => e.type)).toContain('start');
    ticks(sim, 40, { p0: HOLD });
    expect(player(sim, 'p0').charge).toBe(0);
    expect(player(sim, 'p0').actionHeld).toBe(0);
  });

  it('pauses (frozen time, cancelled charge) and resumes, then ends the match exactly at duration', () => {
    const sim = playing(humans(2), { duration: 30 });
    ticks(sim, 30, { p0: HOLD });
    expect(player(sim, 'p0').charge).toBeGreaterThan(0);
    sim.pause();
    expect(sim.state.phase).toBe('paused');
    expect(player(sim, 'p0').charge).toBe(0);
    const { tick, remaining } = sim.state;
    sim.step(0.25);
    sim.step(0.25);
    expect(sim.state.tick).toBe(tick);
    expect(sim.state.remaining).toBe(remaining);
    sim.setOptions({ duration: 60 });
    expect(sim.state.duration).toBe(30);
    sim.resume();
    expect(sim.state.phase).toBe('playing');
    ticks(sim, 60, { p0: HOLD });
    expect(player(sim, 'p0').charge).toBe(0);
    expect(sim.state.remaining).toBeCloseTo(30 - 90 * FIXED_DT, 6);
    const left = Math.round(sim.state.remaining / FIXED_DT);
    ticks(sim, left - 1);
    expect(sim.state.phase).toBe('playing');
    ticks(sim, 1);
    expect(sim.state.phase).toBe('results');
    expect(sim.state.remaining).toBe(0);
    sim.setOptions({ duration: 60 });
    expect(sim.state.duration).toBe(60);
  });

  it('pause during countdown resumes into countdown; pause in lobby is ignored', () => {
    const sim = new GameSimulation();
    sim.setPlayers(humans(2));
    sim.pause();
    expect(sim.state.phase).toBe('lobby');
    sim.start();
    ticks(sim, 60);
    sim.pause();
    sim.resume();
    expect(sim.state.phase).toBe('countdown');
    expect(sim.state.countdown).toBeCloseTo(2, 6);
  });

  it('shares the win on a full tie and breaks ties by knockouts then falls', () => {
    const sim = playing(humans(3), { duration: 30 });
    ticks(sim, 30 * 60 - 2);
    Object.assign(player(sim, 'p0'), { score: 4, knockouts: 2, falls: 1 });
    Object.assign(player(sim, 'p1'), { score: 4, knockouts: 2, falls: 1 });
    Object.assign(player(sim, 'p2'), { score: 4, knockouts: 1, falls: 0 });
    ticks(sim, 5);
    expect(sim.state.phase).toBe('results');
    expect(sim.state.winnerIds).toEqual(['p0', 'p1']);
    const finish = sim.state.events.filter(e => e.type === 'finish');
    expect(finish).toHaveLength(1);
    sim.start();
    expect(sim.state.round).toBe(2);
    expect(sim.state.players.every(p => p.score === 0)).toBe(true);
    expect(sim.state.winnerIds).toEqual([]);
  });
});

describe('charge, hop and slam', () => {
  it('a release before 0.20 s is a hop; holding exactly 0.20 s is a slam', () => {
    const sim = playing(humans(2));
    const ev = collector(sim);
    pressFor(sim, 'p0', TUNING.tapTicks - 1);
    const p0 = player(sim, 'p0');
    expect(ev.pull().filter(e => e.type === 'hop')).toHaveLength(1);
    expect(p0.slamming).toBe(false);
    expect(p0.vy).toBeGreaterThan(0);
    ticks(sim, 90);
    expect(p0.grounded).toBe(true);
    pressFor(sim, 'p0', TUNING.tapTicks);
    expect(p0.slamming).toBe(true);
    expect(p0.slamPower).toBeGreaterThanOrEqual(TUNING.slamPowerMin);
    expect(p0.slamPower).toBeLessThan(TUNING.slamPowerMin + 0.02);
    let guard = 0;
    while (!ev.pull().some(e => e.type === 'slam') && guard++ < 120) ticks(sim, 1);
    const slams = ev.seen.filter(e => e.type === 'slam');
    expect(slams).toHaveLength(1);
    expect(sim.state.waves.some(w => w.owner === 'p0')).toBe(true);
    expect(p0.cooldown).toBeGreaterThan(0);
  });

  it('charges to 1 over the hold, slows movement while charging, and reports actionHeld', () => {
    const sim = playing(humans(2));
    place(sim, 'p0', -3, 0);
    place(sim, 'p1', -3, 3);
    ticks(sim, 60, { p0: { x: 1, z: 0, action: true }, p1: { x: 1, z: 0, action: false } });
    const charged = player(sim, 'p0');
    const free = player(sim, 'p1');
    expect(charged.charge).toBeCloseTo(1, 5);
    expect(charged.actionHeld).toBeCloseTo(1, 5);
    expect(free.x + 3).toBeGreaterThan((charged.x + 3) * 1.8);
    expect(Math.abs(charged.vx)).toBeCloseTo(TUNING.moveSpeed * TUNING.chargeMoveFactor, 1);
  });

  it('cancel clears a charge with no hop or slam, and the next press starts fresh', () => {
    const sim = playing(humans(2));
    const ev = collector(sim);
    ticks(sim, 40, { p0: HOLD });
    sim.step(FIXED_DT, { p0: { x: 0, z: 0, action: false, cancel: true } });
    const p0 = player(sim, 'p0');
    expect(p0.charge).toBe(0);
    expect(p0.actionHeld).toBe(0);
    ticks(sim, 20);
    expect(ev.pull().filter(e => e.type === 'hop' || e.type === 'slam')).toHaveLength(0);
    expect(p0.slamming).toBe(false);
    expect(p0.grounded).toBe(true);
    pressFor(sim, 'p0', 3);
    expect(ev.pull().filter(e => e.type === 'hop')).toHaveLength(1);
  });

  it('a cancel delivered in a step too short to tick is still applied on the next tick', () => {
    const sim = playing(humans(2));
    ticks(sim, 30, { p0: HOLD });
    sim.step(FIXED_DT / 4, { p0: { x: 0, z: 0, action: false, cancel: true } });
    const ev = collector(sim);
    ticks(sim, 5, { p0: IDLE });
    expect(ev.pull()).toHaveLength(0);
    expect(player(sim, 'p0').slamming).toBe(false);
    expect(player(sim, 'p0').charge).toBe(0);
  });

  it('cancel with action still held does not trigger on the following release', () => {
    const sim = playing(humans(2));
    ticks(sim, 30, { p0: HOLD });
    sim.step(FIXED_DT, { p0: { ...HOLD, cancel: true } });
    const ev = collector(sim);
    ticks(sim, 1, { p0: IDLE });
    expect(ev.pull()).toHaveLength(0);
    expect(player(sim, 'p0').slamming).toBe(false);
  });

  it('cooldown blocks a second charged slam until it expires (taps still hop)', () => {
    const sim = playing(humans(2));
    const ev = collector(sim);
    pressFor(sim, 'p0', 70);
    ticks(sim, 70);
    expect(ev.pull().filter(e => e.type === 'slam')).toHaveLength(1);
    const p0 = player(sim, 'p0');
    expect(p0.cooldown).toBeGreaterThan(1);
    pressFor(sim, 'p0', 20);
    expect(p0.slamming).toBe(false);
    expect(p0.charge).toBe(0);
    pressFor(sim, 'p0', 2);
    expect(ev.pull().filter(e => e.type === 'hop')).toHaveLength(1);
    ticks(sim, 120);
    expect(p0.cooldown).toBe(0);
    pressFor(sim, 'p0', 20);
    expect(p0.slamming).toBe(true);
  });

  it('a press just before landing is buffered into a hop', () => {
    const sim = playing(humans(2));
    const ev = collector(sim);
    pressFor(sim, 'p0', 2);
    const p0 = player(sim, 'p0');
    let guard = 0;
    while (!(p0.vy < 0 && p0.y < 0.3) && guard++ < 200) ticks(sim, 1);
    pressFor(sim, 'p0', 1);
    ticks(sim, 12);
    expect(ev.pull().filter(e => e.type === 'hop')).toHaveLength(2);
  });
});

describe('waves, knockback, rides and ring-outs', () => {
  function slamFromCenter(holdTicks: number, victimX: number, victimInput?: (sim: GameSimulation) => Input, arena: ArenaId = 'springyard') {
    const sim = playing(humans(2), { arena });
    place(sim, 'p0', 0, 0);
    place(sim, 'p1', victimX, 0);
    const ev = collector(sim);
    pressFor(sim, 'p0', holdTicks);
    for (let i = 0; i < 240; i++) sim.step(FIXED_DT, { p1: victimInput ? victimInput(sim) : IDLE });
    return { sim, events: ev.pull() };
  }

  it.each(ARENA_IDS)('a fully charged slam near the center rings out a player standing near the rim, with credit (%s)', arena => {
    const { sim, events } = slamFromCenter(70, 6.2, undefined, arena);
    expect(events.some(e => e.type === 'hit' && e.playerId === 'p1' && e.otherId === 'p0')).toBe(true);
    const ko = events.find(e => e.type === 'ko' && e.playerId === 'p1');
    expect(ko?.otherId).toBe('p0');
    expect(ko?.power).toBe(SCORING.knockout);
    expect(player(sim, 'p0').score).toBe(2);
    expect(player(sim, 'p0').knockouts).toBe(1);
    expect(player(sim, 'p1').falls).toBe(1);
    expect(player(sim, 'p1').score).toBe(0);
  });

  it.each(ARENA_IDS)('a minimum slam only nudges a mid-arena player (%s)', arena => {
    const { sim, events } = slamFromCenter(TUNING.tapTicks, 3, undefined, arena);
    expect(events.some(e => e.type === 'hit' && e.playerId === 'p1')).toBe(true);
    expect(events.some(e => e.type === 'ko')).toBe(false);
    expect(Math.hypot(player(sim, 'p1').x, player(sim, 'p1').z)).toBeLessThan(ARENAS.springyard.radius);
  });

  it.each(ARENA_IDS)('a well-timed hop rides the same wave instead of being knocked out (%s)', arena => {
    let tapped = 0;
    const surf = (sim: GameSimulation): Input => {
      const wave = sim.state.waves.find(w => w.owner === 'p0');
      if (!wave) return IDLE;
      const eta = (6.2 - TUNING.waveBand / 2 - wave.radius) / sim.state.arena.waveSpeed;
      if (tapped === 0 && eta < 0.1) tapped = 1;
      if (tapped > 0 && tapped < 3) { tapped++; return HOLD; }
      return IDLE;
    };
    const { sim, events } = slamFromCenter(70, 6.2, surf, arena);
    expect(events.some(e => e.type === 'ride' && e.playerId === 'p1' && e.otherId === 'p0')).toBe(true);
    expect(events.some(e => e.type === 'ko')).toBe(false);
    expect(player(sim, 'p1').rides).toBe(1);
    expect(player(sim, 'p1').falls).toBe(0);
  });

  it('a player high above the wave dodges it; an invincible player is immune', () => {
    const sim = playing(humans(3));
    place(sim, 'p0', 0, 0);
    place(sim, 'p1', 2, 0);
    place(sim, 'p2', -2, 0);
    player(sim, 'p2').invincible = 5;
    const ev = collector(sim);
    pressFor(sim, 'p0', 12);
    let guard = 0;
    while (!sim.state.waves.length && guard++ < 120) ticks(sim, 1);
    for (let i = 0; i < 30; i++) {
      Object.assign(player(sim, 'p1'), { y: 2.5, vy: 0, grounded: false });
      ticks(sim, 1);
    }
    const touched = ev.pull().filter(e => (e.type === 'hit' || e.type === 'ride') && e.playerId !== 'p0');
    expect(touched).toHaveLength(0);
    const wave = sim.state.waves.find(w => w.owner === 'p0');
    expect(wave?.hitIds).toEqual(expect.arrayContaining(['p0', 'p1', 'p2']));
  });

  it('crossing waves each hit a player exactly once, with no duplicates', () => {
    const sim = playing(humans(3));
    place(sim, 'p0', -3, 0);
    place(sim, 'p1', 3, 0);
    place(sim, 'p2', 0, 0.2);
    const ev = collector(sim);
    ticks(sim, 30, { p0: HOLD, p1: HOLD });
    ticks(sim, 1, { p0: IDLE, p1: IDLE });
    ticks(sim, 120);
    const events = ev.pull();
    expect(events.filter(e => e.type === 'slam')).toHaveLength(2);
    const hitsOnP2 = events.filter(e => e.type === 'hit' && e.playerId === 'p2');
    expect(hitsOnP2.length).toBeGreaterThanOrEqual(1);
    expect(new Set(hitsOnP2.map(e => e.otherId)).size).toBe(hitsOnP2.length);
    for (const w of sim.state.waves) expect(new Set(w.hitIds).size).toBe(w.hitIds.length);
  });

  it('walking off the rim is a self fall: -1, floored at 0, then a 1.4 s respawn with invincibility', () => {
    const sim = playing(humans(2));
    place(sim, 'p0', 6.6, 0);
    player(sim, 'p0').score = 3;
    const ev = collector(sim);
    let guard = 0;
    while (!ev.pull().some(e => e.type === 'ko') && guard++ < 300) sim.step(FIXED_DT, { p0: { x: 1, z: 0, action: false } });
    const ko = ev.seen.find(e => e.type === 'ko');
    expect(ko?.power).toBe(SCORING.selfFall);
    expect(ko?.otherId).toBeUndefined();
    const p0 = player(sim, 'p0');
    expect(p0.score).toBe(2);
    expect(p0.falls).toBe(1);
    expect(p0.respawnIn).toBeCloseTo(TUNING.respawnDelay, 6);
    ticks(sim, Math.round(TUNING.respawnDelay / FIXED_DT) - 1);
    expect(p0.respawnIn).toBeGreaterThan(0);
    ticks(sim, 1);
    expect(p0.respawnIn).toBe(0);
    expect(p0.invincible).toBeGreaterThan(TUNING.respawnInvincible - 2 * FIXED_DT);
    expect(Math.hypot(p0.x, p0.z)).toBeLessThan(ARENAS.springyard.radius - 2);
    expect(ev.pull().some(e => e.type === 'respawn' && e.playerId === 'p0')).toBe(true);

    p0.score = 0;
    place(sim, 'p0', 6.8, 0);
    guard = 0;
    while (ev.pull().filter(e => e.type === 'ko').length < 2 && guard++ < 300) sim.step(FIXED_DT, { p0: { x: 1, z: 0, action: false } });
    expect(p0.score).toBe(SCORING.minScore);
  });

  it('credits the last attacker only inside the credit window', () => {
    for (const [age, credited] of [[1, true], [SCORING.creditWindow + 0.5, false]] as const) {
      const sim = playing(humans(2));
      ticks(sim, 600);
      place(sim, 'p1', 6.8, 0);
      Object.assign(player(sim, 'p1'), { lastHitBy: 'p0', lastHitAt: sim.state.elapsed - age });
      for (let i = 0; i < 120; i++) sim.step(FIXED_DT, { p1: { x: 1, z: 0, action: false } });
      expect(player(sim, 'p0').score).toBe(credited ? 2 : 0);
      expect(player(sim, 'p1').falls).toBe(1);
    }
  });

  it('a falling player cannot climb back onto the floor', () => {
    const sim = playing(humans(2));
    place(sim, 'p0', 7.3, 0);
    ticks(sim, 3, { p0: { x: 1, z: 0, action: false } });
    ticks(sim, 30, { p0: { x: -1, z: 0, action: false } });
    expect(player(sim, 'p0').grounded).toBe(false);
    expect(player(sim, 'p0').y).toBeLessThan(0);
  });

  it('body checks push players apart and stamp attacker credit', () => {
    const sim = playing(humans(2));
    place(sim, 'p0', -1, 0);
    place(sim, 'p1', 0, 0);
    player(sim, 'p0').vx = 8;
    ticks(sim, 6, { p0: { x: 1, z: 0, action: false } });
    expect(player(sim, 'p1').x - player(sim, 'p0').x).toBeGreaterThanOrEqual(TUNING.playerRadius * 2 - 1e-6);
    expect(player(sim, 'p1').lastHitBy).toBe('p0');
    expect(player(sim, 'p1').vx).toBeGreaterThan(0);
  });

  it('aftershock telegraphs then fires arena-owned hazard waves', () => {
    const sim = playing(bots(0).concat(humans(2)), { arena: 'aftershock' });
    const ev = collector(sim);
    ticks(sim, 60 * 12);
    const hazards = ev.pull().filter(e => e.type === 'hazard');
    expect(hazards.length).toBeGreaterThanOrEqual(2);
    expect(hazards[0].power).toBe(0);
    expect(hazards[1].power).toBeGreaterThan(0);
    expect(hazards.every(e => e.playerId === ARENA_OWNER)).toBe(true);
  });

  it('exposes an analytic wave height that peaks on the ring', () => {
    const sim = playing(humans(2));
    place(sim, 'p0', 0, 0);
    place(sim, 'p1', 0, 6);
    pressFor(sim, 'p0', 60);
    let guard = 0;
    while (!sim.state.waves.some(w => w.radius > 2) && guard++ < 200) ticks(sim, 1);
    const w = sim.state.waves[0];
    expect(waveHeightAt(sim.state, w.x + w.radius, w.z)).toBeGreaterThan(0.1);
    expect(waveHeightAt(sim.state, w.x + w.radius + 2, w.z)).toBeLessThan(0.01);
  });
});

describe('determinism and long-run stability', () => {
  function botGame(seed: number, dt: number, seconds: number, arena: 'springyard' | 'moonbounce' | 'aftershock' = 'springyard') {
    const sim = new GameSimulation({ seed, duration: 120, arena });
    sim.setPlayers(bots(8));
    sim.start();
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) sim.step(dt);
    return sim;
  }

  it('same seed gives identical games; a different seed diverges', () => {
    const a = JSON.stringify(botGame(42, FIXED_DT, 40).state);
    const b = JSON.stringify(botGame(42, FIXED_DT, 40).state);
    const c = JSON.stringify(botGame(43, FIXED_DT, 40).state);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('results do not depend on the caller frame size', () => {
    const ref = botGame(9, FIXED_DT, 30).state;
    for (const dt of [1 / 30, 1 / 144, 0.05]) {
      const other = botGame(9, dt, 30).state;
      expect(other.tick).toBe(ref.tick);
      expect(JSON.stringify(other)).toBe(JSON.stringify(ref));
    }
  });

  it('a full 8-bot 120 s match on every arena stays bounded, finite and ends with no permanent elimination', () => {
    for (const arena of ['springyard', 'moonbounce', 'aftershock'] as const) {
      const sim = new GameSimulation({ seed: 77, duration: 120, arena });
      sim.setPlayers(bots(8));
      sim.start();
      let lastId = 0;
      let maxWaves = 0;
      let maxWaveId = 0;
      const counts: Record<string, number> = {};
      const respawned = new Set<string>();
      let guard = 0;
      const problems: string[] = [];
      while (sim.state.phase !== 'results' && guard++ < 20000) {
        sim.step(FIXED_DT);
        const s = sim.state;
        if (s.events.length > TUNING.eventBuffer) problems.push(`event buffer ${s.events.length}`);
        for (const e of s.events) {
          if (e.id <= lastId) continue;
          lastId = e.id;
          counts[e.type] = (counts[e.type] ?? 0) + 1;
          if (e.type === 'respawn') respawned.add(e.playerId);
        }
        for (let i = 1; i < s.events.length; i++) if (s.events[i].id <= s.events[i - 1].id) problems.push('event order');
        maxWaves = Math.max(maxWaves, s.waves.length);
        for (const w of s.waves) {
          if (w.id < 1 || new Set(w.hitIds).size !== w.hitIds.length || w.hitIds.length > 9) problems.push(`wave ${w.id}`);
          maxWaveId = Math.max(maxWaveId, w.id);
        }
        for (const p of s.players) {
          const values = [p.x, p.y, p.z, p.vx, p.vy, p.vz, p.charge, p.cooldown, p.respawnIn, p.invincible];
          if (!values.every(Number.isFinite)) problems.push(`non-finite ${p.id} @${s.tick}`);
          if (p.score < 0 || p.respawnIn > TUNING.respawnDelay + 1e-9) problems.push(`bounds ${p.id} @${s.tick}`);
        }
        if (problems.length) break;
      }
      expect(problems).toEqual([]);
      const s = sim.state;
      expect(s.phase).toBe('results');
      expect(maxWaves).toBeLessThanOrEqual(TUNING.waveCap);
      expect(counts.slam ?? 0).toBeGreaterThan(40);
      expect(counts.ko ?? 0).toBeGreaterThan(10);
      expect(counts.ride ?? 0).toBeGreaterThan(10);
      expect(counts.respawn ?? 0).toBeGreaterThanOrEqual((counts.ko ?? 0) - 8);
      expect(respawned.size).toBeGreaterThan(4);
      expect(s.winnerIds.length).toBeGreaterThan(0);
      const totalKo = s.players.reduce((n, p) => n + p.knockouts, 0);
      const totalFalls = s.players.reduce((n, p) => n + p.falls, 0);
      expect(totalKo).toBeLessThanOrEqual(totalFalls);
      if (arena === 'aftershock') expect(counts.hazard ?? 0).toBeGreaterThan(10);
    }
  }, 20_000);

  it('event ids keep increasing across reset and rematch', () => {
    const sim = botGame(5, FIXED_DT, 10);
    const before = Math.max(...sim.state.events.map(e => e.id));
    sim.reset();
    expect(sim.state.phase).toBe('lobby');
    sim.start();
    ticks(sim, 400);
    const after = sim.state.events.filter(e => e.type === 'start');
    expect(after).toHaveLength(1);
    expect(after[0].id).toBeGreaterThan(before);
  });
});
