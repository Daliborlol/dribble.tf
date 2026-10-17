// Schema checker for the hlextras output (`ExtrasRaw`, contract section 2.5 / src/highlander/extras/types.ts).
// Usage as a module: import { checkExtras, sumBytes } from './lib/schema.mjs' (scripts/hl/check-extras.mjs)
//   const { errors, warnings, summary } = checkExtras(raw)
// Checks every field name (exact key sets, no missing or extra keys), every typed-array type,
// track CSR invariants, instance column lengths and ordering, event ordering and HlEvent shapes.

const U8 = 'Uint8Array', I8 = 'Int8Array', U16 = 'Uint16Array', I16 = 'Int16Array'
const U32 = 'Uint32Array', I32 = 'Int32Array', F32 = 'Float32Array'
const NUM = 'number', STR = 'string', BOOL = 'boolean'

// a track: { offsets: U32, ticks: U32, ...fields } keyed by `keys` (a function of the raw object)
const track = (fields, keys) => ({ __kind: 'track', fields, keys })
// an event list: { tick: U32, ...fields }
const events = (fields) => ({ __kind: 'events', fields })
// instances: { count, entityId: U16, created: U32, deleted: U32, ...static columns, ...tracks }
const instances = (columns, tracks = {}, extra = {}) => ({ __kind: 'instances', columns, tracks, extra })

const XFORM = { x: F32, y: F32, z: F32, qx: F32, qy: F32, qz: F32, qw: F32 }

export const AVAIL_KEYS = [
  'cond', 'cloak', 'disguise', 'weapon', 'wstate', 'ammo', 'medigun', 'sniper', 'fov', 'view',
  'resource', 'misc', 'builder', 'loadout', 'viewmodels', 'fire', 'anim', 'scoring', 'itemCharge',
  'buildings', 'projectiles', 'flames', 'dots',
  'objectiveResource', 'timers', 'rules', 'teams', 'watchers', 'carts', 'pd',
  'movers', 'pickups', 'ragdolls', 'drops',
  'bullets', 'explosions', 'tracers', 'particles', 'clientProjectiles', 'hurts', 'events',
]

const P = (raw) => raw.players.count
const VM = { model: U16, seq: U8, parity: U8, muzzle: U8, weaponDef: U16, rate: F32, nodraw: U8 }

