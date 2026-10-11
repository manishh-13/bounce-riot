import { test, expect } from '@playwright/test';
import type { ArenaId } from '../../src/game/types';
import type { GameSimulation } from '../../src/game/simulation';
import type { ArenaScene } from '../../src/render/scene';

declare global {
  interface Window { __bounce?: { sim: GameSimulation; scene: ArenaScene }; }
}

const local = !process.env.BOUNCE_BASE_URL || process.env.BOUNCE_DEV_TEST === '1';
const cases: { arena: ArenaId; quality: 'low' | 'high'; reducedMotion: 'reduce' | 'no-preference' }[] = [
  { arena: 'springyard', quality: 'low', reducedMotion: 'no-preference' },
  { arena: 'moonbounce', quality: 'low', reducedMotion: 'no-preference' },
  { arena: 'aftershock', quality: 'low', reducedMotion: 'reduce' },
  { arena: 'springyard', quality: 'high', reducedMotion: 'no-preference' },
];

for (const spec of cases) {
  test(`${spec.arena} ${spec.quality}: lagoon, coloured waves and eight mascots compile within the TV budget`, async ({ page }) => {
    test.skip(!local, 'The renderer inspection surface is not shipped in production.');
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ reducedMotion: spec.reducedMotion });
    await page.addInitScript(quality => localStorage.setItem('bounce-riot-quality', JSON.stringify(quality)), spec.quality);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('#practice');
    await page.locator('#arena-select').selectOption(spec.arena);
    for (let i = 0; i < 4; i++) await page.locator('#add-bot').click();
    await page.locator('#start-button').click();
    const result = await page.evaluate(() => {
      const { sim, scene } = window.__bounce!;
      for (let i = 0; i < 200; i++) sim.step(1 / 60);
      const state = structuredClone(sim.state);
      state.events = [];
      state.players.forEach((player, i) => {
        const angle = i * Math.PI / 4;
        Object.assign(player, { x: Math.cos(angle) * 3.5, z: Math.sin(angle) * 3.5, y: 0, grounded: true, charge: 0, respawnIn: 0, invincible: 0, slamming: false, hitFlash: 0, score: 0 });
      });
      state.waves = [{ id: 99, owner: state.players[0].id, color: 0, x: 0, z: 0, radius: 3, prevRadius: 2.9, age: 0.5, power: 1, maxRadius: 12, hitIds: [] }];
      for (let i = 0; i < 30; i++) scene.render(state, 1 / 60);
      const stats = scene.getStats();
      return { stats, arena: state.arena.id, board: scene.getBoardBounds() };
    });
    expect(result.arena).toBe(spec.arena);
    expect(result.stats.quality).toBe(spec.quality);
    expect(result.stats.calls).toBeGreaterThan(100);
    expect(result.stats.calls).toBeLessThanOrEqual(145);
    expect(result.stats.triangles).toBeGreaterThan(25_000);
    expect(result.stats.triangles).toBeLessThanOrEqual(spec.quality === 'low' ? 65_000 : 150_000);
    expect(result.board.right - result.board.left).toBeGreaterThan(635);
    expect(result.board.right - result.board.left).toBeLessThan(710);
    expect(result.board.top).toBeGreaterThan(130);
    expect(result.board.bottom).toBeLessThan(680);
    expect(result.board.left).toBeGreaterThan(0);
    expect(result.board.right).toBeLessThan(1280);
    expect(errors).toEqual([]);
    await expect(page.locator('#arena-view canvas')).toBeVisible();
  });
}
