#!/usr/bin/env node
// The base projectile adapter against the base projectile cache at every tick (task X2, ported for contract 14.2).
//
//   flock $S/heavy.lock node --expose-gc scripts/hl/check-adapter.mjs <demo.dem> [--root <checkout>] [--tmp <dir>]
//       [--slot-step <n>] [--out <file.json>]
//
// Loads the demo as the viewer does (lib/load-demo.mjs: the real AsyncParser.ts and ParseWorker.ts, so parser2 and
// both fallback routes run as in the browser; then the extras with every group), then:
//   1. F3's source split (getProjectileSource) and buildProjectileAdapter, built three times (build times);
//   1b. releaseSelfCheck as the browser runs it before a release (256 ticks plus track edges);
//   2. compareWithReader at every tick from -2 to ticks + 2: the same rows in the same order, with the same entity
//      ids, bucket types, teams, positions and rotations; the served types differ from the bucket types exactly
//      typeOverrides times; fractional, NaN, infinite and negative ticks give the same (empty) result;
//   3. getProjectile and getTypeCode at every tick (every --slot-step-th) of every slot, plus slots -1 and ids.length;
//   4. getProjectiles speed over 4000 ticks around the busiest tick, cache and adapter (microseconds per call);
//   5. a planted defect (the team of the latest-ending track's last run flipped in a fresh adapter) must fail
//      releaseSelfCheck;
//   6. a digest of what DemoViewer reads (getProjectilesAtTick at every tick) before and after
//      AsyncParser.releaseProjectileCache, the bytes it released, and that a second release returns 0;
//   7. the split computed again after the release (as after an extras restart) equals the first one.
// --root defaults to this checkout, --tmp (bundled modules while they are imported) to the OS temp dir. Every worker
// shares this process, so it peaks above the browser: VmHWM 0.5 GB on 1434434, 1.0 GB on 1438891 and 2.1 to 2.3 GB
// on the tetsudo fallback demos 1428628 and 1429417 (run those only when `free -m` shows 3000 MB available). Prints a JSON summary (also to --out); exit code 1 when a check fails.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseArgs, REPO_ROOT } from './lib/bundle.mjs'
import { loadDemo, vmMB } from './lib/load-demo.mjs'

