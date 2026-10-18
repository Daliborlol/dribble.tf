#!/usr/bin/env node
// Node checker for the Highlander extras parser (contract section 2.7).
//
//   flock $S/heavy.lock node scripts/hl/check-extras.mjs <demo.dem> [--expect scripts/hl/expect/<demo>.json]
//       [--options-from <native hl_extras --print-options file>] [--groups a,b] [--budget MB] [--out summary.json]
//       [--quiet]
//
// 1. Base values: runs scripts/hl/base-values.mjs as a child process (parser2's wasm heap never shrinks, so it must
//    not share this process), or with --options-from reads a native `hl_extras --print-options` file instead (demos
//    too large for parser2 in Node; the native --self-check then covers alignment).
// 2. In this process: loads src/libs/hlextras with initSync, copies the file into an ExtrasInput, drops the Node
//    buffer, calls parse_demo_extras_input with the base values and the items.json wearable defs (and the memory
//    plan's groups), checks the schema, hydrates with src/highlander/extras/hydrate.ts (bundled with esbuild), runs
//    the section 3.6 alignment rule against the child's samples, computes the acceptance counts and compares them
//    with the expectation file.
// 3. Prints a JSON summary. memory.vmHwmMB is this process's VmHWM right after hydration (the steps ExtrasWorker.ts
//    runs: the extras path alone); memory.vmHwmTotalMB includes the checker's own counting afterwards, and
//    memoryStages has VmRSS/VmHWM at each step. Exit code 1 on any failure.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { ALIGNMENT_WINDOW, alignmentTarget, importBundled, parseArgs, REPO_ROOT, vmHwmKB } from './lib/bundle.mjs'
import { checkExtras } from './lib/schema.mjs'

const { positional, flags } = parseArgs(process.argv.slice(2), ['quiet'])
const demoPath = positional[0]
if (!demoPath) {
  console.error('usage: node scripts/hl/check-extras.mjs <demo.dem> [--expect file] [--options-from file] [--groups a,b] [--budget MB] [--out file]')
  process.exit(2)
}
const log = (...a) => flags.quiet || console.error(...a)
const failures = []
const fail = msg => failures.push(msg)
const memStages = {}
/** Records VmRSS and VmHWM (MB) at a named stage; the summary lists them. */
const stage = name => {
  try {
    const st = fs.readFileSync('/proc/self/status', 'utf8')
    const mb = re => Math.round((Number(re.exec(st)?.[1] ?? 0) / 1024) * 10) / 10
    memStages[name] = { rss: mb(/VmRSS:\s+(\d+)/), hwm: mb(/VmHWM:\s+(\d+)/) }
  } catch {
    // not on Linux
  }
}
stage('start')

// ─── 1. base values ────────────────────────────────────────────────────────────

let base = null // base-values.mjs output
let options
let sceneOrigin
if (flags['options-from']) {
  const native = JSON.parse(fs.readFileSync(flags['options-from'], 'utf8'))
  options = {
    startTick: native.startTick,
    tickBase: native.tickBase,
    ticks: native.ticks,
    intervalPerTick: native.intervalPerTick,
    playerEntityIds: native.playerEntityIds,
  }
  const min = native.derived?.worldMin ?? [0, 0, 0]
  sceneOrigin = { x: min[0], y: min[1], z: min[2] }
  log(`[check] base values from ${flags['options-from']} (native options; alignment is covered by hl_extras --self-check)`)
} else {
  const child = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/hl/base-values.mjs'), demoPath], {
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  })
  if (child.status !== 0) {
    console.error(child.stderr)
    console.error(`[check] base-values.mjs failed with status ${child.status}`)
    process.exit(1)
  }
  base = JSON.parse(child.stdout)
  options = {
    startTick: base.startTick,
    tickBase: base.tickBase,
    ticks: base.ticks,
    intervalPerTick: base.intervalPerTick,
    playerEntityIds: base.playerEntityIds,
  }
  sceneOrigin = base.sceneOrigin
  log(`[check] base: ${base.map} ticks ${base.ticks} players ${base.nextMappedPlayer} parse ${base.parseMs} ms, child VmHWM ${Math.round(base.vmHwmKB / 1024)} MB`)
}

// ─── 2. extras ────────────────────────────────────────────────────────────────

