// Interesting-tick finder (contract section 3.8). The debug bridge exposes it as window.__dribble.hl.findTicks;
// F5's timeline and the harness plans of every feature use it to pick ticks worth looking at.
//
// Results are cache ticks sorted ascending (playback tick = cache tick + 2), at most `limit` (default 20).
// `player` in options and results is a player index p; `instance` indexes the group the kind reads (buildings,
// projectiles, flames, movers, pickups, watchers, control points or timers). `team` keeps rows of that team
// (2 RED, 3 BLU): the instance team where the group has one, else the player's team from spawn and team events.

import { itemKind } from '../items'
import { ITEM_RESPAWN_SECONDS, ITEM_RESPAWN_SLACK_SECONDS } from '../mapdyn/constants'

import { BLD, condSet, COND, HL } from './enums'
import { medicCallTicks, medigunAt, type MedigunType } from './getters'
import type { HighlanderExtras, HlEvent, Track } from './types'

export type FindKind =
  | 'cloak'
  | 'decloak'
  | 'disguise'
  | 'disguising'
  | 'feign'
  | 'backstab'
  | 'headshot'
  | 'uber'
  | 'kritz'
  | 'quickfix'
  | 'vacc'
  | 'crit'
  | 'minicrit'
  | 'burning'
  | 'jarate'
  | 'milk'
  | 'marked'
  | 'bonk'
  | 'overheal'
  | 'teleportedGlow'
  | 'stun'
  | 'gas'
  | 'banner'
  | 'busiest'
  | 'zoom'
  | 'airblast'
  | 'flamesOn'
  | 'deflect'
  | 'buildStart'
  | 'buildDone'
  | 'upgrade'
  | 'carry'
  | 'redeploy'
  | 'sapped'
  | 'destroyed'
  | 'teleported'
  | 'wrangled'
  | `proj:${number}`
  | 'syringe'
  | 'explosion'
  | 'tracer'
  | 'bullet'
  | 'critBullet'
  | 'capStart'
  | 'captured'
  | 'capBlocked'
  | 'capBroken'
  | 'capping'
  | 'cartMoving'
  | 'cartReceding'
  | 'overtime'
  | 'roundWin'
  | 'roundStart'
  | 'setupFinished'
  | 'doorMove'
  | 'pickupTaken'
  | 'pickupBack'
  | 'medicDrop'
  | 'respawnWave'
  | 'medicCall'

export interface FoundTick { tick: number; player?: number; instance?: number; note?: string }
export interface FindOptions { limit?: number; player?: number; team?: number }

/** Every kind except the `proj:<kind>` family (`proj:7` flares, `proj:8` arrows, ...). */
export const FIND_KINDS: readonly FindKind[] = [
  'cloak', 'decloak', 'disguise', 'disguising', 'feign', 'backstab', 'headshot', 'uber', 'kritz', 'quickfix', 'vacc',
  'crit', 'minicrit', 'burning', 'jarate', 'milk', 'marked', 'bonk', 'overheal', 'teleportedGlow', 'stun', 'gas',
  'banner', 'busiest', 'zoom', 'airblast', 'flamesOn', 'deflect', 'buildStart', 'buildDone', 'upgrade', 'carry',
  'redeploy', 'sapped', 'destroyed', 'teleported', 'wrangled', 'syringe', 'explosion', 'tracer', 'bullet',
  'critBullet', 'capStart', 'captured', 'capBlocked', 'capBroken', 'capping', 'cartMoving', 'cartReceding',
  'overtime', 'roundWin', 'roundStart', 'setupFinished', 'doorMove', 'pickupTaken', 'pickupBack', 'medicDrop',
  'respawnWave', 'medicCall',
]

const NONE_U8 = 255
const NONE_U16 = 65535
const NONE_U32 = 0xffffffff
/** One second of 66-tick demo time: the `busiest` window and the `doorMove` rest period. */
const BUSIEST_WINDOW = 132
const DOOR_REST_TICKS = 66
const PROGRESS_HALF = 65535 / 2

/** A result row plus the filters' internals (stripped before returning). */
interface Row extends FoundTick {
  team?: number
  players?: number[]
}

