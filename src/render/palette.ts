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
    floorInner: '#a5ecd2', floorOuter: '#7fd9bb', cream: '#fff6e2', line: '#fffaf0', accent: '#ff7b63', accent2: '#ffc94d',
    rimA: '#ff7a64', rimB: '#fff1dc', frame: '#5fb8c9', dish: '#fbe9cf', spring: '#ffcf4a',
    skyTop: '#7cc8ff', skyHorizon: '#ffe8c8', skyLow: '#ffd2b8', emblem: 'spring',
  },
  moonbounce: {
    floorInner: '#cfc3ff', floorOuter: '#ad9bf2', cream: '#fff6ea', line: '#fffaf4', accent: '#5fb4ff', accent2: '#ffd86b',
    rimA: '#7a8cff', rimB: '#fff1e4', frame: '#ffb6c9', dish: '#f6ecff', spring: '#ffd86b',
    skyTop: '#8aa7ff', skyHorizon: '#ffe0ef', skyLow: '#f5c9e6', emblem: 'moon',
  },
  aftershock: {
    floorInner: '#ffd9b0', floorOuter: '#ffbb86', cream: '#fff5e4', line: '#fffaf0', accent: '#ff5a3d', accent2: '#3f4b6b',
    rimA: '#ff6248', rimB: '#fff0d8', frame: '#4f6fa3', dish: '#ffe7cc', spring: '#ff9d3c',
    skyTop: '#ffb27c', skyHorizon: '#ffe7c4', skyLow: '#ffc5a8', emblem: 'hazard',
  },
};

export function themeFor(id: string | undefined): ArenaTheme {
  return (id && (THEMES as Record<string, ArenaTheme>)[id]) || THEMES.springyard;
}
