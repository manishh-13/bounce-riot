import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import WebSocket from 'ws';
const BASE = process.env.BOUNCE_BASE_URL || 'http://127.0.0.1:4381/';
const local = !process.env.BOUNCE_BASE_URL;
const LANDSCAPE = { width: 844, height: 390 };
const SMALL = { width: 667, height: 375 };
const PORTRAIT = { width: 390, height: 844 };

// The fixture plays the TV: it mirrors each phone's server slot back as the status colour, exactly like host.ts.
async function fixtureHost() {
  // server/hub.mjs sends the host a `roster` of { id, name, slot, connected } and relays with `from` set to that id.
  const slots = new Map<string, number>();
  const greeted = new Set<string>();
  const socket = new WebSocket('ws://127.0.0.1:4382');
  const status = (to: string) => {
    if (!slots.has(to)) return;
    socket.send(JSON.stringify({
      action: 'relay', to,
      data: { kind: 'status', phase: 'lobby', remaining: 0, countdown: 0, score: 0, name: '', color: slots.get(to), charge: 0, cooldown: 0, captain: false, players: [] },
    }));
  };
  const code = await new Promise<string>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ action: 'create' })));
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'created') resolve(message.room);
      if (message.type === 'roster') {
        for (const member of message.roster) slots.set(member.id, member.slot);
        // A roster can land after the hello, so never let a phone keep a guessed seat.
        for (const id of greeted) status(id);
      }
      if (message.type === 'relay' && message.data?.kind === 'hello') { greeted.add(message.from); status(message.from); }
    });
  });
  return { code, slots, close() { socket.send(JSON.stringify({ action: 'close' })); socket.close(); } };
}

async function joinPhone(page: Page, code: string, name: string) {
  await page.goto(new URL(`#join/${code}`, BASE).href);
  await page.locator('#player-name').fill(name);
  await page.locator('#join-button').click();
  await expect(page.locator('#joypad')).toBeVisible();
}

interface Shown { number: string; headline: string; color: string; chip: string; look: string; fills: string[]; }
async function shown(page: Page): Promise<Shown> {
  await expect(page.locator('#identity-reveal')).toBeVisible();
  return {
    number: (await page.locator('#identity-number').textContent())!.trim(),
    headline: (await page.locator('#identity-headline').textContent())!.trim(),
    color: (await page.locator('#identity-color').textContent())!.trim(),
    chip: (await page.locator('#controller-color-name').textContent())!.trim(),
    look: (await page.locator('#identity-look').textContent())!.trim(),
    fills: await page.locator('#identity-preview svg [fill]').evaluateAll(nodes => nodes.map(n => n.getAttribute('fill')!)),
  };
}

async function phone(context: BrowserContext, code: string, name: string) {
  const page = await context.newPage();
  await joinPhone(page, code, name);
  return page;
}

test('two phones each see their own number, colour and matching mascot before arming', async ({ browser }) => {
  test.skip(!local, 'The capture fixture runs only against the local service.');
  const fixture = await fixtureHost();
  const first = await browser.newContext({ viewport: LANDSCAPE, hasTouch: true, isMobile: true });
  const second = await browser.newContext({ viewport: LANDSCAPE, hasTouch: true, isMobile: true });
  const one = await phone(first, fixture.code, 'Asha');
  const two = await phone(second, fixture.code, 'Bo');
  await expect(one.locator('#identity-number')).toHaveText('PLAYER 1');
  await expect(two.locator('#identity-number')).toHaveText('PLAYER 2');

  const a = await shown(one), b = await shown(two);
  expect(a.number).toBe('PLAYER 1');
  expect(b.number).toBe('PLAYER 2');
  expect(a.headline).toBe("You're the coral player.");
  expect(b.headline).toBe("You're the blue player.");
  expect(a.color).toBe('Coral mascot with the headband and tuft.');
  expect(b.color).toBe('Blue mascot with the peaked cap.');
  expect(a.chip).toBe('CORAL PLAYER');
  expect(b.chip).toBe('BLUE PLAYER');
  expect(a.look).toContain('Look at the TV');
  expect(b.look).toContain('Look at the TV');
  expect(await one.locator('#identity-nickname').textContent()).toBe('Asha');
  expect(await two.locator('#identity-nickname').textContent()).toBe('Bo');
  expect(await one.locator('#player-number').textContent()).toBe('1');
  expect(await two.locator('#player-number').textContent()).toBe('2');

  // The preview carries the seat colour plus the accessory hues the renderer gives that same seat.
  expect(a.fills).toContain('#fa513a');
  expect(a.fills).toContain('#ff4b3a');
  expect(b.fills).toContain('#346dff');
  expect(b.fills).toContain('#ffd23f');
  expect(a.fills).not.toContain('#ffd23f');
  expect(b.fills).not.toContain('#ff4b3a');
  const seatColor = (page: Page) => page.evaluate(() => ({
    seat: document.querySelector<HTMLElement>('#joypad')!.style.getPropertyValue('--player-color').trim(),
    headline: getComputedStyle(document.querySelector('#identity-headline')!).color,
    nickname: getComputedStyle(document.querySelector('#identity-nickname')!).color,
    dot: getComputedStyle(document.querySelector('#controller-identity i')!).backgroundColor,
  }));
  expect(await seatColor(one)).toEqual({ seat: '#fa513a', headline: 'rgb(250, 81, 58)', nickname: 'rgb(34, 62, 54)', dot: 'rgb(250, 81, 58)' });
  expect(await seatColor(two)).toEqual({ seat: '#346dff', headline: 'rgb(52, 109, 255)', nickname: 'rgb(34, 62, 54)', dot: 'rgb(52, 109, 255)' });

  // The reveal lives in the existing gate: arming is still the only step, and it hides the reveal.
  await one.locator('#arm-controller').click();
  await expect(one.locator('#controller-gate')).toBeHidden();
  await expect(one.locator('#identity-reveal')).toBeHidden();
  await expect(one.locator('#controller-color-name')).toHaveText('CORAL PLAYER');
  await expect(one.locator('#slam-button')).toBeVisible();

  await first.close(); await second.close(); fixture.close();
});

