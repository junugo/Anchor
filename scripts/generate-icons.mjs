#!/usr/bin/env node
// 生成 Anchor 全客户端图标资产
// 用法: node scripts/generate-icons.mjs

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createICO, createICNS, BILINEAR } from 'png2icons'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const SOURCE_SVG_PATH = path.join(root, 'icon', 'icon.svg')
const ROUNDED_SVG_PATH = path.join(root, 'icon', 'icon-rounded.svg')
const SQUARE_SVG_PATH = path.join(root, 'icon', 'icon-square.svg')

const BACKGROUND = '#ffffff'
const FOREGROUND = '#000000'
const CORNER_RATIO = 0.16

// 读取并清理原始 path 数据
async function readAnchorPath() {
  const svgText = await fs.readFile(SOURCE_SVG_PATH, 'utf8')
  const dMatch = svgText.match(/ d="([^"]+)"/)
  if (!dMatch) throw new Error('无法在 icon/icon.svg 中找到 path 数据')
  const raw = dMatch[1]
  // 按命令字母切分，保留科学计数法
  const segs = raw.split(/(?=[a-zA-Z])/g)
  return segs
    .map((seg) => {
      const cmd = seg[0]
      const tail = seg.slice(1)
      const vals = tail.split(/[\s,]+/).filter(Boolean)
      return cmd + vals.join(' ')
    })
    .join('')
}

function buildRoundedSourceSvg(anchorPath) {
  const vb = 1024
  const cornerRadius = Math.round(vb * CORNER_RATIO)
  const pad = Math.round(vb * 0.115)
  const contentSize = vb - pad * 2
  const pathW = 32
  const pathH = 9
  const scale = contentSize / Math.max(pathW, pathH)
  const tx = (vb - pathW * scale) / 2
  const visualCenterY = 5.5
  const ty = vb / 2 - visualCenterY * scale - vb / 4

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${vb}" height="${vb}" viewBox="0 0 ${vb} ${vb}">
  <defs>
    <mask id="round-mask">
      <rect width="${vb}" height="${vb}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white" />
    </mask>
  </defs>
  <rect width="${vb}" height="${vb}" fill="${BACKGROUND}" />
  <g mask="url(#round-mask)">
    <rect width="${vb}" height="${vb}" fill="${BACKGROUND}" />
    <g transform="translate(${tx.toFixed(2)}, ${ty.toFixed(2)}) scale(${scale.toFixed(4)})">
      <path d="${anchorPath}" fill="${FOREGROUND}" />
    </g>
  </g>
</svg>`
}

function buildSquareSourceSvg(anchorPath) {
  const vb = 1024
  const pad = Math.round(vb * 0.115)
  const contentSize = vb - pad * 2
  const pathW = 32
  const pathH = 9
  const scale = contentSize / Math.max(pathW, pathH)
  const tx = (vb - pathW * scale) / 2
  const visualCenterY = 5.5
  const ty = vb / 2 - visualCenterY * scale - vb / 4

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${vb}" height="${vb}" viewBox="0 0 ${vb} ${vb}">
  <rect width="${vb}" height="${vb}" fill="${BACKGROUND}" />
  <g transform="translate(${tx.toFixed(2)}, ${ty.toFixed(2)}) scale(${scale.toFixed(4)})">
    <path d="${anchorPath}" fill="${FOREGROUND}" />
  </g>
</svg>`
}

function buildSplashSvg(anchorPath) {
  const sw = 1242
  const sh = 2432
  const logoSize = Math.round(sw * 0.32)
  const scale = logoSize / 32
  const lx = (sw - logoSize) / 2
  const visualCenterY = 5.5
  const ly = Math.round(sh * 0.32 - visualCenterY * scale)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sw} ${sh}" width="${sw}" height="${sh}">
  <rect width="${sw}" height="${sh}" fill="${BACKGROUND}" />
  <g transform="translate(${lx}, ${ly}) scale(${scale})">
    <path d="${anchorPath}" fill="${FOREGROUND}" />
  </g>
</svg>`
}

function buildNotificationSvg(anchorPath) {
  const size = 96
  const pad = 18
  const contentSize = size - pad * 2
  const pathW = 32
  const pathH = 9
  const scale = contentSize / Math.max(pathW, pathH)
  const tx = (size - pathW * scale) / 2
  const visualCenterY = 5.5
  const ty = size / 2 - visualCenterY * scale

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <g transform="translate(${tx.toFixed(2)}, ${ty.toFixed(2)}) scale(${scale.toFixed(4)})">
    <path d="${anchorPath}" fill="${FOREGROUND}" />
  </g>
</svg>`
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true })
}

async function renderSvgToPng(svgString, size, outPath, { density = 72, fit = 'cover', background } = {}) {
  const base = sharp(Buffer.from(svgString), { density }).resize(size, size, {
    fit,
    position: 'centre',
    background,
  })
  await base.png().toFile(outPath)
}

