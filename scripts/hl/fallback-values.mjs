#!/usr/bin/env node
// Base values through the viewer's base-parse rule (tasks B1 and B2).
//
//   node scripts/hl/fallback-values.mjs <demo.dem> [--out <file.json>] [--force-fallback] [--tmp <dir>]
//
// Like the browser (ParseWorker.ts and AsyncParser.ts): parser2 first, in a child process (scripts/hl/base-values.mjs,
// so its wasm heap never shares this process, as the browser ends its worker). Then both fallback triggers of
// ParseWorker.ts:
//   - 'no-timeline' (B1): parser2's result has ticks <= 1 or no players;
//   - 'delayed-start' (B2): parser2 starts DELAYED_START_FALLBACK_SECONDS or more after the demo's warmup end, by
//     ParseWorker.ts's own exported delayedStartOf (bundled with esbuild through scripts/hl/lib/parse-worker.mjs, as
//     scripts/hl/check-delayed-trigger.mjs runs it).
// On either, this process runs the fork's fallback cache builder (src/libs/hlextras parse_demo_cache_fallback) with
// AsyncParser.ts resolveFallbackBounds' bounds: the map's OVERWRITE_MAP_BOUNDARIES entry, else its conversion.json
// worldBounds, else (after a delayed start only) the non-zero world bounds parser2 read, else none. When the fallback
// of a delayed start has no timeline, the viewer keeps parser2's late timeline ({ lateStart: true }), and so does this
// script (parserFallback false, parserFallbackFailure set). --force-fallback skips parser2 (trigger 'forced').
// --tmp is where the bundled ParseWorker module is written for its import (default: the OS temp dir; it is removed
// right after).
//
// Output: the base-values.mjs JSON (startTick, tickBase, ticks, playerEntityIds, sceneOrigin, samples, classes, ...)
// plus parserFallback (bool), route ('parser2', 'parser2 (late start)', 'fallback: no-timeline',
// 'fallback: delayed-start' or 'fallback: forced') and, after a fallback parse, fallback { trigger, reason,
// boundsSource, bounds, startedWithoutWorld, parseMs, wasmHeapMB, typedMB, parser2 }. scripts/hl/check-fallback.mjs
// reads it.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { ALIGNMENT_WINDOW, alignmentTarget, importBundled, parseArgs, REPO_ROOT, vmHwmKB } from './lib/bundle.mjs'
import { loadParseWorker } from './lib/parse-worker.mjs'

const { positional, flags } = parseArgs(process.argv.slice(2), ['force-fallback'])
const demoPath = positional[0]
if (!demoPath) {
  console.error('usage: node scripts/hl/fallback-values.mjs <demo.dem> [--out <file.json>] [--force-fallback] [--tmp <dir>]')
  process.exit(2)
}
const write = out => {
  const json = JSON.stringify(out)
  if (flags.out) fs.writeFileSync(flags.out, json)
  else process.stdout.write(json, () => process.exit(0)) // exit only after a piped stdout has drained
}

/** The first `bytes` of a file (the whole file when it is shorter). */
const head = (file, bytes) => {
  const fd = fs.openSync(file, 'r')
  try {
    const size = Math.min(bytes, fs.fstatSync(fd).size)
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, 0)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } finally {
    fs.closeSync(fd)
  }
}

const isZeroBounds = w => [w.boundaryMin, w.boundaryMax].every(v => v && v.x === 0 && v.y === 0 && v.z === 0)

// ─── 1. parser2 (child) and the two triggers ──────────────────────────────────