for (const [label, viewport] of [['landscape phone', LANDSCAPE], ['small landscape phone', SMALL], ['portrait phone', PORTRAIT]] as const) {
  test(`the identity reveal and the header label fit a ${label} without scrolling`, async ({ browser }) => {
    test.skip(!local, 'The capture fixture runs only against the local service.');
    const fixture = await fixtureHost();
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await joinPhone(page, fixture.code, 'Priyanka');
    await expect(page.locator('#identity-reveal')).toBeVisible();

    const overflow = await page.evaluate(() => ({
      docY: document.documentElement.scrollHeight - innerHeight,
      docX: document.documentElement.scrollWidth - innerWidth,
      card: (() => { const card = document.querySelector('.gate-card')!.getBoundingClientRect(); return { top: card.top, bottom: card.bottom }; })(),
      gate: document.querySelector('#controller-gate')!.getBoundingClientRect().height,
      scrolled: scrollY,
    }));
    expect(overflow.docY).toBeLessThanOrEqual(1);
    expect(overflow.docX).toBeLessThanOrEqual(1);
    expect(overflow.card.top).toBeGreaterThanOrEqual(-1);
    expect(overflow.card.bottom).toBeLessThanOrEqual(overflow.gate + 1);
    expect(overflow.scrolled).toBe(0);

    // The reveal must not squash the preview or clip the words beside it.
    const box = await page.locator('#identity-preview svg').boundingBox();
    expect(box!.width).toBeGreaterThan(44);
    expect(box!.height).toBeGreaterThan(44);
    const clipped = await page.evaluate(() => ['#identity-number', '#identity-headline', '#identity-nickname', '#identity-color', '#identity-look', '#controller-color-name']
      .filter(id => { const el = document.querySelector(id)! as HTMLElement; return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1; }));
    expect(clipped).toEqual([]);

    await page.locator('#arm-controller').click();
    await expect(page.locator('#controller-gate')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
    await context.close(); fixture.close();
  });
}

test('a reconnecting phone keeps the same number, colour and mascot', async ({ browser }) => {
  test.skip(!local, 'The capture fixture runs only against the local service.');
  const fixture = await fixtureHost();
  // Separate contexts: a shared localStorage would hand the second page the first phone's resume token.
  const holder = await browser.newContext({ viewport: LANDSCAPE, hasTouch: true, isMobile: true });
  const context = await browser.newContext({ viewport: LANDSCAPE, hasTouch: true, isMobile: true });
  const held = await holder.newPage();
  await joinPhone(held, fixture.code, 'Seat one');
  await expect(held.locator('#identity-number')).toHaveText('PLAYER 1');
  const mine = await context.newPage();
  await joinPhone(mine, fixture.code, 'Reconnector');
  const before = await shown(mine);
  expect(before.number).toBe('PLAYER 2');
  await mine.locator('#arm-controller').click();
  await expect(mine.locator('#controller-gate')).toBeHidden();

  await mine.reload();
  await mine.locator('#join-button').click();
  await expect(mine.locator('#joypad')).toBeVisible();
  const after = await shown(mine);
  expect(after.number).toBe(before.number);
  expect(after.color).toBe(before.color);
  expect(after.headline).toBe(before.headline);
  expect(after.chip).toBe(before.chip);
  expect(after.fills).toEqual(before.fills);
  expect(await mine.locator('#identity-nickname').textContent()).toBe('Reconnector');

  // Returning from the background still shows Welcome back, with the identity intact beneath it.
  await mine.locator('#arm-controller').click();
  await expect(mine.locator('#controller-gate')).toBeHidden();
  await mine.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(mine.locator('#gate-title')).toHaveText('Welcome back.');
  expect((await shown(mine)).number).toBe(before.number);
  await context.close(); await holder.close(); fixture.close();
});

test('a nickname with markup is shown as text, never as HTML', async ({ browser }) => {
  test.skip(!local, 'The capture fixture runs only against the local service.');
  const fixture = await fixtureHost();
  const context = await browser.newContext({ viewport: PORTRAIT, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const nickname = '<img src=x onerror=alert(1)>';
  await joinPhone(page, fixture.code, nickname);
  await expect(page.locator('#identity-reveal')).toBeVisible();
  expect(await page.locator('#identity-nickname').textContent()).toBe(nickname.slice(0, 16));
  expect(await page.locator('#identity-nickname').innerHTML()).not.toContain('<img');
  expect(await page.locator('#identity-reveal').evaluate(el => el.querySelectorAll('img').length)).toBe(0);
  await context.close(); fixture.close();
});
