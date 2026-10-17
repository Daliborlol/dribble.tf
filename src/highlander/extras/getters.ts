// Value-at-tick accessors for the Highlander extras (contract section 3.7.2).
//
// `p` is a player index (base parser player id), `tick` an integer cache tick, `tickF` a fractional cache tick.
// Every getter is a pure function of the extras and its arguments, so scene layers stay seek-deterministic (D12).
// Getters return null (or the documented default) where the track has no entry at the tick; layers still check
// `extras.meta.available` (section 3.9) before they draw anything.
//
// Two lookups that would otherwise walk long tracks (MEDIC! calls, convars) build small indices lazily, once per
// extras object, in module-level WeakMaps.

import { itemInfo, itemKind, itemName, itemSlot } from '../items'

import { condSet, HL, TIMER } from './enums'
import { byPlayerRange, lerpField, sinceTick, trackIndexAt } from './track'
import type { HighlanderExtras } from './types'

const NONE_U8 = 255
const NONE_U16 = 65535
const NONE_U32 = 0xffffffff

/** flagSince walks back at most this many cond entries (a flag stays set across unrelated cond changes). */
const FLAG_SINCE_MAX_STEPS = 1024
/** flagClearedSince looks back at most this many cond entries (contract: within 256 entries). */
const FLAG_CLEARED_MAX_STEPS = 256

/** Last index i in [lo, hi) of a sorted numeric list with list[i] <= value, or -1. */
function lastAtOrBefore(list: ArrayLike<number>, value: number, lo = 0, hi = list.length): number {
  let a = lo, b = hi
  while (a < b) {
    const mid = (a + b) >>> 1
    if (list[mid] <= value) a = mid + 1
    else b = mid
  }
  return a - 1 >= lo ? a - 1 : -1
}

export function playerIndexOf(x: HighlanderExtras, entityId: number): number {
  return x.derived.entityToPlayer.get(entityId) ?? -1 // -1 unknown
}

/** HL mask, 0 without data. */
export function flagsAt(x: HighlanderExtras, p: number, tick: number): number {
  const i = trackIndexAt(x.players.cond, p, tick)
  return i < 0 ? 0 : x.derived.flags[i]
}

/** Raw ETFCond test on w0..w4. */
export function condAt(x: HighlanderExtras, p: number, tick: number, cond: number): boolean {
  const c = x.players.cond
  const i = trackIndexAt(c, p, tick)
  if (i < 0) return false
  return condSet(c.w0[i], c.w1[i], c.w2[i], c.w3[i], c.w4[i], cond)
}

/** Tick the flag became set, null if not set. Walks back at most 1024 cond entries. */
export function flagSince(x: HighlanderExtras, p: number, tick: number, bit: number): number | null {
  const flags = x.derived.flags
  return sinceTick(x.players.cond, p, tick, i => (flags[i] & bit) !== 0, FLAG_SINCE_MAX_STEPS)
}

/** Tick the flag last went from set to clear, null while set or if never set (within 256 entries). */
export function flagClearedSince(x: HighlanderExtras, p: number, tick: number, bit: number): number | null {
  const c = x.players.cond
  const i = trackIndexAt(c, p, tick)
  if (i < 0) return null
  const flags = x.derived.flags
  if ((flags[i] & bit) !== 0) return null
  const lo = c.offsets[p]
  for (let j = i - 1, steps = 0; j >= lo && steps < FLAG_CLEARED_MAX_STEPS; j--, steps++) {
    if ((flags[j] & bit) !== 0) return c.ticks[j + 1]
  }
  return null
}