let base = null // parser2's base values, kept for the late-start route
let request = null // ParseWorker.ts's ParserFallbackRequest (the fields this script needs)
if (!flags['force-fallback']) {
  const child = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/hl/base-values.mjs'), demoPath], {
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  })
  if (child.status !== 0) {
    console.error(child.stderr)
    console.error(`[fallback-values] base-values.mjs failed with status ${child.status}`)
    process.exit(1)
  }
  base = JSON.parse(child.stdout)
  if (!(base.ticks > 1 && base.nextMappedPlayer > 0)) {
    request = {
      trigger: 'no-timeline',
      reason: `parser2 produced ${base.ticks} tick${base.ticks === 1 ? '' : 's'} and ${base.nextMappedPlayer} players`,
      parser2: { ticks: base.ticks, players: base.nextMappedPlayer, parseMs: base.parseMs, vmHwmKB: base.vmHwmKB },
    }
  } else {
    // The worker's rule on the file's frames: only the frame headers up to the 100th frame are read, so the first
    // 8 MB do unless the 100th frame lies further in (then the whole file, as the worker passes it)
    const { mod } = await loadParseWorker(REPO_ROOT, { tmp: flags.tmp })
    const at = { startDemoTick: base.startDemoTick, intervalPerTick: base.intervalPerTick }
    let bytes = head(demoPath, 8 << 20)
    let delayed = mod.delayedStartOf(at, bytes)
    if (!delayed && mod.demoWarmup(bytes).warmupEndTick === null && bytes.byteLength === 8 << 20) {
      bytes = new Uint8Array(fs.readFileSync(demoPath))
      delayed = mod.delayedStartOf(at, bytes)
    }
    bytes = null
    if (delayed) {
      const firstPacket =
        delayed.firstPacketTick === null
          ? ''
          : `, ${((delayed.startDemoTick - delayed.firstPacketTick) * base.intervalPerTick).toFixed(1)} s after the first packet`
      request = {
        trigger: 'delayed-start',
        reason: `parser2 started at demo tick ${delayed.startDemoTick}, ${delayed.delaySeconds.toFixed(1)} s after its warmup ended at demo tick ${delayed.warmupEndTick}${firstPacket}`,
        parser2: {
          ticks: base.ticks,
          players: base.nextMappedPlayer,
          parseMs: base.parseMs,
          vmHwmKB: base.vmHwmKB,
          startTick: base.startTick,
          startDemoTick: base.startDemoTick,
          firstPacketTick: delayed.firstPacketTick,
          warmupEndTick: delayed.warmupEndTick,
          delaySeconds: +delayed.delaySeconds.toFixed(2),
          thresholdSeconds: mod.DELAYED_START_FALLBACK_SECONDS,
          world: { boundaryMin: { ...base.worldBoundaryMin }, boundaryMax: { ...base.worldBoundaryMax } },
        },
      }
    } else {
      write({ ...base, parserFallback: false, route: 'parser2' })
    }
  }
}