const HL_EDGE_KINDS: Partial<Record<FindKind, number>> = {
  disguise: HL.DISGUISED,
  disguising: HL.DISGUISING,
  crit: HL.CRIT,
  minicrit: HL.MINICRIT,
  burning: HL.BURNING,
  jarate: HL.JARATED,
  milk: HL.MILKED,
  marked: HL.MARKED,
  bonk: HL.BONK,
  overheal: HL.OVERHEALED,
  teleportedGlow: HL.TELEPORTED,
  stun: HL.STUNNED,
  zoom: HL.ZOOMED,
}

const UBER_KINDS: Partial<Record<FindKind, MedigunType>> = {
  uber: 'medigun',
  kritz: 'kritzkrieg',
  quickfix: 'quickfix',
  vacc: 'vaccinator',
}

const keyCountOf = (t: Track) => Math.max(0, t.offsets.length - 1)

/** Rising edges (first entry included when set) of `test` over every key of a track. */
function risingEdges(t: Track, test: (i: number) => boolean, emit: (key: number, i: number) => void): void {
  const keys = keyCountOf(t)
  for (let k = 0; k < keys; k++) {
    let prev = false
    for (let i = t.offsets[k]; i < t.offsets[k + 1]; i++) {
      const now = test(i)
      if (now && !prev) emit(k, i)
      prev = now
    }
  }
}

function eventsOf<T extends HlEvent['t']>(x: HighlanderExtras, type: T): Extract<HlEvent, { t: T }>[] {
  const idx = x.derived.eventsByType[type]
  if (!idx) return []
  return idx.map(i => x.events[i] as Extract<HlEvent, { t: T }>)
}

const player = (p: number) => (p >= 0 && p !== NONE_U8 ? p : undefined)

// Player team timeline from spawn and team events, built once per extras object.
const teamIndex = new WeakMap<HighlanderExtras, { ticks: number[]; teams: number[] }[]>()

function playerTeamAt(x: HighlanderExtras, p: number, tick: number): number | undefined {
  let index = teamIndex.get(x)
  if (!index) {
    index = Array.from({ length: x.players.count }, () => ({ ticks: [] as number[], teams: [] as number[] }))
    for (const e of x.events) {
      if ((e.t === 'spawn' || e.t === 'teamChange') && e.player >= 0 && e.player < index.length) {
        index[e.player].ticks.push(e.tick)
        index[e.player].teams.push(e.team)
      }
    }
    teamIndex.set(x, index)
  }
  const entry = index[p]
  if (!entry || entry.ticks.length === 0) return undefined
  let lo = 0, hi = entry.ticks.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (entry.ticks[mid] <= tick) lo = mid + 1
    else hi = mid
  }
  return entry.teams[Math.max(0, lo - 1)] // before the first event: the first known team
}

function condEdges(x: HighlanderExtras, bit: number): Row[] {
  const rows: Row[] = []
  const flags = x.derived.flags
  const cond = x.players.cond
  risingEdges(cond, i => (flags[i] & bit) !== 0, (p, i) => rows.push({ tick: cond.ticks[i], player: p }))
  return rows
}

function cloakRows(x: HighlanderExtras, falling: boolean): Row[] {
  const rows: Row[] = []
  const flags = x.derived.flags
  const cond = x.players.cond
  for (let p = 0; p < keyCountOf(cond); p++) {
    let cloaked = false
    let feignOnset = false
    for (let i = cond.offsets[p]; i < cond.offsets[p + 1]; i++) {
      const now = (flags[i] & HL.CLOAKED) !== 0
      if (now && !cloaked) {
        feignOnset = (flags[i] & HL.FEIGN) !== 0
        if (!falling) rows.push({ tick: cond.ticks[i], player: p, ...(feignOnset ? { note: 'feign' } : {}) })
      } else if (!now && cloaked && falling) {
        rows.push({ tick: cond.ticks[i], player: p, ...(feignOnset ? { note: 'feign' } : {}) })
      }
      cloaked = now
    }
  }
  return rows
}

/** Pickup kind (0 health, 1 ammo) of an item_pickup item name (entity_healthkit.h, entity_ammopack.h), -1 other. */
const pickupEventKind = (item: string | undefined) =>
  !item ? -1 : item.startsWith('medkit_') || item === 'healthammokit' ? 0 : item.startsWith('ammopack_') ? 1 : -1

