#!/usr/bin/env node
// Usage: node scripts/hl/harness/tools/demo-stats.mjs <demo.dem> [parser2-dir]   (a demo parse: run it under the lock)
// Parses a demo with the committed parser2 (Node, initSync) and prints 9v9 volume stats used to
// pick interesting screenshot ticks: killfeed density, projectile counts, uber pops, rounds.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HARNESS_CHECKOUT } from '../lib/setup.mjs'

const [demo, dir = path.join(HARNESS_CHECKOUT, 'src', 'libs', 'parser2')] = process.argv.slice(2)
if (!demo) {
  console.error('usage: node scripts/hl/harness/tools/demo-stats.mjs <demo.dem> [parser2-dir]')
  process.exit(64)
}
const mod = await import(pathToFileURL(path.resolve(dir, 'parser2.js')).href)
mod.initSync({ module: fs.readFileSync(path.resolve(dir, 'parser2_bg.wasm')) })
const t0 = performance.now()
const r = mod.parse_demo_cache(new Uint8Array(fs.readFileSync(demo)))
const parseMs = Math.round(performance.now() - t0)
const ticks = r.ticks
const pc = r.playerCache
const CLASS = ['empty', 'scout', 'sniper', 'soldier', 'demoman', 'medic', 'heavy', 'pyro', 'spy', 'engineer']

const deaths = Object.values(r.deaths).flat().sort((a, b) => a.tick - b.tick)
// killfeed lines visible at playback tick T: deaths with tick in [T-199, T]
let best = { tick: 0, lines: 0 }
let j = 0
for (let i = 0; i < deaths.length; i++) {
  while (deaths[i].tick - deaths[j].tick >= 200) j++
  const lines = i - j + 1
  if (lines > best.lines) best = { tick: deaths[i].tick, lines }
}
const hist = {}
for (let i = 0, k = 0; i < deaths.length; i++) {
  while (deaths[i].tick - deaths[k].tick >= 200) k++
  const n = i - k + 1
  hist[n] = (hist[n] ?? 0) + 1
}

// projectiles alive per tick
const proj = r.projectileCache
let maxAlive = { tick: 0, n: 0 }
const typeCounts = {}
for (let t = 0; t < ticks; t += 4) {
  let n = 0
  for (let p = 0; p < proj.ids.length; p++) {
    const a = proj.position[p]
    if ((a[t * 3] | a[t * 3 + 1] | a[t * 3 + 2]) === 0) continue
    const ty = proj.type[p][t >> 6] ?? 0
    typeCounts[ty] = (typeCounts[ty] ?? 0) + 1
    n++
  }
  if (n > maxAlive.n) maxAlive = { tick: t, n }
}

// uber pops (same heuristic as utils/matchEvents getUberPops)
const ubers = []
for (let i = 0; i < r.players.length; i++) {
  const u = pc.uber[i], m = pc.meta[i]
  if (!u) continue
  for (let k = 1; k < u.length; k++) {
    if (u[k - 1] >= 95 && u[k] < 95 && (m[(k << 4) >> 6] & 15) === 5) ubers.push({ tick: k << 4, player: r.players[i].name })
  }
}

const roster = tick =>
  r.players
    .map((p, i) => ({ name: p.name, team: (pc.meta[i][tick >> 6] >> 4) & 15, cls: CLASS[pc.meta[i][tick >> 6] & 15], hp: pc.health[i][tick >> 2] }))
    .filter(p => p.team === 2 || p.team === 3)

const weapons = {}
for (const d of deaths) weapons[d.weapon] = (weapons[d.weapon] ?? 0) + 1
const activeDefs = new Set()
for (const arr of pc.activeWeaponDef ?? []) for (const v of arr) activeDefs.add(v)

console.log(JSON.stringify({
  map: r.header.map, parseMs, ticks, intervalPerTick: r.intervalPerTick,
  players: r.players.length,
  rosterAt25pct: roster(Math.floor(ticks * 0.25)).map(p => `${p.team === 2 ? 'RED' : 'BLU'} ${p.cls} ${p.name} ${p.hp}`),
  deaths: deaths.length, killfeedPeak: best, killfeedLinesHistogram: hist,
  topWeapons: Object.entries(weapons).sort((a, b) => b[1] - a[1]).slice(0, 25),
  projectileIds: proj.ids.length, maxProjectilesAlive: maxAlive, projectileTypeSamples: typeCounts,
  uberPops: ubers.sort((a, b) => a.tick - b.tick),
  rounds: r.rounds, chat: r.chat.length, shots: r.shots?.length,
  distinctActiveWeaponDefs: activeDefs.size,
}, null, 1))
