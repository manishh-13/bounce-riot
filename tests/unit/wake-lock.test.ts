import { afterEach, describe, expect, it, vi } from 'vitest';
import { WakeKeeper } from '../../src/ui/helpers';
afterEach(() => vi.unstubAllGlobals());
describe('wake lock lifecycle', () => {
  it('does not reacquire after disposal or leak a pending request', async () => {
    const document = new EventTarget() as EventTarget & { visibilityState: string }; document.visibilityState = 'visible';
    let finish!: (sentinel: unknown) => void;
    const request = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('document', document); vi.stubGlobal('navigator', { wakeLock: { request } });
    const keeper = new WakeKeeper(); const acquired = keeper.acquire();
    await keeper.acquire(); expect(request).toHaveBeenCalledOnce();
    keeper.dispose(); const release = vi.fn(async () => {}); finish({ release }); await acquired;
    expect(release).toHaveBeenCalledOnce();
    document.dispatchEvent(new Event('visibilitychange')); expect(request).toHaveBeenCalledOnce();
  });
});
