#!/usr/bin/env node
// Node check of the base-parse fallback (tasks B1 and B2): the base values the viewer would use, the extras parsed
// with them, and the alignment rule of contract section 3.6 between the two.
//
//   flock $S/heavy.lock node scripts/hl/check-fallback.mjs <demo.dem> [--force-fallback] [--out summary.json]
//       [--expect-route parser2|no-timeline|delayed-start|late-start|forced] [--tmp <dir>]
//
// 1. Child process: scripts/hl/fallback-values.mjs (parser2, then the fork's fallback cache builder on either trigger
//    of ParseWorker.ts: no timeline (B1) or a delayed start by its delayedStartOf (B2)), so the base heaps never share
//    this process. --tmp goes to the child (where it writes the bundled ParseWorker module).
// 2. This process: src/libs/hlextras parse_demo_extras_input with the child's startTick, tickBase, ticks,
//    intervalPerTick and playerEntityIds (what loadExtras.ts passes), hydrate with sceneOrigin, then
//    checkAlignmentWith against the child's position samples (what loadExtras.ts runs before 'ready').
// 3. Also: the share of alive base samples inside the reported world bounds (players on the map).
// Prints a JSON summary with the route taken; exit code 1 when the base has no timeline, the extras fail, alignment
// fails or the route differs from --expect-route.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { importBundled, parseArgs, REPO_ROOT, vmHwmKB } from './lib/bundle.mjs'

const { positional, flags } = parseArgs(process.argv.slice(2), ['force-fallback'])
const demoPath = positional[0]
if (!demoPath) {
  console.error('usage: node scripts/hl/check-fallback.mjs <demo.dem> [--force-fallback] [--out summary.json] [--expect-route parser2|no-timeline|delayed-start|late-start|forced] [--tmp dir]')
  process.exit(2)
}
const ROUTES = {
  parser2: 'parser2',
  'no-timeline': 'fallback: no-timeline',
  'delayed-start': 'fallback: delayed-start',
  'late-start': 'parser2 (late start)',
  forced: 'fallback: forced',
}
// Checked before the child runs: a typo should not cost a whole parse
if (flags['expect-route'] !== undefined && !ROUTES[flags['expect-route']]) {
  console.error(`[check-fallback] unknown --expect-route ${flags['expect-route']} (one of ${Object.keys(ROUTES).join(', ')})`)
  process.exit(2)
}
const failures = []

// ─── 1. base values (child) ───────────────────────────────────────────────────

const childArgs = [path.join(REPO_ROOT, 'scripts/hl/fallback-values.mjs'), demoPath]
if (flags['force-fallback']) childArgs.push('--force-fallback')
if (flags.tmp) childArgs.push('--tmp', flags.tmp)
const tBase = performance.now()
const child = spawnSync(process.execPath, childArgs, { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' })
const baseWallMs = performance.now() - tBase
if (child.status !== 0) {
  console.error(child.stderr)
  console.error(`[check-fallback] fallback-values.mjs failed with status ${child.status}`)
  process.exit(1)
}
const base = JSON.parse(child.stdout)
if (flags['expect-route'] !== undefined) {
  const want = ROUTES[flags['expect-route']]
  if (base.route !== want) failures.push(`route: ${base.route}, expected ${want}`)
}
if (!(base.ticks > 1 && base.nextMappedPlayer > 0)) failures.push(`base has no timeline (ticks ${base.ticks}, players ${base.nextMappedPlayer})`)

// ─── 2. extras with the base values ───────────────────────────────────────────

const { hydrate, typedArrayBytes } = await importBundled('scripts/hl/lib/hydrate-entry.mjs')
const pkgDir = path.join(REPO_ROOT, 'src/libs/hlextras')
const wasmMod = await import(pathToFileURL(path.join(pkgDir, 'hlextras.js')).href)
const wasm = wasmMod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'hlextras_bg.wasm')) })
const ITEMS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/constants/items.json'), 'utf8'))
const options = {
  startTick: base.startTick,
  tickBase: base.tickBase,
  ticks: base.ticks,
  intervalPerTick: base.intervalPerTick,
  playerEntityIds: base.playerEntityIds,
  wearableDefs: Object.keys(ITEMS).filter(k => ITEMS[k].c.startsWith('tf_wearable')).map(Number).sort((a, b) => a - b),
}
let raw
let extrasMs = 0
{
  let bytes = fs.readFileSync(demoPath)
  const input = new wasmMod.ExtrasInput(bytes.length)
  new Uint8Array(wasm.memory.buffer, input.ptr(), bytes.length).set(bytes)
  bytes = null
  const t0 = performance.now()
  raw = wasmMod.parse_demo_extras_input(input, options, () => {})
  extrasMs = performance.now() - t0
}
if (typeof raw === 'string' || !raw) {
  console.error(`[check-fallback] extras parse failed: ${raw}`)
  process.exit(1)
}
const x = hydrate(raw, base.sceneOrigin)
const typedBytes = typedArrayBytes(x)

