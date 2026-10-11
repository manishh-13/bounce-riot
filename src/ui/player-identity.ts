import { PLAYER_COLORS } from '../game/types';

export type AccessoryId = 'headband' | 'cap' | 'party-hat' | 'cat-ears' | 'sprout' | 'bow' | 'antenna' | 'bunny-ears';

export interface PlayerIdentity {
  slot: number;
  number: number;
  color: string;
  colorName: string;
  accessory: AccessoryId;
  accessoryLabel: string;
}

const COLOR_NAMES = ['Coral', 'Blue', 'Gold', 'Purple', 'Green', 'Pink', 'Orange', 'Sky blue'] as const;

interface Accessory {
  id: AccessoryId;
  label: string;
  // Drawn behind the body when the real mascot piece sits on the skull, in front when it lies on it.
  behind?: string;
  front?: string;
}

// Accessory hues are copied from the renderer so the phone preview matches the mascot on the TV.
const ACCESSORIES: Accessory[] = [
  {
    id: 'headband', label: 'headband and tuft',
    behind: '<path d="M50 18 L59 -5 L64 19 Z" fill="#c8392b"/><path d="M39 19 L29 1 L47 20 Z" fill="#c8392b"/>',
    front: '<path d="M13 28 Q50 48 87 28 L87 39 Q50 59 13 39 Z" fill="#fffaf0"/><path d="M15 33 Q50 52 85 33 L85 37 Q50 56 15 37 Z" fill="#ff4b3a"/>',
  },
  {
    id: 'cap', label: 'peaked cap',
    front: '<ellipse cx="59" cy="38" rx="27" ry="6" fill="#ffb21f" transform="rotate(-5 59 38)"/><path d="M19 37 A31 22 0 0 1 81 37 Z" fill="#ffd23f"/><circle cx="50" cy="14" r="4" fill="#2f5fd9"/>',
  },
  {
    id: 'party-hat', label: 'party hat',
    front: '<path d="M36 17 L64 10 L59 -9 Z" fill="#ff6fa8"/><ellipse cx="50" cy="18" rx="15" ry="4.5" fill="#ffffff"/><circle cx="59" cy="-12" r="6.5" fill="#ffffff"/>',
  },
  {
    id: 'cat-ears', label: 'cat ears',
    behind: '<path d="M30 31 L21 5 L45 25 Z" fill="#8d63e8"/><path d="M31 27 L26 12 L40 23 Z" fill="#ffb6d0"/><path d="M70 31 L79 5 L55 25 Z" fill="#8d63e8"/><path d="M69 27 L74 12 L60 23 Z" fill="#ffb6d0"/>',
  },
  {
    id: 'sprout', label: 'leaf sprout',
    behind: '<rect x="48" y="-4" width="4" height="24" rx="2" fill="#3f9a5f"/><ellipse cx="63" cy="-3" rx="13" ry="4.5" fill="#7fdc5a" transform="rotate(-24 63 -3)"/><ellipse cx="38" cy="2" rx="11" ry="4" fill="#62c447" transform="rotate(27 38 2)"/>',
  },
  {
    id: 'bow', label: 'ribbon bow',
    front: '<g transform="rotate(-16 67 24)"><path d="M67 24 L51 15 L51 33 Z" fill="#ff3f7f"/><path d="M67 24 L83 15 L83 33 Z" fill="#ff3f7f"/><circle cx="67" cy="24" r="5.5" fill="#ffd1e3"/></g>',
  },
  {
    id: 'antenna', label: 'bobble antenna',
    behind: '<path d="M49 18 L45 -5" stroke="#4a3a33" stroke-width="3.2" stroke-linecap="round"/><circle cx="44" cy="-9" r="6.5" fill="#3f8cff"/>',
    front: '<ellipse cx="50" cy="17" rx="6" ry="3" fill="#4a3a33"/>',
  },
  {
    id: 'bunny-ears', label: 'bunny ears',
    behind: '<g transform="rotate(-13 38 16)"><ellipse cx="38" cy="-3" rx="6" ry="19" fill="#ffffff"/><ellipse cx="38" cy="-2" rx="3.2" ry="13" fill="#ffb0c4"/></g><g transform="rotate(13 62 16)"><ellipse cx="62" cy="-3" rx="6" ry="19" fill="#ffffff"/><ellipse cx="62" cy="-2" rx="3.2" ry="13" fill="#ffb0c4"/></g>',
  },
];

