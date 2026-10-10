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
    for (let i = 0; i < 4; i++) await page.locator('#add-bot').click();
    await page.locator('#start-button').click();
    await expect(page.locator('#arena-view canvas')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#score-strip .score-item')).toHaveCount(8);
    await expect(page.locator('#score-strip')).toHaveClass(/crowded/);
    const boxes = await page.locator('.score-item, .match-clock, #sound-toggle, #fullscreen-button').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
    }));
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(viewport.width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThan(viewport.height * 0.2);
    }
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const left = boxes[a], right = boxes[b];
      const overlapping = Math.min(left.right, right.right) > Math.max(left.x, right.x) + 1 && Math.min(left.bottom, right.bottom) > Math.max(left.y, right.y) + 1;
      expect(overlapping, `TV HUD boxes ${a} and ${b} overlap`).toBe(false);
    }
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
