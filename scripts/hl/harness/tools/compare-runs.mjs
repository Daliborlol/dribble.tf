#!/usr/bin/env node
// Compare two harness runs of the same plan:
//
//   node scripts/hl/harness/tools/compare-runs.mjs <runA> <runB> [outDir] [--threshold 24] [--max-pct <p>]
//        [--cols 2] [--tile 400x225] [--no-diff-tile] [--no-sheet]
//
// 1. Manifest structure: every JSON path and value type of both manifest.json files (array indices
//    included), so a missing key, a changed type or an extra step shows up.
// 2. Per step: tick, render tick, camera mode, focused player, step error, and whether the eval result and
//    the player list are identical.
// 3. Pixel diff of each screenshot pair (tools/imgdiff.mjs; threshold 24 of 255 per channel).
// 4. outDir/sheet.png: each step as A | B | diff (magenta = changed pixels), labelled with the diff share.
// Writes outDir/compare.json. outDir defaults to <runB>-vs-<name of runA>. Exit code 1 when the
// structure differs or, with --max-pct, when a shot changes by more than p percent.

import fs from 'node:fs'
import path from 'node:path'
import { SetupError, rerunWithoutFontconfigWarnings } from '../lib/setup.mjs'
import { DEFAULT_THRESHOLD, diffPng, loadSharp } from './imgdiff.mjs'

if (await rerunWithoutFontconfigWarnings()) await new Promise(() => {}) // the child does the work

const argv = process.argv.slice(2)
const positional = []
const opts = { threshold: DEFAULT_THRESHOLD, cols: 2, tile: '400x225', diffTile: true, sheet: true, maxPct: null }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--threshold') opts.threshold = Number(argv[++i])
  else if (a === '--max-pct') opts.maxPct = Number(argv[++i])
  else if (a === '--cols') opts.cols = Math.max(1, Number(argv[++i]) | 0)
  else if (a === '--tile') opts.tile = String(argv[++i])
  else if (a === '--no-diff-tile') opts.diffTile = false
  else if (a === '--no-sheet') opts.sheet = false
  else if (a.startsWith('--')) {
    console.error(`unknown option ${a}`)
    process.exit(64)
  } else positional.push(a)
}
const [runA, runB, outArg] = positional
if (!runA || !runB) {
  console.error(
    'usage: node scripts/hl/harness/tools/compare-runs.mjs <runA> <runB> [outDir] [--threshold 24] [--max-pct <p>] [--cols 2] [--tile 400x225] [--no-diff-tile] [--no-sheet]'
  )
  process.exit(64)
}
const outDir = path.resolve(outArg ?? `${path.resolve(runB)}-vs-${path.basename(path.resolve(runA))}`)
const [tileW, tileH] = opts.tile.split('x').map(Number)

const readManifest = dir => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
let A
let B
try {
  A = readManifest(runA)
  B = readManifest(runB)
} catch (error) {
  console.error(`cannot read manifest.json: ${error?.message || error}`)
  process.exit(1)
}

// ─── 1. structure ─────────────────────────────────────────────────────────────────

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const shapeOf = (value, prefix = '', out = new Set()) => {
  const type = typeOf(value)
  out.add(`${prefix || '.'}:${type}`)
  if (type === 'object') for (const [k, v] of Object.entries(value)) shapeOf(v, `${prefix}.${k}`, out)
  if (type === 'array') value.forEach((v, i) => shapeOf(v, `${prefix}[${i}]`, out))
  return out
}
const shapeA = shapeOf(A)
const shapeB = shapeOf(B)
const onlyA = [...shapeA].filter(p => !shapeB.has(p))
const onlyB = [...shapeB].filter(p => !shapeA.has(p))
const structureSame = onlyA.length === 0 && onlyB.length === 0

