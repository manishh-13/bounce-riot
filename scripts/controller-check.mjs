import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { mkdir } from 'node:fs/promises';
const dir = new URL('../.artifacts/', import.meta.url).pathname;
await mkdir(dir, { recursive: true });
const socket = new WebSocket('ws://127.0.0.1:4382');
const roomReady = new Promise((resolve, reject) => {
  socket.on('open', () => socket.send(JSON.stringify({ action: 'create' })));
  socket.on('error', reject);
  socket.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'created') resolve(m.room);
    if (m.type === 'relay' && m.data?.kind === 'hello') socket.send(JSON.stringify({ action: 'relay', to: m.from, data: { kind: 'status', phase: 'lobby', remaining: 90, countdown: 3, score: 0, name: 'Manish', color: 0, charge: 0, cooldown: 0, captain: true, players: [] } }));
  });
});
const room = await roomReady;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
for (const [label, viewport] of [['portrait', {width:390,height:844}], ['landscape', {width:844,height:390}]]) {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:4381/#join/${room}`);
  await page.locator('#player-name').fill('Manish');
  await page.screenshot({ path: `${dir}join-${label}.png` });
  await page.locator('#join-button').click();
  await page.locator('#arm-controller').waitFor({ state:'visible' });
  await page.locator('#arm-controller').click();
  await page.locator('#controller-gate').waitFor({state:'hidden'});
  await page.screenshot({ path: `${dir}controller-${label}.png` });
  const result = await page.evaluate(() => ({ overflow:document.documentElement.scrollWidth>innerWidth, fullscreen:!!document.fullscreenElement, pad:getComputedStyle(document.querySelector('#joypad')).touchAction, movement:document.querySelector('#move-zone').getBoundingClientRect().toJSON(), action:document.querySelector('#slam-button').getBoundingClientRect().toJSON() }));
  console.log(label,JSON.stringify({ ...result, errors }));
  await context.close();
}
socket.send(JSON.stringify({action:'close'})); socket.close(); await browser.close();
