import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const base = process.env.BOUNCE_BASE_URL || 'http://localhost:4381/';
const dir = new URL('../.artifacts/', import.meta.url).pathname;
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base); await page.locator('#arena-view canvas').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${dir}home.png` });
  await page.locator('#practice-button').click();
  await page.screenshot({ path: `${dir}practice-lobby.png` });
  await page.locator('#start-button').click();
  await page.locator('#round-callout').waitFor({state:'visible',timeout:10000});
  await page.locator('#round-callout').waitFor({state:'hidden',timeout:30000});
  await page.keyboard.down('Space');
  await page.evaluate(() => new Promise(resolve => { let n=0; const frame=()=>{ if(++n>=40) resolve(null); else requestAnimationFrame(frame); }; requestAnimationFrame(frame); }));
  await page.keyboard.up('Space');
  await page.evaluate(() => new Promise(resolve => { let n=0; const frame=()=>{ if(++n>=30) resolve(null); else requestAnimationFrame(frame); }; requestAnimationFrame(frame); }));
  await page.screenshot({ path: `${dir}gameplay.png` });
  console.log(JSON.stringify({ screenshots: ['home.png','practice-lobby.png','gameplay.png'].map(f=>dir+f),errors },null,2));
} finally { await browser.close(); }
