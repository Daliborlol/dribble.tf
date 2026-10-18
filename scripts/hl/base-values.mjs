#!/usr/bin/env node
// Base parse values for the Highlander extras checker (contract section 2.7).
//
//   node scripts/hl/base-values.mjs <demo.dem> [--out <file.json>]
//
// Loads the committed base parser (src/libs/parser2) with initSync, parses the demo, applies the same map boundary
// override shift as ParseWorker.ts, and writes (to --out, or stdout):
//   startTick, startDemoTick, tickBase, ticks, intervalPerTick, nextMappedPlayer, playerEntityIds, playerNames,
//   worldBoundaryMin, worldBoundaryMax (the bounds parser2 reports), sceneOrigin (the boundaryMin after any override shift),
//   samples: for k = 0..15, the base position (scene space) and health of every player at each tick from
//     round(ticks * (k + 0.5) / 16) to 64 ticks later (the window in which the extras pick their sample tick),
//     as one base64 Float32Array,
//   classes[p]: the base class and team of player p as [tick, classId, teamId] at every change (64-tick buckets).
// Then it exits. check-extras.mjs runs it as a child process, because parser2's wasm heap never shrinks and would
// otherwise dominate the extras measurement.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ALIGNMENT_WINDOW, alignmentTarget, importBundled, parseArgs, REPO_ROOT, vmHwmKB } from './lib/bundle.mjs'

const { positional, flags } = parseArgs(process.argv.slice(2))
const demoPath = positional[0]
if (!demoPath) {
  console.error('usage: node scripts/hl/base-values.mjs <demo.dem> [--out <file.json>]')
  process.exit(2)
}

const POSITION_FIXED_SCALE = 32 // PositionEncoding.ts default when the result has no positionScale
const HEALTH_SPARSE = 2 // HealthCache: one value per 4 ticks
const META_SPARSE = 6 // PlayerMetaCache: one value per 64 ticks

const parserDir = path.join(REPO_ROOT, 'src/libs/parser2')
const parser = await import(pathToFileURL(path.join(parserDir, 'parser2.js')).href)
parser.initSync({ module: fs.readFileSync(path.join(parserDir, 'parser2_bg.wasm')) })
const { getMapBoundaries } = await importBundled('src/components/Analyse/MapBoundaries.ts')

const t0 = performance.now()
let fileBytes = 0
let result
{
  const bytes = new Uint8Array(fs.readFileSync(demoPath))
  fileBytes = bytes.length
  result = parser.parse_demo_cache(bytes)
}
const parseMs = performance.now() - t0
if (typeof result === 'string' || !result) {
  console.error(`base parse failed: ${result}`)
  process.exit(1)
}

const { header, ticks, intervalPerTick, world, players, playerCache } = result
const positionScale = Number.isFinite(result.positionScale) && result.positionScale > 0 ? result.positionScale : POSITION_FIXED_SCALE

// ParseWorker.ts: shift positions from the demo's boundaryMin to the override's, in fixed-point units
let deltaFixed = [0, 0, 0]
const sceneOrigin = { ...world.boundaryMin }
const override = getMapBoundaries(header.map)
if (override) {
  const delta = ['x', 'y', 'z'].map(a => Math.trunc(world.boundaryMin[a] - override.boundaryMin[a]))
  deltaFixed = delta.map(d => Math.trunc(d * positionScale))
  Object.assign(sceneOrigin, override.boundaryMin)
}

let nextMappedPlayer = 0
const playerEntityIdsMap = new Map()
const playerNames = []
for (const pl of players) {
  playerEntityIdsMap.set(pl.id, pl.entityId)
  playerNames[pl.id] = pl.name
  if (pl.id + 1 > nextMappedPlayer) nextMappedPlayer = pl.id + 1
}
const playerEntityIds = Array.from({ length: nextMappedPlayer }, (_, p) => playerEntityIdsMap.get(p) ?? 0)
for (let p = 0; p < nextMappedPlayer; p++) if (playerNames[p] === undefined) playerNames[p] = ''

/** PositionCache.getPosition after the ParseWorker shift: [x, y, z] in scene units. */
function positionAt(p, tick) {
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

// samples: Float32Array [k][p][offset 0..64][x, y, z, health], base64 in the JSON (a few hundred KB instead of
// tens of thousands of small arrays, which would bloat the checker process that measures its own peak)
const SAMPLE_STRIDE = ALIGNMENT_WINDOW + 1
const sampleTargets = Array.from({ length: 16 }, (_, k) => alignmentTarget(ticks, k))
const sampleData = new Float32Array(16 * nextMappedPlayer * SAMPLE_STRIDE * 4).fill(NaN)
for (let k = 0; k < 16; k++) {
  const target = sampleTargets[k]
  for (let p = 0; p < nextMappedPlayer; p++) {
    for (let o = 0; o < SAMPLE_STRIDE; o++) {
      const t = target + o
      if (t >= ticks) break
      const [x, y, z] = positionAt(p, t)
      const at = (((k * nextMappedPlayer + p) * SAMPLE_STRIDE) + o) * 4
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
      const v = meta[b]
      if (v !== prev) {
        changes.push([b << META_SPARSE, v & 0x0f, (v & 0xf0) >> 4])
        prev = v
      }
    }
  }
  classes.push(changes)
}

const out = {
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
  boundaryOverride: !!override,
  sceneOrigin,
  deaths: Object.values(result.deaths ?? {}).reduce((n, list) => n + list.length, 0),
  samples: {
    layout: 'Float32Array [k][p][offset][x, y, z, health], offset = tick - targets[k] in 0..64, NaN past the last tick',
    targets: sampleTargets,
    window: SAMPLE_STRIDE,
    data: Buffer.from(sampleData.buffer).toString('base64'),
  },
  classes,
  parseMs: Math.round(parseMs),
  vmHwmKB: vmHwmKB(),
}

const json = JSON.stringify(out)
if (flags.out) fs.writeFileSync(flags.out, json)
else process.stdout.write(json, () => process.exit(0)) // exit only after a piped stdout has drained