// The real src/highlander code is bundled with esbuild (scripts/hl/lib/bundle.mjs). The full bundle loads after
// hydration, so its few MB of RSS stay out of the measured peak, unless the memory plan must run first (--budget).
const budget = flags.budget !== undefined ? Number(flags.budget) : undefined
const budgetLib = budget !== undefined ? await importBundled('scripts/hl/lib/extras-entry.mjs') : null

stage('base values')
// What the worker has loaded when the parse starts: its own small module (hydrate) and the wasm package
const { hydrate, typedArrayBytes } = await importBundled('scripts/hl/lib/hydrate-entry.mjs')
const pkgDir = path.join(REPO_ROOT, 'src/libs/hlextras')
const wasmMod = await import(pathToFileURL(path.join(pkgDir, 'hlextras.js')).href)
let wasm
{
  const wasmBytes = fs.readFileSync(path.join(pkgDir, 'hlextras_bg.wasm'))
  wasm = wasmMod.initSync({ module: wasmBytes })
  if (wasmBytes.byteOffset === 0 && typeof wasmBytes.buffer.transfer === 'function') wasmBytes.buffer.transfer(0)
}

const fileBytes = fs.statSync(demoPath).size
const seconds = options.ticks * options.intervalPerTick
let plan = budgetLib ? budgetLib.planExtrasGroups(fileBytes, { seconds, budgetMB: budget }) : null
const groups = flags.groups ? flags.groups.split(',').filter(Boolean) : plan?.groups
options.groups = groups
// items.ts wearableDefs(): defs whose item class starts with tf_wearable (compared with the bundled one below)
const ITEMS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/constants/items.json'), 'utf8'))
options.wearableDefs = Object.keys(ITEMS).filter(k => ITEMS[k].c.startsWith('tf_wearable')).map(Number).sort((a, b) => a - b)

stage('wasm init')
const progress = []
const t0 = performance.now()
let raw
let parseMs = 0
{
  // Same steps as ExtrasWorker.ts: the file arrives as one buffer, is copied into wasm memory and released at once
  let bytes = fs.readFileSync(demoPath)
  const input = new wasmMod.ExtrasInput(bytes.length)
  new Uint8Array(wasm.memory.buffer, input.ptr(), bytes.length).set(bytes)
  if (bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.length && typeof bytes.buffer.transfer === 'function') {
    bytes.buffer.transfer(0) // frees the Node copy now instead of at the next GC (D18)
  }
  bytes = null // the wasm copy is the only one from here on
  const t1 = performance.now()
  raw = wasmMod.parse_demo_extras_input(input, options, p => progress.push(p))
  parseMs = performance.now() - t1
}
const totalMs = performance.now() - t0
stage('parsed')
if (typeof raw === 'string' || !raw) {
  console.error(`[check] extras parse failed: ${raw}`)
  process.exit(1)
}
const wasmMemoryBytes = wasm.memory.buffer.byteLength

const progressOk =
  progress.length > 0 &&
  progress[progress.length - 1] === 100 &&
  progress.every((p, i) => Number.isInteger(p) && p >= 0 && p <= 100 && (i === 0 || p > progress[i - 1]))
if (!progressOk) fail(`progress callbacks are not 0..100 strictly increasing ending at 100 (${progress.length} calls)`)

const tH = performance.now()
const x = hydrate(raw, sceneOrigin)
const hydrateMs = performance.now() - tH
const typedBytes = typedArrayBytes(x)
stage('hydrated')

// Everything below is the checker's own work: the schema check, the full bundle, alignment and the counts.
const { derived: _derived, ...rawView } = x // the schema of section 2.5 has no `derived`
const schema = checkExtras(rawView)
for (const e of schema.errors.slice(0, 50)) fail(`schema: ${e}`)
if (schema.errors.length > 50) fail(`schema: ${schema.errors.length - 50} more errors`)
const lib = budgetLib ?? (await importBundled('scripts/hl/lib/extras-entry.mjs'))
if (!plan) plan = lib.planExtrasGroups(fileBytes, { seconds })
if (plan.skip) log(`[check] memory plan would skip this demo in the browser: ${plan.reason}`)
if (!flags.groups && budget === undefined && plan.groups) log(`[check] note: the browser plan would exclude ${plan.excluded.join(', ')} (budget ${plan.budgetMB} MB)`)
if (JSON.stringify(lib.wearableDefs()) !== JSON.stringify(options.wearableDefs)) fail('wearable defs differ from items.ts wearableDefs()')
const { getters, findTicks, HL, BLD, RULES, condSet } = lib

