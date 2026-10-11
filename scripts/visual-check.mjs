import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Run against Vite, never the production app: the inspection hook is development-only.
const base = process.env.BOUNCE_BASE_URL || 'http://127.0.0.1:4381/';
const label = process.argv[2] || 'current';
assert.match(label, /^[a-z0-9-]+$/i);
const output = new URL(`../.artifacts/polish/${label}/`, import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const cases = [
  { name: 'springyard-720-low', arena: 'springyard', width: 1280, height: 720, quality: 'low', players: 4 },
  { name: 'eight-players-720-low', arena: 'springyard', width: 1280, height: 720, quality: 'low', players: 8 },
  { name: 'springyard-1080-high', arena: 'springyard', width: 1920, height: 1080, quality: 'high', players: 4 },
  { name: 'moonbounce-720-low', arena: 'moonbounce', width: 1280, height: 720, quality: 'low', players: 4 },
  { name: 'aftershock-720-low', arena: 'aftershock', width: 1280, height: 720, quality: 'low', players: 4 },
];
const report = [];
try {
  for (const spec of cases.filter(item => !process.env.BOUNCE_VISUAL_FILTER || item.name.includes(process.env.BOUNCE_VISUAL_FILTER))) {
    const page = await browser.newPage({ viewport: { width: spec.width, height: spec.height } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(quality => {
      localStorage.setItem('bounce-riot-quality', JSON.stringify(quality));
      localStorage.setItem('bounce-riot-sound', 'false');
      let seed = 81;
      Math.random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    }, spec.quality);
    await page.goto(new URL('#practice', base).href);
    await page.waitForFunction(() => !!window.__bounce?.scene);
    await page.locator('#arena-select').selectOption(spec.arena);
    await page.evaluate(spec => {
      const { sim, scene, startRound } = window.__bounce;
      const names = ['You', 'Peaches', 'Mochi', 'Pickle', 'Waffles', 'Noodle', 'Tater', 'Sprout'];
      sim.setPlayers(names.slice(0, spec.players).map((name, i) => ({ id: i ? `bot-${i - 1}` : 'keyboard', name, color: i, bot: false, connected: true })));
      startRound();
      for (let tick = 0; tick < 200; tick++) sim.step(1 / 60);
      sim.state.phase = 'playing';
      sim.state.remaining = 64;
      sim.state.events = [];
      const spots = [[-2.6, 1.4], [2.2, 0.4], [1.1, -3.2], [-2.6, -2.4], [4, 2.7], [-4.5, 3.2], [4, -3], [-4.8, -1.1]];
      sim.state.players.forEach((p, i) => {
        Object.assign(p, { x: spots[i][0], z: spots[i][1], y: i === 1 ? 1.1 : 0, grounded: i !== 1, invincible: 0, respawnIn: 0, facing: i === 1 ? -0.5 : 0.35, charge: i === 2 ? 0.76 : 0, vx: 0, vz: 0, vy: 0, score: [6, 4, 2, 8, 2, 4, 0, 6][i] });
      });
      sim.state.waves = [{ id: 1000, owner: 'keyboard', x: -2.6, z: 1.4, radius: 2.5, prevRadius: 2.4, power: 1.2, age: 0.65, maxRadius: 12, color: 0, hitIds: [] }];
      // Freeze physics, not the host UI. Render fixed timesteps to settle the presentation.
      sim.step = () => {};
      const render = scene.render.bind(scene);
      for (let frame = 0; frame < 45; frame++) render(sim.state, 1 / 60);
      scene.render = state => render(state, 0);
    }, spec);
    await page.locator('#play-hud').waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    // Capture one fully laid-out frame, then stop redrawing this staged fixture so a
    // software GPU cannot starve the browser compositor while it takes the screenshot.
    const stats = await page.evaluate(() => {
      const { scene, sim } = window.__bounce;
      scene.render(sim.state, 0);
      scene.render = () => {};
      const pause = getComputedStyle(document.querySelector('#pause-button'));
      return { ...scene.getStats(), board: scene.getBoardBounds(), pauseStyle: { color: pause.color, background: pause.backgroundColor, opacity: pause.opacity } };
    });
    assert.equal(await page.locator('.score-item').count(), spec.players);
    assert.equal(stats.pauseStyle.color, 'rgb(255, 240, 210)', `${spec.name}: the Pause label must remain light on the dark HUD`);
    assert.equal(stats.pauseStyle.opacity, '1', `${spec.name}: Pause must remain fully visible`);
    assert.deepEqual(errors, [], `${spec.name}: browser errors`);
    await page.screenshot({ path: `${output}${spec.name}.png`, timeout: 60000 });
    report.push({ ...spec, ...stats, errors });
    console.log(JSON.stringify(report.at(-1)));
    await page.close();
  }
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
