import { Color } from 'three';
import { PLAYER_COLORS, type ArenaId } from '../game/types';

export type Quality = 'auto' | 'low' | 'high';
export type ResolvedQuality = 'low' | 'high';

const COLOR_CACHE = new Map<number, string>();

// Simulation colors may be a palette slot (0..7) or a packed 0xRRGGBB number.
export function colorHex(value: number): string {
  const cached = COLOR_CACHE.get(value);
  if (cached) return cached;
  let hex: string;
  if (Number.isInteger(value) && value >= 0 && value < PLAYER_COLORS.length) hex = PLAYER_COLORS[value];
  else if (Number.isFinite(value) && value >= 0) hex = `#${(Math.floor(value) & 0xffffff).toString(16).padStart(6, '0')}`;
  else hex = PLAYER_COLORS[0];
  COLOR_CACHE.set(value, hex);
  return hex;
}

export function slotOf(value: number, fallback: number): number {
  if (Number.isInteger(value) && value >= 0 && value < PLAYER_COLORS.length) return value;
  const hex = colorHex(value).toLowerCase();
  const idx = PLAYER_COLORS.findIndex((c) => c.toLowerCase() === hex);
  return idx >= 0 ? idx : fallback % PLAYER_COLORS.length;
}

export function shade(hex: string, amount: number): Color {
  const c = new Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, hsl.s * (amount < 0 ? 1.05 : 0.9)), Math.max(0, Math.min(1, hsl.l + amount)));
  return c;
}

export interface ArenaTheme {
  floorInner: string;
  floorOuter: string;
  cream: string;
  line: string;
  accent: string;
  accent2: string;
  rimA: string;
  rimB: string;
  frame: string;
  dish: string;
  spring: string;
  skyTop: string;
  skyHorizon: string;
  skyLow: string;
  emblem: 'spring' | 'moon' | 'hazard';
}

export const THEMES: Record<ArenaId, ArenaTheme> = {
  springyard: {
    floorInner: '#508f7e', floorOuter: '#306b60', cream: '#fff4dd', line: '#e6fff1', accent: '#f35c3f', accent2: '#ffbd2d',
    rimA: '#f4583b', rimB: '#fff0d7', frame: '#426658', dish: '#edcea4', spring: '#f9ba28',
    skyTop: '#7cc8ff', skyHorizon: '#ffe8c8', skyLow: '#ffd2b8', emblem: 'spring',
  },
  moonbounce: {
    floorInner: '#82799e', floorOuter: '#595c82', cream: '#fff3e5', line: '#f5ecff', accent: '#2c91e9', accent2: '#ffcd3d',
    rimA: '#5a71eb', rimB: '#fff0df', frame: '#4c526b', dish: '#d4c4ed', spring: '#ffc63c',
    skyTop: '#8aa7ff', skyHorizon: '#ffe0ef', skyLow: '#f5c9e6', emblem: 'moon',
  },
  aftershock: {
    floorInner: '#c29157', floorOuter: '#996b3e', cream: '#fff3dd', line: '#fff4d9', accent: '#eb4b2f', accent2: '#354c61',
    rimA: '#ed4c30', rimB: '#fff0d5', frame: '#594b39', dish: '#e9c397', spring: '#f79427',
    skyTop: '#ffb27c', skyHorizon: '#ffe7c4', skyLow: '#ffc5a8', emblem: 'hazard',
  },
};

export function themeFor(id: string | undefined): ArenaTheme {
  return (id && (THEMES as Record<string, ArenaTheme>)[id]) || THEMES.springyard;
}
