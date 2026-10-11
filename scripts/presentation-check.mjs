import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { startLocalServer } from '../server/local.mjs';

const base = process.env.BOUNCE_BASE_URL || 'http://127.0.0.1:4381/';
const local = ['localhost', '127.0.0.1'].includes(new URL(base).hostname);
const output = new URL('../.artifacts/presentation/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const service = local ? await startLocalServer({ host: '127.0.0.1', port: 4382, log: () => {} }) : null;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const errors = [];
try {
  const host = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  host.on('pageerror', e => errors.push(e.message));
  await host.addInitScript(() => {
    localStorage.setItem('bounce-riot-quality', '"low"');
    localStorage.setItem('bounce-riot-sound', 'false');
  });
  await host.goto(base);
  await host.locator('#host-button').waitFor({ state: 'visible' });
  await host.evaluate(() => document.fonts.ready);
  await host.screenshot({ path: `${output}home.png`, timeout: 60000 });
  await host.locator('#host-button').click();
  await host.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.querySelector('#room-code-display')?.textContent ?? ''));
  const room = await host.locator('#room-code-display').textContent();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await context.newPage();
  phone.on('pageerror', e => errors.push(e.message));
  await phone.goto(new URL(`#join/${room}`, base).href);
  await phone.locator('#player-name').fill('Manish');
  await phone.locator('#join-button').click();
  await phone.locator('#identity-reveal').waitFor({ state: 'visible' });
  assert.equal(await phone.locator('#identity-headline').textContent(), "You're the coral player.");
  await phone.screenshot({ path: `${output}identity-portrait.png` });
  await host.waitForFunction(() => !document.querySelector('#join-announcement')?.hidden);
  await host.screenshot({ path: `${output}lobby.png`, timeout: 60000 });
  await phone.setViewportSize({ width: 667, height: 375 });
  await phone.screenshot({ path: `${output}identity-landscape.png` });
  await host.locator('#close-room-button').click();
  await phone.locator('#join-view').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ home: true, lobby: true, realPhoneIdentity: true, portrait: true, smallLandscape: true, roomClosed: true, errors }));
} finally {
  await browser.close();
  await service?.close();
}
