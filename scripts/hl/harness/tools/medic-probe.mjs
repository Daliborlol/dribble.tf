#!/usr/bin/env node
// Usage: node scripts/hl/harness/tools/medic-probe.mjs <demo.dem> <tick> ...   (a demo parse: run it under the lock)
// Prints medic charge + active weapon defs around given ticks (base parser output).
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HARNESS_CHECKOUT } from '../lib/setup.mjs'
const [demo, ...tickArgs] = process.argv.slice(2)
if (!demo) {
  console.error('usage: node scripts/hl/harness/tools/medic-probe.mjs <demo.dem> <tick> ...')
  process.exit(64)
}
const dir = path.join(HARNESS_CHECKOUT, 'src', 'libs', 'parser2')
const mod = await import(pathToFileURL(path.resolve(dir, 'parser2.js')).href)
mod.initSync({ module: fs.readFileSync(path.resolve(dir, 'parser2_bg.wasm')) })
const r = mod.parse_demo_cache(new Uint8Array(fs.readFileSync(demo)))
const items = JSON.parse(fs.readFileSync(path.join(HARNESS_CHECKOUT, 'src', 'constants', 'items.json'), 'utf8'))
const pc = r.playerCache
const medics = r.players.map((p, i) => ({ p, i })).filter(({ i }) => [...pc.meta[i]].some(m => (m & 15) === 5))
for (const { p, i } of medics) {
  const defs = new Map()
  pc.activeWeaponDef[i].forEach(d => defs.set(d, (defs.get(d) ?? 0) + 1))
  console.log(p.name, 'weapon defs used:', [...defs].filter(([d]) => d).map(([d, n]) => `${d} ${items[d]?.n ?? '?'} (${n})`).join(', '))
  for (const t of tickArgs.map(Number)) {
    const row = []
    for (let k = t - 64; k <= t + 64; k += 16) row.push(`${k}:${pc.uber[i][k >> 4]}/${pc.activeWeaponDef[i][k >> 4]}`)
    console.log('  ', row.join(' '))
  }
}