// ─── 3. alignment (section 3.6) ───────────────────────────────────────────────

let alignment = null
if (base) {
  const { targets, window: stride } = base.samples
  const sampleBytes = Buffer.from(base.samples.data, 'base64')
  const data = new Float32Array(sampleBytes.buffer, sampleBytes.byteOffset, sampleBytes.byteLength / 4)
  const players = base.nextMappedPlayer
  alignment = lib.checkAlignmentWith(x, {
    startTick: base.startTick,
    tickBase: base.tickBase,
    ticks: base.ticks,
    nextMappedPlayer: players,
    sample(p, tick) {
      for (let k = 0; k < targets.length; k++) {
        const o = tick - targets[k]
        if (o < 0 || o >= stride || p >= players) continue
        const at = ((k * players + p) * stride + o) * 4
        if (Number.isNaN(data[at])) return null
        return { x: data[at], y: data[at + 1], z: data[at + 2], health: data[at + 3] }
      }
      return null
    },
  })
  if (!alignment.ok) fail(`alignment: ${alignment.reason}`)
  for (let k = 0; k < 16; k++) {
    const t = x.alignment.ticks[k], target = alignmentTarget(x.meta.ticks, k)
    if (t < target || t > target + ALIGNMENT_WINDOW) fail(`alignment.ticks[${k}] = ${t} outside [${target}, ${target + ALIGNMENT_WINDOW}]`)
  }
}

// ─── 4. stats ─────────────────────────────────────────────────────────────────

const stats = {}
const set = (k, v) => (stats[k] = v)
const pc = x.meta.playerCount
const names = base ? base.playerNames : []

// HL and raw cond rising edges, counted like the native runner (the first entry of a player counts when set)
{
  const c = x.players.cond
  const flagsArr = x.derived.flags
  const hlRising = Object.fromEntries(Object.keys(HL).map(k => [k, 0]))
  const condRising = {}
  for (let p = 0; p < pc; p++) {
    let prevFlags = 0
    let prevW = [0, 0, 0, 0, 0]
    for (let i = c.offsets[p]; i < c.offsets[p + 1]; i++) {
      const f = flagsArr[i]
      for (const name of Object.keys(HL)) if ((f & HL[name]) !== 0 && (prevFlags & HL[name]) === 0) hlRising[name]++
      const w = [c.w0[i], c.w1[i], c.w2[i], c.w3[i], c.w4[i]]
      for (let cond = 0; cond < 160; cond++) {
        if (condSet(w[0], w[1], w[2], w[3], w[4], cond) && !condSet(prevW[0], prevW[1], prevW[2], prevW[3], prevW[4], cond)) {
          condRising[cond] = (condRising[cond] ?? 0) + 1
        }
      }
      prevFlags = f
      prevW = w
    }
  }
  for (const [k, v] of Object.entries(hlRising)) set(`hlRising.${k}`, v)
  for (const [k, v] of Object.entries(condRising)) set(`condRising.${k}`, v)
}

set('tempents.bullets', x.tempents.bullets.tick.length)
set('tempents.critBullets', x.tempents.bullets.crit.reduce((n, v) => n + (v ? 1 : 0), 0))
set('tempents.explosions', x.tempents.explosions.tick.length)
set('tempents.tracers', x.tempents.tracers.tick.length)
set('tempents.particles', x.tempents.particles.tick.length)
set('tempents.clientProjectiles', x.tempents.clientProjectiles.tick.length)
for (const k of [17, 21]) set(`clientProjectiles.kind${k}`, x.tempents.clientProjectiles.kind.reduce((n, v) => n + (v === k ? 1 : 0), 0))
set('players.anim', x.players.anim.tick.length)
set('players.fire', x.players.fire.tick.length)
set('hurts', x.hurts.tick.length)

// fire events per player name
{
  const byP = new Array(pc).fill(0)
  for (const p of x.players.fire.player) if (p < pc) byP[p]++
  for (let p = 0; p < pc; p++) {
    const name = names[p]
    if (name) set(`fireByName.${name}`, (stats[`fireByName.${name}`] ?? 0) + byP[p])
  }
}

