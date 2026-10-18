#!/usr/bin/env node
// Where parser2's timeline starts and where it holds positions (task B2).
//
//   node scripts/hl/parser2-start.mjs <demo.dem> [--out <file.json>]
//
// Runs the committed base parser (src/libs/parser2) on one demo and prints its timeline scalars (startTick,
// startDemoTick, tickBase, ticks, endTick, endDemoTick, intervalPerTick, players, world) plus, from the player
// position cache, the first and last cache tick at which any player has a position (the timeline's empty head and
// tail), the cache bytes, the parse time and this process's VmHWM. scripts/hl/parser2-survey.mjs --parser2 runs it
// once per demo as a child process, because parser2's wasm heap never shrinks.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseArgs, REPO_ROOT, vmHwmKB } from './lib/bundle.mjs'

const { positional, flags } = parseArgs(process.argv.slice(2))
const demoPath = positional[0]
if (!demoPath) {
  console.error('usage: node scripts/hl/parser2-start.mjs <demo.dem> [--out <file.json>]')
  process.exit(2)
}

const parserDir = path.join(REPO_ROOT, 'src/libs/parser2')
const parser = await import(pathToFileURL(path.join(parserDir, 'parser2.js')).href)
parser.initSync({ module: fs.readFileSync(path.join(parserDir, 'parser2_bg.wasm')) })

const t0 = performance.now()
let fileBytes = 0
let r
{
  const bytes = new Uint8Array(fs.readFileSync(demoPath))
  fileBytes = bytes.length
  r = parser.parse_demo_cache(bytes)
}
const parseMs = performance.now() - t0
if (typeof r === 'string' || !r) {
  console.error(`parser2 failed: ${r}`)
  process.exit(1)
}

let firstTickWithPositions = null
let lastTickWithPositions = null
for (const arr of r.playerCache?.position ?? []) {
  const n = Math.floor(arr.length / 3)
  for (let t = 0; t < n; t++) {
    if (arr[t * 3] | arr[t * 3 + 1] | arr[t * 3 + 2]) {
      if (firstTickWithPositions === null || t < firstTickWithPositions) firstTickWithPositions = t
      break
    }
  }
  for (let t = n - 1; t >= 0; t--) {
    if (arr[t * 3] | arr[t * 3 + 1] | arr[t * 3 + 2]) {
      if (lastTickWithPositions === null || t > lastTickWithPositions) lastTickWithPositions = t
      break
    }
  }
}
const bytesOf = group => {
  let total = 0
  for (const list of Object.values(group ?? {})) {
    if (Array.isArray(list)) for (const a of list) if (ArrayBuffer.isView(a)) total += a.byteLength
  }
  return total
}

const out = {
  demo: path.basename(demoPath),
  map: r.header?.map,
  fileBytes,
  headerTicks: r.header?.ticks,
  ticks: r.ticks,
  startTick: r.startTick ?? null,
  startDemoTick: r.startDemoTick ?? null,
  tickBase: r.tickBase ?? null,
  endTick: r.endTick ?? null,
  endDemoTick: r.endDemoTick ?? null,
  intervalPerTick: r.intervalPerTick,
  positionScale: r.positionScale ?? null,
  players: r.players?.length ?? 0,
  world: r.world,
  firstTickWithPositions,
  lastTickWithPositions,
  playerCacheMB: +(bytesOf(r.playerCache) / 1048576).toFixed(1),
  projectileCacheMB: +(bytesOf(r.projectileCache) / 1048576).toFixed(1),
  projectiles: r.projectileCache?.ids?.length ?? 0,
  deaths: Object.values(r.deaths ?? {}).reduce((n, list) => n + list.length, 0),
  parseMs: Math.round(parseMs),
  vmHwmKB: vmHwmKB(),
}
const json = JSON.stringify(out)
if (flags.out) {
  fs.writeFileSync(flags.out, json)
  process.exit(0)
} else process.stdout.write(`${json}\n`, () => process.exit(0)) // exit only after a piped stdout has drained
