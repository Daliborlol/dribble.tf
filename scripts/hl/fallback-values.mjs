#!/usr/bin/env node
// Base values through the viewer's base-parse rule (task B1).
//
//   node scripts/hl/fallback-values.mjs <demo.dem> [--out <file.json>] [--force-fallback]
//
// Like the browser (ParseWorker.ts and AsyncParser.ts): parser2 first, in a child process (scripts/hl/base-values.mjs,
// so its wasm heap never shares this process, as the browser ends its worker). When parser2's result has no timeline
// (ticks <= 1 or no players), this process runs the fork's fallback cache builder (src/libs/hlextras
// parse_demo_cache_fallback) with the map's bounds: its OVERWRITE_MAP_BOUNDARIES entry, else its conversion.json
// worldBounds, else none. --force-fallback skips parser2.
//
// Output: the base-values.mjs JSON (startTick, tickBase, ticks, playerEntityIds, sceneOrigin, samples, classes, ...)
// plus parserFallback (bool) and, after a fallback parse, fallback { reason, boundsSource, bounds,
// startedWithoutWorld, parseMs, wasmHeapMB, typedMB, parser2 }. scripts/hl/check-fallback.mjs reads it.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { ALIGNMENT_WINDOW, alignmentTarget, importBundled, parseArgs, REPO_ROOT, vmHwmKB } from './lib/bundle.mjs'

const { positional, flags } = parseArgs(process.argv.slice(2), ['force-fallback'])
const demoPath = positional[0]
if (!demoPath) {
  console.error('usage: node scripts/hl/fallback-values.mjs <demo.dem> [--out <file.json>] [--force-fallback]')
  process.exit(2)
}
const write = out => {
  const json = JSON.stringify(out)
  if (flags.out) fs.writeFileSync(flags.out, json)
  else process.stdout.write(json, () => process.exit(0)) // exit only after a piped stdout has drained
}

// ─── 1. parser2 (child) ───────────────────────────────────────────────────────

let parser2 = null
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
  const base = JSON.parse(child.stdout)
  if (base.ticks > 1 && base.nextMappedPlayer > 0) {
    write({ ...base, parserFallback: false })
    process.exitCode = 0
  } else {
    parser2 = { ticks: base.ticks, players: base.nextMappedPlayer, parseMs: base.parseMs, vmHwmKB: base.vmHwmKB }
  }
}

if (flags['force-fallback'] || parser2) {
  // ─── 2. fallback (this process, like the browser's fresh worker) ──────────────

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

  // AsyncParser.ts resolveFallbackBounds: the override first, then conversion.json worldBounds
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

  const t0 = performance.now()
  let fileBytes = 0
  let result
  {
    const bytes = new Uint8Array(fs.readFileSync(demoPath))
    fileBytes = bytes.length
    result = lib.parse_demo_cache_fallback(bytes, { ...bounds }, () => {})
  }
  const parseMs = performance.now() - t0
  if (typeof result === 'string' || !result) {
    console.error(`fallback parse failed: ${result}`)
    process.exit(1)
  }
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
      reason: parser2 ? `parser2 produced ${parser2.ticks} tick(s) and ${parser2.players} players` : 'forced',
      boundsSource,
      bounds,
      startedWithoutWorld: !!result.startedWithoutWorld,
      parseMs: Math.round(parseMs),
      wasmHeapMB: Math.round(wasmHeapMB),
      typedMB: Math.round(typedBytes / 1048576),
      parser2,
    },
  })
}
