#!/usr/bin/env node
// Delayed-start fallback check (task B2): what the viewer's base parse does with a demo and, when it routes the demo
// to the fallback, how the fallback's timeline compares with parser2's.
//
//   flock $S/heavy.lock node scripts/hl/check-delayed-start.mjs <demo.dem> --tmp <dir on a disk> [--out summary.json]
//       [--root <checkout>] [--examples <n>] [--keep]
//
// --tmp is where the children dump the caches: about 5.6 x the demo file per base cache (1428628, 85 MB: 476 MB),
// three of them after a delayed start. Without --tmp the OS temp dir is used, and the check refuses to start when that
// is a tmpfs (RAM; /tmp here, with a per-user quota every process shares) and the demo is over 20 MB. The dumps are
// removed when the check ends, also after a failure, unless --keep.
//
// One child process per base parse, so each heap is measured alone (the browser ends each worker):
//   1. worker:   the real ParseWorker.ts of --root (default: this checkout), bundled with esbuild, its onmessage run
//                with { buffer }, the browser's first message. Records whether it asks for the fallback, the request,
//                the progress it posted and VmHWM. Without a request it dumps (and hashes) the CachedDemo and the
//                check ends there.
//   2. fallback: AsyncParser.ts's bounds rule (resolveFallbackBounds) applied to the request, then the real
//                ParseWorker.ts with { buffer, fallback }, the browser's fresh worker. Its CachedDemo is dumped.
//   3. parser2:  the committed parser2 binary directly, with ParseWorker.ts's map-boundary shift: the timeline the
//                viewer showed before B2.
//   4. fork:     the fork's original cache export (src/libs/hlextras parse_demo_cache: the fallback's builder with
//                parser2's start rule), shifted the same way. It separates the two causes of a difference: fork vs
//                fallback differ only by the start, parser2 vs fork only by the builder.
// (3 and 4 run only after a delayed start; the no-timeline route of B1 has no parser2 timeline to compare.)
//   5. extras:   the extras parse with the fallback's timeline and player entity ids (what loadExtras.ts passes), the
//                section 3.6 alignment rule against the fallback, and the exact distances of the extras samples (entity
//                origins at full float precision, independent of both cache builders) to both caches.
// The parent compares parser2 -> fallback, fork -> fallback and parser2 -> fork over the ticks both sides cover.
// Server tick = cache tick + startTick in every cache, so the other side's cache tick u = t + (startTick difference).
// Players are matched by entity id, the key the cache builders use. Per pair it reports:
//   - positions: the per-axis mode of the difference (a constant offset between the caches), then every sample
//     after removing it against the quanta (parser2 1/1024, fork and fallback 1/32, both rounded to nearest:
//     1/64 + 1/2048), per entity, and samples with a position on one side only. On 1428628 parser2 and the fork carry
//     a constant +1/32 in x: they take their position offset from m_WorldMins at their start (a plhud.nut counter,
//     -1/32 at demo tick 3772) but report the end-of-demo bounds, which ParseWorker.ts shifts by; the extras confirm
//     that the fallback is the exact one;
//   - view angles and duck (exact per tick);
//   - the sparse caches health, meta (class, team), connected, uber and heal target (buckets of 4, 64, 16, 16 and 16
//     ticks that hold the last value written in them). At the same start every bucket must match. A start shifted by
//     a tick count that is not a multiple of the bucket size samples a changing value at other ticks, so the check
//     counts matches in a neighbouring bucket and, for health and uber, values inside the other side's range, and
//     its pass rule is the stable-window test: where one cache holds a value in three consecutive buckets, the other
//     cache's bucket in between holds it too, except for flickers (at most 0.1 %, health by at most 1);
//   - deaths, rounds and chat at aligned ticks; projectile positions by entity id, after the same constant offset.
// And for the fallback: coverage against the demo's warmup end and last packet, and memory (VmHWM of each child, the
// cache bytes). Exit code 1 when a check fails.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { importBundled, parseArgs, REPO_ROOT, vmHwmKB } from './lib/bundle.mjs'
import { scanDemoFrames } from './lib/demo-frames.mjs'
import { hashCachedDemo, loadParseWorker } from './lib/parse-worker.mjs'

const { positional, flags } = parseArgs(process.argv.slice(2), ['keep'])
const SCRIPT = fileURLToPath(import.meta.url)
const root = path.resolve(flags.root ?? REPO_ROOT)

// ─── dump files: [u32 header bytes][header JSON][typed arrays, 8-byte aligned] ──────────────────────────

