import { expect, test } from '@playwright/test';
const BASE = process.env.BOUNCE_BASE_URL || 'http://127.0.0.1:4381/';
const local = !process.env.BOUNCE_BASE_URL || process.env.BOUNCE_DEV_TEST === '1';

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => { if (!localStorage.getItem('bounce-riot-quality')) localStorage.setItem('bounce-riot-quality', '"low"'); });
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test(`compact main menu leaves the whole diorama visible at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(BASE);
    await expect(page.locator('#host-button')).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Bounce Riot', exact: true })).toBeVisible();
    await expect(page.locator('#menu-join')).toBeVisible();
    await expect(page.locator('#menu-settings')).toBeVisible();
    await expect(page.locator('#home-panel')).not.toContainText('Good friends.');
    await expect(page.locator('#hero-sticker')).toHaveCount(0);
    const menu = await page.locator('#home-panel').boundingBox();
    expect(menu!.width).toBeLessThanOrEqual(355);
    expect(menu!.y).toBeGreaterThan(60);
    expect(menu!.y + menu!.height).toBeLessThan(viewport.height - 45);
    if (local) {
      const board = await page.evaluate(() => window.__bounce!.scene.getBoardBounds());
      expect(board.left).toBeGreaterThan(menu!.x + menu!.width + 20);
      expect(board.right).toBeLessThan(viewport.width - 10);
      expect(board.top).toBeGreaterThan(75);
      expect(board.bottom).toBeLessThan(viewport.height - 30);
    }
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#menu-join')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#practice-button')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#lobby-panel')).toBeVisible();
    await expect(page.locator('#lobby-roster .roster-player')).toHaveCount(4);
  });
}

test('settings stay inside the modal, update graphics and sound, and persist on reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  await page.locator('#menu-settings').click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.locator('#settings-quality').selectOption('high');
  await expect(page.locator('#quality-toggle')).toHaveText('GRAPHICS: HIGH');
  await page.locator('#settings-sound').click();
  await expect(page.locator('#settings-sound')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#sound-toggle')).toHaveText('SOUND OFF');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#settings-close')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#settings-quality')).toBeFocused();
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-panel')).not.toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bounce-riot-quality')!))).toBe('high');
  await page.reload();
  await expect(page.locator('#quality-toggle')).toHaveText('GRAPHICS: HIGH');
  await expect(page.locator('#sound-toggle')).toHaveText('SOUND OFF');
  await page.locator('#menu-settings').click();
  await page.locator('#settings-close').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#settings-quality')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#settings-close')).toBeFocused();
  await page.locator('#settings-quality').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-panel')).not.toBeVisible();
  await expect(page.locator('#menu-settings')).toBeFocused();
  expect(errors).toEqual([]);
});

test('How to play opens from the title menu and Join opens the lightweight phone page', async ({ page }) => {
  await page.goto(BASE);
  await page.locator('#menu-help').click();
  await expect(page.locator('#help-panel')).toBeVisible();
  await expect(page.locator('#help-panel')).toContainText('Hold. Release. Slam.');
  await expect(page.locator('#help-close')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#help-close')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#help-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#help-panel')).toBeHidden();
  await expect(page.locator('#menu-help')).toBeFocused();
  await page.locator('#menu-join').click();
  await expect(page.locator('#join-form')).toBeVisible();
  await expect(page.locator('#arena-view')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.classList.contains('host-mode'))).toBe(false);
});