const { positional, flags } = parseArgs(process.argv.slice(2))
const demoPath = positional[0]
const slotStep = Number(flags['slot-step'] ?? 1)
if (!demoPath || !(Number.isInteger(slotStep) && slotStep >= 1)) {
  console.error('usage: node --expose-gc scripts/hl/check-adapter.mjs <demo.dem> [--root checkout] [--tmp dir] [--slot-step n] [--out file]')
  process.exit(2)
}
const root = path.resolve(flags.root ?? REPO_ROOT)
const tmp = fs.mkdtempSync(path.join(flags.tmp ?? os.tmpdir(), 'hl-adapter-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))
const gc = () => {
  if (globalThis.gc) {
    globalThis.gc()
    globalThis.gc()
  }
}
const mem = () => ({
  ...vmMB(),
  heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
  externalMB: Math.round(process.memoryUsage().arrayBuffers / 1048576),
})
const failures = []
const out = { demo: path.basename(demoPath), root, exposeGc: typeof globalThis.gc === 'function' }

const { parsed, x, route, baseMs, extrasMs, modules } = await loadDemo(root, demoPath, {
  tmp,
  entries: { source: 'src/highlander/combat/projectileSource.ts', adapter: 'src/highlander/memory/projectileAdapter.ts' },
})
const { getProjectileSource } = modules.source
const { buildProjectileAdapter, compareWithReader, releaseSelfCheck } = modules.adapter
out.route = route
out.parserFallback = !!parsed.parserFallback
out.ticks = parsed.ticks
out.positionScale = parsed.positionScale
out.baseMs = Math.round(baseMs)
out.extrasMs = Math.round(extrasMs)
const cache = parsed.projectileCache
const cacheParts = [cache.positionCache, cache.rotationCache, cache.teamNumberCache, cache.typeCache]
let cacheBytes = 0
for (const c of cacheParts) for (const a of c.data) cacheBytes += a?.byteLength ?? 0
out.cacheMB = +(cacheBytes / 1048576).toFixed(1)

// ─── 1. the split, then the adapter (timed) ───────────────────────────────────

const source = getProjectileSource(x, parsed)
const split = { served: Array.from(source.servedByBase), baseType: Array.from(source.baseType), mismatches: source.mismatches }
out.split = { instances: split.served.length, served: split.served.reduce((a, b) => a + b, 0), mismatches: split.mismatches }
gc()
const memBeforeBuild = mem()
const builds = []
let adapter
for (let k = 0; k < 3; k++) {
  const t0 = performance.now()
  adapter = buildProjectileAdapter(cache, parsed.ticks, x, source)
  builds.push(+(performance.now() - t0).toFixed(1))
}
out.buildMs = builds
out.stats = adapter.stats
out.adapterMB = +(adapter.stats.bytes / 1048576).toFixed(2)

// ─── 1b. the release self-check as the browser runs it ────────────────────────

{
  const t0 = performance.now()
  const check = releaseSelfCheck(adapter, cache, parsed.ticks, 256)
  out.releaseSelfCheck = { ...check, ms: +(performance.now() - t0).toFixed(1) }
  if (check.mismatches) failures.push(`release self-check found ${check.mismatches} differences, first ${JSON.stringify(check.first)}`)
}

// ─── 2. every tick (and a few past both ends): exact rows, then the served view ─

const allTicks = Array.from({ length: parsed.ticks + 5 }, (_, i) => i - 2) // -2 .. ticks + 2
const exact = compareWithReader(adapter, cache, allTicks)
out.exact = exact
if (exact.mismatches) failures.push(`exact rows differ at ${exact.mismatches} places, first ${JSON.stringify(exact.first)}`)
let servedTypeDiffs = 0
for (let t = 0; t < parsed.ticks; t++) {
  const a = cache.getProjectiles(t)
  const b = adapter.getProjectiles(t)
  for (let i = 0; i < a.length && i < b.length; i++) if (a[i].type !== b[i].type) servedTypeDiffs++
}
out.servedTypeDiffs = servedTypeDiffs
if (servedTypeDiffs !== adapter.stats.typeOverrides) {
  failures.push(`served type diffs ${servedTypeDiffs} != typeOverrides ${adapter.stats.typeOverrides}`)
}
for (const t of [0.5, 100.25, NaN, Infinity, -1]) {
  if (cache.getProjectiles(t).length !== adapter.getProjectiles(t).length) failures.push(`getProjectiles(${t}) differs`)
}

// ─── 3. per slot: getProjectile and getTypeCode ───────────────────────────────

let slotChecks = 0
let slotDiffs = 0
let firstSlotDiff = null
const ids = cache.projectileIds
for (let slot = -1; slot <= ids.length; slot++) {
  const real = slot >= 0 && slot < ids.length
  for (let t = -1; t < parsed.ticks + 1; t += real ? slotStep : 997) {
    const a = cache.getProjectile(t, slot)
    const b = adapter.getProjectile(t, slot, true)
    slotChecks++
    // getTypeCode means something on rows only; with type overrides the adapter's code is the instance's baseType
    const sameRow = a === null ? b === null : b !== null && JSON.stringify(a) === JSON.stringify(b)
    const sameCode = a === null || adapter.stats.typeOverrides > 0 || cache.getTypeCode(t, slot) === adapter.getTypeCode(t, slot)
    if (!sameRow || !sameCode) {
      slotDiffs++
      firstSlotDiff ??= { slot, t, cache: a, adapter: b, cacheCode: cache.getTypeCode(t, slot), adapterCode: adapter.getTypeCode(t, slot) }
    }
  }
}
out.slotChecks = slotChecks
out.slotDiffs = slotDiffs
if (slotDiffs) failures.push(`getProjectile/getTypeCode differ ${slotDiffs} times, first ${JSON.stringify(firstSlotDiff)}`)

// ─── 4. speed around the busiest tick ─────────────────────────────────────────

let busiest = 0
let busiestRows = -1
for (let t = 0; t < parsed.ticks; t++) {
  const n = adapter.getProjectiles(t).length
  if (n > busiestRows) {
    busiestRows = n
    busiest = t
  }
}
const from = Math.max(0, busiest - 2000)
const to = Math.min(parsed.ticks, from + 4000)
const time = reader => {
  let best = Infinity
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now()
    for (let t = from; t < to; t++) reader.getProjectiles(t)
    best = Math.min(best, performance.now() - t0)
  }
  return +((best / Math.max(1, to - from)) * 1000).toFixed(2) // microseconds per call
}
out.busiest = { tick: busiest, rows: busiestRows }
out.usPerCall = { cache: time(cache), adapter: time(adapter) }

// ─── 5. a planted defect must fail the self-check ─────────────────────────────

{
  const broken = buildProjectileAdapter(cache, parsed.ticks, x, source)
  let lastTrack = -1
  for (let tr = 0; tr < broken.trackSlot.length; tr++) {
    if (lastTrack < 0 || broken.trackEnd[tr] > broken.trackEnd[lastTrack]) lastTrack = tr
  }
  if (lastTrack < 0) {
    out.planted = { skipped: 'no tracks' }
  } else {
    const lastRun = broken.trackRun[lastTrack + 1] - 1
    broken.runTeam[lastRun] ^= 1
    const caught = releaseSelfCheck(broken, cache, parsed.ticks, 256)
    out.planted = { track: lastTrack, slot: broken.trackSlot[lastTrack], end: broken.trackEnd[lastTrack], mismatches: caught.mismatches, first: caught.first }
    if (!(caught.mismatches > 0)) failures.push('the release self-check missed a planted team flip in the last run')
  }
}

// ─── 6. what DemoViewer reads, before and after the release ───────────────────

const digest = () => {
  let h = 0x811c9dc5
  const f = new Float64Array(1)
  const u = new Uint32Array(f.buffer)
  const mix = v => {
    h ^= v
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const num = v => {
    f[0] = v
    mix(u[0])
    mix(u[1])
  }
  for (let t = 0; t <= parsed.ticks; t++) {
    for (const p of parsed.getProjectilesAtTick(t)) {
      num(p.entityId)
      num(p.teamNumber)
      for (const ch of p.type) mix(ch.charCodeAt(0))
      for (const v of [p.position.x, p.position.y, p.position.z, p.rotation.x, p.rotation.y, p.rotation.z]) num(v)
    }
    mix(0xfeed)
  }
  return h.toString(16)
}
// Before the release getProjectilesAtTick reads the cache's bucket types; equal to the adapter's while typeOverrides is 0
const before = digest()
gc()
const memBefore = mem()
const released = parsed.releaseProjectileCache(adapter)
const again = parsed.releaseProjectileCache(adapter)
gc()
const memAfter = mem()
const after = digest()
out.release = {
  releasedMB: +(released / 1048576).toFixed(1),
  secondCall: again,
  cacheArraysLeft: cacheParts.map(c => c.data.length),
  flag: parsed.projectileCacheReleased,
  readerIsAdapter: parsed.projectileReader() === adapter,
  digestBefore: before,
  digestAfter: after,
  memBeforeBuild,
  memBefore,
  memAfter,
}
if (before !== after && adapter.stats.typeOverrides === 0) failures.push(`digest before ${before} != after ${after}`)
if (released !== cacheBytes) failures.push(`released ${released} != cache bytes ${cacheBytes}`)
if (again !== 0) failures.push('a second release returned bytes')
if (!parsed.projectileCacheReleased || parsed.projectileReader() !== adapter) failures.push('the reader is not the adapter after the release')

// ─── 7. the split again after the release (a new extras identity) ─────────────

const fresh = getProjectileSource({ ...x }, parsed)
const sameSplit =
  fresh.mismatches === split.mismatches &&
  fresh.servedByBase.length === split.served.length &&
  fresh.servedByBase.every((v, j) => v === split.served[j]) &&
  fresh.baseType.every((v, j) => v === split.baseType[j])
out.splitAfterRelease = { same: sameSplit, served: fresh.servedByBase.reduce((a, b) => a + b, 0), mismatches: fresh.mismatches }
if (!sameSplit) failures.push('the split computed after the release differs')

out.ok = failures.length === 0
out.failures = failures
out.mem = vmMB()
const json = JSON.stringify(out, null, 1)
if (flags.out) fs.writeFileSync(flags.out, json)
console.log(json)
process.exit(out.ok ? 0 : 1)