function writeDump(file, meta, arrays) {
  const entries = []
  let offset = 0
  for (const [name, list] of Object.entries(arrays)) {
    list.forEach((a, i) => {
      if (!a) return
      entries.push({ name, i, type: a.constructor.name, offset, length: a.length })
      offset += Math.ceil(a.byteLength / 8) * 8
    })
  }
  const header = Buffer.from(JSON.stringify({ meta, entries }))
  const pad = Math.ceil((4 + header.length) / 8) * 8
  const fd = fs.openSync(file, 'w')
  const lead = Buffer.alloc(pad)
  lead.writeUInt32LE(header.length, 0)
  header.copy(lead, 4)
  fs.writeSync(fd, lead)
  let at = 0
  for (const e of entries) {
    const a = arrays[e.name][e.i]
    if (e.offset > at) fs.writeSync(fd, Buffer.alloc(e.offset - at))
    fs.writeSync(fd, new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
    at = e.offset + a.byteLength
  }
  fs.closeSync(fd)
}

function readDump(file) {
  const buf = fs.readFileSync(file)
  const headerBytes = buf.readUInt32LE(0)
  const { meta, entries } = JSON.parse(buf.toString('utf8', 4, 4 + headerBytes))
  const base = Math.ceil((4 + headerBytes) / 8) * 8
  const arrays = {}
  const types = { Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array, Float64Array }
  for (const e of entries) {
    const T = types[e.type]
    ;(arrays[e.name] ??= [])[e.i] = new T(buf.buffer, buf.byteOffset + base + e.offset, e.length)
  }
  return { meta, arrays }
}

const typedBytes = lists => lists.reduce((n, list) => n + (list ?? []).reduce((m, a) => m + (a?.byteLength ?? 0), 0), 0)

/** Dump of a CachedDemo as ParseWorker.ts posts it (positions already shifted). */
function dumpCachedDemo(file, cd, extra) {
  const pc = cd.playerCache
  const pr = cd.projectileCache
  const players = [...cd.entityPlayerMap].map(([id, ref]) => ({ id, ...ref.user }))
  const arrays = {
    position: pc.positionCache.data,
    viewAngles: pc.viewAnglesCache.data,
    health: pc.healthCache.data,
    meta: pc.metaCache.data,
    connected: pc.connectedCache.data,
    uber: pc.uberCache.data,
    healTarget: pc.healTargetCache.data,
    duck: pc.duckCache.data,
    projectilePosition: pr.positionCache.data,
    projectileType: pr.typeCache.data,
  }
  writeDump(
    file,
    {
      ...extra,
      ticks: cd.ticks,
      startTick: cd.startTick,
      startDemoTick: cd.startDemoTick,
      tickBase: cd.tickBase,
      intervalPerTick: cd.intervalPerTick,
      world: cd.world,
      positionScale: pc.positionCache.scale,
      angleScale: pc.viewAnglesCache.scale,
      projectileScale: pr.positionCache.scale,
      players,
      projectileIds: pr.projectileIds,
      deaths: cd.deaths,
      rounds: cd.rounds,
      chat: cd.chat,
      parserFallback: cd.parserFallback ?? null,
      cacheMB: cd.perf ? +(cd.perf.totalBytes / 1048576).toFixed(1) : null,
    },
    arrays
  )
}

// ─── children ──────────────────────────────────────────────────────────────────────────────────────────────

if (flags.child === 'worker') {
  const { handler, posted } = await loadParseWorker(root, { tmp: flags.tmp })
  const bytes = fs.readFileSync(flags.demo)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const work = flags.work ? JSON.parse(fs.readFileSync(flags.work, 'utf8')) : undefined
  const t0 = performance.now()
  await handler({ data: work ? { buffer, fallback: work } : { buffer } })
  const ms = Math.round(performance.now() - t0)
  const last = posted[posted.length - 1]
  const progress = posted.filter(m => m && typeof m.progress === 'number').map(m => m.progress)
  const extra = {
    ms,
    progress: { calls: progress.length, first: progress[0] ?? null, last: progress.at(-1) ?? null, max: Math.max(0, ...progress) },
  }
  if (last?.error) {
    fs.writeFileSync(flags.dump, JSON.stringify({ ...extra, error: last.error, vmHwmKB: vmHwmKB() }))
  } else if (last?.fallbackRequest) {
    const handedBack = last.fileBuffer?.byteLength === bytes.length
    fs.writeFileSync(flags.dump, JSON.stringify({ ...extra, fallbackRequest: last.fallbackRequest, handedBack, vmHwmKB: vmHwmKB() }))
  } else {
    const fileBufferBack = last?.fileBuffer?.byteLength === bytes.length
    dumpCachedDemo(flags.dump, last, { ...extra, fileBufferBack, sha256: hashCachedDemo(last), vmHwmKB: vmHwmKB() })
  }
  process.exit(0)
}

if (flags.child === 'direct') {
  const [dir, name] = flags.lib === 'fork' ? [path.join(root, 'src/libs/hlextras'), 'hlextras'] : [path.join(root, 'src/libs/parser2'), 'parser2']
  const lib = await import(pathToFileURL(path.join(dir, `${name}.js`)).href)
  lib.initSync({ module: fs.readFileSync(path.join(dir, `${name}_bg.wasm`)) })
  const { getMapBoundaries } = await import(pathToFileURL(flags.bundle).href)
  const t0 = performance.now()
  let r
  {
    const bytes = new Uint8Array(fs.readFileSync(flags.demo))
    r = lib.parse_demo_cache(bytes)
  }
  const parseMs = Math.round(performance.now() - t0)
  if (typeof r === 'string' || !r) {
    console.error(`${flags.lib} parse failed: ${r}`)
    process.exit(1)
  }
  const pc = r.playerCache
  const scale = Number.isFinite(r.positionScale) && r.positionScale > 0 ? r.positionScale : 32
  // The fields ParseWorker.ts counts in perf.totalBytes (parser2's activeWeaponDef is not hydrated)
  const pr = r.projectileCache
  const cacheMB = +(
    typedBytes([pc.position, pc.viewAngles, pc.health, pc.meta, pc.connected, pc.uber, pc.healTarget, pc.duck, pr.position, pr.rotation, pr.team, pr.type]) /
    1048576
  ).toFixed(1)
  // ParseWorker.ts: shift positions from the demo's boundaryMin to the override's, in fixed-point units
  const world = { boundaryMin: { ...r.world.boundaryMin }, boundaryMax: { ...r.world.boundaryMax } }
  const override = getMapBoundaries(r.header.map)
  if (override) {
    const d = ['x', 'y', 'z'].map(a => Math.trunc(Math.trunc(r.world.boundaryMin[a] - override.boundaryMin[a]) * scale))
    for (const list of [pc.position, r.projectileCache.position]) {
      for (const arr of list) {
        for (let i = 0; i < arr.length; i += 3) {
          if ((arr[i] | arr[i + 1] | arr[i + 2]) === 0) continue
          arr[i] += d[0]
          arr[i + 1] += d[1]
          arr[i + 2] += d[2]
        }
      }
    }
    world.boundaryMin = override.boundaryMin
    world.boundaryMax = override.boundaryMax
  }
  const arrays = {
    position: pc.position,
    viewAngles: pc.viewAngles,
    health: pc.health,
    meta: pc.meta,
    connected: pc.connected,
    uber: pc.uber,
    healTarget: pc.healTarget,
    duck: pc.duck ?? [],
    projectilePosition: r.projectileCache.position,
    projectileType: r.projectileCache.type,
  }
  writeDump(
    flags.dump,
    {
      ticks: r.ticks,
      startTick: r.startTick,
      startDemoTick: r.startDemoTick,
      tickBase: r.tickBase,
      intervalPerTick: r.intervalPerTick,
      world,
      positionScale: scale,
      angleScale: Number.isFinite(r.angleScale) ? r.angleScale : 1,
      projectileScale: scale,
      players: r.players,
      projectileIds: r.projectileCache.ids,
      deaths: r.deaths,
      rounds: r.rounds,
      chat: r.chat ?? [],
      parseMs,
      cacheMB,
      vmHwmKB: vmHwmKB(),
    },
    arrays
  )
  process.exit(0)
}

if (flags.child === 'extras') {
  // What loadExtras.ts and ExtrasWorker.ts do with a base parse: parse_demo_extras_input with the base's timeline and
  // player entity ids, then hydrate with the scene origin. Only the alignment samples and the meta are kept.
  const { hydrate, typedArrayBytes } = await importBundled('scripts/hl/lib/hydrate-entry.mjs')
  const dir = path.join(root, 'src/libs/hlextras')
  const lib = await import(pathToFileURL(path.join(dir, 'hlextras.js')).href)
  const wasm = lib.initSync({ module: fs.readFileSync(path.join(dir, 'hlextras_bg.wasm')) })
  const options = JSON.parse(fs.readFileSync(flags.options, 'utf8'))
  const t0 = performance.now()
  let raw
  {
    let bytes = fs.readFileSync(flags.demo)
    const input = new lib.ExtrasInput(bytes.length)
    new Uint8Array(wasm.memory.buffer, input.ptr(), bytes.length).set(bytes)
    bytes = null
    raw = lib.parse_demo_extras_input(input, options.options, () => {})
  }
  const parseMs = Math.round(performance.now() - t0)
  if (typeof raw === 'string' || !raw) {
    console.error(`extras parse failed: ${raw}`)
    process.exit(1)
  }
  const x = hydrate(raw, options.sceneOrigin)
  const m = x.meta
  writeDump(
    flags.dump,
    {
      startTick: m.startTick,
      tickBase: m.tickBase,
      ticks: m.ticks,
      playerCount: m.playerCount,
      warnings: m.warnings,
      excluded: m.excluded,
      available: m.available,
      sampleTicks: Array.from(x.alignment.ticks),
      parseMs,
      typedMB: +(typedArrayBytes(x) / 1048576).toFixed(1),
      wasmMB: Math.round(wasm.memory.buffer.byteLength / 1048576),
      vmHwmKB: vmHwmKB(),
    },
    { pos: [x.alignment.pos] }
  )
  process.exit(0)
}

// ─── comparison of two dumps ───────────────────────────────────────────────────────────────────────────────

/**
 * Compares cache A with cache B, B's cache tick = A's + (A.startTick - B.startTick). `tol` is the position tolerance
 * in scene units: 1/64 + 1/2048 when both round the same values (1/32 and 1/1024 grids), 0 for the same grid.
 */
function compare(A, B, { tol, examples }) {
  const a = A.meta
  const b = B.meta
  const shift = a.startTick - b.startTick
  const fails = []
  const out = { shiftTicks: shift, sameTickBase: a.tickBase === b.tickBase }
  if (a.tickBase !== b.tickBase) fails.push(`tickBase differs: ${a.tickBase} vs ${b.tickBase}`)

  const bByEntity = new Map(b.players.map(pl => [pl.entityId, pl]))
  const pairs = []
  const unmatched = []
  for (const pl of a.players) {
    const q = bByEntity.get(pl.entityId)
    if (!q) unmatched.push(pl.entityId)
    else pairs.push({ p: pl.id, q: q.id, entityId: pl.entityId, name: pl.name, sameUser: q.userId === pl.userId && q.steamId === pl.steamId && q.name === pl.name })
  }
  out.players = { a: a.players.length, b: b.players.length, matched: pairs.length, unmatched, sameUser: pairs.filter(x => x.sameUser).length, bOnly: b.players.filter(pl => !a.players.some(x => x.entityId === pl.entityId)).map(pl => pl.entityId) }
  if (unmatched.length) fails.push(`players without a match: ${unmatched.join(', ')}`)
  if (pairs.some(x => !x.sameUser)) fails.push('a matched player has a different user')

  const lo = Math.max(0, -shift)
  const hi = Math.min(a.ticks, b.ticks - shift)
  out.overlap = { fromTick: lo, toTick: hi, ticks: Math.max(0, hi - lo) }

  // positions, in two passes: the per-axis mode of A - B (a constant offset between the two caches, such as a
  // map-boundary shift that misses a fraction of a unit), then every sample against the tolerance after removing it
  {
    const sa = a.positionScale
    const sb = b.positionScale
    const GRID = 2048 // differences are multiples of 1/2048 at most (1/1024 and 1/32 grids)
    const forEachSample = fn => {
      for (const pair of pairs) {
        const x = A.arrays.position[pair.p]
        const y = B.arrays.position[pair.q]
        if (!x || !y) continue
        for (let t = lo; t < hi; t++) {
          const ia = t * 3
          const ib = (t + shift) * 3
          const za = (x[ia] | x[ia + 1] | x[ia + 2]) === 0
          const zb = (y[ib] | y[ib + 1] | y[ib + 2]) === 0
          if (za && zb) continue
          fn(pair, t, za !== zb ? null : [0, 1, 2].map(c => (x[ia + c] | 0) / sa - (y[ib + c] | 0) / sb), za, zb, x, y, ia, ib)
        }
      }
    }
    const hist = [new Map(), new Map(), new Map()]
    let n = 0
    forEachSample((_pair, _t, d) => {
      if (!d) return
      n++
      d.forEach((v, c) => {
        const k = Math.round(v * GRID)
        hist[c].set(k, (hist[c].get(k) ?? 0) + 1)
      })
    })
    const offset = hist.map(h => {
      const [k, count] = [...h].sort((u, v) => v[1] - u[1])[0] ?? [0, 0]
      return count > n / 2 ? k / GRID : 0 // a constant offset only when most samples share it
    })
    const bins = { exact: 0, le64th: 0, le32nd: 0, le16th: 0, gt16th: 0 }
    let max = 0
    let maxAt = null
    let rawMax = 0
    let presence = 0
    const presenceAt = []
    const perEntity = new Map()
    forEachSample((pair, t, d, za, zb, x, y, ia, ib) => {
      if (!d) {
        presence++
        if (presenceAt.length < examples) presenceAt.push({ entityId: pair.entityId, tick: t, a: !za, b: !zb })
        return
      }
      const e = perEntity.get(pair.entityId) ?? { entityId: pair.entityId, name: pair.name, samples: 0, max: 0, overTolerance: 0 }
      perEntity.set(pair.entityId, e)
      const r = Math.max(...d.map(Math.abs))
      const v = Math.max(...d.map((dv, c) => Math.abs(dv - offset[c])))
      e.samples++
      if (v === 0) bins.exact++
      else if (v <= 1 / 64 + 1 / GRID) bins.le64th++
      else if (v <= 1 / 32 + 1 / GRID) bins.le32nd++
      else if (v <= 1 / 16) bins.le16th++
      else bins.gt16th++
      if (v > tol + 1e-9) e.overTolerance++
      e.max = Math.max(e.max, v)
      rawMax = Math.max(rawMax, r)
      if (v > max) {
        max = v
        maxAt = { entityId: pair.entityId, tick: t, a: [0, 1, 2].map(c => (x[ia + c] | 0) / sa), b: [0, 1, 2].map(c => (y[ib + c] | 0) / sb) }
      }
    })
    const entities = [...perEntity.values()]
    const over = entities.reduce((s, e) => s + e.overTolerance, 0)
    const offsetHistogram = hist.map(h => [...h].sort((u, v) => v[1] - u[1]).slice(0, 4).map(([k, c]) => [k / GRID, c]))
    out.positions = {
      samples: n,
      rawMax: +rawMax.toFixed(6),
      constantOffset: { x: offset[0], y: offset[1], z: offset[2] },
      offsetHistogram: { x: offsetHistogram[0], y: offsetHistogram[1], z: offsetHistogram[2] },
      maxAfterOffset: +max.toFixed(6),
      maxAt,
      tolerance: +tol.toFixed(6),
      overTolerance: over,
      binsAfterOffset: bins,
      presenceMismatch: presence,
      presenceAt,
      perEntity: entities.filter(e => e.overTolerance > 0).map(e => ({ ...e, max: +e.max.toFixed(6) })),
    }
    if (over > 0) fails.push(`${over} position samples differ by more than ${tol} after the constant offset`)
    if (offset.some(o => Math.abs(o) > 1 / 32 + 1e-9)) fails.push(`constant position offset ${offset.join(', ')} is larger than one 1/32 quantum`)
    if (presence > 0) fails.push(`${presence} samples have a position on one side only`)
  }

  // view angles and duck: exact per tick
  {
    let n = 0
    let max = 0
    let duckN = 0
    let duckDiff = 0
    for (const { p, q } of pairs) {
      const x = A.arrays.viewAngles[p]
      const y = B.arrays.viewAngles[q]
      const xa = A.arrays.position[p]
      for (let t = lo; x && y && t < hi; t++) {
        const ia = t * 3
        if ((xa[ia] | xa[ia + 1] | xa[ia + 2]) === 0) continue
        const ib = (t + shift) * 3
        for (let c = 0; c < 2; c++) {
          let d = Math.abs((x[ia + c] | 0) / a.angleScale - (y[ib + c] | 0) / b.angleScale)
          d = Math.min(d, Math.abs(360 - d))
          max = Math.max(max, d)
          n++
        }
      }
      const da = A.arrays.duck?.[p]
      const db = B.arrays.duck?.[q]
      for (let t = lo; da && db && t < hi; t++) {
        duckN++
        if (da[t] !== db[t + shift]) duckDiff++
      }
    }
    out.viewAngles = { samples: n, maxDegrees: +max.toFixed(6) }
    out.duck = { samples: duckN, differing: duckDiff }
    if (max > 1e-6) fails.push(`view angles differ by up to ${max} degrees`)
    if (duckDiff > 0) fails.push(`${duckDiff} duck samples differ`)
  }

  // sparse caches: the bucket holding A's tick t against B's bucket holding t + shift
  out.sparse = {}
  for (const [name, bits, numeric] of [['health', 2, true], ['meta', 6, false], ['connected', 4, false], ['uber', 4, true], ['healTarget', 4, false]]) {
    const span = 1 << bits
    const phase = ((shift % span) + span) % span
    let n = 0
    let exact = 0
    let neighbour = 0
    let inRange = 0
    let stable = 0
    let stableMismatch = 0
    let stableMaxDelta = 0
    const misses = []
    const stableMisses = []
    for (const { p, q, entityId } of pairs) {
      const x = A.arrays[name][p]
      const y = B.arrays[name][q]
      if (!x || !y) continue
      for (let t = lo - (lo % span); t < hi; t += span) {
        if (t < lo) continue
        const k = (t + shift) >> bits
        const va = x[t >> bits]
        n++
        // Strict test: where B holds one value in three consecutive buckets, A's bucket in between holds it too,
        // unless the value flickers (changes and changes back) inside one bucket span
        if (k > 0 && y[k - 1] === y[k] && y[k] === y[k + 1]) {
          stable++
          if (va !== y[k]) {
            stableMismatch++
            if (numeric) stableMaxDelta = Math.max(stableMaxDelta, Math.abs(va - y[k]))
            const ib = t >> bits
            if (stableMisses.length < examples) stableMisses.push({ entityId, tick: t, a: [x[ib - 1], va, x[ib + 1]], b: y[k] })
          }
        }
        if (va === y[k]) {
          exact++
          continue
        }
        if (y[k - 1] === va || y[k + 1] === va) {
          neighbour++
          continue
        }
        if (numeric) {
          const around = [y[k - 1], y[k], y[k + 1]].filter(v => v !== undefined)
          if (va >= Math.min(...around) && va <= Math.max(...around)) {
            inRange++
            continue
          }
        }
        if (misses.length < examples) misses.push({ entityId, tick: t, a: va, b: [y[k - 1], y[k], y[k + 1]] })
      }
    }
    // `other`: the value changed twice inside the window (damage then regeneration, a heal target switching back),
    // which a sampling phase between the two caches' buckets explains. Pass rule: at the same phase every bucket
    // matches; at another phase at most 0.1 % of the stable windows differ (flickers), health by at most 1.
    const other = n - exact - neighbour - inRange
    out.sparse[name] = {
      bucketTicks: span,
      phaseTicks: phase,
      samples: n,
      exact,
      neighbourBucket: neighbour,
      inNeighbourRange: inRange,
      other,
      misses,
      stableWindows: stable,
      stableMismatch,
      stableMismatchShare: stable ? +(stableMismatch / stable).toFixed(6) : 0,
      ...(numeric ? { stableMaxDelta } : {}),
      stableMisses,
    }
    if (phase === 0 && exact !== n) fails.push(`${name}: ${n - exact} of ${n} buckets differ at the same phase`)
    if (phase !== 0 && stableMismatch > stable * 0.001) fails.push(`${name}: ${stableMismatch} of ${stable} buckets differ where the other cache is constant`)
    if (name === 'health' && stableMaxDelta > 1) fails.push(`health differs by ${stableMaxDelta} where the other cache is constant`)
  }

  // deaths, rounds, chat at aligned ticks
  {
    const deathKey = (tick, e) => `${tick}|${e.victim.user.userId}|${e.killer?.user.userId ?? ''}|${e.assister?.user.userId ?? ''}|${e.weapon}`
    const inA = t => t >= lo && t < hi
    const count = new Map()
    let bOutside = 0
    for (const [tick, list] of Object.entries(b.deaths)) {
      for (const e of list) {
        const t = Number(tick) - shift
        if (!inA(t)) {
          bOutside++
          continue
        }
        const k = deathKey(t, e)
        count.set(k, (count.get(k) ?? 0) + 1)
      }
    }
    let matched = 0
    let aOutside = 0
    const onlyA = []
    for (const [tick, list] of Object.entries(a.deaths)) {
      for (const e of list) {
        if (!inA(Number(tick))) {
          aOutside++
          continue
        }
        const k = deathKey(Number(tick), e)
        if (count.get(k)) {
          count.set(k, count.get(k) - 1)
          matched++
        } else onlyA.push(k)
      }
    }
    const onlyB = [...count].filter(([, c]) => c > 0).map(([k]) => k)
    out.deaths = { matched, onlyA: onlyA.length, onlyAAt: onlyA.slice(0, examples), onlyB: onlyB.length, onlyBAt: onlyB.slice(0, examples), aOutsideOverlap: aOutside, bOutsideOverlap: bOutside }
    if (onlyA.length || onlyB.length) fails.push(`deaths differ at aligned ticks (${onlyA.length} only in A, ${onlyB.length} only in B)`)

    const rounds = (list, s) => list.filter(r => inA(r.endTick - s)).map(r => `${r.endTick - s}|${r.winner}|${r.length}`)
    const ra = rounds(a.rounds, 0)
    const rb = rounds(b.rounds, shift)
    out.rounds = { a: a.rounds.length, b: b.rounds.length, inOverlap: [ra.length, rb.length], same: JSON.stringify(ra) === JSON.stringify(rb) }
    if (!out.rounds.same) fails.push('rounds differ at aligned ticks')

    const chats = (list, s) => list.filter(c => inA(c.tick - s)).map(c => `${c.tick - s}|${c.kind}|${c.clientEntityId ?? ''}|${c.rawText}`)
    const ca = chats(a.chat, 0)
    const cb = chats(b.chat, shift)
    out.chat = { a: a.chat.length, b: b.chat.length, inOverlap: [ca.length, cb.length], same: JSON.stringify(ca) === JSON.stringify(cb) }
    if (!out.chat.same) fails.push('chat differs at aligned ticks')
  }

  // projectiles by entity id, after the same constant offset as the player positions (the same shift moved both)
  {
    const off = out.positions.constantOffset
    const offset = [off.x, off.y, off.z]
    const bSlot = new Map(b.projectileIds.map((id, j) => [id, j]))
    let n = 0
    let max = 0
    let rawMax = 0
    let presence = 0
    let typeDiff = 0
    let common = 0
    a.projectileIds.forEach((id, i) => {
      const j = bSlot.get(id)
      if (j === undefined) return
      common++
      const x = A.arrays.projectilePosition[i]
      const y = B.arrays.projectilePosition[j]
      for (let t = lo; t < hi; t++) {
        const ia = t * 3
        const ib = (t + shift) * 3
        const za = (x[ia] | x[ia + 1] | x[ia + 2]) === 0
        const zb = (y[ib] | y[ib + 1] | y[ib + 2]) === 0
        if (za && zb) continue
        if (za !== zb) {
          presence++
          continue
        }
        for (let c = 0; c < 3; c++) {
          const d = (x[ia + c] | 0) / a.projectileScale - (y[ib + c] | 0) / b.projectileScale
          rawMax = Math.max(rawMax, Math.abs(d))
          max = Math.max(max, Math.abs(d - offset[c]))
        }
        n++
        if (A.arrays.projectileType[i][t >> 6] !== B.arrays.projectileType[j][(t + shift) >> 6]) typeDiff++
      }
    })
    out.projectiles = { aIds: a.projectileIds.length, bIds: b.projectileIds.length, commonIds: common, samples: n, rawMax: +rawMax.toFixed(6), maxAfterOffset: +max.toFixed(6), presenceMismatch: presence, typeBucketDiffs: typeDiff }
    if (max > tol + 1e-9) fails.push(`projectile positions differ by up to ${max} after the constant offset`)
    if (presence > 0) fails.push(`${presence} projectile samples have a position on one side only`)
  }
  out.ok = fails.length === 0
  out.failures = fails
  return out
}

/** First and last cache tick with any player position, also in demo ticks. */
function coverage(D, frames) {
  const m = D.meta
  let firstT = null
  let lastT = null
  for (const arr of D.arrays.position) {
    if (!arr) continue
    const n = Math.min(m.ticks, Math.floor(arr.length / 3))
    for (let t = 0; t < n; t++) {
      if (arr[t * 3] | arr[t * 3 + 1] | arr[t * 3 + 2]) {
        if (firstT === null || t < firstT) firstT = t
        break
      }
    }
    for (let t = n - 1; t >= 0; t--) {
      if (arr[t * 3] | arr[t * 3 + 1] | arr[t * 3 + 2]) {
        if (lastT === null || t > lastT) lastT = t
        break
      }
    }
  }
  const ipt = m.intervalPerTick
  const demoTick = t => (t === null ? null : t + m.startTick - m.tickBase)
  return {
    ticks: m.ticks,
    startDemoTick: m.startDemoTick,
    firstTickWithPositions: firstT,
    lastTickWithPositions: lastT,
    firstDemoTick: demoTick(firstT),
    lastDemoTick: demoTick(lastT),
    secondsBeforeFirstPosition: frames.firstPacketTick === null || firstT === null ? null : +((demoTick(firstT) - frames.firstPacketTick) * ipt).toFixed(2),
    emptyTailTicks: lastT === null ? null : m.ticks - 1 - lastT,
    emptyTailSeconds: lastT === null ? null : +((m.ticks - 1 - lastT) * ipt).toFixed(2),
    secondsAfterLastPosition: lastT === null || frames.lastPacketTick === null ? null : +((frames.lastPacketTick - demoTick(lastT)) * ipt).toFixed(2),
  }
}

// ─── parent ────────────────────────────────────────────────────────────────────────────────────────────────

const demoPath = positional[0]
if (!demoPath) {
  console.error('usage: node scripts/hl/check-delayed-start.mjs <demo.dem> --tmp <dir on a disk> [--out summary.json] [--root checkout] [--examples n] [--keep]')
  process.exit(2)
}
const EXAMPLES = Number(flags.examples ?? 5)
{
  const TMPFS_MAGIC = 0x01021994
  const dir = os.tmpdir()
  const demoMB = fs.statSync(demoPath).size / 1048576
  let tmpfs = false
  try {
    tmpfs = fs.statfsSync(dir).type === TMPFS_MAGIC
  } catch {}
  if (!flags.tmp && tmpfs && demoMB > 20) {
    console.error(
      `check-delayed-start: the cache dumps of this ${Math.round(demoMB)} MB demo take up to ${Math.ceil(3 * 5.6 * demoMB)} MB, ` +
        `and the default temp dir ${dir} is a tmpfs. Pass --tmp <dir on a disk>.`
    )
    process.exit(2)
  }
}
const tmp = fs.mkdtempSync(path.join(flags.tmp ?? os.tmpdir(), 'b2-delayed-'))
// Remove the dumps however the check ends: a failed child throws out of child(), and Ctrl-C or a kill ends the process
const removeDumps = () => {
  if (!flags.keep) fs.rmSync(tmp, { recursive: true, force: true })
}
process.on('exit', removeDumps)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    removeDumps()
    process.exit(130)
  })
}
const failures = []
const child = (args, label) => {
  const t0 = performance.now()
  const run = spawnSync(process.execPath, [SCRIPT, ...args, ...(flags.tmp ? ['--tmp', flags.tmp] : []), '--root', root], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const wallMs = Math.round(performance.now() - t0)
  if (run.status !== 0) {
    console.error(run.stderr)
    throw new Error(`${label} child failed with status ${run.status}`)
  }
  return wallMs
}

// ParseWorker's getMapBoundaries and mapAssets' getMapFolder, bundled once for every process
const require = createRequire(path.join(root, 'package.json'))
const esbuild = require('esbuild')
const entry = path.join(tmp, 'entry.ts')
fs.writeFileSync(
  entry,
  [
    `export { getMapBoundaries } from ${JSON.stringify(path.join(root, 'src/components/Analyse/MapBoundaries.ts'))}`,
    `export { getMapFolder } from ${JSON.stringify(path.join(root, 'src/utils/mapAssets.ts'))}`,
  ].join('\n')
)
const bundled = await esbuild.build({
  entryPoints: [entry],
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
  define: { 'import.meta.env.DEV': 'false' },
  alias: { three: path.join(root, 'scripts/hl/lib/three-shim.mjs') },
})
await esbuild.stop()
const bundleFile = path.join(tmp, 'lookups.mjs')
fs.writeFileSync(bundleFile, bundled.outputFiles[0].text)
const { getMapBoundaries, getMapFolder } = await import(pathToFileURL(bundleFile).href)

const frames = scanDemoFrames(demoPath, { full: true })
const summary = {
  demo: path.basename(demoPath),
  map: frames.header.map,
  root,
  frames: {
    firstPacketTick: frames.firstPacketTick,
    warmupEndTick: frames.warmupEndTick,
    lastPacketTick: frames.lastPacketTick,
    headerTicks: frames.header.ticks,
    truncated: frames.truncated,
  },
}

// 1. the browser's first message
const first = path.join(tmp, 'worker.json')
const workerWallMs = child(['--child', 'worker', '--demo', demoPath, '--dump', first], 'worker')
let firstResult
try {
  firstResult = JSON.parse(fs.readFileSync(first, 'utf8'))
} catch {
  firstResult = { cachedDemo: readDump(first).meta } // no request: the worker posted its CachedDemo
}
const firstMeta = firstResult.cachedDemo ?? firstResult
summary.worker = {
  asked: !!firstResult.fallbackRequest,
  request: firstResult.fallbackRequest ?? null,
  handedBack: firstResult.handedBack ?? null,
  error: firstResult.error ?? null,
  progress: firstMeta.progress,
  ms: firstMeta.ms,
  wallMs: workerWallMs,
  vmHwmMB: Math.round(firstMeta.vmHwmKB / 1024),
}
if (firstResult.error) failures.push(`worker error: ${firstResult.error}`)

if (!firstResult.fallbackRequest) {
  const m = firstResult.cachedDemo
  if (m) {
    summary.cachedDemo = { ticks: m.ticks, startTick: m.startTick, startDemoTick: m.startDemoTick, tickBase: m.tickBase, players: m.players.length, positionScale: m.positionScale, parserFallback: m.parserFallback, cacheMB: m.cacheMB, fileBufferBack: m.fileBufferBack, sha256: m.sha256 }
  }
} else {
  // 2. the fresh worker, with AsyncParser.ts's bounds
  const request = firstResult.fallbackRequest
  if (request.trigger === 'delayed-start' && !firstResult.handedBack) failures.push('the worker did not hand the file back')
  let where = { boundsSource: 'none' }
  const override = getMapBoundaries(request.map)
  const zero = w => [w.boundaryMin, w.boundaryMax].every(v => v.x === 0 && v.y === 0 && v.z === 0)
  // AsyncParser.ts resolveFallbackBounds: the override, else conversion.json worldBounds, else parser2's world bounds
  const folder = getMapFolder(request.map)
  const conv = folder && path.join(root, 'public/models/maps', folder, 'conversion.json')
  const wb = conv && fs.existsSync(conv) ? JSON.parse(fs.readFileSync(conv, 'utf8')).worldBounds : undefined
  if (override) {
    where = { bounds: { boundaryMin: { ...override.boundaryMin }, boundaryMax: { ...override.boundaryMax } }, boundsSource: 'override' }
  } else if (wb?.boundaryMin && wb?.boundaryMax) {
    where = { bounds: wb, boundsSource: 'conversion' }
  } else if (request.parser2.world && !zero(request.parser2.world)) {
    where = { bounds: request.parser2.world, boundsSource: 'parser2' }
  }
  summary.bounds = where
  const workFile = path.join(tmp, 'work.json')
  fs.writeFileSync(workFile, JSON.stringify({ ...request, ...where }))
  const fbFile = path.join(tmp, 'fallback.bin')
  const fallbackWallMs = child(['--child', 'worker', '--demo', demoPath, '--work', workFile, '--dump', fbFile], 'fallback')
  const FB = readDump(fbFile)
  const brief = (m, wallMs) => ({
    ticks: m.ticks, startTick: m.startTick, startDemoTick: m.startDemoTick, tickBase: m.tickBase, players: m.players.length,
    positionScale: m.positionScale, world: m.world, cacheMB: m.cacheMB, parseMs: m.parseMs ?? m.ms, wallMs, vmHwmMB: Math.round(m.vmHwmKB / 1024),
  })
  summary.fallback = {
    ...brief(FB.meta, fallbackWallMs),
    parserFallback: FB.meta.parserFallback,
    fileBufferBack: FB.meta.fileBufferBack,
    progress: FB.meta.progress,
    sha256: FB.meta.sha256,
  }
  if (!FB.meta.parserFallback) failures.push('the fallback CachedDemo has no parserFallback info')
  else if (FB.meta.parserFallback.reason !== request.reason) failures.push('parserFallback.reason is not the request reason')
  if (!FB.meta.fileBufferBack) failures.push('the fallback worker did not hand the file back')
  summary.coverage = { fallback: coverage(FB, frames) }

  // 3. parser2 alone, 4. the fork's original export: only a delayed start has a parser2 timeline to compare with
  let P2 = null
  if (request.trigger === 'delayed-start') {
    const p2File = path.join(tmp, 'parser2.bin')
    const parser2WallMs = child(['--child', 'direct', '--lib', 'parser2', '--demo', demoPath, '--bundle', bundleFile, '--dump', p2File], 'parser2')
    const forkFile = path.join(tmp, 'fork.bin')
    const forkWallMs = child(['--child', 'direct', '--lib', 'fork', '--demo', demoPath, '--bundle', bundleFile, '--dump', forkFile], 'fork')
    P2 = readDump(p2File)
    const FK = readDump(forkFile)
    summary.parser2 = brief(P2.meta, parser2WallMs)
    summary.fork = brief(FK.meta, forkWallMs)

    // A 1/32 grid against a 1/1024 grid, both rounded to nearest: 1/64 + 1/2048. The same 1/32 grid with different
    // offsets: values exactly half-way round away from zero, so a sign change between the two offsets moves them by
    // one quantum.
    const quantumTol = 1 / 64 + 1 / 2048
    summary.compare = {
      parser2ToFallback: compare(P2, FB, { tol: quantumTol, examples: EXAMPLES }),
      forkToFallback: compare(FK, FB, { tol: 1 / 32, examples: EXAMPLES }),
      parser2ToFork: compare(P2, FK, { tol: quantumTol, examples: EXAMPLES }),
    }
    for (const [k, v] of Object.entries(summary.compare)) for (const f of v.failures) failures.push(`${k}: ${f}`)
    // parser2 and the fork bucket every sparse cache identically (parser2ToFork is exact), so against the fallback
    // they must show the same counts: what remains is the fallback's bucket phase, not its data
    const counts = c => Object.fromEntries(Object.entries(c.sparse).map(([k, v]) => [k, [v.exact, v.neighbourBucket, v.inNeighbourRange, v.other]]))
    summary.sparsePhaseOnly = JSON.stringify(counts(summary.compare.parser2ToFallback)) === JSON.stringify(counts(summary.compare.forkToFallback))
    if (!summary.sparsePhaseOnly) failures.push('parser2 and the fork differ from the fallback in different sparse buckets')

    summary.coverage.parser2 = coverage(P2, frames)
  }
  const fc = summary.coverage.fallback
  if (FB.meta.startDemoTick !== frames.warmupEndTick) failures.push(`the fallback starts at demo tick ${FB.meta.startDemoTick}, not at the warmup end ${frames.warmupEndTick}`)
  if (fc.firstTickWithPositions !== 0) failures.push(`the fallback's first tick with positions is ${fc.firstTickWithPositions}`)
  if (!(fc.emptyTailTicks <= 1)) failures.push(`the fallback timeline ends with ${fc.emptyTailTicks} ticks without positions`)
  if (!(fc.secondsAfterLastPosition <= 0.1)) failures.push(`the fallback's positions end ${fc.secondsAfterLastPosition} s before the last packet`)

  // 5. the extras on the fallback timeline (loadExtras.ts options), the section 3.6 rule against the fallback base,
  // and the exact distances of the extras samples (origins at full float precision) to both base caches
  {
    const m = FB.meta
    const nextMappedPlayer = m.players.reduce((n, pl) => Math.max(n, pl.id + 1), 0)
    const playerEntityIds = Array.from({ length: nextMappedPlayer }, (_, p) => m.players.find(pl => pl.id === p)?.entityId ?? 0)
    const items = JSON.parse(fs.readFileSync(path.join(root, 'src/constants/items.json'), 'utf8'))
    const wearableDefs = Object.keys(items).filter(k => items[k].c.startsWith('tf_wearable')).map(Number).sort((x, y) => x - y)
    const optionsFile = path.join(tmp, 'extras-options.json')
    fs.writeFileSync(
      optionsFile,
      JSON.stringify({
        options: { startTick: m.startTick, tickBase: m.tickBase, ticks: m.ticks, intervalPerTick: m.intervalPerTick, playerEntityIds, wearableDefs },
        sceneOrigin: m.world.boundaryMin,
      })
    )
    const exFile = path.join(tmp, 'extras.bin')
    const extrasWallMs = child(['--child', 'extras', '--demo', demoPath, '--options', optionsFile, '--dump', exFile], 'extras')
    const EX = readDump(exFile)
    const pos = EX.arrays.pos[0]
    const SAMPLES = EX.meta.sampleTicks.length
    const at = (D, p, t) => {
      const arr = D.arrays.position[p]
      if (!arr || t < 0 || t >= D.meta.ticks) return null
      const o = t * 3
      if ((arr[o] | arr[o + 1] | arr[o + 2]) === 0) return null
      const s = D.meta.positionScale
      return { x: (arr[o] | 0) / s, y: (arr[o + 1] | 0) / s, z: (arr[o + 2] | 0) / s, health: D.arrays.health[p]?.[t >> 2] ?? 0 }
    }
    const { checkAlignmentWith } = await importBundled('scripts/hl/lib/extras-entry.mjs')
    const extrasLike = { meta: EX.meta, alignment: { ticks: Int32Array.from(EX.meta.sampleTicks), pos } }
    const alignment = checkAlignmentWith(extrasLike, {
      startTick: m.startTick,
      tickBase: m.tickBase,
      ticks: m.ticks,
      nextMappedPlayer,
      sample: (p, t) => at(FB, p, t) ?? { x: 0, y: 0, z: 0, health: 0 },
    })
    // exact distances: fallback at the sample tick; parser2 at the same server tick (players matched by entity id)
    const p2ByEntity = new Map((P2?.meta.players ?? []).map(pl => [pl.entityId, pl.id]))
    const shift = P2 ? P2.meta.startTick - FB.meta.startTick : 0
    const dist = []
    const distP2 = []
    const axisP2 = [[], [], []]
    let recovered = 0
    for (let k = 0; k < SAMPLES; k++) {
      const t = EX.meta.sampleTicks[k]
      if (t < shift) recovered++
      for (let p = 0; p < nextMappedPlayer; p++) {
        const o = (p * SAMPLES + k) * 3
        if (Number.isNaN(pos[o])) continue
        const b = at(FB, p, t)
        if (b && b.health > 0) dist.push(Math.hypot(pos[o] - b.x, pos[o + 1] - b.y, pos[o + 2] - b.z))
        const q = p2ByEntity.get(playerEntityIds[p])
        const c = q === undefined ? null : at(P2, q, t - shift)
        if (c && c.health > 0) {
          distP2.push(Math.hypot(pos[o] - c.x, pos[o + 1] - c.y, pos[o + 2] - c.z))
          ;['x', 'y', 'z'].forEach((axis, i) => axisP2[i].push(c[axis] - pos[o + i]))
        }
      }
    }
    const stats = v => {
      const s = [...v].sort((x, y) => x - y)
      return s.length ? { n: s.length, median: +s[s.length >> 1].toFixed(5), p99: +s[Math.floor(s.length * 0.99)].toFixed(5), max: +s[s.length - 1].toFixed(5) } : null
    }
    const mean = v => (v.length ? +(v.reduce((x, y) => x + y, 0) / v.length).toFixed(5) : null)
    summary.extras = {
      meta: { startTick: EX.meta.startTick, tickBase: EX.meta.tickBase, ticks: EX.meta.ticks, playerCount: EX.meta.playerCount, warnings: EX.meta.warnings, excluded: EX.meta.excluded },
      available: EX.meta.available,
      sampleTicks: EX.meta.sampleTicks,
      samplesBeforeParser2Start: P2 ? recovered : null,
      alignment,
      distanceToFallback: stats(dist),
      distanceToParser2: stats(distP2),
      parser2MinusExtrasMean: { x: mean(axisP2[0]), y: mean(axisP2[1]), z: mean(axisP2[2]) },
      parseMs: EX.meta.parseMs,
      typedMB: EX.meta.typedMB,
      wasmMB: EX.meta.wasmMB,
      wallMs: extrasWallMs,
      vmHwmMB: Math.round(EX.meta.vmHwmKB / 1024),
    }
    if (!alignment.ok) failures.push(`extras alignment on the fallback timeline: ${alignment.reason}`)
    if (!(summary.extras.distanceToFallback?.max <= 0.05)) failures.push(`extras samples are up to ${summary.extras.distanceToFallback?.max} units from the fallback positions`)
  }

  // Memory: before B2 the browser ran the parser2 worker only; now that worker runs, ends, and the fallback worker
  // follows, so the peak grows only by the part of the fallback worker's peak above the parser2 worker's (both
  // children carry the same harness overhead: two copies of the file and the bundled worker).
  summary.memory = {
    parser2AloneVmHwmMB: summary.parser2?.vmHwmMB ?? null,
    workerParser2PassVmHwmMB: summary.worker.vmHwmMB,
    fallbackWorkerVmHwmMB: summary.fallback.vmHwmMB,
    peakGrowthMB: Math.max(0, summary.fallback.vmHwmMB - summary.worker.vmHwmMB),
    cacheMB: P2
      ? { parser2: P2.meta.cacheMB, fallback: FB.meta.cacheMB, growth: +(FB.meta.cacheMB - P2.meta.cacheMB).toFixed(1) }
      : { fallback: FB.meta.cacheMB },
  }
  if (P2 && summary.memory.peakGrowthMB > 300) failures.push(`the fallback worker peaks ${summary.memory.peakGrowthMB} MB above the parser2 worker`)
  if (P2 && summary.memory.cacheMB.growth > 300) failures.push(`the fallback caches are ${summary.memory.cacheMB.growth} MB larger`)
}

if (flags.keep) summary.dumps = tmp
else removeDumps()
summary.ok = failures.length === 0
summary.failures = failures
summary.vmHwmMB = Math.round(vmHwmKB() / 1024)
const json = JSON.stringify(summary, null, 1)
if (flags.out) fs.writeFileSync(flags.out, json)
console.log(json)
process.exitCode = failures.length ? 1 : 0
