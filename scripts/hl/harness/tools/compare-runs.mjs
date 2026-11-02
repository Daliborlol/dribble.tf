#!/usr/bin/env node
// Compare two harness runs of the same plan:
//
//   node scripts/hl/harness/tools/compare-runs.mjs <runA> <runB> [outDir] [--threshold 24] [--max-pct <p>]
//        [--allow-request <key>]... [--cols 2] [--tile 400x225] [--no-diff-tile] [--no-sheet]
//
// 1. Manifest structure: every JSON path and value type of both manifest.json files (array indices
//    included), so a missing key, a changed type or an extra step shows up. The asset-phase subtrees
//    assetPack, requests, requestSummary and each step's assetsIdle and eval are left out
//    (specs/assets/contract.md 5.1).
// 1b. Requests: the same-origin request log by the request-set rule of contract 5.1: pathname only, Vite's
//    content hashes under /assets/ normalised to -[hash], each key counted by its distinct raw pathnames.
//    Keys given with --allow-request are left out. A different asset-pack fingerprint is a warning.
// 2. Per step: the step as written, tick, render tick, camera mode, focused player, step error, and whether
//    the eval result and the player list are identical.
// 3. Pixel diff of each screenshot pair (lib/images.mjs; threshold 24 of 255 per channel).
// 4. outDir/sheet.png: each step as A | B | diff (magenta = changed pixels), labelled with the diff share.
// Writes outDir/compare.json. outDir defaults to <runB>-vs-<name of runA>.
//
// Exit code, as with diff(1): 0 when both runs did the same thing, 1 when they did not (or, with --max-pct,
// a shot changed more than p percent), 2 when they could not be compared, 64 for a usage error. The same
// thing means the same demo header, viewport and manifest structure, and for every step the same step
// definition, tick, camera mode, focused player and error, a screenshot in both runs or in neither, and,
// unless the step plays ("play" runs on wall time), the same render tick and player list. Differences in
// eval results, browser, renderer and console error counts are warnings only: some probes return frame
// counts that change from run to run. Different request keys are a failure ("requests differ").

import fs from 'node:fs'
import path from 'node:path'
import { SetupError, rerunWithoutFontconfigWarnings } from '../lib/setup.mjs'
import { DEFAULT_THRESHOLD, diffPng, loadSharp } from '../lib/images.mjs'

if (await rerunWithoutFontconfigWarnings()) await new Promise(() => {}) // the child does the work

const EXIT_DIFFERENT = 1
const EXIT_TROUBLE = 2
const EXIT_USAGE = 64
const USAGE =
  'usage: node scripts/hl/harness/tools/compare-runs.mjs <runA> <runB> [outDir] [--threshold 24] [--max-pct <p>] [--allow-request <key>]... [--cols 2] [--tile 400x225] [--no-diff-tile] [--no-sheet]'

const argv = process.argv.slice(2)
const positional = []
const opts = { threshold: DEFAULT_THRESHOLD, cols: 2, tile: '400x225', diffTile: true, sheet: true, maxPct: null, allowRequests: [] }
const usageProblems = []
const numberArg = (name, value) => {
  const n = Number(value)
  if (value === undefined || !Number.isFinite(n) || n < 0) usageProblems.push(`${name} needs a non-negative number`)
  return n
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--threshold') opts.threshold = numberArg(a, argv[++i])
  else if (a === '--max-pct') opts.maxPct = numberArg(a, argv[++i])
  else if (a === '--cols') opts.cols = Math.max(1, numberArg(a, argv[++i]) | 0)
  else if (a === '--tile') opts.tile = String(argv[++i])
  else if (a === '--no-diff-tile') opts.diffTile = false
  else if (a === '--no-sheet') opts.sheet = false
  else if (a === '--allow-request' || a.startsWith('--allow-request=')) {
    const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]
    if (!value || value.startsWith('--')) usageProblems.push('--allow-request needs a pathname or normalised key')
    else opts.allowRequests.push(value)
  }
  else if (a.startsWith('--')) usageProblems.push(`unknown option ${a}`)
  else positional.push(a)
}
const [runA, runB, outArg, ...extra] = positional
if (!runA || !runB) usageProblems.push('two run folders are needed')
if (extra.length) usageProblems.push(`unexpected argument ${extra[0]}`)
if (!/^\d+x\d+$/.test(opts.tile)) usageProblems.push(`--tile needs WxH, e.g. 400x225 (got "${opts.tile}")`)
if (usageProblems.length) {
  console.error(`${usageProblems.join('\n')}\n${USAGE}`)
  process.exit(EXIT_USAGE)
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
  process.exit(EXIT_TROUBLE)
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)
const equal = ([x, y]) => same(x, y)
const pair = ([x, y]) => (same(x, y) ? String(x) : `${x} -> ${y}`)
const stepLabel = s => `step ${String(s.index).padStart(2, '0')}${s.name ? ` ${s.name}` : ''}`