/** 0..cap; cap 0.95 is the spectator view, 1 the enemy view. tf2-reference 3.2 (InvisibilityThink). */
export function invisAt(x: HighlanderExtras, p: number, tickF: number, cap = 0.95): number {
  // Cloak and Dagger empty-meter motion cloak is not modelled.
  // Dead Ringer cloaks set m_flInvisChangeCompleteTime to the onset time (tf2-reference 3.1), so a feign cloak is
  // fully invisible from its onset: 0.95 at onset + 0 in the spectator view.
  const i = trackIndexAt(x.players.cond, p, Math.floor(tickF))
  if (i < 0) return 0
  const f = x.derived.flags[i]
  const S = (f & HL.CLOAKED) !== 0
  const j = trackIndexAt(x.players.invis, p, Math.floor(tickF))
  const C = j < 0 ? -Infinity : x.players.invis.completeTick[j]
  const dt = (C - tickF) * x.meta.intervalPerTick // seconds until the fade completes
  let inv = C > tickF ? (S ? 1 - dt : dt * 0.5) : S ? 1 : 0
  if (f & (HL.CLOAK_BLINK | HL.JARATED)) inv *= 0.85
  return Math.min(cap, Math.max(0, inv))
}

/** 0..100, 100 without data. */
export function cloakMeterAt(x: HighlanderExtras, p: number, tick: number): number {
  const i = trackIndexAt(x.players.cloak, p, tick)
  return i < 0 ? 100 : x.players.cloak.meter[i]
}

export interface DisguiseState { team: number; cls: number; target: number; health: number; weaponDef: number; disguising: boolean; desiredTeam: number; desiredCls: number; since: number }

/**
 * Null unless DISGUISED or DISGUISING. `since`: while disguised, the tick the current disguise (team and class)
 * took effect; while only disguising, the DISGUISING onset. `target` is a player index (255 none).
 */
export function disguiseAt(x: HighlanderExtras, p: number, tick: number): DisguiseState | null {
  const f = flagsAt(x, p, tick)
  const disguised = (f & HL.DISGUISED) !== 0
  const disguising = (f & HL.DISGUISING) !== 0
  if (!disguised && !disguising) return null

  let since = flagSince(x, p, tick, disguised ? HL.DISGUISED : HL.DISGUISING) ?? tick
  const t = x.players.disguise
  const i = trackIndexAt(t, p, tick)
  if (i < 0) {
    return { team: 0, cls: 0, target: NONE_U8, health: 0, weaponDef: NONE_U16, disguising, desiredTeam: 0, desiredCls: 0, since }
  }
  if (disguised) {
    const team = t.team[i], cls = t.cls[i]
    const start = sinceTick(t, p, tick, j => t.team[j] === team && t.cls[j] === cls, 4096)
    if (start !== null && start > since) since = start
  }
  return {
    team: t.team[i],
    cls: t.cls[i],
    target: t.target[i],
    health: t.health[i],
    weaponDef: t.weaponDef[i],
    disguising,
    desiredTeam: t.desiredTeam[i],
    desiredCls: t.desiredCls[i],
    since,
  }
}

export interface ActiveWeapon { id: number; def: number; cls: string; kind: string; slot: string; name: string; since: number }

/**
 * The active weapon, null without data or while the player holds none. `id` is the weapons instance index, `cls`
 * the server class name, `kind`/`slot`/`name` come from items.json (`'other'`, `''` and `'Unknown'` for unknown
 * defs), `since` is the tick this weapon instance became active.
 */
export function activeWeaponAt(x: HighlanderExtras, p: number, tick: number, classId: number): ActiveWeapon | null {
  const w = x.players.weapon
  const i = trackIndexAt(w, p, tick)
  if (i < 0) return null
  const id = w.id[i]
  if (id === NONE_U32) return null
  const def = w.def[i]
  const since = sinceTick(w, p, tick, j => w.id[j] === id, 64) ?? w.ticks[i]
  return {
    id,
    def,
    cls: x.strings.classes[w.cls[i]] ?? '',
    kind: itemKind(def),
    slot: itemSlot(def, classId),
    name: itemName(def),
    since,
  }
}

export interface WeaponState { state: number; reload: number; clip: number; readyToBackstab: boolean; critFire: boolean; lowered: boolean; chargeTick: number | null }