export const SCHEMA = {
  players: {
    count: NUM,
    entityId: U32,
    cond: track({ w0: U32, w1: U32, w2: U32, w3: U32, w4: U32 }, P),
    cloak: track({ meter: U8 }, P),
    invis: track({ completeTick: F32 }, P),
    disguise: track({ team: U8, cls: U8, target: U8, health: U16, weaponDef: U16, desiredTeam: U8, desiredCls: U8 }, P),
    weapon: track({ id: U32, def: U16, cls: U16 }, P),
    wstate: track({ state: U8, reload: U8, clip: I16, flags: U8, chargeTick: F32 }, P),
    ammo: track({ primary: U16, secondary: U16, metal: U16 }, P),
    medigun: track({ charge: U16, flags: U8, target: U8, def: U16, resist: U8 }, P),
    sniper: track({ charge: U8 }, P),
    fov: track({ fov: U8, start: U8, tick: F32, rate: F32 }, P),
    view: track({ eyeZ: U8, duck: U8 }, P),
    resource: track({ respawnTick: F32, maxHealth: U16, maxBuffed: U16, alive: U8, score: U16, damage: U32, healing: U32 }, P),
    misc: track({ healers: U8, carrying: U8, flip: U8, obsMode: U8, obsTarget: U8, revenge: U8, heads: U8, charge: U8, rage: U8, stickies: U8, saveMe: U8 }, P),
    builder: track({ state: U8, type: U8, mode: U8 }, P),
    loadout: track({ d0: U16, d1: U16, d2: U16, d3: U16, d4: U16, d5: U16, d6: U16, d7: U16, w0: U16, w1: U16, w2: U16, w3: U16 }, P),
    scoring: track({
      kills: U16, deaths: U16, assists: U16, damage: U32, heals: U32, caps: U16, defenses: U16, backstabs: U16,
      headshots: U16, invulns: U16, teleports: U16, built: U16, destroyed: U16, dominations: U16, revenges: U16, points: U16,
    }, P),
    itemCharge: track({ s0: U8, s1: U8, s2: U8 }, P),
    vm0: track(VM, P),
    vm1: track(VM, P),
    fire: events({ player: U8, weaponDef: U16 }),
    anim: events({ player: U8, event: U8, data: U16 }),
  },
  weapons: instances({ owner: U8, def: U16, cls: U16, disguise: U8 }),
  buildings: instances(
    { type: U8, mode: U8, builder: U8, team: U8, mini: U8, mapPlaced: U8, builtOn: I32 },
    {
      state: { level: U8, health: U16, maxHealth: U16, built: U8, flags: U16, objState: U8, upgradeMetal: U16,
        shells: U16, rockets: U8, metal: U16, rechargeTick: F32, rechargeDur: F32, timesUsed: U16 },
      pose: { yaw: U8, pitch: U8 },
      xform: XFORM,
      enemy: { kind: U8, index: U16 },
      heal: { lo: U32, hi: U32 },
    },
  ),
  projectiles: instances(
    { kind: U8, team: U8, owner: U8, launcherDef: U16, crit: U8, sentry: U16, hidden: U32, vx: F32, vy: F32, vz: F32, posStart: U32, posCount: U32 },
    { deflects: { team: U8, owner: U8, count: U8 } },
    { pos: F32 },
  ),
  flames: instances({ owner: U8 }, { box: { firing: U8, cx: F32, cy: F32, cz: F32, hx: F32, hy: F32, hz: F32 } }),
  dots: instances({ owner: U8, team: U8, laser: U8 }, { pos: { x: F32, y: F32, z: F32, chargeTick: F32 } }),
  objectives: {
    gameType: NUM,
    koth: BOOL,
    rules: track({ roundState: U8, winner: U8, flags: U16, swState: U8, rounds: U8, redKoth: I16, bluKoth: I16,
      hudTimer: I16, swTimer: I16, waveRed: F32, waveBlu: F32, restartTick: F32 }, () => 1),
    teams: track({ score: I32, roundsWon: U16, role: U8, flagCaps: U8 }, () => 4),
    timers: instances({}, { state: { paused: U8, endTick: F32, remaining: F32, length: U16, maxLength: U16,
      setupLength: U16, mode: U8, flags: U8, totalTime: F32 } }),
    cp: {
      count: NUM,
      layout: STR,
      pos: F32,
      visible: U8,
      group: U8,
      capTimeRed: F32,
      capTimeBlu: F32,
      reqRed: U8,
      reqBlu: U8,
      pathDistance: F32,
      scales: U8,
      state: track({ owner: U8, capping: U8, inZone: U8, numRed: U8, numBlu: U8, lazy: F32, flags: U8, unlockTick: F32 }, () => 8),
      progress: track({ p: U16 }, () => 8),
    },
    watchers: instances({}, { state: { progress: U16, speed: I8, cappers: I8, recedeTick: F32 } }),
    cart: { movers: I32, trains: I32 },
    pd: track({ red: U16, blu: U16, max: U16 }, () => 1),
  },
  movers: instances({ cls: U8, bspModel: I16, model: U16, parent: I32 }, { xform: XFORM, vis: { v: U8 } }),
  pickups: instances({ kind: U8, size: U8, model: U16, x: F32, y: F32, z: F32 }, { vis: { v: U8 } }),
  ragdolls: instances({ player: U8, cls: U8, team: U8, flags: U16, custom: U16, x: F32, y: F32, z: F32, vx: F32, vy: F32, vz: F32 }),
  drops: instances({ kind: U8, model: U16, def: U16 }, { xform: XFORM }),
  tempents: {
    bullets: events({ player: U8, weaponId: U8, crit: U8, seed: U8, spread: F32, x: F32, y: F32, z: F32, pitch: F32, yaw: F32 }),
    explosions: events({ x: F32, y: F32, z: F32, nx: F32, ny: F32, nz: F32, weaponId: U8, def: U16, entity: U16, particle: U16 }),
    tracers: events({ sentry: U16, sx: F32, sy: F32, sz: F32, ex: F32, ey: F32, ez: F32 }),
    particles: events({ name: U16, x: F32, y: F32, z: F32, entity: U16 }),
    clientProjectiles: events({ kind: U8, player: U8, crit: U8, x: F32, y: F32, z: F32, vx: F32, vy: F32, vz: F32 }),
  },
  hurts: events({ victim: U8, attacker: U8, damage: U16, health: I16, crit: U8, weaponId: U8, custom: U16 }),
}

