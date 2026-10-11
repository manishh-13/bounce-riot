import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLAYER_COLORS } from '../../src/game/types';
import { identitySlot, identitySvg, playerIdentity } from '../../src/ui/player-identity';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const slots = [0, 1, 2, 3, 4, 5, 6, 7];

describe('player identity contract', () => {
  it('names every seat with its palette colour and a distinct accessory', () => {
    const identities = slots.map(playerIdentity);
    expect(identities.map(i => i.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(identities.map(i => i.slot)).toEqual(slots);
    expect(identities.map(i => i.color)).toEqual([...PLAYER_COLORS]);
    expect(identities.map(i => i.colorName)).toEqual(['Coral', 'Blue', 'Gold', 'Purple', 'Green', 'Pink', 'Orange', 'Sky blue']);
    expect(new Set(identities.map(i => i.accessory)).size).toBe(8);
    expect(identities.map(i => i.accessory)).toEqual(['headband', 'cap', 'party-hat', 'cat-ears', 'sprout', 'bow', 'antenna', 'bunny-ears']);
    for (const identity of identities) expect(identity.accessoryLabel).toMatch(/^[a-z ]+$/);
  });

  it('sanitizes anything that is not a seat number to the first seat', () => {
    for (const bad of [NaN, Infinity, -Infinity, -1, 8, 99, 3.7, -0.9, Number('x')]) expect(identitySlot(bad)).toBe(0);
    for (const bad of [undefined, null, 'three', {}]) expect(playerIdentity(bad as unknown as number).slot).toBe(0);
    for (const slot of slots) expect(identitySlot(slot)).toBe(slot);
    expect(playerIdentity('5' as unknown as number).number).toBe(6);
    expect(playerIdentity(NaN).color).toBe(PLAYER_COLORS[0]);
  });
});

describe('phone mascot preview', () => {
  it('paints each seat in its own colour with no engine dependency', () => {
    const module = read('src/ui/player-identity.ts');
    expect(module).not.toContain("from 'three'");
    expect(module).not.toContain('getContext');
    for (const slot of slots) {
      const identity = playerIdentity(slot);
      const svg = identitySvg(identity);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain(identity.color);
      expect(svg).toContain(`the ${identity.colorName.toLowerCase()} mascot with the ${identity.accessoryLabel}`);
      expect(svg).not.toContain('<script');
      expect(svg).not.toContain('<image');
    }
    expect(new Set(slots.map(slot => identitySvg(playerIdentity(slot)))).size).toBe(8);
  });

  it('reuses the accessory hues the renderer gives the same slot', () => {
    const source = read('src/render/character.ts');
    const body = source.slice(source.indexOf('function buildAccessories'), source.indexOf('return out;'));
    const blocks = body.split(/\n  \{\n/).slice(1);
    expect(blocks).toHaveLength(8);
    for (const slot of slots) {
      const hues = [...new Set(blocks[slot].match(/#[0-9a-f]{6}/g) ?? [])].filter(h => h !== '#ffffff');
      expect(hues.length).toBeGreaterThan(0);
      const svg = identitySvg(playerIdentity(slot));
      expect(hues.filter(hue => svg.includes(hue)).length).toBeGreaterThan(0);
    }
  });
});

describe('controller identity wiring', () => {
  const controller = read('src/ui/controller.ts');
  const styles = read('src/ui/identity.css');
  it('keeps nicknames and labels in pine, with the colour name as the only tinted heading', () => {
    const tinted = styles.match(/\.identity-[a-z]+\{[^}]*var\(--player-color\)[^}]*\}/g) ?? [];
    expect(tinted).toHaveLength(1);
    expect(tinted[0]).toContain('.identity-headline');
    expect(styles).toMatch(/\.identity-nickname\{[^}]*color:var\(--ink\)/);
    expect(styles).toMatch(/\.identity-color\{[^}]*color:var\(--ink\)/);
  });
  it('reveals the identity in the existing gate without a new step', () => {
    expect(controller).toContain("import './identity.css'");
    expect(controller).toContain('applyIdentity(info.slot, name)');
    expect(controller).toContain('id="identity-reveal"');
    expect(controller).toContain('id="controller-color-name"');
    expect(controller).toContain("$('#identity-nickname').textContent = nickname");
    expect(controller).toContain("$('#identity-headline').textContent = `You're the ${identity.colorName.toLowerCase()} player.`");
    expect(controller).not.toContain("$('#identity-nickname').innerHTML");
    const gateButtons = controller.match(/id="arm-controller"/g) ?? [];
    expect(gateButtons).toHaveLength(1);
  });
  it('keeps the gate title owned by pause and resume, not by status frames', () => {
    const renderStatus = controller.slice(controller.indexOf('function renderStatus'), controller.indexOf('async function join'));
    expect(renderStatus).not.toContain('gate-title');
    expect(controller).toContain("$('#gate-title').textContent = 'Welcome back.'");
    expect(controller).toContain("$('#gate-title').textContent = 'Controller paused.'");
  });
  it('saves the seat so a reconnecting phone shows the same identity', () => {
    expect(controller).toContain('name, slot: info.slot');
    expect(controller).toContain("typeof saved.slot === 'number'");
  });
});