// ─── 1. structure ─────────────────────────────────────────────────────────────────

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
// Contract 5.1: these subtrees are judged by the request-set rule or are warnings (evals), not by structure.
const UNCHECKED = [/^\.(assetPack|requests|requestSummary)$/, /^\.shots\[\d+\]\.(assetsIdle|eval)$/]
const shapeOf = (value, prefix = '', out = new Set()) => {
  if (UNCHECKED.some(re => re.test(prefix))) return out
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

// ─── 1b. requests ─────────────────────────────────────────────────────────────────

// Contract 5.1 request-set rule. The log keeps the query; the comparison uses the pathname, with the Vite
// content hash of build files under /assets/ replaced by [hash]. Each key counts the distinct raw pathnames
// behind it, since two chunks can share a normalised name.
const HASHED = /^(\/assets\/.+)-[A-Za-z0-9_-]{8}(\.[A-Za-z0-9]+)$/
const requestKey = pathname => pathname.replace(HASHED, '$1-[hash]$2')
const requestKeys = M => {
  if (!Array.isArray(M.requests)) return null
  const raw = new Map()
  for (const entry of M.requests) {
    const pathname = String(entry?.path ?? '').split('?')[0]
    const key = requestKey(pathname)
    if (!raw.has(key)) raw.set(key, new Set())
    raw.get(key).add(pathname)
  }
  return new Map([...raw].map(([key, set]) => [key, set.size]))
}
const keysA = requestKeys(A)
const keysB = requestKeys(B)
const allowed = new Set(opts.allowRequests.map(key => requestKey(String(key).split('?')[0])))
const requestDiffs = []
const allowedDiffs = []
if (keysA && keysB) {
  for (const key of [...new Set([...keysA.keys(), ...keysB.keys()])].sort()) {
    const counts = [keysA.get(key) ?? 0, keysB.get(key) ?? 0]
    if (counts[0] === counts[1]) continue
    ;(allowed.has(key) ? allowedDiffs : requestDiffs).push({ key, a: counts[0], b: counts[1] })
  }
}
const requestsCompared = !!(keysA && keysB)
const requestsSame = requestsCompared && requestDiffs.length === 0
const unusedAllows = [...allowed].filter(key => !allowedDiffs.some(d => d.key === key))

// ─── 2 + 3. steps and pixels ──────────────────────────────────────────────────────

// A step that plays runs on wall time, so its render tick and player list vary from run to run.
const isTimed = step => Number(step?.play) > 0
const count = Math.max(A.shots?.length ?? 0, B.shots?.length ?? 0)
const steps = []
for (let i = 0; i < count; i++) {
  const a = A.shots?.[i]
  const b = B.shots?.[i]
  const row = {
    index: i,
    name: a?.step?.name ?? b?.step?.name ?? null,
    stepSame: same(a?.step, b?.step),
    timed: isTimed(a?.step) || isTimed(b?.step),
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
  const filesThere = [fileA, fileB].map(file => !!file && fs.existsSync(file))
  if (filesThere[0] && filesThere[1]) {
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
        process.exit(EXIT_TROUBLE)
      }
      row.pixels = { error: String(error?.message || error) }
    }
  }

  // what makes this step "not the same thing"
  const failures = []
  if (!a || !b) failures.push(`only in run ${a ? 'A' : 'B'}`)
  else {
    if (!row.stepSame) failures.push('the step differs')
    if (!equal(row.tick)) failures.push(`tick ${pair(row.tick)}`)
    if (!row.timed && !equal(row.renderTick)) failures.push(`render tick ${pair(row.renderTick)}`)
    if (!equal(row.mode)) failures.push(`mode ${pair(row.mode)}`)
    if (!equal(row.focused)) failures.push(`focused ${pair(row.focused)}`)
    if (!equal(row.error)) failures.push(`error ${pair(row.error.map(e => (e === null ? 'none' : JSON.stringify(e))))}`)
    if (!row.timed && !row.playersSame) failures.push('the player list differs')
    if (!!fileA !== !!fileB) failures.push(`screenshot only in run ${fileA ? 'A' : 'B'}`)
    else if (fileA && !(filesThere[0] && filesThere[1])) {
      failures.push(`screenshot missing on disk: ${[fileA, fileB].filter((_, k) => !filesThere[k]).join(', ')}`)
    } else if (row.pixels?.error) failures.push(`screenshots not comparable: ${row.pixels.error}`)
  }
  row.failures = failures
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
const ca = consoleCounts(runA)
const cb = consoleCounts(runB)

// ─── verdict ──────────────────────────────────────────────────────────────────────

let worst = 0
for (const s of steps) if (s.pixels?.changedPct > worst) worst = s.pixels.changedPct
const tooMuch = opts.maxPct !== null && worst > opts.maxPct

const failures = []
if (!structureSame) {
  const sample = [...onlyA.map(p => `A ${p}`), ...onlyB.map(p => `B ${p}`)]
  failures.push(
    `manifest structure: ${onlyA.length} path(s) only in A, ${onlyB.length} only in B (${sample.slice(0, 3).join(', ')}${sample.length > 3 ? ', ...' : ''})`
  )
}
if (!same(A.header, B.header)) failures.push(`demo header: ${JSON.stringify(A.header)} -> ${JSON.stringify(B.header)}`)
if (!same(A.viewport, B.viewport)) failures.push(`viewport: ${JSON.stringify(A.viewport)} -> ${JSON.stringify(B.viewport)}`)
for (const s of steps) for (const reason of s.failures) failures.push(`${stepLabel(s)}: ${reason}`)
if (tooMuch) failures.push(`largest pixel change ${worst} % exceeds --max-pct ${opts.maxPct}`)
const countsText = d => `${d.key} ${d.a} -> ${d.b}`
if (requestDiffs.length) failures.push(`requests differ: ${requestDiffs.map(countsText).join(', ')}`)
if (!keysA !== !keysB) failures.push(`request log only in run ${keysA ? 'A' : 'B'} (the other run's harness predates it)`)

const warnings = []
const evalDiffers = steps.filter(s => !s.evalSame && !s.timed && !s.failures.length)
if (evalDiffers.length) {
  warnings.push(`eval results differ at ${evalDiffers.map(stepLabel).join(', ')} (read them: some probes return frame counts)`)
}
const timedDiffers = steps.filter(s => s.timed && !s.failures.length && (!equal(s.renderTick) || !s.playersSame || !s.evalSame))
if (timedDiffers.length) {
  warnings.push(`render tick, player list or eval differ at ${timedDiffers.map(stepLabel).join(', ')}, which play on wall time`)
}
const browserOf = M => M.browser ?? {}
if (!same(browserOf(A).executablePath, browserOf(B).executablePath)) {
  warnings.push(`different browser: ${browserOf(A).executablePath} -> ${browserOf(B).executablePath}`)
}
if (!same(browserOf(A).gpu, browserOf(B).gpu) || !same(browserOf(A).renderer, browserOf(B).renderer)) {
  warnings.push(`different WebGL backend: ${browserOf(A).gpu} ${browserOf(A).renderer} -> ${browserOf(B).gpu} ${browserOf(B).renderer}`)
}
if (ca && cb && ca.appErrors !== cb.appErrors) warnings.push(`console app errors ${ca.appErrors} -> ${cb.appErrors} (read console.log)`)
const packOf = M => M.assetPack ?? {}
if (!same(packOf(A).fingerprint ?? null, packOf(B).fingerprint ?? null)) {
  warnings.push(`different asset-pack fingerprint: ${packOf(A).fingerprint ?? 'none'} -> ${packOf(B).fingerprint ?? 'none'}`)
} else if (!same(packOf(A).manifestSha256 ?? null, packOf(B).manifestSha256 ?? null) || !same(packOf(A).served ?? null, packOf(B).served ?? null)) {
  warnings.push(
    `different asset pack: served ${packOf(A).served ?? null} -> ${packOf(B).served ?? null}, manifest sha256 ${packOf(A).manifestSha256?.slice(0, 12) ?? 'none'} -> ${packOf(B).manifestSha256?.slice(0, 12) ?? 'none'}`
  )
}
if (!keysA && !keysB) warnings.push('no request log in either run (harness before the asset phase); requests not compared')
if (allowedDiffs.length) warnings.push(`allowed request differences: ${allowedDiffs.map(countsText).join(', ')}`)
if (unusedAllows.length) warnings.push(`--allow-request key(s) that did not differ: ${unusedAllows.join(', ')}`)
const exitCode = failures.length ? EXIT_DIFFERENT : 0

// ─── report ───────────────────────────────────────────────────────────────────────

console.log(`A ${path.resolve(runA)}`)
console.log(`B ${path.resolve(runB)}`)
console.log(
  `structure: ${structureSame ? `identical (${shapeA.size} paths)` : `DIFFERENT (${onlyA.length} paths only in A, ${onlyB.length} only in B)`}`
)
for (const p of onlyA.slice(0, 15)) console.log(`  only A  ${p}`)
for (const p of onlyB.slice(0, 15)) console.log(`  only B  ${p}`)
console.log(
  `requests: ${
    requestsCompared
      ? `${requestsSame ? 'same keys' : 'DIFFERENT keys'} (${keysA.size} -> ${keysB.size} keys, ${A.requests.length} -> ${B.requests.length} logged paths${allowedDiffs.length ? `, ${allowedDiffs.length} allowed difference(s)` : ''})`
      : 'not compared'
  }`
)
for (const d of requestDiffs.slice(0, 20)) console.log(`  differ  ${countsText(d)}`)
for (const d of allowedDiffs) console.log(`  allowed ${countsText(d)}`)
console.log(`asset pack: ${pair([packOf(A).dir ?? null, packOf(B).dir ?? null])}  fingerprint: ${pair([packOf(A).fingerprint ?? null, packOf(B).fingerprint ?? null])}`)
console.log(`demo: ${pair([A.header?.map, B.header?.map])}  steps: ${pair([A.shots?.length, B.shots?.length])}  warnings: ${pair([A.warnings?.length, B.warnings?.length])}`)
console.log(`browser: ${pair([browserOf(A).executablePath, browserOf(B).executablePath])}`)
console.log(`renderer: ${pair([browserOf(A).renderer, browserOf(B).renderer])}  gpu: ${pair([browserOf(A).gpu, browserOf(B).gpu])}`)
console.log(`memory peak MB: ${pair([A.memoryMB?.peak, B.memoryMB?.peak])}  final: ${pair([A.memoryMB?.final, B.memoryMB?.final])}  ready after s: ${pair([A.loaded?.atSec, B.loaded?.atSec])}`)
if (ca || cb) console.log(`console app errors: ${pair([ca?.appErrors, cb?.appErrors])}  aborted-GLB noise: ${pair([ca?.noise, cb?.noise])}  lines: ${pair([ca?.lines, cb?.lines])}`)
console.log('')
console.log('step                              tick         render       mode      focus  eval players  pixels changed  bbox')
for (const s of steps) {
  const px = s.pixels?.error ?? (s.pixels ? `${s.pixels.changedPct.toFixed(3).padStart(7)} %` : '      -')
  const flags = [s.timed ? 'timed' : null, s.failures.length ? `DIFFERENT: ${s.failures.join('; ')}` : null].filter(Boolean)
  console.log(
    `${String(s.index).padStart(2, '0')} ${String(s.name ?? '').padEnd(30).slice(0, 30)} ${pair(s.tick).padEnd(12)} ${pair(s.renderTick).padEnd(12)} ${pair(s.mode).padEnd(9)} ${pair(s.focused).padEnd(6)} ${(s.evalSame ? 'same' : 'DIFF').padEnd(4)} ${(s.playersSame ? 'same' : 'DIFF').padEnd(7)}  ${px.padEnd(14)}  ${s.pixels?.bbox ? JSON.stringify(s.pixels.bbox) : ''} ${flags.join('  ')}`
  )
}

fs.mkdirSync(outDir, { recursive: true })
const report = {
  runA: path.resolve(runA),
  runB: path.resolve(runB),
  threshold: opts.threshold,
  maxPct: opts.maxPct,
  result: { exitCode, same: exitCode === 0, failures, warnings },
  structure: { same: structureSame, paths: shapeA.size, onlyA, onlyB },
  requests: {
    compared: requestsCompared,
    same: requestsSame,
    keys: [keysA?.size ?? null, keysB?.size ?? null],
    differ: requestDiffs,
    allowed: allowedDiffs,
    allowRequest: opts.allowRequests,
  },
  assetPack: { a: A.assetPack ?? null, b: B.assetPack ?? null },
  browser: { a: A.browser ?? null, b: B.browser ?? null },
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
    const head = `${String(s.index).padStart(2, '0')} ${s.name ?? ''}   A | B${opts.diffTile ? ' | diff' : ''}   ${pct !== undefined ? `${pct.toFixed(3)} % changed` : (s.pixels?.error ?? '')}${s.failures.length ? '   DIFFERENT STEP' : ''}`
    layers.push({ input: label(head, groupW, s.failures.length ? '#f66' : pct > 1 ? '#ff6' : 'white'), left, top })
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

console.log('')
if (warnings.length) console.log(`warnings:\n${warnings.map(w => `  - ${w}`).join('\n')}`)
if (failures.length) {
  console.log(`result: DIFFERENT (exit ${exitCode})\n${failures.map(f => `  - ${f}`).join('\n')}`)
} else {
  console.log(
    `result: same steps, ticks, modes, focus, players and request keys (exit 0); judge the pixel changes above${opts.maxPct === null ? '' : ` (all within --max-pct ${opts.maxPct})`}`
  )
}
process.exit(exitCode)
