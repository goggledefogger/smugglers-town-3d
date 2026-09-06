import { CanvasTexture, RepeatWrapping } from 'three';

const cache = new Map<string, CanvasTexture>();

function texture(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  let t = cache.get(key);
  if (t) return t;
  if (typeof document === 'undefined') {
    // Headless / SSR fallback for Node vitest runner
    t = new CanvasTexture({} as HTMLCanvasElement);
    cache.set(key, t);
    return t;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) draw(ctx);
  t = new CanvasTexture(c);
  t.anisotropy = 4;
  cache.set(key, t);
  return t;
}

/** Tire tread, repeated around the circumference. */
export function tread(): CanvasTexture {
  const t = texture('tread', 128, 64, ctx => {
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = '#2a2a2a';
    // chevron lugs
    for (let x = 0; x < 128; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x + 4, 4);
      ctx.lineTo(x + 20, 4);
      ctx.lineTo(x + 30, 32);
      ctx.lineTo(x + 20, 60);
      ctx.lineTo(x + 4, 60);
      ctx.lineTo(x + 14, 32);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 30, 128, 4);
  });
  t.wrapS = RepeatWrapping;
  t.repeat.set(8, 1);
  return t;
}

/** Tire sidewall with a spoked rim in the middle, mapped onto the wheel caps. */
export function sidewall(): CanvasTexture {
  return texture('sidewall', 256, 256, ctx => {
    const c = 128;
    ctx.fillStyle = '#151515';
    ctx.beginPath();
    ctx.arc(c, c, 128, 0, Math.PI * 2);
    ctx.fill();
    // sidewall lettering ticks
    ctx.strokeStyle = '#2e2e2e';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(c, c, 104, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#3a3a3a';
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ctx.fillRect(c + Math.cos(a) * 112 - 2, c + Math.sin(a) * 112 - 5, 4, 10);
    }
    // rim
    const rim = ctx.createRadialGradient(c - 20, c - 20, 10, c, c, 80);
    rim.addColorStop(0, '#e8ecef');
    rim.addColorStop(1, '#8e969c');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(c, c, 78, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1e2124';
    for (let i = 0; i < 6; i++) {
      const a0 = (i / 6) * Math.PI * 2 + 0.18;
      const a1 = ((i + 1) / 6) * Math.PI * 2 - 0.18;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a0) * 30, c + Math.sin(a0) * 30);
      ctx.arc(c, c, 66, a0, a1);
      ctx.lineTo(c + Math.cos(a1) * 30, c + Math.sin(a1) * 30);
      ctx.closePath();
      ctx.fill();
    }
    // hub + bolts
    ctx.fillStyle = '#44494e';
    ctx.beginPath();
    ctx.arc(c, c, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d8dde0';
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c + Math.cos(a) * 13, c + Math.sin(a) * 13, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