// instances
const counts = x.meta.counts
for (const [k, v] of Object.entries(counts)) if (k.startsWith('inst.') || k.startsWith('scoring.') || k.startsWith('localTables.')) set(k, v)
// availability flags, so expectation files can assert them (`available.view` and so on)
for (const [k, v] of Object.entries(x.meta.available)) set(`available.${k}`, v)
{
  // local-only tables (Rust drops values frozen at signon): players the getter reports, and stale values left over
  let withLocal = 0, staleClip = 0, staleRage = 0
  for (let p = 0; p < pc; p++) {
    const live = getters.hasLocalTables(x, p)
    if (live) withLocal++
    if (live) continue
    const w = x.players.wstate, m = x.players.misc
    for (let i = w.offsets[p]; i < w.offsets[p + 1]; i++) if (w.clip[i] !== -1 || !Number.isNaN(w.chargeTick[i])) staleClip++
    for (let i = m.offsets[p]; i < m.offsets[p + 1]; i++) if (m.rage[i] !== 0 || m.stickies[i] !== 0) staleRage++
  }
  set('localTables.getterPlayers', withLocal)
  set('localTables.staleClipEntries', staleClip)
  set('localTables.staleRageEntries', staleRage)
}
{
  const b = x.buildings
  let sentry = 0, dispenserPlayer = 0, dispenserMap = 0, teleporter = 0, sapper = 0
  for (let j = 0; j < b.count; j++) {
    if (b.type[j] === 2) sentry++
    else if (b.type[j] === 0 && !b.mapPlaced[j]) dispenserPlayer++
    else if (b.type[j] === 0) dispenserMap++
    else if (b.type[j] === 1) teleporter++
    else if (b.type[j] === 3) sapper++
  }
  set('buildings.sentry', sentry)
  set('buildings.dispenserPlayer', dispenserPlayer)
  set('buildings.dispenserMapPlaced', dispenserMap)
  set('buildings.teleporter', teleporter)
  set('buildings.sapper', sapper)
  let wrangled = 0
  for (let i = 0; i < b.state.ticks.length; i++) if (b.state.flags[i] & BLD.WRANGLED) wrangled++
  set('buildings.wrangledEntries', wrangled)
}
{
  const d = x.dots
  let l0 = 0, l1 = 0
  for (let j = 0; j < d.count; j++) d.laser[j] ? l1++ : l0++
  set('dots.laser0', l0)
  set('dots.laser1', l1)
}
{
  const w = x.weapons
  const byCls = {}
  for (let j = 0; j < w.count; j++) {
    if (!w.disguise[j]) continue
    const cls = x.strings.classes[w.cls[j]] ?? String(w.cls[j])
    byCls[cls] = (byCls[cls] ?? 0) + 1
  }
  for (const [k, v] of Object.entries(byCls)) set(`weaponDisguise.${k}`, v)
  set('weaponDisguise.CWeaponMedigun', byCls.CWeaponMedigun ?? 0)
}
// medigun entries with a def while the base says the player is a spy (rule 2.3.12)
if (base) {
  const m = x.players.medigun
  let spyDefs = 0
  for (let p = 0; p < pc; p++) {
    const changes = base.classes[p] ?? []
    for (let i = m.offsets[p]; i < m.offsets[p + 1]; i++) {
      if (m.def[i] === 65535) continue
      const tick = m.ticks[i]
      let cls = 0
      for (const [t, c] of changes) {
        if (t <= tick) cls = c
        else break
      }
      if (cls === 8) spyDefs++
    }
  }
  set('medigun.spyDefEntries', spyDefs)
}
{
  const pj = x.projectiles
  const kinds = {}
  let crit = 0
  for (let j = 0; j < pj.count; j++) {
    kinds[pj.kind[j]] = (kinds[pj.kind[j]] ?? 0) + 1
    if (pj.crit[j]) crit++
  }
  for (let k = 0; k <= 21; k++) set(`projKind.${k}`, kinds[k] ?? 0)
  set('projKind.2+3', (kinds[2] ?? 0) + (kinds[3] ?? 0))
  set('projKind.8+9', (kinds[8] ?? 0) + (kinds[9] ?? 0))
  set('projectiles.crit', crit)
  set('projectiles.count', pj.count)
}
set('flames.count', x.flames.count)
set('movers.count', x.movers.count)
set('pickups.count', x.pickups.count)
set('ragdolls.count', x.ragdolls.count)
set('drops.count', x.drops.count)