const N = 'number', S = 'string', B = 'boolean', NA = 'number[]'
export const EVENT_FIELDS = {
  kill: { victim: N, attacker: N, assister: N, inflictor: N, weapon: S, weaponLog: S, weaponDef: N, weaponId: N, deathFlags: N, customKill: N, critType: N, feign: B },
  uberDeployed: { medic: N, target: N },
  medicDeath: { medic: N, attacker: N, healing: N, charged: B },
  deflect: { pyro: N, owner: N, weaponId: N, entity: N, projectile: N },
  buildStart: { building: N, builder: N, type: N, mode: N },
  buildDone: { building: N, builder: N, type: N },
  upgrade: { building: N, builder: N, level: N },
  carry: { building: N, builder: N },
  redeploy: { building: N, builder: N },
  destroyed: { building: N, owner: N, attacker: N, assister: N, weapon: S, type: N, wasBuilding: B },
  detonated: { building: N, owner: N, type: N },
  sapped: { building: N, spy: N, owner: N, type: N },
  teleported: { player: N, builder: N, dist: N },
  capStart: { cp: N, cpName: S, team: N, capTeam: N, cappers: NA, capTime: N },
  captured: { cp: N, cpName: S, team: N, cappers: NA },
  capBlocked: { cp: N, cpName: S, blocker: N, victim: N },
  capBroken: { cp: N, cpName: S, timeRemaining: N },
  cpLocked: { cp: N },
  cpUnlocked: { cp: N },
  roundStart: { fullReset: B },
  roundActive: {},
  setupFinished: {},
  roundWin: { team: N, winReason: N, fullRound: B, roundTime: N, suddenDeath: B },
  overtimeStart: {},
  overtimeEnd: {},
  timeAdded: { timer: N, seconds: N },
  gameOver: { reason: S },
  banner: { owner: N, buffType: N },
  pickup: { player: N, item: S },
  spawn: { player: N, cls: N, team: N },
  classChange: { player: N, cls: N },
  teamChange: { player: N, team: N, oldTeam: N, disconnect: B },
  disconnect: { player: N, reason: S },
}

const TOP = ['meta', 'strings', 'alignment', 'players', 'weapons', 'buildings', 'projectiles', 'flames', 'dots',
  'objectives', 'movers', 'pickups', 'ragdolls', 'drops', 'tempents', 'hurts', 'events']

