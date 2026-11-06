#!/usr/bin/env node
// Draws the placeholder icon (512×512 PNG): three release bars, the top one
// live (green), with a pointer to it. No dependencies: 4× supersampling and a
// minimal PNG encoder. Replace mcpb/icon.png with your own art at any time.
//
//   node scripts/make-icon.mjs mcpb/icon.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const SS = 4;
const BIG = SIZE * SS;

const roundedRect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const triangle =
  ([ax, ay], [bx, by], [cx, cy]) =>
  (x, y) => {
    const s = (px, py, qx, qy) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
    const d1 = s(ax, ay, bx, by);
    const d2 = s(bx, by, cx, cy);
    const d3 = s(cx, cy, ax, ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };

// Layers, bottom first, in 512-unit coordinates.
const layers = [
  [roundedRect(16, 16, 496, 496, 104), [30, 41, 59]], // slate background
  [roundedRect(154, 140, 410, 200, 22), [34, 197, 94]], // live release
  [roundedRect(154, 226, 410, 286, 22), [100, 116, 139]],
  [roundedRect(154, 312, 410, 372, 22), [71, 85, 105]],
  [triangle([102, 138], [102, 202], [138, 170]), [248, 250, 252]], // "current" pointer
];

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0,
      g = 0,
      b = 0,
      a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = (px * SS + sx + 0.5) / SS;
        const y = (py * SS + sy + 0.5) / SS;
        let color;
        for (const [inside, c] of layers) if (inside(x, y)) color = c;
        if (color) {
          r += color[0];
          g += color[1];
          b += color[2];
          a += 255;
        }
      }
    }
    const n = SS * SS;
    const covered = a / 255;
    const i = (py * SIZE + px) * 4;
    rgba[i] = covered ? Math.round(r / covered) : 0;
    rgba[i + 1] = covered ? Math.round(g / covered) : 0;
    rgba[i + 2] = covered ? Math.round(b / covered) : 0;
    rgba[i + 3] = Math.round(a / n);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++)
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = process.argv[2] ?? 'mcpb/icon.png';
writeFileSync(out, png);
console.error(`Wrote ${out} (${png.length} bytes, ${BIG / SS}×${BIG / SS}).`);