/** State of the active weapon; clip -1 = no clip or unknown (`hasLocalTables`), chargeTick null = not charging or unknown. */
export function weaponStateAt(x: HighlanderExtras, p: number, tick: number): WeaponState | null {
  const t = x.players.wstate
  const i = trackIndexAt(t, p, tick)
  if (i < 0) return null
  const flags = t.flags[i]
  const chargeTick = t.chargeTick[i]
  return {
    state: t.state[i],
    reload: t.reload[i],
    clip: t.clip[i],
    readyToBackstab: (flags & 1) !== 0,
    critFire: (flags & 2) !== 0,
    lowered: (flags & 4) !== 0,
    chargeTick: Number.isNaN(chargeTick) ? null : chargeTick,
  }
}

export type MedigunType = 'medigun' | 'kritzkrieg' | 'quickfix' | 'vaccinator'
export interface MedigunState { charge: number; healing: boolean; attacking: boolean; releasing: boolean; holstered: boolean; target: number; def: number; type: MedigunType; resist: number }

/** Medigun type from items.json `ct`: 1 kritzkrieg, 2 quickfix, 3 vaccinator, otherwise medigun. */
export function medigunTypeOf(def: number): MedigunType {
  const ct = itemInfo(def)?.chargeType
  return ct === 1 ? 'kritzkrieg' : ct === 2 ? 'quickfix' : ct === 3 ? 'vaccinator' : 'medigun'
}

/** Null when def is 65535 (no medigun). `charge` is 0..1, `target` a player index (255 none). */
export function medigunAt(x: HighlanderExtras, p: number, tick: number): MedigunState | null {
  const t = x.players.medigun
  const i = trackIndexAt(t, p, tick)
  if (i < 0) return null
  const def = t.def[i]
  if (def === NONE_U16) return null
  const flags = t.flags[i]
  return {
    charge: t.charge[i] / 1000,
    healing: (flags & 1) !== 0,
    attacking: (flags & 2) !== 0,
    releasing: (flags & 4) !== 0,
    holstered: (flags & 8) !== 0,
    target: t.target[i],
    def,
    type: medigunTypeOf(def),
    resist: t.resist[i],
  }
}

/** 0..150 */
export function sniperChargeAt(x: HighlanderExtras, p: number, tick: number): number {
  const i = trackIndexAt(x.players.sniper, p, tick)
  return i < 0 ? 0 : x.players.sniper.charge[i]
}

/** Source FOV (horizontal at 4:3). C_BasePlayer::GetFOV (c_baseplayer.cpp:2435-2504). */
export function fovAt(x: HighlanderExtras, p: number, tickF: number, defaultFov = 90): number {
  const i = trackIndexAt(x.players.fov, p, Math.floor(tickF))
  if (i < 0) return defaultFov
  const t = x.players.fov
  const target = t.fov[i] || defaultFov, start = t.start[i] || defaultFov, rate = t.rate[i]
  if (!(rate > 0) || target === start) return target
  const d = ((tickF - t.tick[i]) * x.meta.intervalPerTick) / rate
  if (d >= 1) return target
  const s = Math.max(0, d)
  return start + (target - start) * (s * s * (3 - 2 * s)) // SimpleSpline
}

/** Degrees, for three.js. Source FOV is horizontal at 4:3: 90 -> 73.74, 20 -> 15.07, 70 -> 55.4. */
export function verticalFov(fovH43: number): number {
  return (2 * Math.atan(Math.tan((fovH43 * Math.PI) / 360) * 0.75) * 180) / Math.PI
}

/**
 * True when p's local-only tables reached the demo (a Delta updated them; the Rust side checks per player).
 * Old SourceTV demos such as the bundled 6v6 sample, and every player but the recorder of a POV demo, carry them
 * only once, from the signon baseline. For those players the extras drop the view, ammo, scoring, itemCharge and
 * sniper entries, and the local-only fields of other tracks read as unknown: `wstate.clip` -1, `chargeTick` null,
 * `misc.rage` and `misc.stickies` 0, desired disguise 0, FOV rate 0 (instant zoom), `builder.type` 255. Gate a
 * displayed rage, sticky count or clip on this.
 */