// Anything that is not a real seat number falls back to seat 0, so a stray frame can never blank the reveal.
export function identitySlot(slot: number): number {
  const value = Number(slot);
  return Number.isInteger(value) && value >= 0 && value < PLAYER_COLORS.length ? value : 0;
}

export function playerIdentity(slot: number): PlayerIdentity {
  const index = identitySlot(slot);
  const accessory = ACCESSORIES[index];
  return {
    slot: index,
    number: index + 1,
    color: PLAYER_COLORS[index],
    colorName: COLOR_NAMES[index],
    accessory: accessory.id,
    accessoryLabel: accessory.label,
  };
}

function channels(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function mix(hex: string, other: string, amount: number): string {
  const a = channels(hex), b = channels(other);
  const out = a.map((c, i) => Math.round(c + (b[i] - c) * amount));
  return `#${out.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

// A flat SVG twin of the renderer mascot: no Three.js, no WebGL, nothing to warm up on a phone.
export function identitySvg(identity: PlayerIdentity): string {
  const body = identity.color;
  const limb = mix(body, '#20372d', 0.18);
  const foot = mix(body, '#20372d', 0.34);
  const belly = mix(mix(body, '#fff4e0', 0.62), '#ffffff', 0.1);
  const accessory = ACCESSORIES[identity.slot];
  return `<svg viewBox="-8 -24 116 158" class="identity-mascot" role="img" aria-label="Player ${identity.number}, the ${identity.colorName.toLowerCase()} mascot with the ${identity.accessoryLabel}">`
    + `<ellipse cx="50" cy="123" rx="31" ry="6" fill="#223e36" opacity="0.14"/>`
    + (accessory.behind ?? '')
    + `<ellipse cx="33" cy="114" rx="14" ry="8" fill="${foot}"/><ellipse cx="67" cy="114" rx="14" ry="8" fill="${foot}"/>`
    + `<rect x="1" y="66" width="13" height="26" rx="6.5" fill="${limb}"/><rect x="86" y="66" width="13" height="26" rx="6.5" fill="${limb}"/>`
    + `<path d="M50 16 C72 16 90 38 90 68 C90 97 72 112 50 112 C28 112 10 97 10 68 C10 38 28 16 50 16 Z" fill="${body}"/>`
    + `<ellipse cx="50" cy="80" rx="20" ry="17" fill="${belly}"/>`
    + `<ellipse cx="26" cy="62" rx="7" ry="4" fill="#ff8f9c" opacity="0.75"/><ellipse cx="74" cy="62" rx="7" ry="4" fill="#ff8f9c" opacity="0.75"/>`
    + `<ellipse cx="38" cy="50" rx="7.5" ry="9.5" fill="#ffffff"/><ellipse cx="62" cy="50" rx="7.5" ry="9.5" fill="#ffffff"/>`
    + `<ellipse cx="39" cy="51.5" rx="5" ry="6.4" fill="#241a1a"/><ellipse cx="63" cy="51.5" rx="5" ry="6.4" fill="#241a1a"/>`
    + `<circle cx="41" cy="47" r="2.2" fill="#ffffff"/><circle cx="65" cy="47" r="2.2" fill="#ffffff"/>`
    + `<path d="M42 64 Q50 73 58 64" fill="none" stroke="#3a2324" stroke-width="3.4" stroke-linecap="round"/>`
    + (accessory.front ?? '')
    + `</svg>`;
}