// ─── 3. alignment (section 3.6) and players on the map ────────────────────────

const lib = await importBundled('scripts/hl/lib/extras-entry.mjs')
const { targets, window: stride } = base.samples
const sampleBytes = Buffer.from(base.samples.data, 'base64')
const data = new Float32Array(sampleBytes.buffer, sampleBytes.byteOffset, sampleBytes.byteLength / 4)
const players = base.nextMappedPlayer
const sample = (p, tick) => {
  for (let k = 0; k < targets.length; k++) {
    const o = tick - targets[k]
    if (o < 0 || o >= stride || p >= players) continue
    const at = ((k * players + p) * stride + o) * 4
    if (Number.isNaN(data[at])) return null
    return { x: data[at], y: data[at + 1], z: data[at + 2], health: data[at + 3] }
  }
  return null
}
const alignment = lib.checkAlignmentWith(x, {
  startTick: base.startTick,
  tickBase: base.tickBase,
  ticks: base.ticks,
  nextMappedPlayer: players,
  sample,
})
if (!alignment.ok) failures.push(`alignment: ${alignment.reason}`)

// Alive base samples (scene space) inside [0, boundaryMax - boundaryMin] with 64 units of slack
let alive = 0
let inside = 0
const max = base.worldBoundaryMax
const min = base.sceneOrigin
if (max) {
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z }
  for (let k = 0; k < targets.length; k++) {
    for (let p = 0; p < players; p++) {
      for (let o = 0; o < stride; o++) {
        const at = ((k * players + p) * stride + o) * 4
        const [sx, sy, sz, health] = [data[at], data[at + 1], data[at + 2], data[at + 3]]
        if (Number.isNaN(sx) || health <= 0 || (sx === 0 && sy === 0 && sz === 0)) continue
        alive++
        const ok = (v, s) => v >= -64 && v <= s + 64
        if (ok(sx, size.x) && ok(sy, size.y) && ok(sz, size.z)) inside++
      }
    }
  }
  if (alive > 0 && inside / alive < 0.99) failures.push(`only ${inside} of ${alive} alive base samples inside the world bounds`)
}

const summary = {
  demo: path.basename(demoPath),
  map: base.map,
  ok: failures.length === 0,
  failures,
  route: base.route,
  base: {
    parserFallback: base.parserFallback,
    fallback: base.fallback,
    parserFallbackFailure: base.parserFallbackFailure,
    startTick: base.startTick,
    startDemoTick: base.startDemoTick,
    tickBase: base.tickBase,
    ticks: base.ticks,
    players: base.nextMappedPlayer,
    positionScale: base.positionScale,
    sceneOrigin: base.sceneOrigin,
    deaths: base.deaths,
    projectiles: base.projectiles,
    parseMs: base.parseMs,
    childVmHwmMB: Math.round(base.vmHwmKB / 1024),
    wallMs: Math.round(baseWallMs),
  },
  extras: {
    parseMs: Math.round(extrasMs),
    typedMB: +(typedBytes / 1048576).toFixed(1),
    wasmMB: Math.round(wasm.memory.buffer.byteLength / 1048576),
    ticks: x.meta.ticks,
    playerCount: x.meta.playerCount,
    warnings: x.meta.warnings,
  },
  alignment,
  onMap: { alive, inside },
  vmHwmMB: Math.round(vmHwmKB() / 1024),
}
const json = JSON.stringify(summary, null, 1)
if (flags.out) fs.writeFileSync(flags.out, json)
console.log(json)
process.exitCode = failures.length ? 1 : 0