/**
 * `pickupTaken` rows (section 3.8, refined by P2).
 * - A map kit is taken when it leaves the snapshot: a `pickups.vis` falling edge. Two falling edges are not takes:
 *   the vis 0 entry a kit gets at its deletion tick when a round restart deletes it (10 rows at 240 on 1434434), and
 *   a leave without a return while the instance lives on past the respawn estimate (ITEM_RESPAWN_SECONDS plus the
 *   slack): that kit left for good (two koth_product kits at the restart of 1438891), and F6 draws it as stale.
 * - A thrown or dropped item never leaves the snapshot, because TF2 removes it on pickup (it has SF_NORESPAWN). It
 *   is taken at its deletion when an item_pickup event of its kind falls on that tick (`note: 'thrown'`); its other
 *   deletions are the 30 s lifetime, a new throw of the same lunchbox and the round restart.
 * - `player` is the taker: the player of the one item_pickup event of the take's tick and kind. Rows without exactly
 *   one such event have none (a disguised spy at full health takes a medkit without an event, entity_healthkit.cpp).
 */
function pickupTakes(x: HighlanderExtras): Row[] {
  const p = x.pickups
  const v = p.vis
  const ipt = x.meta.intervalPerTick || 0.015
  const staleAfter = Math.round(ITEM_RESPAWN_SECONDS / ipt) + Math.round(ITEM_RESPAWN_SLACK_SECONDS / ipt)
  const events = new Map<number, { kind: number; player: number }[]>()
  for (const e of eventsOf(x, 'pickup')) {
    const kind = pickupEventKind(e.item)
    if (kind < 0) continue
    let list = events.get(e.tick)
    if (!list) events.set(e.tick, (list = []))
    list.push({ kind, player: e.player })
  }
  const taker = (tick: number, kind: number): { found: boolean; player?: number } => {
    const list = events.get(tick)?.filter(e => e.kind === kind)
    if (!list || list.length === 0) return { found: false }
    return { found: true, player: list.length === 1 ? player(list[0].player) : undefined }
  }
  const rows: Row[] = []
  for (let j = 0; j < p.count; j++) {
    const kind = p.kind[j] === 1 ? 1 : 0
    const deleted = p.deleted[j]
    const end = deleted === NONE_U32 ? x.meta.ticks : deleted
    let left = false
    for (let i = v.offsets[j] + 1; i < v.offsets[j + 1]; i++) {
      if (v.v[i] !== 0 || v.v[i - 1] === 0) continue
      left = true
      const tick = v.ticks[i]
      if (tick === deleted) continue // deleted (round restart), not taken
      if (i + 1 === v.offsets[j + 1] && end > tick + staleAfter) continue // left for good
      rows.push({ tick, instance: j, player: taker(tick, kind).player })
    }
    if (!left && deleted !== NONE_U32) {
      const t = taker(deleted, kind)
      if (t.found) rows.push({ tick: deleted, instance: j, player: t.player, note: 'thrown' })
    }
  }
  return rows
}

function busiestRows(x: HighlanderExtras, opts: FindOptions, limit: number): Row[] {
  const hurts = x.hurts
  const ticks = x.meta.ticks
  if (ticks <= 0) return []
  const counts = new Uint32Array(ticks + 1)
  for (let i = 0; i < hurts.tick.length; i++) {
    if (opts.player !== undefined && hurts.victim[i] !== opts.player && hurts.attacker[i] !== opts.player) continue
    const t = hurts.tick[i]
    if (t < ticks) counts[t + 1]++
  }
  for (let t = 0; t < ticks; t++) counts[t + 1] += counts[t] // prefix sums
  const windowCount = (s: number) => counts[Math.min(ticks, s + BUSIEST_WINDOW)] - counts[s]
  const picked: { tick: number; count: number }[] = []
  const lastStart = Math.max(0, ticks - BUSIEST_WINDOW)
  const blocked = new Uint8Array(lastStart + 1) // starts whose window would overlap a picked one
  while (picked.length < limit) {
    let best = -1, bestCount = 0
    for (let s = 0; s <= lastStart; s++) {
      if (blocked[s]) continue
      const c = windowCount(s)
      if (c > bestCount) {
        best = s
        bestCount = c
      }
    }
    if (best < 0) break
    picked.push({ tick: best, count: bestCount })
    blocked.fill(1, Math.max(0, best - BUSIEST_WINDOW + 1), Math.min(lastStart + 1, best + BUSIEST_WINDOW))
  }
  return picked.map(w => ({ tick: w.tick, note: `${w.count} hurts` }))
}

