import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const text = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
describe('published browser controller contract', () => {
  it('declares installable fullscreen without requesting sensitive sensors', () => {
    const manifest = JSON.parse(text('public/manifest.webmanifest'));
    expect(manifest.display).toBe('fullscreen');
    expect(manifest.scope).toBe('./');
    const controller = text('src/ui/controller.ts');
    expect(controller).not.toContain('getUserMedia');
    expect(controller).not.toContain('DeviceMotionEvent');
    expect(controller).toContain("addEventListener('pointercancel', neutral)");
    expect(controller).toContain("addEventListener('visibilitychange', visibility)");
    expect(controller).toContain('Add to Home Screen');
  });
  it('uses relative build assets and code-splits the phone from the game renderer', () => {
    expect(text('vite.config.ts')).toContain("base: './'");
    expect(text('src/main.ts')).toContain("await import('./ui/controller')");
    expect(text('src/main.ts')).toContain("await import('./ui/host')");
    expect(text('src/ui/controller.ts')).not.toContain("from 'three'");
  });
});