async function renderPngFromSvg(svgString, width, height, outPath, { density = 72, fit = 'contain', background } = {}) {
  await sharp(Buffer.from(svgString), { density })
    .resize(width, height, { fit, position: 'centre', background })
    .png()
    .toFile(outPath)
}

async function generate() {
  const anchorPath = await readAnchorPath()

  // 1. 写源 SVG
  const roundedSvg = buildRoundedSourceSvg(anchorPath)
  await ensureDir(path.dirname(ROUNDED_SVG_PATH))
  await fs.writeFile(ROUNDED_SVG_PATH, roundedSvg, 'utf8')

  const squareSvg = buildSquareSourceSvg(anchorPath)
  await fs.writeFile(SQUARE_SVG_PATH, squareSvg, 'utf8')

  console.log('✓ 已生成源文件:', path.relative(root, ROUNDED_SVG_PATH), path.relative(root, SQUARE_SVG_PATH))

  // 2. 渲染 1024x1024 主 PNG 缓存
  const masterPng = await sharp(Buffer.from(roundedSvg), { density: 72 }).resize(1024, 1024).png().toBuffer()
  const squareMasterPng = await sharp(Buffer.from(squareSvg), { density: 72 }).resize(1024, 1024).png().toBuffer()

  // 3. Mobile assets
  const mobileAssets = path.join(root, 'apps', 'mobile', 'assets')
  await ensureDir(mobileAssets)

  // Expo iOS icon 使用圆角源（iOS 会自动裁切，这里保留设计意图）
  await renderSvgToPng(roundedSvg, 1024, path.join(mobileAssets, 'icon.png'), { density: 72 })
  // Android adaptive icon 前景使用透明方形源（背景色由 app.json 指定）
  await renderSvgToPng(squareSvg, 1024, path.join(mobileAssets, 'adaptive-icon.png'), { density: 72 })
  // Splash
  const splashSvg = buildSplashSvg(anchorPath)
  await renderPngFromSvg(splashSvg, 1242, 2432, path.join(mobileAssets, 'splash.png'), {
    density: 72,
    fit: 'contain',
    background: BACKGROUND,
  })
  // Notification icon (alpha only, Android 会取 alpha 通道并用通知色着色)
  const notificationSvg = buildNotificationSvg(anchorPath)
  await renderSvgToPng(notificationSvg, 96, path.join(mobileAssets, 'notification-icon.png'), { density: 72 })

  // Android mipmap
  const mipmaps = [
    { dir: 'mipmap-mdpi', size: 48 },
    { dir: 'mipmap-hdpi', size: 72 },
    { dir: 'mipmap-xhdpi', size: 96 },
    { dir: 'mipmap-xxhdpi', size: 144 },
    { dir: 'mipmap-xxxhdpi', size: 192 },
  ]
  const androidRes = path.join(root, 'apps', 'mobile', 'android', 'app', 'src', 'main', 'res')
  for (const { dir, size } of mipmaps) {
    const dirPath = path.join(androidRes, dir)
    await ensureDir(dirPath)
    await renderSvgToPng(roundedSvg, size, path.join(dirPath, 'ic_launcher.png'), { density: 72 })
    await renderSvgToPng(roundedSvg, size, path.join(dirPath, 'ic_launcher_round.png'), { density: 72 })
  }
  console.log('✓ Mobile 图标已生成')

  // 5. Chrome Extension
  const chromeIconDir = path.join(root, 'apps', 'chrome-ext', 'public', 'icon')
  await ensureDir(chromeIconDir)
  for (const size of [16, 32, 48, 128]) {
    await renderSvgToPng(roundedSvg, size, path.join(chromeIconDir, `${size}.png`), { density: 72 })
  }
  console.log('✓ Chrome Extension 图标已生成')

  // 6. VS Code Extension
  const vscodeAssets = path.join(root, 'apps', 'vscode-ext', 'assets')
  await ensureDir(vscodeAssets)
  await renderSvgToPng(roundedSvg, 128, path.join(vscodeAssets, 'icon.png'), { density: 72 })
  console.log('✓ VS Code Extension 图标已生成')

  // 7. Web
  const webAppDir = path.join(root, 'apps', 'web', 'app')
  // favicon.ico 多尺寸
  const faviconPng = await sharp(Buffer.from(roundedSvg), { density: 72 }).resize(256, 256).png().toBuffer()
  await fs.writeFile(path.join(webAppDir, 'favicon.ico'), createICO(faviconPng, BILINEAR, false))
  // apple-touch-icon
  await renderSvgToPng(roundedSvg, 180, path.join(webAppDir, 'apple-touch-icon.png'), { density: 72 })
  // icon.svg 直接使用圆角源（Next.js 自动识别）
  await fs.writeFile(path.join(webAppDir, 'icon.svg'), roundedSvg, 'utf8')
  console.log('✓ Web 图标已生成')

  console.log('\n全部图标生成完成。')
}

generate().catch((err) => {
  console.error('生成失败:', err)
  process.exit(1)
})