export function hasLocalTables(x: HighlanderExtras, p: number): boolean {
  const has = (t: { offsets: Uint32Array }) => (t.offsets[p + 1] ?? 0) > (t.offsets[p] ?? 0)
  return has(x.players.ammo) || has(x.players.view) || has(x.players.scoring)
}

/** VEC_DEAD_VIEWHEIGHT is 14; a living player's eye is never below the duck height (45). */
const DEAD_EYE_Z_BELOW = 20

/**
 * The player's own eye height (m_vecViewOffset z), null without data (also for every player whose local tables
 * never updated, see `hasLocalTables`). Also null while p observes (misc.obsMode != 0: the observer's view offset
 * follows his observer target, so after a death it carries the eye height of whoever he spectates) and for the
 * dead view height (14) of the first ticks after a death.
 */
export function eyeZAt(x: HighlanderExtras, p: number, tick: number): number | null {
  const i = trackIndexAt(x.players.view, p, tick)
  if (i < 0) return null
  const z = x.players.view.eyeZ[i]
  if (z < DEAD_EYE_Z_BELOW) return null
  const m = trackIndexAt(x.players.misc, p, tick)
  if (m >= 0 && x.players.misc.obsMode[m] !== 0) return null
  return z
}

/** Null when alive or unknown. Seconds until m_flNextRespawnTime, never below 0. */
export function respawnSecondsAt(x: HighlanderExtras, p: number, tickF: number): number | null {
  const t = x.players.resource
  const i = trackIndexAt(t, p, Math.floor(tickF))
  if (i < 0 || t.alive[i]) return null
  const respawnTick = t.respawnTick[i]
  if (Number.isNaN(respawnTick)) return null
  return Math.max(0, (respawnTick - tickF) * x.meta.intervalPerTick)
}

export function ammoAt(x: HighlanderExtras, p: number, tick: number): { primary: number; secondary: number; metal: number } | null {
  const t = x.players.ammo
  const i = trackIndexAt(t, p, tick)
  if (i < 0) return null
  return { primary: t.primary[i], secondary: t.secondary[i], metal: t.metal[i] }
}

/** Weapon defs (d0..d7), then wearable defs (w0..w3) known to items.json; 65535 dropped. */
export function loadoutAt(x: HighlanderExtras, p: number, tick: number): number[] {
  const t = x.players.loadout
  const i = trackIndexAt(t, p, tick)
  if (i < 0) return []
  const out: number[] = []
  for (const d of [t.d0[i], t.d1[i], t.d2[i], t.d3[i], t.d4[i], t.d5[i], t.d6[i], t.d7[i]]) {
    if (d !== NONE_U16) out.push(d)
  }
  for (const w of [t.w0[i], t.w1[i], t.w2[i], t.w3[i]]) {
    if (w !== NONE_U16 && itemInfo(w)) out.push(w)
  }
  return out
}

export interface ScoringState { kills: number; deaths: number; assists: number; damage: number; heals: number; caps: number; defenses: number; backstabs: number; headshots: number; invulns: number; teleports: number; built: number; destroyed: number; dominations: number; revenges: number; points: number }

/** Null without data (local tables never updated, see `hasLocalTables`). Match totals (section 2.6.4). */
export function scoringAt(x: HighlanderExtras, p: number, tick: number): ScoringState | null {
  const t = x.players.scoring
  const i = trackIndexAt(t, p, tick)
  if (i < 0) return null
  return {
    kills: t.kills[i],
    deaths: t.deaths[i],
    assists: t.assists[i],
    damage: t.damage[i],
    heals: t.heals[i],
    caps: t.caps[i],
    defenses: t.defenses[i],
    backstabs: t.backstabs[i],
    headshots: t.headshots[i],
    invulns: t.invulns[i],
    teleports: t.teleports[i],
    built: t.built[i],
    destroyed: t.destroyed[i],
    dominations: t.dominations[i],
    revenges: t.revenges[i],
    points: t.points[i],
  }
}

