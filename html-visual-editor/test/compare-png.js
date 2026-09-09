/* 极简 PNG 像素对比工具（零依赖）：node compare-png.js <a.png> <b.png> */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('非 PNG 文件');
  let pos = 8;
  let width, height, bitDepth, colorType, interlace;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
      if (bitDepth !== 8 || interlace !== 0) throw new Error('仅支持 8bit 非隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!bpp) throw new Error('不支持的色彩类型: ' + colorType);
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride);
    rp += stride;
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 6 || colorType === 2) {
        out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2];
        out[o + 3] = colorType === 6 ? cur[x * bpp + 3] : 255;
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = cur[x]; out[o + 3] = 255;
      } else {
        // 调色板等不常见类型：灰度近似
        out[o] = out[o + 1] = out[o + 2] = cur[x * bpp]; out[o + 3] = 255;
      }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

const [, , fileA, fileB, rectA, rectB] = process.argv;
const a = decodePNG(fs.readFileSync(fileA));
const b = decodePNG(fs.readFileSync(fileB));
// 可选裁剪：参数 "x,y,w,h"（两图可各自指定，缺省整图）
const parseRect = (s, img) => {
  if (!s) return { x: 0, y: 0, w: img.width, h: img.height };
  const [x, y, w, h] = s.split(',').map(Number);
  return { x, y, w, h };
};
const ra = parseRect(rectA, a);
const rb = parseRect(rectB, b);
if (ra.w !== rb.w || ra.h !== rb.h) {
  console.log(`裁剪尺寸不同: ${ra.w}x${ra.h} vs ${rb.w}x${rb.h}`);
  process.exit(1);
}
let diff = 0;
const total = ra.w * ra.h;
for (let y = 0; y < ra.h; y++) {
  for (let x = 0; x < ra.w; x++) {
    const oa = ((ra.y + y) * a.width + ra.x + x) * 4;
    const ob = ((rb.y + y) * b.width + rb.x + x) * 4;
    if (Math.abs(a.data[oa] - b.data[ob]) + Math.abs(a.data[oa + 1] - b.data[ob + 1]) + Math.abs(a.data[oa + 2] - b.data[ob + 2]) > 6) diff++;
  }
}
console.log(`${fileA}[${ra.x},${ra.y}] vs ${fileB}[${rb.x},${rb.y}]: ${ra.w}x${ra.h}, 差异像素 ${diff}/${total} (${(100 * diff / total).toFixed(4)}%)`);