function typeOf(v) {
  if (v === null) return 'null'
  if (ArrayBuffer.isView(v)) return v.constructor.name
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function keysEqual(errors, path, obj, expected) {
  const got = Object.keys(obj).sort()
  const want = [...expected].sort()
  for (const k of want) if (!got.includes(k)) errors.push(`${path}: missing key ${k}`)
  for (const k of got) if (!want.includes(k)) errors.push(`${path}: unexpected key ${k}`)
}

function checkTrack(errors, path, t, fields, keyCount, ticks) {
  if (typeOf(t) !== 'object') return errors.push(`${path}: not an object`)
  keysEqual(errors, path, t, ['offsets', 'ticks', ...Object.keys(fields)])
  if (typeOf(t.offsets) !== U32) errors.push(`${path}.offsets: ${typeOf(t.offsets)} != ${U32}`)
  if (typeOf(t.ticks) !== U32) errors.push(`${path}.ticks: ${typeOf(t.ticks)} != ${U32}`)
  for (const [f, ty] of Object.entries(fields)) {
    if (typeOf(t[f]) !== ty) errors.push(`${path}.${f}: ${typeOf(t[f])} != ${ty}`)
    else if (t.ticks && t[f].length !== t.ticks.length) errors.push(`${path}.${f}: length ${t[f].length} != ticks ${t.ticks.length}`)
  }
  if (!(t.offsets instanceof Uint32Array) || !(t.ticks instanceof Uint32Array)) return
  if (t.offsets.length !== keyCount + 1) errors.push(`${path}.offsets: length ${t.offsets.length} != keyCount+1 ${keyCount + 1}`)
  if (t.offsets[0] !== 0) errors.push(`${path}.offsets[0] != 0`)
  if (t.offsets[t.offsets.length - 1] !== t.ticks.length) errors.push(`${path}.offsets end ${t.offsets[t.offsets.length - 1]} != ticks.length ${t.ticks.length}`)
  let bad = 0
  for (let k = 0; k + 1 < t.offsets.length; k++) {
    const a = t.offsets[k], b = t.offsets[k + 1]
    if (b < a) { errors.push(`${path}.offsets not monotonic at ${k}`); break }
    for (let i = a; i < b; i++) {
      if (t.ticks[i] >= ticks) bad++
      if (i > a && t.ticks[i] <= t.ticks[i - 1]) { errors.push(`${path}: ticks not strictly increasing for key ${k} at ${i}`); return }
    }
  }
  if (bad) errors.push(`${path}: ${bad} ticks >= meta.ticks`)
}

function checkEvents(errors, path, e, fields, ticks) {
  if (typeOf(e) !== 'object') return errors.push(`${path}: not an object`)
  keysEqual(errors, path, e, ['tick', ...Object.keys(fields)])
  if (typeOf(e.tick) !== U32) return errors.push(`${path}.tick: ${typeOf(e.tick)} != ${U32}`)
  for (const [f, ty] of Object.entries(fields)) {
    if (typeOf(e[f]) !== ty) errors.push(`${path}.${f}: ${typeOf(e[f])} != ${ty}`)
    else if (e[f].length !== e.tick.length) errors.push(`${path}.${f}: length ${e[f].length} != tick ${e.tick.length}`)
  }
  for (let i = 0; i < e.tick.length; i++) {
    if (e.tick[i] >= ticks) { errors.push(`${path}: tick ${e.tick[i]} >= meta.ticks`); break }
    if (i > 0 && e.tick[i] < e.tick[i - 1]) { errors.push(`${path}: not sorted at ${i}`); break }
  }
}

function checkInstances(errors, path, g, spec, ticks) {
  if (typeOf(g) !== 'object') return errors.push(`${path}: not an object`)
  const keys = ['count', 'entityId', 'created', 'deleted', ...Object.keys(spec.columns), ...Object.keys(spec.tracks), ...Object.keys(spec.extra)]
  keysEqual(errors, path, g, keys)
  if (typeof g.count !== 'number') errors.push(`${path}.count: ${typeOf(g.count)} != number`)
  const base = { entityId: U16, created: U32, deleted: U32 }
  for (const [f, ty] of Object.entries({ ...base, ...spec.columns })) {
    if (typeOf(g[f]) !== ty) errors.push(`${path}.${f}: ${typeOf(g[f])} != ${ty}`)
    else if (g[f].length !== g.count) errors.push(`${path}.${f}: length ${g[f].length} != count ${g.count}`)
  }
  for (const [f, ty] of Object.entries(spec.extra)) if (typeOf(g[f]) !== ty) errors.push(`${path}.${f}: ${typeOf(g[f])} != ${ty}`)
  for (const [t, fields] of Object.entries(spec.tracks)) checkTrack(errors, `${path}.${t}`, g[t], fields, g.count, ticks)
  if (g.created instanceof Uint32Array && g.entityId instanceof Uint16Array) {
    for (let i = 1; i < g.count; i++) {
      const a = g.created[i - 1], b = g.created[i]
      if (b < a || (b === a && g.entityId[i] < g.entityId[i - 1])) { errors.push(`${path}: not sorted by (created, entityId) at ${i}`); break }
    }
    for (let i = 0; i < g.count; i++) {
      if (g.created[i] >= ticks) { errors.push(`${path}: created >= ticks at ${i}`); break }
      if (g.deleted[i] !== 0xFFFFFFFF && g.deleted[i] < g.created[i]) { errors.push(`${path}: deleted < created at ${i}`); break }
    }
  }
}

function checkNode(errors, path, value, spec, raw, ticks) {
  if (typeof spec === 'string') {
    if (typeOf(value) !== spec) errors.push(`${path}: ${typeOf(value)} != ${spec}`)
    return
  }
  if (spec.__kind === 'track') return checkTrack(errors, path, value, spec.fields, spec.keys(raw), ticks)
  if (spec.__kind === 'events') return checkEvents(errors, path, value, spec.fields, ticks)
  if (spec.__kind === 'instances') return checkInstances(errors, path, value, spec, ticks)
  if (typeOf(value) !== 'object') return errors.push(`${path}: ${typeOf(value)} != object`)
  keysEqual(errors, path, value, Object.keys(spec))
  for (const [k, s] of Object.entries(spec)) if (k in value) checkNode(errors, `${path}.${k}`, value[k], s, raw, ticks)
}

function checkMeta(errors, m) {
  const want = { schema: NUM, startTick: NUM, tickBase: NUM, ticks: NUM, intervalPerTick: NUM, snapshotInterval: NUM,
    playerCount: NUM, map: STR, parseMs: NUM, available: 'object', counts: 'object', warnings: 'array', excluded: 'array',
    convars: 'array', pauses: 'array' }
  if (typeOf(m) !== 'object') return errors.push('meta: not an object')
  keysEqual(errors, 'meta', m, Object.keys(want))
  for (const [k, ty] of Object.entries(want)) if (typeOf(m[k]) !== ty) errors.push(`meta.${k}: ${typeOf(m[k])} != ${ty}`)
  if (m.schema !== 1) errors.push(`meta.schema ${m.schema} != 1`)
  if (m.available) {
    keysEqual(errors, 'meta.available', m.available, AVAIL_KEYS)
    for (const [k, v] of Object.entries(m.available)) if (typeof v !== 'boolean') errors.push(`meta.available.${k}: ${typeof v}`)
  }
  for (const [k, v] of Object.entries(m.counts || {})) if (typeof v !== 'number') errors.push(`meta.counts.${k}: ${typeof v}`)
  for (const w of m.warnings || []) if (typeof w !== 'string') errors.push('meta.warnings: non-string')
  for (const w of m.excluded || []) if (typeof w !== 'string') errors.push('meta.excluded: non-string')
  for (const c of (m.convars || []).slice(0, 2000)) {
    if (typeOf(c) !== 'object' || typeof c.tick !== 'number' || typeof c.key !== 'string' || typeof c.value !== 'string' || Object.keys(c).length !== 3) {
      errors.push('meta.convars: bad entry ' + JSON.stringify(c)); break
    }
  }
  for (const p of m.pauses || []) {
    if (typeOf(p) !== 'object' || typeof p.tick !== 'number' || typeof p.paused !== 'boolean' || Object.keys(p).length !== 2) {
      errors.push('meta.pauses: bad entry ' + JSON.stringify(p)); break
    }
  }
}

function checkStrings(errors, s) {
  if (typeOf(s) !== 'object') return errors.push('strings: not an object')
  keysEqual(errors, 'strings', s, ['models', 'classes', 'particles', 'effects'])
  for (const k of ['models', 'classes', 'particles', 'effects']) {
    if (!Array.isArray(s[k])) errors.push(`strings.${k}: not an array`)
    else if (s[k].some((x) => typeof x !== 'string')) errors.push(`strings.${k}: non-string entry`)
  }
}

function checkEventsJson(errors, list, raw) {
  if (!Array.isArray(list)) return errors.push('events: not an array')
  const ticks = raw.meta.ticks
  let prev = -1
  const seen = {}
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    const spec = EVENT_FIELDS[e && e.t]
    if (!spec) { errors.push(`events[${i}]: unknown t ${e && e.t}`); continue }
    seen[e.t] = (seen[e.t] || 0) + 1
    const want = ['t', 'tick', ...Object.keys(spec)]
    const got = Object.keys(e)
    if (got.length !== want.length || want.some((k) => !got.includes(k))) {
      if (seen[e.t] === 1) errors.push(`events ${e.t}: keys ${got.sort().join(',')} != ${want.sort().join(',')}`)
    }
    if (typeof e.tick !== 'number' || e.tick < 0 || e.tick >= ticks) errors.push(`events[${i}]: bad tick ${e.tick}`)
    if (e.tick < prev) errors.push(`events[${i}]: not sorted by tick`)
    prev = e.tick
    for (const [k, ty] of Object.entries(spec)) {
      const v = e[k]
      const ok = ty === 'number[]' ? Array.isArray(v) && v.every((x) => typeof x === 'number') : typeof v === ty
      if (!ok && seen[e.t] <= 3) errors.push(`events ${e.t}.${k}: ${typeOf(v)} != ${ty}`)
    }
  }
  return seen
}

