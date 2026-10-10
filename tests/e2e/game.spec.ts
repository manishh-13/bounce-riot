import { test, expect, type Page } from '@playwright/test';
const BASE = process.env.BOUNCE_BASE_URL || 'http://127.0.0.1:4381/';
function gameUrl(hash = '') { return new URL(hash, BASE.endsWith('/') ? BASE : `${BASE}/`).href; }
const local = !process.env.BOUNCE_BASE_URL || process.env.BOUNCE_DEV_TEST === '1';
test.beforeEach(async ({ context }) => { await context.addInitScript(() => localStorage.setItem('bounce-riot-quality', JSON.stringify('low'))); });
async function openParty(host: Page) {
  await host.goto(gameUrl());
  await host.getByRole('button', { name: /Host a party/ }).click();
  await expect(host.locator('#room-code-display')).toHaveText(/^[A-Z0-9]{6}$/);
  return (await host.locator('#room-code-display').textContent())!;
}
async function joinPhone(phone: Page, code: string, name: string) {
  await phone.goto(gameUrl(`#join/${code}`));
  await phone.getByLabel('What should we call you?').fill(name);
  await phone.getByRole('button', { name: /Grab a controller/ }).click();
  await expect(phone.locator('#joypad')).toBeVisible();
  await phone.locator('#arm-controller').click();
  await expect(phone.locator('#controller-gate')).toBeHidden();
}
async function runFrames(page: Page, count: number) {
  await page.evaluate((n) => new Promise<void>(resolve => {
    let i = 0; const next = () => { if (++i >= n) resolve(); else requestAnimationFrame(next); }; requestAnimationFrame(next);
  }), count);
}
test('homepage is a rendered 3D game with keyboard-accessible actions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(gameUrl());
  await expect(page.getByRole('heading', { name: /Good friends/ })).toBeVisible();
  await expect(page.locator('#arena-view canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: /Host a party/ })).toBeVisible();
  await page.getByRole('button', { name: /Try it with bots/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#lobby-roster .roster-player')).toHaveCount(4);
  await expect(page.locator('#start-button')).toBeEnabled();
  expect(errors).toEqual([]);
});
test('practice has actual movement, slams, pause, results and rematch', async ({ page }) => {
  test.skip(!local, 'Development inspection is excluded from the deployed game.');
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(gameUrl('#practice'));
  await page.locator('#duration-select').selectOption('30');
  await page.locator('#start-button').click();
  await expect(page.locator('#round-callout')).toBeVisible();
  await expect(page.locator('#round-callout')).toBeHidden({ timeout: 30000 });
  const before = await page.evaluate(() => (window as any).__bounce.sim.state.players.find((p: any) => p.id === 'keyboard').x);
  await page.keyboard.down('ArrowRight');
  await runFrames(page, 20);
  await page.keyboard.up('ArrowRight');
  const after = await page.evaluate(() => (window as any).__bounce.sim.state.players.find((p: any) => p.id === 'keyboard').x);
  expect(after).toBeGreaterThan(before + 0.2);
  await page.keyboard.down('Space');
  await expect(async () => expect(await page.evaluate(() => (window as any).__bounce.sim.state.players.find((p: any) => p.id === 'keyboard').charge)).toBeGreaterThan(0.1)).toPass();
  await page.keyboard.up('Space');
  await expect(async () => expect(await page.evaluate(() => (window as any).__bounce.sim.state.events.some((e: any) => e.type === 'slam' && e.playerId === 'keyboard'))).toBeTruthy()).toPass();
  await page.locator('#pause-button').click();
  await expect(page.locator('#pause-panel')).toBeVisible();
  const paused = await page.evaluate(() => (window as any).__bounce.sim.state.remaining);
  await runFrames(page, 12);
  expect(await page.evaluate(() => (window as any).__bounce.sim.state.remaining)).toBe(paused);
  await page.locator('#resume-button').click();
  await page.evaluate(() => { const s = (window as any).__bounce.sim; for (let i = 0; i < 2400; i++) s.step(1 / 60); });
  await expect(page.locator('#result-panel')).toBeVisible();
  await expect(page.locator('#results-list li')).toHaveCount(4);
  await page.locator('#rematch-button').click();
  await expect(page.locator('#round-callout')).toBeVisible();
  expect(errors).toEqual([]);
});
test('two phones pair, captain starts, peer input moves the TV player, reconnect keeps the slot', async ({ browser, page: host }) => {
  const code = await openParty(host);
  const c1 = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p1 = await c1.newPage(), p2 = await c2.newPage();
  const errors: string[] = [];
  for (const p of [host, p1, p2]) p.on('pageerror', e => errors.push(e.message));
  await joinPhone(p1, code, 'Nova');
  await joinPhone(p2, code, 'Mochi');
  await expect(host.locator('#lobby-roster .roster-player')).toHaveCount(2);
  await expect(p1.locator('#captain-action')).toBeVisible();
  await expect(p2.locator('#captain-action')).toBeHidden();
  await expect(p1.locator('#controller-connection')).toHaveText('DIRECT TO TV', { timeout: 25000 });
  await p1.locator('#captain-action').click();
  await expect(p1.locator('#controller-phase')).toHaveText('BOUNCE RIOT', { timeout: 30000 });
  await expect(host.locator('#round-callout')).toBeHidden();
  const stick = await p1.locator('#move-zone').boundingBox();
  expect(stick).toBeTruthy();
  if (local) {
    const before = await host.evaluate(() => (window as any).__bounce.sim.state.players.find((p: any) => p.name === 'Nova').x);
    await p1.mouse.move(stick!.x + stick!.width / 2, stick!.y + stick!.height / 2);
    await p1.mouse.down();
    await p1.mouse.move(stick!.x + stick!.width / 2 + 45, stick!.y + stick!.height / 2);
    await expect(async () => expect(await host.evaluate(() => (window as any).__bounce.sim.state.players.find((p: any) => p.name === 'Nova').x)).toBeGreaterThan(before + 0.15)).toPass();
    await p1.mouse.up();
  }
  const slot = await p2.locator('#player-number').textContent();
  await p2.reload();
  await p2.getByRole('button', { name: /Grab a controller/ }).click();
  await expect(p2.locator('#joypad')).toBeVisible();
  await expect(p2.locator('#player-number')).toHaveText(slot!);
  await expect(host.locator('#score-strip .score-item')).toHaveCount(2);
  await expect(p2.locator('#controller-name')).toHaveText('Mochi');
  expect(await p1.evaluate(() => getComputedStyle(document.querySelector('#joypad')!).touchAction)).toBe('none');
  expect(await p1.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
  await c1.close(); await c2.close();
});
test('relay fallback works when the phone has no WebRTC', async ({ browser, page: host }) => {
  const code = await openParty(host);
  await host.locator('#add-bot').click();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await context.addInitScript(() => { Object.defineProperty(window, 'RTCPeerConnection', { value: undefined, configurable: true }); });
  const phone = await context.newPage();
  await joinPhone(phone, code, 'Relay');
  await expect(phone.locator('#controller-connection')).toHaveText('CONNECTED VIA RELAY');
  await phone.locator('#captain-action').click();
  await expect(phone.locator('#controller-phase')).toHaveText('BOUNCE RIOT', { timeout: 30000 });
  await phone.locator('#controller-menu').click();
  await phone.locator('#captain-pause').click();
  await expect(host.locator('#pause-panel')).toBeVisible();
  await context.close();
});
test('bad room shows a useful error and does not open a fake controller', async ({ page }) => {
  await page.goto(gameUrl('#join/ZZZZZZ'));
  await page.locator('#player-name').fill('Lost');
  await page.locator('#join-button').click();
  await expect(page.locator('#join-message')).not.toHaveText('Finding your room...');
  await expect(page.locator('#joypad')).toBeHidden();
  await expect(page.locator('#join-button')).toBeEnabled();
});