/** 0..100 */
export function itemChargeAt(x: HighlanderExtras, p: number, tick: number): { primary: number; secondary: number; melee: number } | null {
  const t = x.players.itemCharge
  const i = trackIndexAt(t, p, tick)
  if (i < 0) return null
  return { primary: t.s0[i], secondary: t.s1[i], melee: t.s2[i] }
}

export interface VmState { model: string; seq: number; parity: number; muzzle: number; weaponDef: number; rate: number; nodraw: boolean; since: number }

/**
 * Viewmodel 0 (weapon) or 1 (spy watch / second viewmodel) of p. `model` is the modelprecache name,
 * `since` the tick the current (model, sequence, parity) started.
 */
export function viewmodelAt(x: HighlanderExtras, p: number, tick: number, which: 0 | 1): VmState | null {
  const t = which === 1 ? x.players.vm1 : x.players.vm0
  const i = trackIndexAt(t, p, tick)
  if (i < 0) return null
  const model = t.model[i], seq = t.seq[i], parity = t.parity[i]
  const since =
    sinceTick(t, p, tick, j => t.model[j] === model && t.seq[j] === seq && t.parity[j] === parity, 1024) ?? t.ticks[i]
  return {
    model: x.strings.models[model] ?? '',
    seq,
    parity,
    muzzle: t.muzzle[i],
    weaponDef: t.weaponDef[i],
    rate: t.rate[i],
    nodraw: t.nodraw[i] !== 0,
    since,
  }
}

/** Ticks of p's weapon fire events with from <= tick < to. */
export function fireTicks(x: HighlanderExtras, p: number, from: number, to: number): number[] {
  const list = x.players.fire
  return byPlayerRange(x.derived.fireByPlayer, list, p, from, to).map(i => list.tick[i])
}

/** p's player animation events (ANIM_EVENT) with from <= tick < to. */
export function animEvents(x: HighlanderExtras, p: number, from: number, to: number): { tick: number; event: number; data: number }[] {
  const list = x.players.anim
  return byPlayerRange(x.derived.animByPlayer, list, p, from, to).map(i => ({ tick: list.tick[i], event: list.event[i], data: list.data[i] }))
}

// MEDIC! calls: ticks where m_bSaveMeParity flips, per player, built once per extras object.
const saveMeIndex = new WeakMap<HighlanderExtras, Uint32Array[]>()

/** Ticks of every MEDIC! call of p (m_bSaveMeParity changes after p's first misc entry), ascending. */
export function medicCallTicks(x: HighlanderExtras, p: number): Uint32Array {
  let perPlayer = saveMeIndex.get(x)
  if (!perPlayer) {
    perPlayer = []
    const t = x.players.misc
    const keyCount = t.offsets.length - 1
    for (let k = 0; k < keyCount; k++) {
      const lo = t.offsets[k], hi = t.offsets[k + 1]
      const ticks: number[] = []
      for (let i = lo + 1; i < hi; i++) if (t.saveMe[i] !== t.saveMe[i - 1]) ticks.push(t.ticks[i])
      perPlayer.push(Uint32Array.from(ticks))
    }
    saveMeIndex.set(x, perPlayer)
  }
  return perPlayer[p] ?? new Uint32Array(0)
}

/**
 * `saveMeTick` is the tick of p's latest MEDIC! call at or before `tick`, -1 when there was none. `rage` and
 * `stickies` come from local-only tables: they read 0 when `hasLocalTables(x, p)` is false.
 */
export function miscAt(x: HighlanderExtras, p: number, tick: number): { healers: number; carrying: boolean; flip: boolean; obsMode: number; obsTarget: number; revenge: number; heads: number; charge: number; rage: number; stickies: number; saveMeTick: number } | null {
  const t = x.players.misc
  const i = trackIndexAt(t, p, tick)
  if (i < 0) return null
  const calls = medicCallTicks(x, p)
  const c = lastAtOrBefore(calls, tick)
  return {
    healers: t.healers[i],
    carrying: t.carrying[i] !== 0,
    flip: t.flip[i] !== 0,
    obsMode: t.obsMode[i],
    obsTarget: t.obsTarget[i],
    revenge: t.revenge[i],
    heads: t.heads[i],
    charge: t.charge[i],
    rage: t.rage[i],
    stickies: t.stickies[i],
    saveMeTick: c < 0 ? -1 : calls[c],
  }
}

