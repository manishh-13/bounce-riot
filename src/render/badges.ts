import { CanvasTexture, Color, LinearFilter, SRGBColorSpace } from 'three';

const W = 320, H = 96;
const FONT = "'Fredoka', 'Nunito Sans', ui-rounded, system-ui, sans-serif";

export interface BadgeSpec { name: string; color: string; number: number; offline: boolean; leader: boolean; bot: boolean; }

// One small canvas texture per distinct badge look, reused across frames; only rebuilt when the label changes.
export class BadgeCache {
  private cache = new Map<string, CanvasTexture>();
  private version = 0;
  readonly aspect = W / H;

  constructor() {
    const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
    fonts?.ready?.then(() => { this.version++; }).catch(() => undefined);
  }

  key(spec: BadgeSpec): string {
    return `${this.version}|${spec.name}|${spec.color}|${spec.number}|${spec.offline ? 1 : 0}|${spec.leader ? 1 : 0}|${spec.bot ? 1 : 0}`;
  }

  get(spec: BadgeSpec): CanvasTexture {
    const key = this.key(spec);
    let tex = this.cache.get(key);
    if (!tex) {
      tex = draw(spec);
      this.cache.set(key, tex);
    }
    return tex;
  }

  sweep(inUse: Set<CanvasTexture>): void {
    if (this.cache.size < 40) return;
    for (const [k, t] of this.cache) if (!inUse.has(t)) { t.dispose(); this.cache.delete(k); }
  }

  dispose(): void {
    for (const t of this.cache.values()) t.dispose();
    this.cache.clear();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw(spec: BadgeSpec): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const name = (spec.name || 'Player').toUpperCase().slice(0, 12);
  ctx.font = `700 34px ${FONT}`;
  const textW = Math.min(ctx.measureText(name).width, W - 120);
  const pillW = Math.min(W - 8, textW + 104);
  const x = (W - pillW) / 2, y = 14, h = 62;

  ctx.globalAlpha = spec.offline ? 0.55 : 1;
  ctx.fillStyle = 'rgba(22,52,42,0.45)';
  roundRect(ctx, x + 2, y + 6, pillW, h, h / 2); ctx.fill();
  ctx.fillStyle = '#fffaf0';
  roundRect(ctx, x, y, pillW, h, h / 2); ctx.fill();
  ctx.lineWidth = 6; ctx.strokeStyle = spec.color;
  roundRect(ctx, x + 2.5, y + 2.5, pillW - 5, h - 5, (h - 5) / 2); ctx.stroke();

  const cx = x + h / 2, cy = y + h / 2;
  ctx.fillStyle = spec.color;
  ctx.beginPath(); ctx.arc(cx, cy, h / 2 - 7, 0, Math.PI * 2); ctx.fill();
  const color = new Color(spec.color);
  const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  ctx.fillStyle = luminance > 0.3 ? '#173b31' : '#fffaf0';
  ctx.font = `700 30px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(spec.bot ? 'B' : String(spec.number), cx, cy + 2);

  ctx.fillStyle = '#173b31';
  ctx.font = `700 34px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(name, x + h + 6, cy + 2, textW);

  if (spec.leader) {
    ctx.fillStyle = '#ffc93c'; ctx.strokeStyle = '#a2671a'; ctx.lineWidth = 3;
    const kx = x + pillW - 10, ky = y - 2;
    ctx.beginPath();
    ctx.moveTo(kx - 22, ky + 12); ctx.lineTo(kx - 18, ky - 8); ctx.lineTo(kx - 9, ky + 2); ctx.lineTo(kx - 2, ky - 12);
    ctx.lineTo(kx + 5, ky + 2); ctx.lineTo(kx + 14, ky - 8); ctx.lineTo(kx + 18, ky + 12); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  if (spec.offline) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#7a6a60';
    ctx.font = `700 22px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('RECONNECTING', W / 2, y + h + 12);
  }

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}