// ─── 2 + 3. steps and pixels ──────────────────────────────────────────────────────

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)
const count = Math.max(A.shots?.length ?? 0, B.shots?.length ?? 0)
const steps = []
for (let i = 0; i < count; i++) {
  const a = A.shots?.[i]
  const b = B.shots?.[i]
  const row = {
    index: i,
    name: a?.step?.name ?? b?.step?.name ?? null,
    stepSame: same(a?.step, b?.step),
    tick: [a?.tick ?? null, b?.tick ?? null],
    renderTick: [a?.state?.playback?.renderTick ?? null, b?.state?.playback?.renderTick ?? null],
    mode: [a?.state?.scene?.controlsMode ?? null, b?.state?.scene?.controlsMode ?? null],
    focused: [a?.state?.scene?.focusedEntityId ?? null, b?.state?.scene?.focusedEntityId ?? null],
    error: [a?.error ?? null, b?.error ?? null],
    evalSame: same(a?.eval, b?.eval),
    playersSame: same(a?.players, b?.players),
    files: [a?.file ? path.basename(a.file) : null, b?.file ? path.basename(b.file) : null],
  }
  const fileA = a?.file ? path.join(runA, path.basename(a.file)) : null
  const fileB = b?.file ? path.join(runB, path.basename(b.file)) : null
  if (fileA && fileB && fs.existsSync(fileA) && fs.existsSync(fileB)) {
    try {
      const d = await diffPng(fileA, fileB, opts.threshold)
      row.pixels = d.error ? { error: d.error } : { changedPct: d.changedPct, bbox: d.bbox }
      row.paths = [fileA, fileB]
      if (d.diff) {
        fs.mkdirSync(outDir, { recursive: true })
        row.diffFile = path.join(outDir, path.basename(fileB).replace('.png', '-diff.png'))
        await loadSharp()(d.diff, { raw: { width: d.width, height: d.height, channels: 3 } }).png().toFile(row.diffFile)
      }
    } catch (error) {
      if (error instanceof SetupError) {
        console.error(error.message)
        process.exit(1)
      }
      row.pixels = { error: String(error?.message || error) }
    }
  }
  steps.push(row)
}

// ─── console ──────────────────────────────────────────────────────────────────────

const consoleCounts = dir => {
  const file = path.join(dir, 'console.log')
  if (!fs.existsSync(file)) return null
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const errors = lines.filter(line => / (error|pageerror|reqfail) /.test(line.slice(0, 20)))
  const noise = errors.filter(line => /\breqfail\b.*\.glb net::ERR_ABORTED/.test(line))
  return { lines: lines.length, appErrors: errors.length - noise.length, noise: noise.length }
}

// ─── report ───────────────────────────────────────────────────────────────────────

const pair = ([x, y]) => (same(x, y) ? String(x) : `${x} -> ${y}`)
console.log(`A ${path.resolve(runA)}`)
console.log(`B ${path.resolve(runB)}`)
console.log(
  `structure: ${structureSame ? `identical (${shapeA.size} paths)` : `DIFFERENT (${onlyA.length} paths only in A, ${onlyB.length} only in B)`}`
)
for (const p of onlyA.slice(0, 15)) console.log(`  only A  ${p}`)
for (const p of onlyB.slice(0, 15)) console.log(`  only B  ${p}`)
console.log(`demo: ${pair([A.header?.map, B.header?.map])}  steps: ${pair([A.shots?.length, B.shots?.length])}  warnings: ${pair([A.warnings?.length, B.warnings?.length])}`)
console.log(`renderer: ${pair([A.browser?.renderer, B.browser?.renderer])}`)
console.log(`memory peak MB: ${pair([A.memoryMB?.peak, B.memoryMB?.peak])}  final: ${pair([A.memoryMB?.final, B.memoryMB?.final])}  ready after s: ${pair([A.loaded?.atSec, B.loaded?.atSec])}`)
const ca = consoleCounts(runA)
const cb = consoleCounts(runB)
if (ca || cb) console.log(`console app errors: ${pair([ca?.appErrors, cb?.appErrors])}  aborted-GLB noise: ${pair([ca?.noise, cb?.noise])}  lines: ${pair([ca?.lines, cb?.lines])}`)
console.log('')
console.log('step                              tick         render       mode   focus  eval players  pixels changed  bbox')
let worst = 0
for (const s of steps) {
  const px = s.pixels?.error ?? (s.pixels ? `${s.pixels.changedPct.toFixed(3).padStart(7)} %` : '      -')
  if (s.pixels?.changedPct > worst) worst = s.pixels.changedPct
  const flags = [
    s.stepSame ? null : 'STEP DIFFERS',
    s.error[0] || s.error[1] ? `ERROR ${pair(s.error)}` : null,
  ].filter(Boolean)
  console.log(
    `${String(s.index).padStart(2, '0')} ${String(s.name ?? '').padEnd(30).slice(0, 30)} ${pair(s.tick).padEnd(12)} ${pair(s.renderTick).padEnd(12)} ${pair(s.mode).padEnd(6)} ${pair(s.focused).padEnd(6)} ${(s.evalSame ? 'same' : 'DIFF').padEnd(4)} ${(s.playersSame ? 'same' : 'DIFF').padEnd(7)}  ${px.padEnd(14)}  ${s.pixels?.bbox ? JSON.stringify(s.pixels.bbox) : ''} ${flags.join(' ')}`
  )
}