// pickups (P2, contract 12.4 items 1 and 2): moving pickups (xform tracks), the plate rule and sizes, track
// invariants (static pickups have no entries, a moving one has at least two, inside [created, deleted)) and the
// position getter at the first and last entry
{
  const pk = x.pickups
  const xf = pk.xform
  const PLATE = /(^|\/)models\/(items|workshop)\/(.*\/)?plate[^/]*\.mdl$/
  const KIT = /(^|\/)models\/items\/(medkit|ammopack)_(small|medium|large)\.mdl$/
  const SMALL_PLATE = /\/plate_(chocolate|banana|fishcake)\.mdl$/
  let moving = 0, movingPlates = 0, staticPlates = 0, kitModelsMoving = 0, platesSmall = 0, platesMedium = 0
  let notPickupModel = 0, floorplates = 0, wrongPlateSize = 0, badTracks = 0, getterMismatch = 0
  const pos = { x: 0, y: 0, z: 0 }
  for (let j = 0; j < pk.count; j++) {
    const model = (x.strings.models[pk.model[j]] ?? '').replace(/\\/g, '/')
    const plate = PLATE.test(model)
    if (!plate && !KIT.test(model)) notPickupModel++
    if (/floorplate/.test(model)) floorplates++
    if (plate) {
      if (pk.size[j] === 0) platesSmall++
      else platesMedium++
      if (pk.kind[j] !== 0 || pk.size[j] !== (SMALL_PLATE.test(model) ? 0 : 1)) wrongPlateSize++
    }
    const a = xf.offsets[j], b = xf.offsets[j + 1]
    if (b === a) {
      if (plate) staticPlates++
      continue
    }
    moving++
    if (plate) movingPlates++
    if (KIT.test(model)) kitModelsMoving++
    const end = pk.deleted[j] === 0xffffffff ? x.meta.ticks : pk.deleted[j]
    if (b - a < 2 || xf.ticks[a] < pk.created[j] || xf.ticks[b - 1] >= end) badTracks++
    getters.pickupPositionAt(x, j, xf.ticks[b - 1], pos)
    if (pos.x !== xf.x[b - 1] || pos.y !== xf.y[b - 1] || pos.z !== xf.z[b - 1]) getterMismatch++
    getters.pickupPositionAt(x, j, xf.ticks[a], pos)
    if (pos.x !== xf.x[a] || pos.y !== xf.y[a] || pos.z !== xf.z[a]) getterMismatch++
    set(`pickupTrack.${j}.model`, model)
    set(`pickupTrack.${j}.created`, pk.created[j])
    set(`pickupTrack.${j}.entries`, b - a)
    set(`pickupTrack.${j}.lastTick`, xf.ticks[b - 1])
    set(`pickupTrack.${j}.dropZ`, Math.round((xf.z[a] - xf.z[b - 1]) * 100) / 100)
  }
  set('pickups.moving', moving)
  set('pickups.xformEntries', xf.ticks.length)
  set('pickups.movingPlates', movingPlates)
  set('pickups.staticPlates', staticPlates)
  set('pickups.kitModelsMoving', kitModelsMoving)
  set('pickups.platesSmall', platesSmall)
  set('pickups.platesMedium', platesMedium)
  set('pickups.notPickupModel', notPickupModel)
  set('pickups.floorplates', floorplates)
  set('pickups.wrongPlateSize', wrongPlateSize)
  set('pickups.badTracks', badTracks)
  set('pickups.getterMismatch', getterMismatch)
  if (badTracks) fail(`pickups.xform: ${badTracks} moving pickups with fewer than 2 entries or entries outside [created, deleted)`)
  if (getterMismatch) fail(`pickupPositionAt differs from the xform entries ${getterMismatch} times`)
  if (wrongPlateSize) fail(`${wrongPlateSize} plates with a kind or size other than the 12.2 item 4 rule`)
}

// events
{
  const byType = {}
  let feign = 0
  for (const e of x.events) {
    byType[e.t] = (byType[e.t] ?? 0) + 1
    if (e.t === 'kill' && e.feign) feign++
  }
  for (const [k, v] of Object.entries(byType)) set(`events.${k}`, v)
  set('kill.feign', feign)
}

