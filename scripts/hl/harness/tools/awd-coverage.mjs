#!/usr/bin/env node
// Usage: node scripts/hl/harness/tools/awd-coverage.mjs <demo.dem>   (a demo parse: run it under the lock)
// Coverage of playerCache.activeWeaponDef per player (share of alive samples with a nonzero def).
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HARNESS_CHECKOUT } from '../lib/setup.mjs'
const [demo] = process.argv.slice(2)
if (!demo) {
  console.error('usage: node scripts/hl/harness/tools/awd-coverage.mjs <demo.dem>')
  process.exit(64)
}
const dir = path.join(HARNESS_CHECKOUT, 'src', 'libs', 'parser2')
const mod = await import(pathToFileURL(path.resolve(dir, 'parser2.js')).href)
mod.initSync({ module: fs.readFileSync(path.resolve(dir, 'parser2_bg.wasm')) })
const r = mod.parse_demo_cache(new Uint8Array(fs.readFileSync(demo)))
const pc = r.playerCache
const CLASS = ['-', 'scout', 'sniper', 'soldier', 'demoman', 'medic', 'heavy', 'pyro', 'spy', 'engineer']
for (let i = 0; i < r.players.length; i++) {
  let alive = 0, withDef = 0
  const n = pc.activeWeaponDef[i].length
  for (let k = 0; k < n; k++) {
    const hp = pc.health[i][(k << 4) >> 2]
    if (!hp) continue
    alive++
    if (pc.activeWeaponDef[i][k]) withDef++
  }
  const cls = CLASS[pc.meta[i][Math.floor(pc.meta[i].length / 2)] & 15]
  console.log(String(r.players[i].entityId).padStart(3), cls.padEnd(9), r.players[i].team.padEnd(5), `${alive ? Math.round((100 * withDef) / alive) : 0}%`.padStart(4), r.players[i].name)
}
