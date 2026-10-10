export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
export function readSaved<T>(key: string): T | null { try { return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null; } catch { return null; } }
export function save(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private browsing can deny storage. */ } }
export function removeSaved(key: string) { try { localStorage.removeItem(key); } catch { /* Not essential. */ } }
export function isStandalone() { return matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone; }
export function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
export async function fullscreen(element: HTMLElement = document.documentElement): Promise<boolean> {
  if (document.fullscreenElement || isStandalone()) return true;
  try {
    if (!element.requestFullscreen) return false;
    await element.requestFullscreen({ navigationUI: 'hide' });
    return true;
  } catch { return false; }
}
export class WakeKeeper {
  private sentinel: WakeLockSentinel | null = null;
  private enabled = false;
  private pending = false;
  private onVisibility = () => { if (document.visibilityState === 'visible' && this.enabled) void this.acquire(); };
  constructor(private changed?: (active: boolean) => void) { document.addEventListener('visibilitychange', this.onVisibility); }
  async acquire() {
    this.enabled = true;
    if (document.visibilityState !== 'visible' || !navigator.wakeLock || this.sentinel || this.pending) return;
    this.pending = true;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!this.enabled) { await sentinel.release(); return; }
      this.sentinel = sentinel;
      this.changed?.(true);
      this.sentinel.addEventListener('release', () => { this.sentinel = null; this.changed?.(false); });
    } catch { this.changed?.(false); } finally { this.pending = false; }
  }
  dispose() { this.enabled = false; void this.sentinel?.release(); document.removeEventListener('visibilitychange', this.onVisibility); }
}
export function enableRemoteNavigation(scope: HTMLElement, onBack?: () => void) {
  const listener = (event: KeyboardEvent) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) return;
    if (event.key === 'Escape' || event.key === 'BrowserBack') { onBack?.(); return; }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const elements = [...scope.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select')].filter(el => el.offsetParent !== null);
    if (!elements.length) return;
    event.preventDefault();
    const active = elements.indexOf(document.activeElement as HTMLElement);
    const dir = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
    elements[(active + dir + elements.length) % elements.length].focus();
  };
  scope.addEventListener('keydown', listener);
  return () => scope.removeEventListener('keydown', listener);
}
