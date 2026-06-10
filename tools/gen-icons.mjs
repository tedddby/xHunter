/* xHunter — icon generator (dependency-free)
 * Draws the brand mark (a white crosshair) on an indigo rounded square and
 * writes icons/icon16.png, icon48.png, icon128.png.
 * Pure Node: rasterizes with supersampling and encodes PNG via zlib.
 *
 * Run:  node tools/gen-icons.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, '..', 'icons');

// ---- Colors (RGBA, 0-255) ----
const BG_TOP = [0x6d, 0x64, 0xff, 255];
const BG_BOT = [0x57, 0x4e, 0xf0, 255];
const MARK = [0xff, 0xff, 0xff]; // crosshair

// Crosshair geometry in a 0..24 design space (mirrors the inline SVG).
const CENTER = [12, 12];
const RING_R = 7.3;
const RING_HALF = 1.0; // half ring stroke
const DOT_R = 2.0;
const TICKS = [
  [[2.6, 12], [21.4, 12]], // horizontal
  [[12, 2.6], [12, 21.4]]  // vertical
];
const TICK_HALF = 1.0;

function distToSegment(px, py, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = px - a[0];
  const wy = py - a[1];
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}

// White crosshair coverage: ring annulus, center dot, or either axis tick.
function inMark(dx, dy) {
  const d = Math.hypot(dx - CENTER[0], dy - CENTER[1]);
  if (d <= DOT_R) return true;
  if (Math.abs(d - RING_R) <= RING_HALF) return true;
  for (const [a, b] of TICKS) {
    if (distToSegment(dx, dy, a, b) <= TICK_HALF) return true;
  }
  return false;
}

function insideRoundedRect(x, y, size, inset, radius) {
  const min = inset;
  const max = size - inset;
  if (x < min || x > max || y < min || y > max) return false;
  const cx = x < min + radius ? min + radius : x > max - radius ? max - radius : x;
  const cy = y < min + radius ? min + radius : y > max - radius ? max - radius : y;
  if (cx !== x && cy !== y) {
    return Math.hypot(x - cx, y - cy) <= radius;
  }
  return true;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// straight-alpha "src over dst"
function over(src, dst) {
  const sa = src[3] / 255;
  const da = dst[3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return [0, 0, 0, 0];
  const r = (src[0] * sa + dst[0] * da * (1 - sa)) / outA;
  const g = (src[1] * sa + dst[1] * da * (1 - sa)) / outA;
  const b = (src[2] * sa + dst[2] * da * (1 - sa)) / outA;
  return [r, g, b, outA * 255];
}

function sampleColor(px, py, size) {
  const dx = (px / size) * 24;
  const dy = (py / size) * 24;

  let color = [0, 0, 0, 0];

  // Background rounded square (indigo vertical gradient).
  const inset = size * 0.045;
  const radius = size * 0.22;
  if (insideRoundedRect(px, py, size, inset, radius)) {
    const t = py / size;
    color = over(
      [
        lerp(BG_TOP[0], BG_BOT[0], t),
        lerp(BG_TOP[1], BG_BOT[1], t),
        lerp(BG_TOP[2], BG_BOT[2], t),
        255
      ],
      color
    );
  }

  // White crosshair on top.
  if (inMark(dx, dy)) {
    color = over([MARK[0], MARK[1], MARK[2], 255], color);
  }

  return color;
}

function renderIcon(size) {
  const SS = 4; // supersampling factor
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sampleColor(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size);
          r += c[0];
          g += c[1];
          b += c[2];
          a += c[3];
        }
      }
      const n = SS * SS;
      const idx = (y * size + x) * 4;
      buf[idx] = Math.round(r / n);
      buf[idx + 1] = Math.round(g / n);
      buf[idx + 2] = Math.round(b / n);
      buf[idx + 3] = Math.round(a / n);
    }
  }
  return buf;
}

// ---- Minimal PNG encoder (RGBA, 8-bit) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- Main ----
mkdirSync(ICONS_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = encodePng(renderIcon(size), size);
  const out = join(ICONS_DIR, `icon${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
console.log('Done.');
