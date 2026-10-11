import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';

export function seeded(seed: number): () => number {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Original, seeded painted wood. Baked once, shared by the frame and the jetty. */
export function woodTexture(size = 512): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not paint the wooden arena frame.');
  const random = seeded(2408);
  ctx.fillStyle = '#a57848'; ctx.fillRect(0, 0, size, size);
  const boards = 8, height = size / boards;
  for (let board = 0; board < boards; board++) {
    const top = board * height;
    ctx.fillStyle = `rgba(${board % 2 ? '246,195,122' : '73,38,24'},${0.06 + random() * 0.12})`;
    ctx.fillRect(0, top, size, height);
    const knot = size * (0.2 + random() * 0.6);
    for (let line = 0; line < 44; line++) {
      const y = top + random() * height;
      ctx.strokeStyle = `rgba(${line % 3 ? '53,29,20' : '255,226,165'},${0.035 + random() * 0.15})`;
      ctx.lineWidth = 0.4 + random() * 1.2;
      ctx.beginPath();
      for (let x = 0; x <= size; x += 8) {
        const distance = (x - knot) / (size * 0.1);
        const bulge = Math.exp(-distance * distance) * Math.sin((y - top) / height * Math.PI * 2) * height * 0.16;
        const v = y + Math.sin(x * 0.032 + board + line * 0.16) * 1.2 + bulge;
        if (x === 0) ctx.moveTo(x, v); else ctx.lineTo(x, v);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#4c3427'; ctx.fillRect(0, top, size, 1.4);
    ctx.fillStyle = '#efc68c'; ctx.fillRect(0, top + 1.4, size, 0.8);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}