// objectives
{
  const ob = x.objectives
  set('objectives.koth', ob.koth)
  set('objectives.gameType', ob.gameType)
  set('cp.count', ob.cp.count)
  set('cp.layout', ob.cp.layout)
  for (let i = 0; i < 8; i++) set(`cp.pathDistance.${i}`, Math.round(ob.cp.pathDistance[i] * 1e5) / 1e5)
  const r = ob.rules
  let stopwatch = false, swStateMax = 0, redKoth = 0, bluKoth = 0, overtime = false
  for (let i = 0; i < r.ticks.length; i++) {
    if (r.flags[i] & RULES.STOPWATCH) stopwatch = true
    if (r.flags[i] & RULES.IN_OVERTIME) overtime = true
    swStateMax = Math.max(swStateMax, r.swState[i])
    if (r.redKoth[i] >= 0 && r.redKoth[i] < ob.timers.count) redKoth++
    if (r.bluKoth[i] >= 0 && r.bluKoth[i] < ob.timers.count) bluKoth++
  }
  set('rules.entries', r.ticks.length)
  set('rules.stopwatch', stopwatch)
  set('rules.overtime', overtime)
  set('rules.swStateMax', swStateMax)
  set('rules.redKothResolved', redKoth)
  set('rules.bluKothResolved', bluKoth)
  set('timers.count', ob.timers.count)
  set('watchers.count', ob.watchers.count)
  set('cart.movers', ob.cart.movers.length)
  set('cart.trains', ob.cart.trains.length)
  const pd = ob.pd
  let pdMax = 0, pdRed = 0, pdBlu = 0
  for (let i = 0; i < pd.ticks.length; i++) {
    pdMax = Math.max(pdMax, pd.max[i])
    pdRed = Math.max(pdRed, pd.red[i])
    pdBlu = Math.max(pdBlu, pd.blu[i])
  }
  set('pd.entries', pd.ticks.length)
  set('pd.max', pdMax)
  set('pd.redMax', pdRed)
  set('pd.bluMax', pdBlu)
  // previous points, base points and mini rounds (P2, contract 12.4 item 3), and CTFGameRules::TeamMayCapturePoint
  // per team and point at the round starts and right after each capture (one digit per point, 1 = may capture)
  set('cp.prevRed', Array.from(ob.cp.prevRed).join(','))
  set('cp.prevBlu', Array.from(ob.cp.prevBlu).join(','))
  set('cp.baseRed', ob.cp.baseRed)
  set('cp.baseBlu', ob.cp.baseBlu)
  set('cp.miniRounds', ob.cp.miniRounds)
  if (ob.cp.count > 0) {
    const ticks = []
    for (const e of x.events) {
      if (e.t === 'roundActive') ticks.push(e.tick + 1)
      if (e.t === 'captured') ticks.push(e.tick + 1)
    }
    for (const t of ticks.slice(0, 16)) {
      for (const [name, team] of [['red', 2], ['blu', 3]]) {
        let digits = ''
        for (let i = 0; i < ob.cp.count; i++) digits += getters.teamMayCapturePointAt(x, team, i, t) ? '1' : '0'
        set(`cpMay.${name}@${t}`, digits)
      }
    }
  }
}

// scoring
{
  const s = x.players.scoring
  let playersWithScoring = 0
  for (let p = 0; p < pc; p++) if (s.offsets[p + 1] > s.offsets[p]) playersWithScoring++
  set('scoring.players', playersWithScoring)
  set('scoring.element', counts['scoring.element'] ?? null)
}

// convars at tick 0 and meta
for (const key of ['mp_tournament_redteamname', 'mp_tournament_blueteamname', 'tv_transmitall', 'mp_capstyle', 'tf_use_fixed_weaponspreads']) {
  set(`convar0.${key}`, getters.convarAt(x, key, 0) ?? null)
}
set('meta.snapshotInterval', x.meta.snapshotInterval)
set('meta.map', x.meta.map)
set('meta.truncated', x.meta.warnings.some(w => w.includes('truncated')))
set('meta.intervalPerTick', x.meta.intervalPerTick)

// alignment sample ticks on demos with a snapshot interval > 1: every sample tick must lie on the packet grid
{
  const si = x.meta.snapshotInterval
  if (si > 1) {
    const residues = new Map()
    for (const t of [x.players.view.ticks, x.players.cond.ticks, x.players.fov.ticks, x.players.misc.ticks]) {
      for (const tick of t) if (tick > 0) residues.set(tick % si, (residues.get(tick % si) ?? 0) + 1)
    }
    const [grid] = [...residues.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0]
    const off = [...x.alignment.ticks].filter(t => t % si !== grid)
    set('alignment.packetGrid', `${grid} mod ${si}`)
    set('alignment.offGrid', off.length)
  } else {
    set('alignment.offGrid', 0)
  }
}
if (alignment) {
  set('alignment.ok', alignment.ok)
  set('alignment.pairs', alignment.pairs)
  set('alignment.within', alignment.within)
  set('alignment.maxDistance', Math.round(alignment.maxDistance * 1000) / 1000)
}