function rowsFor(x: HighlanderExtras, kind: FindKind, opts: FindOptions, limit: number): Row[] {
  const hlBit = HL_EDGE_KINDS[kind]
  if (hlBit !== undefined) return condEdges(x, hlBit)

  const uberType = UBER_KINDS[kind]
  if (uberType !== undefined) {
    return eventsOf(x, 'uberDeployed')
      .filter(e => (medigunAt(x, e.medic, e.tick)?.type ?? 'medigun') === uberType)
      .map(e => ({ tick: e.tick, player: player(e.medic), note: player(e.target) !== undefined ? `target ${e.target}` : undefined }))
  }

  if (kind.startsWith('proj:')) {
    const k = Number(kind.slice(5))
    const pj = x.projectiles
    const rows: Row[] = []
    if (!Number.isInteger(k)) return rows
    for (let j = 0; j < pj.count; j++) {
      if (pj.kind[j] === k) rows.push({ tick: pj.created[j], instance: j, player: player(pj.owner[j]), team: pj.team[j] })
    }
    return rows
  }

  switch (kind) {
    case 'cloak':
      return cloakRows(x, false)
    case 'decloak':
      return cloakRows(x, true)
    case 'gas': {
      const rows: Row[] = []
      const c = x.players.cond
      risingEdges(c, i => condSet(c.w0[i], c.w1[i], c.w2[i], c.w3[i], c.w4[i], COND.GAS), (p, i) => rows.push({ tick: c.ticks[i], player: p }))
      return rows
    }
    case 'feign':
      return eventsOf(x, 'kill').filter(e => e.feign).map(e => ({ tick: e.tick, player: player(e.victim), note: e.weapon }))
    case 'backstab':
    case 'headshot': {
      const custom = kind === 'backstab' ? 2 : 1
      return eventsOf(x, 'kill')
        .filter(e => !e.feign && e.customKill === custom)
        .map(e => ({ tick: e.tick, player: player(e.attacker), note: `victim ${e.victim}` }))
    }
    case 'banner':
      return eventsOf(x, 'banner').map(e => ({ tick: e.tick, player: player(e.owner), note: `buff ${e.buffType}` }))
    case 'busiest':
      return busiestRows(x, opts, limit)
    case 'airblast': {
      const rows: Row[] = []
      const w = x.players.wstate
      const weapon = x.players.weapon
      for (let p = 0; p < keyCountOf(w); p++) {
        let prev = -1
        for (let i = w.offsets[p]; i < w.offsets[p + 1]; i++) {
          const state = w.state[i]
          if (state === 3 && prev !== 3) {
            const tick = w.ticks[i]
            // m_iWeaponState 3 is the flamethrower's airblast and the minigun's spin: keep flamethrowers only
            let lo = weapon.offsets[p], hi = weapon.offsets[p + 1]
            while (lo < hi) {
              const mid = (lo + hi) >>> 1
              if (weapon.ticks[mid] <= tick) lo = mid + 1
              else hi = mid
            }
            const wi = lo - 1
            if (wi >= weapon.offsets[p] && itemKind(weapon.def[wi]) === 'flamethrower') rows.push({ tick, player: p })
          }
          prev = state
        }
      }
      return rows
    }
    case 'flamesOn': {
      const rows: Row[] = []
      const f = x.flames
      risingEdges(f.box, i => f.box.firing[i] !== 0, (j, i) => rows.push({ tick: f.box.ticks[i], instance: j, player: player(f.owner[j]) }))
      return rows
    }
    case 'deflect':
      return eventsOf(x, 'deflect').map(e => ({
        tick: e.tick,
        player: player(e.pyro),
        instance: e.projectile >= 0 ? e.projectile : undefined,
        note: e.projectile >= 0 ? 'projectile' : 'player',
      }))
    case 'buildStart':
    case 'buildDone':
    case 'upgrade':
    case 'carry':
    case 'redeploy':
      return eventsOf(x, kind).map(e => ({
        tick: e.tick,
        player: player(e.builder),
        instance: e.building >= 0 ? e.building : undefined,
        team: e.building >= 0 ? x.buildings.team[e.building] : undefined,
      }))
    case 'sapped':
      return eventsOf(x, 'sapped').map(e => ({ tick: e.tick, player: player(e.spy), instance: e.building >= 0 ? e.building : undefined, note: `owner ${e.owner}` }))
    case 'destroyed':
      return eventsOf(x, 'destroyed').map(e => ({
        tick: e.tick,
        player: player(e.owner),
        instance: e.building >= 0 ? e.building : undefined,
        team: e.building >= 0 ? x.buildings.team[e.building] : undefined,
        note: `attacker ${e.attacker}`,
      }))
    case 'teleported':
      return eventsOf(x, 'teleported').map(e => ({ tick: e.tick, player: player(e.player), note: `builder ${e.builder}` }))
    case 'wrangled': {
      const rows: Row[] = []
      const b = x.buildings
      risingEdges(b.state, i => (b.state.flags[i] & BLD.WRANGLED) !== 0, (j, i) =>
        rows.push({ tick: b.state.ticks[i], instance: j, player: player(b.builder[j]), team: b.team[j] })
      )
      return rows
    }
    case 'syringe': {
      const cp = x.tempents.clientProjectiles
      const rows: Row[] = []
      for (let i = 0; i < cp.tick.length; i++) if (cp.kind[i] === 21) rows.push({ tick: cp.tick[i], player: player(cp.player[i]) })
      return rows
    }
    case 'explosion': {
      const ex = x.tempents.explosions
      return Array.from(ex.tick, (tick, i) => ({ tick, note: `weapon ${ex.weaponId[i]}` }))
    }
    case 'tracer': {
      const tr = x.tempents.tracers
      return Array.from(tr.tick, (tick, i) => {
        const j = tr.sentry[i]
        return { tick, instance: j !== NONE_U16 ? j : undefined, team: j !== NONE_U16 ? x.buildings.team[j] : undefined }
      })
    }
    case 'bullet':
    case 'critBullet': {
      const b = x.tempents.bullets
      const rows: Row[] = []
      for (let i = 0; i < b.tick.length; i++) {
        if (kind === 'critBullet' && !b.crit[i]) continue
        rows.push({ tick: b.tick[i], player: player(b.player[i]), note: `weapon ${b.weaponId[i]}` })
      }
      return rows
    }
    case 'capStart':
      return eventsOf(x, 'capStart').map(e => ({ tick: e.tick, instance: e.cp, player: player(e.cappers[0] ?? -1), players: e.cappers, team: e.capTeam, note: e.cpName }))
    case 'captured':
      return eventsOf(x, 'captured').map(e => ({ tick: e.tick, instance: e.cp, player: player(e.cappers[0] ?? -1), players: e.cappers, team: e.team, note: e.cpName }))
    case 'capBlocked':
      return eventsOf(x, 'capBlocked').map(e => ({ tick: e.tick, instance: e.cp, player: player(e.blocker), note: e.cpName }))
    case 'capBroken':
      return eventsOf(x, 'capBroken').map(e => ({ tick: e.tick, instance: e.cp, note: e.cpName }))
    case 'capping': {
      // crossings of the simulated progress from at most one half to above one half
      const rows: Row[] = []
      const pr = x.objectives.cp.progress
      const st = x.objectives.cp.state
      risingEdges(pr, i => pr.p[i] > PROGRESS_HALF, (point, i) => {
        const tick = pr.ticks[i]
        let lo = st.offsets[point], hi = st.offsets[point + 1]
        while (lo < hi) {
          const mid = (lo + hi) >>> 1
          if (st.ticks[mid] <= tick) lo = mid + 1
          else hi = mid
        }
        const si = lo - 1
        const team = si >= st.offsets[point] ? st.capping[si] : undefined
        rows.push({ tick, instance: point, team })
      })
      return rows
    }
    case 'cartMoving':
    case 'cartReceding': {
      const rows: Row[] = []
      const w = x.objectives.watchers.state
      const sign = kind === 'cartMoving' ? 1 : -1
      risingEdges(w, i => Math.sign(w.speed[i]) === sign, (j, i) => rows.push({ tick: w.ticks[i], instance: j, note: `speed ${w.speed[i]}` }))
      return rows
    }
    case 'overtime':
      return eventsOf(x, 'overtimeStart').map(e => ({ tick: e.tick }))
    case 'roundWin':
      return eventsOf(x, 'roundWin').map(e => ({ tick: e.tick, team: e.team, note: `team ${e.team} reason ${e.winReason}` }))
    case 'roundStart':
      return eventsOf(x, 'roundStart').map(e => ({ tick: e.tick, note: e.fullReset ? 'full reset' : undefined }))
    case 'setupFinished':
      return eventsOf(x, 'setupFinished').map(e => ({ tick: e.tick }))
    case 'doorMove': {
      const rows: Row[] = []
      const m = x.movers
      for (let j = 0; j < m.count; j++) {
        if (m.cls[j] !== 0) continue
        for (let i = m.xform.offsets[j] + 1; i < m.xform.offsets[j + 1]; i++) {
          if (m.xform.ticks[i] - m.xform.ticks[i - 1] >= DOOR_REST_TICKS) rows.push({ tick: m.xform.ticks[i], instance: j })
        }
      }
      return rows
    }
    case 'pickupTaken':
      return pickupTakes(x)
    case 'pickupBack': {
      const rows: Row[] = []
      const v = x.pickups.vis
      for (let j = 0; j < keyCountOf(v); j++) {
        for (let i = v.offsets[j] + 1; i < v.offsets[j + 1]; i++) {
          if (v.v[i] === 1 && v.v[i - 1] !== 1) rows.push({ tick: v.ticks[i], instance: j })
        }
      }
      return rows
    }
    case 'medicDrop':
      return eventsOf(x, 'medicDeath').filter(e => e.charged).map(e => ({ tick: e.tick, player: player(e.medic), note: `attacker ${e.attacker}` }))
    case 'respawnWave': {
      const rows: Row[] = []
      const r = x.objectives.rules
      const same = (a: number, b: number) => a === b || (Number.isNaN(a) && Number.isNaN(b))
      for (let i = r.offsets[0]; i < (r.offsets[1] ?? 0); i++) {
        const first = i === r.offsets[0]
        if (!Number.isNaN(r.waveRed[i]) && (first || !same(r.waveRed[i], r.waveRed[i - 1]))) rows.push({ tick: r.ticks[i], team: 2, note: 'red' })
        if (!Number.isNaN(r.waveBlu[i]) && (first || !same(r.waveBlu[i], r.waveBlu[i - 1]))) rows.push({ tick: r.ticks[i], team: 3, note: 'blu' })
      }
      return rows
    }
    case 'medicCall': {
      const rows: Row[] = []
      for (let p = 0; p < x.players.count; p++) for (const tick of medicCallTicks(x, p)) rows.push({ tick, player: p })
      return rows
    }
    default:
      return []
  }
}

