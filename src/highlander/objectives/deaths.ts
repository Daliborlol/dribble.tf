// Base deaths joined with the extras `kill` events (contract section 5 F5): the killfeed, the scoreboard, the
// match feed and the timeline all read deaths through this index, so a Dead Ringer feign is recognised the same
// way everywhere. A base death and a kill event match when the victim entity is the same and the ticks differ by
// at most 1. Built once per (demo, extras) pair.

import type { AsyncParser, CachedDeath } from '@components/Analyse/Data/AsyncParser'
import type { PlayerRef } from '@components/Analyse/Data/Types'
import type { HighlanderExtras } from '@highlander/extras/types'

import { eventsOf, type EventOf } from './stopwatch'

export type KillEvent = EventOf<'kill'>

export interface DeathRow {
  death: CachedDeath
  tick: number
  victim: number // player index, -1 unknown
  killer: number // -1 none or unknown
  assister: number
  victimEntity: number
  killerEntity: number // 0 none
  /** no killer, or the killer is the victim */
  suicide: boolean
  /** Dead Ringer fake death (extras kill event with `feign`) */
  feign: boolean
  kill: KillEvent | null
}

export interface DeathIndex {
  rows: DeathRow[]
  ticks: number[]
  feigns: number
  matched: number
  extrasKills: number
}

const NONE_U8 = 255

interface PlayerLookup {
  bySteamEntity: Map<string, number>
  bySteam: Map<string, number>
}

const lookupCache = new WeakMap<AsyncParser, PlayerLookup>()

function lookupOf(demo: AsyncParser): PlayerLookup {
  let lookup = lookupCache.get(demo)
  if (!lookup) {
    lookup = { bySteamEntity: new Map(), bySteam: new Map() }
    for (const [p, ref] of demo.entityPlayerMap) {
      const key = `${ref.user.steamId}:${ref.user.entityId}`
      if (!lookup.bySteamEntity.has(key)) lookup.bySteamEntity.set(key, p)
      if (!lookup.bySteam.has(ref.user.steamId)) lookup.bySteam.set(ref.user.steamId, p)
    }
    lookupCache.set(demo, lookup)
  }
  return lookup
}

/** Player index of a base PlayerRef: by steam id and entity, then steam id, then entity id; -1 unknown. */
export function playerOfRef(demo: AsyncParser, ref: PlayerRef | null | undefined): number {
  if (!ref?.user) return -1
  const lookup = lookupOf(demo)
  const { steamId, entityId } = ref.user
  return lookup.bySteamEntity.get(`${steamId}:${entityId}`) ?? lookup.bySteam.get(steamId) ?? demo.playerIndexOfEntity(entityId)
}

const cache = new WeakMap<AsyncParser, { x: HighlanderExtras | undefined; index: DeathIndex }>()

export function deathIndex(demo: AsyncParser, x?: HighlanderExtras): DeathIndex {
  const cached = cache.get(demo)
  if (cached && cached.x === x) return cached.index

  const deaths: CachedDeath[] = []
  for (const key in demo.deaths) for (const death of demo.deaths[key]) deaths.push(death)
  deaths.sort((a, b) => a.tick - b.tick)

  // extras kill events grouped by victim entity
  const kills = x ? eventsOf(x, 'kill') : []
  const byVictim = new Map<number, { ev: KillEvent; used: boolean }[]>()
  if (x) {
    for (const ev of kills) {
      const entity = ev.victim >= 0 && ev.victim !== NONE_U8 ? x.players.entityId[ev.victim] : undefined
      if (!entity) continue
      let list = byVictim.get(entity)
      if (!list) byVictim.set(entity, (list = []))
      list.push({ ev, used: false })
    }
  }

  let feigns = 0
  let matched = 0
  const rows: DeathRow[] = deaths.map(death => {
    const victimEntity = death.victim?.user?.entityId ?? 0
    let kill: KillEvent | null = null
    const candidates = byVictim.get(victimEntity)
    if (candidates) {
      let best = -1
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]
        if (c.used) continue
        const d = Math.abs(c.ev.tick - death.tick)
        if (d <= 1 && (best < 0 || d < Math.abs(candidates[best].ev.tick - death.tick))) best = i
      }
      if (best >= 0) {
        candidates[best].used = true
        kill = candidates[best].ev
        matched++
      }
    }
    const victim = playerOfRef(demo, death.victim)
    const killer = playerOfRef(demo, death.killer)
    const killerEntity = death.killer?.user?.entityId ?? 0
    const feign = !!kill?.feign
    if (feign) feigns++
    return {
      death,
      tick: death.tick,
      victim,
      killer,
      assister: playerOfRef(demo, death.assister),
      victimEntity,
      killerEntity,
      suicide: !death.killer || killerEntity === victimEntity,
      feign,
      kill,
    }
  })

  const index: DeathIndex = { rows, ticks: rows.map(r => r.tick), feigns, matched, extrasKills: kills.length }
  cache.set(demo, { x, index })
  return index
}

/** First index i with ticks[i] >= value. */
export function lowerBoundOf(ticks: ArrayLike<number>, value: number): number {
  let lo = 0, hi = ticks.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ticks[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Number of entries of a sorted tick list at or before `tick`. */
export function countAtOrBefore(ticks: ArrayLike<number>, tick: number): number {
  return lowerBoundOf(ticks, tick + 1)
}
