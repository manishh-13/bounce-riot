import { test, expect } from '@playwright/test';
const BASE = process.env.BOUNCE_BASE_URL || 'http://127.0.0.1:4381/';
for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test(`TV controls fit and the full arena renders at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE);
    await expect(page.locator('#host-button')).toBeVisible();
    const host = await page.locator('#host-button').boundingBox();
    expect(host!.y + host!.height).toBeLessThan(viewport.height);
    await page.locator('#practice-button').click();
    await expect(page.locator('#start-button')).toBeInViewport();
    await page.locator('#start-button').click();
    await expect(page.locator('#arena-view canvas')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
test('phone join does not load the 3D engine', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(); const requested: string[] = [];
  page.on('request', r => requested.push(r.url()));
  await page.goto(new URL('#join', BASE).href);
  await expect(page.locator('#join-button')).toBeVisible();
  expect(requested.some(url => /\/three[._-]|\/render\/scene|\/ui\/host/.test(url))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});