// findTicks agrees with the edge counts above, and every kind runs
const findKindsChecked = {}
{
  const all = kind => findTicks(x, kind, { limit: 1e9 })
  const edgeKinds = { cloak: 'CLOAKED', disguise: 'DISGUISED', disguising: 'DISGUISING', zoom: 'ZOOMED', crit: 'CRIT', burning: 'BURNING', overheal: 'OVERHEALED', stun: 'STUNNED', marked: 'MARKED' }
  for (const [kind, bit] of Object.entries(edgeKinds)) {
    const n = all(kind).length
    findKindsChecked[kind] = n
    if (n !== stats[`hlRising.${bit}`]) fail(`findTicks('${kind}') returned ${n}, HL.${bit} has ${stats[`hlRising.${bit}`]} rising edges`)
  }
  const eventKinds = { feign: null, deflect: 'deflect', buildStart: 'buildStart', buildDone: 'buildDone', upgrade: 'upgrade', sapped: 'sapped', destroyed: 'destroyed', teleported: 'teleported', capStart: 'capStart', captured: 'captured', roundWin: 'roundWin', banner: 'banner' }
  for (const [kind, type] of Object.entries(eventKinds)) {
    const n = all(kind).length
    findKindsChecked[kind] = n
    const want = type ? stats[`events.${type}`] ?? 0 : stats['kill.feign']
    if (n !== want) fail(`findTicks('${kind}') returned ${n}, expected ${want}`)
  }
  const proj7 = all('proj:7').length
  if (proj7 !== stats['projKind.7']) fail(`findTicks('proj:7') returned ${proj7}, projectiles of kind 7: ${stats['projKind.7']}`)
  findKindsChecked['proj:7'] = proj7
  const uberKinds = ['uber', 'kritz', 'quickfix', 'vacc'].map(k => all(k).length)
  findKindsChecked.uberKinds = uberKinds
  if (uberKinds.reduce((a, b) => a + b, 0) !== (stats['events.uberDeployed'] ?? 0)) fail(`uber + kritz + quickfix + vacc (${uberKinds}) != uberDeployed ${stats['events.uberDeployed'] ?? 0}`)
  for (const kind of lib.FIND_KINDS) {
    const rows = findTicks(x, kind, { limit: 20 })
    for (let i = 1; i < rows.length; i++) if (rows[i].tick < rows[i - 1].tick) fail(`findTicks('${kind}') not sorted`)
    for (const r of rows) if (!(r.tick >= 0 && r.tick < x.meta.ticks)) fail(`findTicks('${kind}') tick ${r.tick} out of range`)
    findKindsChecked[`first.${kind}`] = rows.length ? rows[0].tick : null
  }
  set('findTicks.busiest.count', all('busiest').length)
}

// hydration invariants
{
  const d = x.derived
  let n = 0
  for (const list of d.projectilesByEntity.values()) n += list.length
  if (n !== x.projectiles.count) fail(`projectilesByEntity holds ${n} of ${x.projectiles.count} instances`)
  const rowsOf = bp => bp.rows.length
  if (rowsOf(d.fireByPlayer) !== x.players.fire.tick.length) fail('fireByPlayer does not hold every fire row')
  if (rowsOf(d.animByPlayer) !== x.players.anim.tick.length) fail('animByPlayer does not hold every anim row')
  if (d.flags.length !== x.players.cond.ticks.length) fail('derived.flags length != players.cond entries')
  const evN = Object.values(d.eventsByType).reduce((a, l) => a + l.length, 0)
  if (evN !== x.events.length) fail('eventsByType does not index every event')
}

stage('stats')

// ─── 5. expectations and limits ───────────────────────────────────────────────

// The extras path is everything up to and including hydration (what ExtrasWorker.ts does); the counts above are
// the checker's own work, so the limit applies to the high-water mark at the 'hydrated' stage.
const fileMB = fileBytes / 1e6
const hwmTotalMB = vmHwmKB() / 1024
const hwmMB = memStages.hydrated?.hwm ?? hwmTotalMB
// contract 11.1 A9: max(2.6 x file + 100, 140) MB (the 6v6 sample's 117 to 127 MB are fixed Node and V8 overhead)
const hwmLimitMB = Math.max(2.6 * fileMB + 100, 140)
if (hwmMB > hwmLimitMB) fail(`VmHWM ${hwmMB.toFixed(1)} MB above max(2.6 x file + 100, 140) = ${hwmLimitMB.toFixed(1)} MB`)