if (flags['force-fallback'] || request) {
  // ─── 2. fallback (this process, like the browser's fresh worker) ──────────────

  const trigger = request?.trigger ?? 'forced'

  const POSITION_FIXED_SCALE = 32
  const HEALTH_SPARSE = 2
  const META_SPARSE = 6

  const { getMapBoundaries, getMapFolder } = await importBundled('scripts/hl/lib/fallback-entry.mjs')
  const pkgDir = path.join(REPO_ROOT, 'src/libs/hlextras')
  const lib = await import(pathToFileURL(path.join(pkgDir, 'hlextras.js')).href)
  const wasm = lib.initSync({ module: fs.readFileSync(path.join(pkgDir, 'hlextras_bg.wasm')) })

  // The map name is in the demo header (a 1072-byte struct; map at offset 536, 260 bytes, NUL-padded)
  const headerMap = (() => {
    const fd = fs.openSync(demoPath, 'r')
    const buf = Buffer.alloc(260)
    fs.readSync(fd, buf, 0, 260, 536)
    fs.closeSync(fd)
    return buf.toString('latin1').replace(/\0[\s\S]*$/, '')
  })()

  // AsyncParser.ts resolveFallbackBounds: the override first, then conversion.json worldBounds, then (delayed start)
  // the non-zero bounds parser2 read
  let bounds
  let boundsSource = 'none'
  const override = getMapBoundaries(headerMap)
  if (override) {
    bounds = { boundaryMin: { ...override.boundaryMin }, boundaryMax: { ...override.boundaryMax } }
    boundsSource = 'override'
  } else {
    const folder = getMapFolder(headerMap)
    const file = folder && path.join(REPO_ROOT, 'public/models/maps', folder, 'conversion.json')
    const wb = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).worldBounds : undefined
    if (wb?.boundaryMin && wb?.boundaryMax) {
      bounds = { boundaryMin: { ...wb.boundaryMin }, boundaryMax: { ...wb.boundaryMax } }
      boundsSource = 'conversion'
    }
  }
  const parser2World = request?.parser2.world
  if (boundsSource === 'none' && parser2World?.boundaryMin && parser2World?.boundaryMax && !isZeroBounds(parser2World)) {
    bounds = { boundaryMin: { ...parser2World.boundaryMin }, boundaryMax: { ...parser2World.boundaryMax } }
    boundsSource = 'parser2'
  }

  const t0 = performance.now()
  let fileBytes = 0
  let result
  {
    const bytes = new Uint8Array(fs.readFileSync(demoPath))
    fileBytes = bytes.length
    result = lib.parse_demo_cache_fallback(bytes, { ...bounds }, () => {})
  }
  const parseMs = performance.now() - t0
  const lateStart = error => {
    // ParseWorker.ts fail() after a delayed start: AsyncParser parses again with { lateStart } and keeps parser2
    write({ ...base, parserFallback: false, route: 'parser2 (late start)', parserFallbackFailure: { trigger, error, request } })
  }
  if (typeof result === 'string' || !result) {
    if (trigger === 'delayed-start') {
      console.error(`[fallback-values] fallback parse failed (${result}); keeping parser2's late timeline`)
      lateStart(result || 'Failed to parse demo.')
    } else {
      console.error(`fallback parse failed: ${result}`)
      process.exit(1)
    }
  } else if (trigger === 'delayed-start' && !(result.ticks > 1 && (result.players?.length ?? 0) > 0)) {
    lateStart(`the fallback cache builder produced ${result.ticks} tick(s) and ${result.players?.length ?? 0} players`)
  } else {
    const wasmHeapMB = wasm.memory.buffer.byteLength / 1048576

    const { header, ticks, intervalPerTick, world, players, playerCache } = result
    const positionScale =
      Number.isFinite(result.positionScale) && result.positionScale > 0 ? result.positionScale : POSITION_FIXED_SCALE

    // ParseWorker.ts: shift positions from the reported boundaryMin to the override's (zero after an override fallback)
    let deltaFixed = [0, 0, 0]
    const sceneOrigin = { ...world.boundaryMin }
    const shiftTo = getMapBoundaries(header.map)
    if (shiftTo) {
      const delta = ['x', 'y', 'z'].map(a => Math.trunc(world.boundaryMin[a] - shiftTo.boundaryMin[a]))
      deltaFixed = delta.map(d => Math.trunc(d * positionScale))
      Object.assign(sceneOrigin, shiftTo.boundaryMin)
    }

    let nextMappedPlayer = 0
    const entityIds = new Map()
    const playerNames = []
    for (const pl of players) {
      entityIds.set(pl.id, pl.entityId)
      playerNames[pl.id] = pl.name
      if (pl.id + 1 > nextMappedPlayer) nextMappedPlayer = pl.id + 1
    }
    const playerEntityIds = Array.from({ length: nextMappedPlayer }, (_, p) => entityIds.get(p) ?? 0)
    for (let p = 0; p < nextMappedPlayer; p++) if (playerNames[p] === undefined) playerNames[p] = ''

    /** PositionCache.getPosition after the ParseWorker shift: [x, y, z] in scene units. */
    const positionAt = (p, tick) => {
      const arr = playerCache.position[p]
      if (!arr) return [0, 0, 0]
      const o = tick * 3
      let x = arr[o], y = arr[o + 1], z = arr[o + 2]
      if (x === undefined) return [0, 0, 0]
      if ((x | y | z) !== 0) {
        x = (x + deltaFixed[0]) >>> 0
        y = (y + deltaFixed[1]) >>> 0
        z = (z + deltaFixed[2]) >>> 0
      }
      return [(x | 0) / positionScale, (y | 0) / positionScale, (z | 0) / positionScale]
    }
    const healthAt = (p, tick) => playerCache.health[p]?.[tick >> HEALTH_SPARSE] ?? 0

    // Same layout as base-values.mjs: Float32Array [k][p][offset 0..64][x, y, z, health], base64
    const SAMPLE_STRIDE = ALIGNMENT_WINDOW + 1
    const sampleTargets = Array.from({ length: 16 }, (_, k) => alignmentTarget(ticks, k))
    const sampleData = new Float32Array(16 * nextMappedPlayer * SAMPLE_STRIDE * 4).fill(NaN)
    for (let k = 0; k < 16; k++) {
      for (let p = 0; p < nextMappedPlayer; p++) {
        for (let o = 0; o < SAMPLE_STRIDE; o++) {
          const t = sampleTargets[k] + o
          if (t >= ticks) break
          const [x, y, z] = positionAt(p, t)
          const at = ((k * nextMappedPlayer + p) * SAMPLE_STRIDE + o) * 4
          sampleData[at] = x
          sampleData[at + 1] = y
          sampleData[at + 2] = z
          sampleData[at + 3] = healthAt(p, t)
        }
      }
    }

    const classes = []
    for (let p = 0; p < nextMappedPlayer; p++) {
      const meta = playerCache.meta[p]
      const changes = []
      let prev = -1
      if (meta) {
        for (let b = 0; b < meta.length; b++) {
          if (meta[b] !== prev) {
            changes.push([b << META_SPARSE, meta[b] & 0x0f, (meta[b] & 0xf0) >> 4])
            prev = meta[b]
          }
        }
      }
      classes.push(changes)
    }

    let typedBytes = 0
    for (const group of [result.playerCache, result.projectileCache]) {
      for (const list of Object.values(group)) {
        if (Array.isArray(list)) for (const a of list) if (ArrayBuffer.isView(a)) typedBytes += a.byteLength
      }
    }

    write({
      demo: path.basename(demoPath),
      map: header.map,
      fileBytes,
      startTick: result.startTick ?? 0,
      startDemoTick: result.startDemoTick ?? 0,
      tickBase: result.tickBase ?? 0,
      ticks,
      intervalPerTick,
      nextMappedPlayer,
      playerEntityIds,
      playerNames,
      positionScale,
      worldBoundaryMin: world.boundaryMin,
      worldBoundaryMax: world.boundaryMax,
      boundaryOverride: !!shiftTo,
      sceneOrigin,
      deaths: Object.values(result.deaths ?? {}).reduce((n, list) => n + list.length, 0),
      projectiles: result.projectileCache.ids.length,
      samples: {
        layout: 'Float32Array [k][p][offset][x, y, z, health], offset = tick - targets[k] in 0..64, NaN past the last tick',
        targets: sampleTargets,
        window: SAMPLE_STRIDE,
        data: Buffer.from(sampleData.buffer).toString('base64'),
      },
      classes,
      parseMs: Math.round(parseMs),
      vmHwmKB: vmHwmKB(),
      parserFallback: true,
      fallback: {
        trigger,
        reason: request?.reason ?? 'forced',
        boundsSource,
        bounds,
        startedWithoutWorld: !!result.startedWithoutWorld,
        parseMs: Math.round(parseMs),
        wasmHeapMB: Math.round(wasmHeapMB),
        typedMB: Math.round(typedBytes / 1048576),
        parser2: request?.parser2 ?? null,
      },
      route: `fallback: ${trigger}`,
    })
  }
}
