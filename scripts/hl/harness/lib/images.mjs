// Image helpers shared by the harness tools: the app's sharp and the pixel diff. Library only: import it, do
// not run it. tools/imgdiff.mjs is the command-line front end.
//
// A pixel counts as changed when its largest channel delta exceeds the threshold (default 24 of 255). The diff
// image shows B dimmed to 35 % with the changed pixels in magenta.

import fs from 'node:fs'
import path from 'node:path'
import { requireFromCheckout } from './setup.mjs'

export const DEFAULT_THRESHOLD = 24

let sharpModule
/** sharp from the checkout's node_modules (it comes in through @gltf-transform/cli); throws a SetupError. */
export const loadSharp = () => (sharpModule ??= requireFromCheckout('sharp'))

/** Diff two PNG files. Returns { changedPct, bbox, width, height, diff (raw RGB buffer or null) } or { error }. */
export async function diffPng(fileA, fileB, threshold = DEFAULT_THRESHOLD) {
  const sharp = loadSharp()
  const a = await sharp(fileA).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const b = await sharp(fileB).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return { error: 'size mismatch' }
  const { width, height } = a.info
  const out = Buffer.alloc(width * height * 3)
  let changed = 0
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let i = 0, px = 0; px < width * height; px++, i += 3) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]))
    if (d > threshold) {
      changed++
      const x = px % width
      const y = (px / width) | 0
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
      out[i] = 255
      out[i + 1] = 0
      out[i + 2] = 255
    } else {
      out[i] = b.data[i] * 0.35
      out[i + 1] = b.data[i + 1] * 0.35
      out[i + 2] = b.data[i + 2] * 0.35
    }
  }
  const pct = (100 * changed) / (width * height)
  return { changedPct: Math.round(pct * 1000) / 1000, bbox: x1 >= 0 ? [x0, y0, x1, y1] : null, width, height, diff: changed > 0 ? out : null }
}

/** Diff every PNG that both folders have; writes the diff images and diff.json into outDir. */
export async function diffDirs(dirA, dirB, outDir, threshold = DEFAULT_THRESHOLD) {
  const sharp = loadSharp()
  fs.mkdirSync(outDir, { recursive: true })
  const names = fs.readdirSync(dirA).filter(n => n.endsWith('.png') && fs.existsSync(path.join(dirB, n))).sort()
  const rows = []
  for (const name of names) {
    const result = await diffPng(path.join(dirA, name), path.join(dirB, name), threshold)
    if (result.error) {
      rows.push({ name, error: result.error })
      continue
    }
    const row = { name, changedPct: result.changedPct, bbox: result.bbox }
    if (result.diff) {
      row.diffFile = path.join(outDir, name.replace('.png', '-diff.png'))
      await sharp(result.diff, { raw: { width: result.width, height: result.height, channels: 3 } }).png().toFile(row.diffFile)
    }
    rows.push(row)
  }
  fs.writeFileSync(path.join(outDir, 'diff.json'), JSON.stringify(rows.map(({ diffFile, ...row }) => row), null, 1))
  return rows
}