fs.mkdirSync(outDir, { recursive: true })
const report = {
  runA: path.resolve(runA),
  runB: path.resolve(runB),
  threshold: opts.threshold,
  structure: { same: structureSame, paths: shapeA.size, onlyA, onlyB },
  console: { a: ca, b: cb },
  steps: steps.map(({ paths, ...row }) => row),
}
fs.writeFileSync(path.join(outDir, 'compare.json'), JSON.stringify(report, null, 1))

// ─── 4. sheet ─────────────────────────────────────────────────────────────────────

if (opts.sheet) {
  const sharp = loadSharp()
  const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const LH = 20
  const groups = steps.filter(s => s.paths)
  const perGroup = opts.diffTile ? 3 : 2
  const groupW = perGroup * tileW
  const rows = Math.ceil(groups.length / opts.cols)
  const label = (text, width, color = 'white') =>
    Buffer.from(
      `<svg width="${width}" height="${LH}"><rect width="100%" height="100%" fill="black"/><text x="6" y="15" font-size="13" fill="${color}" font-family="sans-serif">${escape(text)}</text></svg>`
    )
  const tile = async file => sharp(file).resize(tileW, tileH, { fit: 'fill' }).png().toBuffer()
  const blank = await sharp({ create: { width: tileW, height: tileH, channels: 3, background: '#000' } }).png().toBuffer()
  const layers = []
  for (let g = 0; g < groups.length; g++) {
    const s = groups[g]
    const left = (g % opts.cols) * groupW
    const top = Math.floor(g / opts.cols) * (tileH + LH)
    const pct = s.pixels?.changedPct
    const head = `${String(s.index).padStart(2, '0')} ${s.name ?? ''}   A | B${opts.diffTile ? ' | diff' : ''}   ${pct !== undefined ? `${pct.toFixed(3)} % changed` : (s.pixels?.error ?? '')}`
    layers.push({ input: label(head, groupW, pct > 1 ? '#ff6' : 'white'), left, top })
    layers.push({ input: await tile(s.paths[0]), left, top: top + LH })
    layers.push({ input: await tile(s.paths[1]), left: left + tileW, top: top + LH })
    if (opts.diffTile) layers.push({ input: s.diffFile ? await tile(s.diffFile) : blank, left: left + 2 * tileW, top: top + LH })
  }
  if (groups.length) {
    const sheetFile = path.join(outDir, 'sheet.png')
    await sharp({
      create: { width: Math.min(groups.length, opts.cols) * groupW, height: rows * (tileH + LH), channels: 3, background: '#222' },
    })
      .composite(layers)
      .png()
      .toFile(sheetFile)
    console.log(`\nsheet -> ${sheetFile}`)
  }
}
console.log(`report -> ${path.join(outDir, 'compare.json')}`)

const tooMuch = opts.maxPct !== null && worst > opts.maxPct
if (tooMuch) console.log(`largest pixel change ${worst} % exceeds --max-pct ${opts.maxPct}`)
process.exit(!structureSame || tooMuch ? 1 : 0)
