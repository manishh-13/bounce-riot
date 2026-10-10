import { describe, it, expect } from 'vitest';
import { InputBuffer, INPUT_TIMEOUT_MS } from '../../src/net/input-buffer';
const frame = (seq: number, action = false, extra = {}) => ({ seq, action, x: 0, z: 0, ...extra });
describe('network input safety and action edges', () => {
  it('rejects non-finite input and stale or duplicate sequences', () => {
    const buffer = new InputBuffer();
    expect(buffer.accept('a', frame(2), 10)).toBe(true);
    expect(buffer.accept('a', frame(2, true), 20)).toBe(false);
    expect(buffer.accept('a', frame(1), 20)).toBe(false);
    expect(buffer.accept('a', frame(3, false, { x: NaN }), 20)).toBe(false);
    expect(buffer.accept('a', frame(3, false, { z: Infinity }), 20)).toBe(false);
    expect(buffer.accept('a', frame(3, false, { x: '1' }), 20)).toBe(false);
    expect(buffer.accept('a', frame(3, false, { seq: 1.5 }), 20)).toBe(false);
  });
  it('normalizes diagonal speed', () => {
    const buffer = new InputBuffer(); buffer.accept('a', frame(1, false, { x: 5, z: -8 }), 0);
    const input = buffer.read('a', 1);
    expect(Math.hypot(input.x, input.z)).toBeCloseTo(1); expect(input.z).toBeLessThan(0);
  });
  it('does not lose an extremely quick tap between rendered frames', () => {
    const buffer = new InputBuffer(); buffer.accept('a', frame(1, true), 0); buffer.accept('a', frame(2, false), 3);
    expect(buffer.read('a', 4).action).toBe(true);
    expect(buffer.read('a', 20).action).toBe(false);
  });
  it('cancels a queued action when the pointer or visibility is lost', () => {
    const buffer = new InputBuffer(); buffer.accept('a', frame(1, true), 0); buffer.accept('a', frame(2, false, { cancel: true }), 3);
    expect(buffer.read('a', 4)).toMatchObject({ action: false, cancel: true });
  });
  it('neutralizes a disconnected or stale controller without releasing a slam', () => {
    const buffer = new InputBuffer(); buffer.accept('a', frame(1, true, { x: 1 }), 0);
    expect(buffer.read('a', INPUT_TIMEOUT_MS + 1)).toEqual({ x: 0, z: 0, action: false, cancel: true });
    buffer.accept('a', frame(2, true), 1000);
    expect(buffer.read('a', 1001, false).cancel).toBe(true);
  });
  it('bounds event spam and isolates players', () => {
    const buffer = new InputBuffer(); for (let i = 0; i < 100; i++) buffer.accept('a', frame(i, i % 2 === 0), 1);
    buffer.accept('b', frame(1, true), 1);
    expect(buffer.read('b', 2).action).toBe(true);
    for (let i = 0; i < 12; i++) buffer.read('a', 2);
    expect(buffer.read('a', 2).action).toBe(false);
    buffer.clear(); expect(buffer.read('b', 2).cancel).toBe(true);
  });
});
