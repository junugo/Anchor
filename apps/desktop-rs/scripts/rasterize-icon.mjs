// 一次性工具：从 apps/web/app/icon.svg 提取锚形路径，渲染 32x32 托盘底图（raw RGBA）
// 用法：node apps/desktop-rs/scripts/rasterize-icon.mjs（在仓库根目录执行）

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const src = fs.readFileSync("apps/web/app/icon.svg", "utf8");
const m = src.match(/<path d="([^"]+)"/);
if (!m) throw new Error("path not found in icon.svg");
const d = m[1];

// 原 SVG：1024 viewBox，glyph transform translate(118,120.56) scale(24.625)
// 32px 托盘图标：整体缩放 0.03125，glyph 微放大至约 24px 宽
const s = 0.03125 * 1.08;
const tx = 118.0 * s;
const ty = 120.56 * s;
const gs = 24.625 * s;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
  <g transform="translate(${tx.toFixed(3)}, ${ty.toFixed(3)}) scale(${gs.toFixed(5)})">
    <path d="${d}" fill="#000000"/>
  </g>
</svg>`;

const { data, info } = await sharp(Buffer.from(svg))
  .raw()
  .toBuffer({ resolveWithObject: true });

if (info.width !== 32 || info.height !== 32 || info.channels !== 4) {
  throw new Error(`unexpected output: ${info.width}x${info.height} ch=${info.channels}`);
}

fs.writeFileSync("apps/desktop-rs/assets/tray-icon.rgba", data);
console.log("written apps/desktop-rs/assets/tray-icon.rgba", data.length, "bytes");

// 窗口图标（64x64 PNG，黑色锚形透明底）
const s64 = (64 / 1024) * 1.08;
const svg64 = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <g transform="translate(${(118.0 * s64).toFixed(3)}, ${(120.56 * s64).toFixed(3)}) scale(${(24.625 * s64).toFixed(5)})">
    <path d="${d}" fill="#000000"/>
  </g>
</svg>`;
await sharp(Buffer.from(svg64)).png().toFile("apps/desktop-rs/assets/icon.png");
console.log("written apps/desktop-rs/assets/icon.png");

// exe 图标（白底圆角 + 黑色锚形，对齐安卓端）：多尺寸打包 .ico
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const size of sizes) {
  const rx = Math.round(size * 0.16);
  const s = size / 1024;
  const svgN = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs><mask id="m"><rect width="${size}" height="${size}" rx="${rx}" fill="white"/></mask></defs>
    <g mask="url(#m)">
      <rect width="${size}" height="${size}" fill="#ffffff"/>
      <g transform="translate(${(118.0 * s).toFixed(3)}, ${(120.56 * s).toFixed(3)}) scale(${(24.625 * s).toFixed(5)})">
        <path d="${d}" fill="#000000"/>
      </g>
    </g>
  </svg>`;
  pngs.push(await sharp(Buffer.from(svgN)).png().toBuffer());
}
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = [];
for (let i = 0; i < sizes.length; i++) {
  const e = Buffer.alloc(16);
  const sz = sizes[i];
  e.writeUInt8(sz >= 256 ? 0 : sz, 0);
  e.writeUInt8(sz >= 256 ? 0 : sz, 1);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
}
fs.writeFileSync("apps/desktop-rs/assets/icon.ico", Buffer.concat([header, ...entries, ...pngs]));
console.log("written apps/desktop-rs/assets/icon.ico");