/** Cache ticks sorted ascending, `limit` default 20 (section 3.8). Unknown kinds return []. */
export function findTicks(
  x: HighlanderExtras,
  kind: FindKind,
  opts?: { limit?: number; player?: number; team?: number }
): { tick: number; player?: number; instance?: number; note?: string }[] {
  const options: FindOptions = opts ?? {}
  const limit = Math.max(0, Math.floor(options.limit ?? 20))
  if (!x || limit === 0) return []

  let rows = rowsFor(x, kind, options, limit)
  if (options.player !== undefined && kind !== 'busiest') {
    const p = options.player
    rows = rows.filter(r => r.player === p || (r.players?.includes(p) ?? false))
  }
  if (options.team !== undefined) {
    const team = options.team
    rows = rows.filter(r => {
      const t = r.team ?? (r.player !== undefined ? playerTeamAt(x, r.player, r.tick) : undefined)
      return t === team
    })
  }
  rows.sort((a, b) => a.tick - b.tick || (a.player ?? -1) - (b.player ?? -1) || (a.instance ?? -1) - (b.instance ?? -1))

  return rows.slice(0, limit).map(r => {
    const out: FoundTick = { tick: r.tick }
    if (r.player !== undefined) out.player = r.player
    if (r.instance !== undefined) out.instance = r.instance
    if (r.note !== undefined) out.note = r.note
    return out
  })
}
