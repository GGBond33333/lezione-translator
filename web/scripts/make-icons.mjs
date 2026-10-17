// 生成 PWA 和 iOS 主屏幕需要的 PNG 图标（iOS 不支持 SVG 的 apple-touch-icon）。
// 不依赖第三方库：逐像素绘制两个对话气泡，再用 zlib 编码成 PNG。
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const BG = [15, 23, 42];
const GREEN = [34, 197, 94];
const RED = [239, 68, 68];

function inRoundRect(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s = (p1x, p1y, p2x, p2y, p3x, p3y) => (p1x - p3x) * (p2y - p3y) - (p2x - p3x) * (p1y - p3y);
  const d1 = s(px, py, ax, ay, bx, by);
  const d2 = s(px, py, bx, by, cx, cy);
  const d3 = s(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// 坐标基于 512 画布，与 public/icon.svg 一致；full=true 时背景铺满（iOS 自己加圆角）
function pixel(x, y, full) {
  if (!full && !inRoundRect(x, y, 0, 0, 512, 512, 112)) return null;
  if (inRoundRect(x, y, 208, 232, 232, 168, 40) || inTriangle(x, y, [392, 400], [392, 458], [334, 400])) return RED;
  if (inRoundRect(x, y, 72, 104, 232, 168, 40) || inTriangle(x, y, [120, 272], [120, 330], [178, 272])) return GREEN;
  return BG;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, full) {
  const scale = 512 / size;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 2x2 超采样抗锯齿
      let r = 0, g = 0, b = 0, a = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const c = pixel((x + ox) * scale, (y + oy) * scale, full);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
      }
      const n = a / 255 || 1;
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r / n; raw[i + 1] = g / n; raw[i + 2] = b / n; raw[i + 3] = a / 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../public/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("icon-192.png", out), png(192, false));
writeFileSync(new URL("icon-512.png", out), png(512, true));
writeFileSync(new URL("apple-touch-icon.png", out), png(180, true));
console.log("icons written");
