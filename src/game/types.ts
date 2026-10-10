export const PLAYER_COLORS = ['#f65d46', '#467cff', '#f1c94c', '#b18aff', '#53c99a', '#ed83bc', '#f99b43', '#a6cedd'] as const;
export const MAX_PLAYERS = 8;
export type Phase = 'lobby' | 'countdown' | 'playing' | 'results' | 'paused';
export type ArenaId = 'springyard' | 'moonbounce' | 'aftershock';
export interface PlayerSpec { id: string; name: string; color: number; bot?: boolean; connected?: boolean; }
export interface Input { x: number; z: number; action: boolean; cancel?: boolean; }
export interface PlayerState extends PlayerSpec {
  x: number; z: number; y: number; vx: number; vz: number; vy: number;
  facing: number; charge: number; cooldown: number; grounded: boolean;
  score: number; knockouts: number; falls: number; rides: number;
  respawnIn: number; invincible: number; hitFlash: number;
  lastHitBy: string | null; lastHitAt: number; actionHeld: number;
  slamming: boolean; slamPower: number;
}
export interface Wave {
  id: number; owner: string; x: number; z: number; radius: number; prevRadius: number;
  power: number; age: number; maxRadius: number; hitIds: string[]; color: number;
}
export interface GameEvent {
  id: number; type: 'hop' | 'slam' | 'hit' | 'ride' | 'ko' | 'respawn' | 'start' | 'finish' | 'hazard';
  playerId: string; otherId?: string; x: number; z: number; power: number;
}
export interface ArenaConfig { id: ArenaId; name: string; radius: number; gravity: number; waveSpeed: number; description: string; }
export interface GameState {
  phase: Phase; players: PlayerState[]; waves: Wave[]; events: GameEvent[];
  elapsed: number; duration: number; remaining: number; countdown: number;
  arena: ArenaConfig; winnerIds: string[]; round: number; tick: number;
}
export interface GameOptions { duration?: number; arena?: ArenaId; seed?: number; }
