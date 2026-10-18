#!/usr/bin/env node
// Contact sheet: node scripts/hl/harness/tools/sheet.mjs <out.png> <cols> <image | folder> ... [--tile 640x360]
// Tiles every image (a folder adds its PNGs in name order) into a grid, each with its folder/file name.

import fs from 'node:fs'
import path from 'node:path'
import { SetupError, rerunWithoutFontconfigWarnings } from '../lib/setup.mjs'
import { loadSharp } from './imgdiff.mjs'

if (await rerunWithoutFontconfigWarnings()) await new Promise(() => {}) // the child does the work

const argv = process.argv.slice(2)
let tile = '640x360'
const rest = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--tile') tile = String(argv[++i])
  else rest.push(argv[i])
}
const [out, colsArg, ...inputs] = rest
const cols = Number(colsArg)
if (!out || !(cols >= 1) || !inputs.length) {
  console.error('usage: node scripts/hl/harness/tools/sheet.mjs <out.png> <cols> <image | folder> ... [--tile 640x360]')
  process.exit(64)
}
const files = inputs.flatMap(input =>
  fs.statSync(input).isDirectory()
    ? fs.readdirSync(input).filter(n => n.endsWith('.png')).sort().map(n => path.join(input, n))
    : [input]
)
const [W, H] = tile.split('x').map(Number)
const LH = 22
let sharp
try {
  sharp = loadSharp()
} catch (error) {
  console.error(error instanceof SetupError ? error.message : error)
  process.exit(1)
}
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const rows = Math.ceil(files.length / cols)
const tiles = await Promise.all(
  files.map(async (f, i) => {
    const img = await sharp(f).resize(W, H, { fit: 'fill' }).png().toBuffer()
    const label = Buffer.from(
      `<svg width="${W}" height="${LH}"><rect width="100%" height="100%" fill="black"/><text x="6" y="16" font-size="14" fill="white" font-family="sans-serif">${escape(f.split('/').slice(-2).join('/'))}</text></svg>`
    )
    const left = (i % cols) * W
    const top = Math.floor(i / cols) * (H + LH)
    return [
      { input: img, left, top: top + LH },
      { input: label, left, top },
    ]
  })
)
await sharp({ create: { width: Math.min(cols, files.length) * W, height: rows * (H + LH), channels: 3, background: '#222' } })
  .composite(tiles.flat())
  .png()
  .toFile(out)
console.log(out)
