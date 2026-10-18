#!/usr/bin/env node
// Usage: node scripts/hl/harness/tools/shots-probe.mjs <demo.dem>   (a demo parse: run it under the lock)
// Summarise the base parser's `shots` array: per player and per weapon definition.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HARNESS_CHECKOUT } from '../lib/setup.mjs'
const [demo] = process.argv.slice(2)
if (!demo) {
  console.error('usage: node scripts/hl/harness/tools/shots-probe.mjs <demo.dem>')
  process.exit(64)
}
const dir = path.join(HARNESS_CHECKOUT, 'src', 'libs', 'parser2')
const mod = await import(pathToFileURL(path.resolve(dir, 'parser2.js')).href)
mod.initSync({ module: fs.readFileSync(path.resolve(dir, 'parser2_bg.wasm')) })
const r = mod.parse_demo_cache(new Uint8Array(fs.readFileSync(demo)))
const items = JSON.parse(fs.readFileSync(path.join(HARNESS_CHECKOUT, 'src', 'constants', 'items.json'), 'utf8'))
const byDef = new Map(), byPlayer = new Map()
for (const s of r.shots) {
  byDef.set(s.weaponDefIndex, (byDef.get(s.weaponDefIndex) ?? 0) + 1)
  const name = r.players[s.playerId]?.name ?? `#${s.playerId}`
  byPlayer.set(name, (byPlayer.get(name) ?? 0) + 1)
}
console.log('shots', r.shots.length)
console.log('by weapon:', [...byDef].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${items[d]?.n ?? '?'}: ${n}`).join(' | '))
console.log('by player:', [...byPlayer].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}: ${n}`).join(' | '))