export interface RulesState { roundState: number; winner: number; flags: number; swState: number; rounds: number; redKoth: number; bluKoth: number; hudTimer: number; swTimer: number; waveRed: number; waveBlu: number; restartTick: number }

/** Game rules at the tick. Timer fields are timers instance indices (-1 none); wave and restart fields are tickF (NaN none). */
export function rulesAt(x: HighlanderExtras, tick: number): RulesState | null {
  const t = x.objectives.rules
  const i = trackIndexAt(t, 0, tick)
  if (i < 0) return null
  return {
    roundState: t.roundState[i],
    winner: t.winner[i],
    flags: t.flags[i],
    swState: t.swState[i],
    rounds: t.rounds[i],
    redKoth: t.redKoth[i],
    bluKoth: t.bluKoth[i],
    hudTimer: t.hudTimer[i],
    swTimer: t.swTimer[i],
    waveRed: t.waveRed[i],
    waveBlu: t.waveBlu[i],
    restartTick: t.restartTick[i],
  }
}

/** Seconds shown by a round timer (teamplay_round_timer.cpp:377-403); 0 without data or for timer -1. */
export function timerSecondsAt(x: HighlanderExtras, timer: number, tickF: number): number {
  if (!(timer >= 0)) return 0
  const s = x.objectives.timers.state
  const i = trackIndexAt(s, timer, Math.floor(tickF))
  if (i < 0) return 0
  if ((s.flags[i] & TIMER.STOPWATCH) && (s.flags[i] & TIMER.CAPTURE_WATCH)) return s.totalTime[i]
  if (s.paused[i]) return Math.max(0, s.remaining[i])
  return Math.max(0, (s.endTick[i] - tickF) * x.meta.intervalPerTick)
}

/** 0..1, lerpField with maxGap = meta.snapshotInterval. */
export function capProgressAt(x: HighlanderExtras, point: number, tickF: number): number {
  const t = x.objectives.cp.progress
  const v = lerpField(t, t.p, point, tickF, x.meta.snapshotInterval || 1)
  if (Number.isNaN(v)) return 0
  return Math.min(1, Math.max(0, v / 65535))
}

/** CTFTeam values; team 2 RED, 3 BLU. */
export function teamAt(x: HighlanderExtras, team: number, tick: number): { score: number; roundsWon: number; role: number } | null {
  const t = x.objectives.teams
  const i = trackIndexAt(t, team, tick)
  if (i < 0) return null
  return { score: t.score[i], roundsWon: t.roundsWon[i], role: t.role[i] }
}

// convar key -> (ticks, values) in tick order, built once per extras object.
const convarIndex = new WeakMap<HighlanderExtras, Map<string, { ticks: number[]; values: string[] }>>()

/** Last SetConVar value at or before tick. */
export function convarAt(x: HighlanderExtras, key: string, tick: number): string | undefined {
  let index = convarIndex.get(x)
  if (!index) {
    index = new Map()
    const sorted = x.meta.convars
      .map((c, order) => ({ c, order }))
      .sort((a, b) => a.c.tick - b.c.tick || a.order - b.order)
    for (const { c } of sorted) {
      let entry = index.get(c.key)
      if (!entry) index.set(c.key, (entry = { ticks: [], values: [] }))
      entry.ticks.push(c.tick)
      entry.values.push(c.value)
    }
    convarIndex.set(x, index)
  }
  const entry = index.get(key)
  if (!entry) return undefined
  const i = lastAtOrBefore(entry.ticks, tick)
  return i < 0 ? undefined : entry.values[i]
}