/** Sum of the byteLength of every typed array below `v`. */
export function sumBytes(v, seen = new Set()) {
  if (v === null || typeof v !== 'object') return 0
  if (ArrayBuffer.isView(v)) return v.byteLength
  if (seen.has(v)) return 0
  seen.add(v)
  let n = 0
  for (const k of Object.keys(v)) n += sumBytes(v[k], seen)
  return n
}

export function checkExtras(raw) {
  const errors = []
  const warnings = []
  if (typeOf(raw) !== 'object') return { errors: ['result is not an object: ' + String(raw)], warnings, summary: {} }
  keysEqual(errors, 'ExtrasRaw', raw, TOP)
  checkMeta(errors, raw.meta)
  checkStrings(errors, raw.strings)
  const ticks = raw.meta?.ticks ?? 0
  // alignment
  if (typeOf(raw.alignment) === 'object') {
    keysEqual(errors, 'alignment', raw.alignment, ['ticks', 'pos'])
    if (typeOf(raw.alignment.ticks) !== U32 || raw.alignment.ticks.length !== 16) errors.push('alignment.ticks: must be Uint32Array(16)')
    const pc = raw.meta?.playerCount ?? 0
    if (typeOf(raw.alignment.pos) !== F32 || raw.alignment.pos.length !== pc * 16 * 3) errors.push(`alignment.pos: must be Float32Array(${pc * 48})`)
  } else errors.push('alignment: not an object')
  for (const [g, spec] of Object.entries(SCHEMA)) {
    if (!(g in raw)) continue
    checkNode(errors, g, raw[g], spec, raw, ticks)
  }
  if (raw.players && raw.meta && raw.players.count !== raw.meta.playerCount) errors.push('players.count != meta.playerCount')
  if (raw.players?.entityId && raw.players.entityId.length !== raw.players.count) errors.push('players.entityId length != count')
  // projectiles position stream
  const pj = raw.projectiles
  if (pj && pj.posStart instanceof Uint32Array && pj.pos instanceof Float32Array) {
    for (let i = 0; i < pj.count; i++) {
      if ((pj.posStart[i] + pj.posCount[i]) * 3 > pj.pos.length) { errors.push(`projectiles: posStart+posCount beyond pos at ${i}`); break }
      if (pj.hidden[i] !== 0xFFFFFFFF && pj.posCount[i] > pj.hidden[i] - pj.created[i]) { errors.push(`projectiles: posCount beyond hidden at ${i}`); break }
    }
  }
  // objectives fixed-length arrays
  const cp = raw.objectives?.cp
  if (cp) {
    if (cp.pos?.length !== 24) errors.push('objectives.cp.pos length != 24')
    for (const k of ['visible', 'group', 'capTimeRed', 'capTimeBlu', 'reqRed', 'reqBlu', 'pathDistance', 'scales']) if (cp[k]?.length !== 8) errors.push(`objectives.cp.${k} length != 8`)
  }
  const eventCounts = checkEventsJson(errors, raw.events, raw) || {}
  const summary = {
    bytes: sumBytes(raw),
    playerCount: raw.meta?.playerCount,
    ticks,
    eventCounts,
    instances: Object.fromEntries(['weapons', 'buildings', 'projectiles', 'flames', 'dots', 'movers', 'pickups', 'ragdolls', 'drops'].map((g) => [g, raw[g]?.count])),
    groupBytes: Object.fromEntries(TOP.map((g) => [g, sumBytes(raw[g])])),
    available: raw.meta?.available,
    excluded: raw.meta?.excluded,
    warnings: raw.meta?.warnings,
  }
  return { errors, warnings, summary }
}
