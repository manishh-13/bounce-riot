import { test, expect, type Page } from '@playwright/test';
import WebSocket from 'ws';
const BASE = process.env.BOUNCE_BASE_URL || 'http://127.0.0.1:4381/';
const local = !process.env.BOUNCE_BASE_URL;
interface Captured { kind?: string; seq?: number; x?: number; z?: number; action?: boolean; cancel?: boolean; }
async function fixtureHost() {
  const inputs: Captured[] = [];
  const socket = new WebSocket('ws://127.0.0.1:4382');
  const code = await new Promise<string>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ action: 'create' })));
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'created') resolve(message.room);
      if (message.type === 'relay' && message.data?.kind === 'input') inputs.push(message.data);
      if (message.type === 'relay' && message.data?.kind === 'hello') socket.send(JSON.stringify({ action: 'relay', to: message.from, data: { kind: 'status', phase: 'playing', remaining: 90, countdown: 0, score: 0, name: 'Touch', color: 0, charge: 0, cooldown: 0, captain: true, players: [] } }));
    });
  });
  return { code, inputs, close() { socket.send(JSON.stringify({ action: 'close' })); socket.close(); } };
}
async function enter(page: Page, code: string) {
  await page.goto(new URL(`#join/${code}`, BASE).href);
  await page.locator('#player-name').fill('Touch');
  await page.locator('#join-button').click();
  await expect(page.locator('#joypad')).toBeVisible();
  await page.locator('#arm-controller').click();
  await expect(page.locator('#controller-gate')).toBeHidden();
}
test('actual simultaneous touches move and charge without scrolling; cancellation never attacks', async ({ browser }) => {
  test.skip(!local, 'The capture fixture runs only against the local service.');
  const fixture = await fixtureHost();
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await enter(page, fixture.code);
  const cdp = await context.newCDPSession(page);
  const move = await page.locator('#move-zone').boundingBox();
  const slam = await page.locator('#slam-button').boundingBox();
  const sx = move!.x + move!.width / 2, sy = move!.y + move!.height / 2;
  const ax = slam!.x + slam!.width / 2, ay = slam!.y + slam!.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, id: 1 }, { x: ax, y: ay, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + 40, y: sy, id: 1 }, { x: ax, y: ay, id: 2 }] });
  await expect.poll(() => fixture.inputs.some(i => Number(i.x) > 0.4 && i.action === true)).toBe(true);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  const cut = fixture.inputs.length;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect.poll(() => fixture.inputs.slice(cut).some(i => i.cancel === true && !i.action && i.x === 0)).toBe(true);
  expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('joypad');
  await context.close(); fixture.close();
});
test('fullscreen exit neutralizes controls and requires a deliberate resume', async ({ browser }) => {
  test.skip(!local, 'The capture fixture runs only against the local service.');
  const fixture = await fixtureHost();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await enter(page, fixture.code);
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator('#controller-gate')).toBeVisible();
  await expect(page.locator('#arm-controller')).toHaveText('Return to fullscreen');
  await expect.poll(() => fixture.inputs.at(-1)?.cancel).toBe(true);
  await page.locator('#arm-controller').click();
  await expect(page.locator('#controller-gate')).toBeHidden();
  await expect(page.locator('#joypad')).toBeVisible();
  await context.close(); fixture.close();
});
test('iPhone fallback explains Add to Home Screen without pretending fullscreen works', async ({ browser }) => {
  test.skip(!local, 'The capture fixture runs only against the local service.');
  const fixture = await fixtureHost();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
  await context.addInitScript(() => Object.defineProperty(Element.prototype, 'requestFullscreen', { value: undefined }));
  const page = await context.newPage();
  await page.goto(new URL(`#join/${fixture.code}`, BASE).href);
  await page.locator('#player-name').fill('Touch');
  await page.locator('#join-button').click();
  await expect(page.locator('#fullscreen-hint')).toContainText('Add to Home Screen');
  await expect(page.locator('#arm-controller')).toHaveText('Play in this browser');
  await page.locator('#arm-controller').click();
  await expect(page.locator('#controller-gate')).toBeHidden();
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close(); fixture.close();
});

test('locking or backgrounding the phone clears held input before resume', async ({ browser }) => {
  test.skip(!local, 'The capture fixture runs only against the local service.');
  const fixture = await fixtureHost();
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(); await enter(page, fixture.code);
  const button = await page.locator('#slam-button').boundingBox();
  await page.mouse.move(button!.x + button!.width / 2, button!.y + button!.height / 2); await page.mouse.down();
  await expect.poll(() => fixture.inputs.at(-1)?.action).toBe(true);
  const cut = fixture.inputs.length;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => fixture.inputs.slice(cut).some(i => i.cancel === true && i.action === false)).toBe(true);
  await page.mouse.up();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#controller-gate')).toBeVisible();
  await expect(page.locator('#gate-title')).toHaveText('Welcome back.');
  await page.locator('#arm-controller').click(); await expect(page.locator('#controller-gate')).toBeHidden();
  await context.close(); fixture.close();
});