let expect = null
if (flags.expect) {
  expect = JSON.parse(fs.readFileSync(flags.expect, 'utf8'))
  if (!expect.allowTruncated && stats['meta.truncated']) fail(`meta.warnings has a truncated entry: ${x.meta.warnings.join('; ')}`)
  const limits = expect.limits ?? {}
  if (limits.parseMs !== undefined && parseMs > limits.parseMs) fail(`parse ${Math.round(parseMs)} ms above ${limits.parseMs} ms`)
  if (limits.typedArrayMB !== undefined && typedBytes / 1e6 > limits.typedArrayMB) fail(`typed arrays ${(typedBytes / 1e6).toFixed(2)} MB above ${limits.typedArrayMB} MB`)
  for (const c of expect.checks ?? []) {
    if (c.needsBase && !base) continue
    const got = stats[c.stat]
    const label = c.name ?? c.stat
    if (got === undefined) {
      fail(`${label}: no stat ${c.stat}`)
      continue
    }
    if ('probe' in c) {
      if (!(typeof got === 'number' && got <= c.probe && got >= 0.95 * c.probe - 1e-9)) fail(`${label}: ${got} not within 95..100 % of the probe value ${c.probe}`)
    } else if ('eq' in c) {
      if (got !== c.eq) fail(`${label}: ${JSON.stringify(got)} != ${JSON.stringify(c.eq)}`)
    } else if ('near' in c) {
      if (!(Math.abs(got - c.near) <= (c.tol ?? 1e-3))) fail(`${label}: ${got} not within ${c.tol ?? 1e-3} of ${c.near}`)
    } else if ('min' in c || 'max' in c) {
      if ('min' in c && !(got >= c.min)) fail(`${label}: ${got} below ${c.min}`)
      if ('max' in c && !(got <= c.max)) fail(`${label}: ${got} above ${c.max}`)
    }
  }
} else if (stats['meta.truncated']) {
  log(`[check] warning: ${x.meta.warnings.join('; ')}`)
}

const summary = {
  demo: path.basename(demoPath),
  map: x.meta.map,
  fileBytes,
  ticks: x.meta.ticks,
  playerCount: pc,
  baseFrom: base ? 'base-values.mjs (parser2 child)' : `native options ${path.basename(flags['options-from'])}`,
  groups: groups ?? 'all',
  excluded: x.meta.excluded,
  plan,
  timing: { parseMs: Math.round(parseMs), totalMs: Math.round(totalMs), hydrateMs: Math.round(hydrateMs) },
  memory: {
    vmHwmMB: Math.round(hwmMB * 10) / 10,
    limitMB: Math.round(hwmLimitMB * 10) / 10,
    vmHwmTotalMB: Math.round(hwmTotalMB * 10) / 10,
    wasmMemoryMB: Math.round((wasmMemoryBytes / 1048576) * 10) / 10,
    typedArrayMB: Math.round((typedBytes / 1e6) * 1000) / 1000,
    typedArrayBytes: typedBytes,
    baseChildVmHwmMB: base ? Math.round((base.vmHwmKB / 1024) * 10) / 10 : null,
  },
  memoryStages: memStages,
  groupBytes: schema.summary.groupBytes,
  progressCalls: progress.length,
  alignment,
  available: x.meta.available,
  unavailable: Object.entries(x.meta.available).filter(([, v]) => !v).map(([k]) => k),
  warnings: x.meta.warnings,
  stats,
  findTicks: findKindsChecked,
  expect: flags.expect ? path.basename(flags.expect) : null,
  failures,
  ok: failures.length === 0,
}

if (flags.out) fs.writeFileSync(flags.out, JSON.stringify(summary, null, 1))
process.stdout.write(JSON.stringify(summary, null, 1) + '\n')
if (failures.length) {
  console.error(`[check] ${failures.length} failure(s):\n  ${failures.join('\n  ')}`)
  process.exitCode = 1 // not process.exit(): a piped stdout must drain first
} else {
  console.error(`[check] OK ${summary.demo}: parse ${summary.timing.parseMs} ms, ${summary.memory.typedArrayMB} MB typed, VmHWM ${summary.memory.vmHwmMB} MB (limit ${summary.memory.limitMB})`)
}
