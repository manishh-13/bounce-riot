import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const base=process.env.BOUNCE_BASE_URL || 'http://127.0.0.1:4383/';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox']});
try {
  const context=await browser.newContext({viewport:{width:1280,height:720}});
  await context.addInitScript(()=>localStorage.setItem('bounce-riot-quality',JSON.stringify('low')));
  const page=await context.newPage();
  page.on('pageerror', e=>console.log('PAGE ERROR',e.message));
  page.on('requestfailed', r=>console.log('FAILED',r.url(),r.failure()?.errorText));
  await page.goto(new URL('#practice',base).href);
  await page.locator('#start-button').waitFor({state:'visible'});
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();

  await page.locator('#start-button').waitFor({state:'visible'});
  assert.equal(await page.locator('#lobby-roster .roster-player').count(),4);
  await page.locator('#start-button').click();
  await page.locator('#round-callout').waitFor({state:'visible'});
  console.log('PASS: previously cached production build opens and starts practice offline. Online room pairing remains unavailable offline.');
} finally {await browser.close();}
