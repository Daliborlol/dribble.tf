// Tab scoreboard values at a tick (contract section 5 F5). Per-player tick lists are built once per
// (demo, extras); every count is a binary search, so the board is a value-at-tick lookup that seeks cleanly.
//
//   K   base deaths with that killer, minus feigns and suicides
//   A   kill events with that assister, not feign (base death assisters without extras)
//   D   base deaths of that victim, minus feigns
//   DMG scoring.damage when the player's local tables reached the demo, else resource.damage
//   HEAL scoring.heals, else resource.healing
//   UB  uberDeployed events of that medic (HL.UBER rising edges on medics when the demo has no such events)
//   BS / HS  kill events with customKill 2 / 1, not feign
//   CAP scoring.caps, else captured events listing the player
//   BLD destroyed events with that attacker
//   classes played: class icons in order of first play, from the base meta cache (64-tick resolution)
// Columns whose source has no data in this demo hide (section 3.9). The rows are the players connected at the tick;
// at the end of a demo, after everyone left the finished match, the players of the last tick that had any.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import type { CachedPlayer } from '@components/Analyse/Data/PlayerCache'
import { CLASS_ORDER_MAP } from '@constants/mappings'
import { hasLocalTables, scoringAt } from '@highlander/extras/getters'
import { HL } from '@highlander/extras/enums'
import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'

import { countAtOrBefore, deathIndex } from './deaths'
import { eventsOf } from './stopwatch'

const META_STEP = 64 // PlayerMetaCache resolution (sparse 6)

export interface ScoreIndex {
  kills: number[][]
  assists: number[][]
  deaths: number[][]
  ubers: number[][]
  backstabs: number[][]
  headshots: number[][]
  caps: number[][]
  destroyed: number[][]
  classes: { tick: number; cls: number }[][]
  /** per-team uber ticks (by the medic's team at the event), for the medic panel */
  teamUbers: Record<number, number[]>
  sources: {
    assists: 'events' | 'base'
    ubers: 'events' | 'cond' | 'none'
    killDetails: boolean
    caps: 'events' | 'none'
    destroyed: boolean
  }
}

const cache = new WeakMap<AsyncParser, { x: HighlanderExtras | undefined; index: ScoreIndex }>()

const NONE_U8 = 255
const valid = (p: number, n: number) => p >= 0 && p !== NONE_U8 && p < n

export function teamOfAt(demo: AsyncParser, p: number, tick: number): number {
  if (p < 0) return 0
  return demo.playerCache.metaCache.getMeta(p, Math.max(0, Math.min(tick, demo.ticks - 1))).teamId
}

export function scoreIndex(demo: AsyncParser, x?: HighlanderExtras): ScoreIndex {
  const cached = cache.get(demo)
  if (cached && cached.x === x) return cached.index

  const n = demo.nextMappedPlayer
  const lists = () => Array.from({ length: n }, () => [] as number[])
  const index: ScoreIndex = {
    kills: lists(),
    assists: lists(),
    deaths: lists(),
    ubers: lists(),
    backstabs: lists(),
    headshots: lists(),
    caps: lists(),
    destroyed: lists(),
    classes: Array.from({ length: n }, () => [] as { tick: number; cls: number }[]),
    teamUbers: { 2: [], 3: [] },
    sources: { assists: 'base', ubers: 'none', killDetails: false, caps: 'none', destroyed: false },
  }

  const deaths = deathIndex(demo, x)
  for (const row of deaths.rows) {
    if (row.feign) continue
    if (valid(row.victim, n)) index.deaths[row.victim].push(row.tick)
    if (!row.suicide && valid(row.killer, n)) index.kills[row.killer].push(row.tick)
    if (!x && valid(row.assister, n)) index.assists[row.assister].push(row.tick)
  }

  if (x) {
    const kills = eventsOf(x, 'kill')
    if (kills.length > 0) {
      index.sources.assists = 'events'
      index.sources.killDetails = true
      for (const e of kills) {
        if (e.feign) continue
        if (valid(e.assister, n)) index.assists[e.assister].push(e.tick)
        if (valid(e.attacker, n) && e.attacker !== e.victim) {
          if (e.customKill === 2) index.backstabs[e.attacker].push(e.tick)
          else if (e.customKill === 1) index.headshots[e.attacker].push(e.tick)
        }
      }
    } else {
      // kill events missing: fall back to base assisters
      for (const row of deaths.rows) if (!row.feign && valid(row.assister, n)) index.assists[row.assister].push(row.tick)
    }

    const ubers = eventsOf(x, 'uberDeployed')
    if (ubers.length > 0) {
      index.sources.ubers = 'events'
      for (const e of ubers) {
        if (!valid(e.medic, n)) continue
        index.ubers[e.medic].push(e.tick)
        const team = teamOfAt(demo, e.medic, e.tick)
        if (team === 2 || team === 3) index.teamUbers[team].push(e.tick)
      }
    } else if (x.meta.available.cond) {
      // old demos have no player_chargedeployed: rising edges of HL.UBER on a medic
      index.sources.ubers = 'cond'
      const c = x.players.cond
      const flags = x.derived.flags
      for (let p = 0; p < Math.min(n, c.offsets.length - 1); p++) {
        let prev = false
        for (let i = c.offsets[p]; i < c.offsets[p + 1]; i++) {
          const now = (flags[i] & HL.UBER) !== 0
          if (now && !prev) {
            const tick = c.ticks[i]
            const meta = demo.playerCache.metaCache.getMeta(p, Math.min(tick, demo.ticks - 1))
            if (meta.classId === 5) {
              index.ubers[p].push(tick)
              if (meta.teamId === 2 || meta.teamId === 3) index.teamUbers[meta.teamId].push(tick)
            }
          }
          prev = now
        }
      }
    }

    const captured = eventsOf(x, 'captured')
    if (captured.length > 0) {
      index.sources.caps = 'events'
      for (const e of captured) for (const p of e.cappers) if (valid(p, n)) index.caps[p].push(e.tick)
    }

    const destroyed = eventsOf(x, 'destroyed')
    if (destroyed.length > 0 || x.meta.available.buildings) {
      index.sources.destroyed = true
      for (const e of destroyed) if (valid(e.attacker, n) && e.attacker !== e.owner) index.destroyed[e.attacker].push(e.tick)
    }
  }

  // classes played, in order of first play
  for (let p = 0; p < n; p++) {
    if (!demo.entityPlayerMap.has(p)) continue
    const seen = new Set<number>()
    for (let t = 0; t < demo.ticks; t += META_STEP) {
      const cls = demo.playerCache.metaCache.getMeta(p, t).classId
      if (cls >= 1 && cls <= 9 && !seen.has(cls)) {
        seen.add(cls)
        index.classes[p].push({ tick: t, cls })
      }
    }
  }

  for (const team of [2, 3]) index.teamUbers[team].sort((a, b) => a - b)
  cache.set(demo, { x, index })
  return index
}

export interface ScoreRow {
  entityId: number
  p: number
  name: string
  classId: number
  alive: boolean
  kills: number
  assists: number
  deaths: number
  damage: number | null
  heals: number | null
  ubers: number
  backstabs: number
  headshots: number
  caps: number
  destroyed: number
  classes: number[]
}

export interface ScoreColumns {
  damage: boolean
  heals: boolean
  ubers: boolean
  backstabs: boolean
  headshots: boolean
  caps: boolean
  destroyed: boolean
}

export interface ScoreTeam { team: number; rows: ScoreRow[] }
export interface ScoreboardView {
  tick: number
  /** tick whose connected players the rows list: `tick`, or an earlier one at the end of a demo (rosterAt) */
  rosterTick: number
  columns: ScoreColumns
  teams: ScoreTeam[]
  sources: Record<string, string>
}

function resourceAt(x: HighlanderExtras, p: number, tick: number): { damage: number; healing: number } | null {
  const t = x.players.resource
  const i = trackIndexAt(t, p, tick)
  return i < 0 ? null : { damage: t.damage[i], healing: t.healing[i] }
}

const ROSTER_STEP = 33
const ROSTER_LOOKBACK = 66 * 300
let rosterMemo: { demo: AsyncParser; tick: number; rosterTick: number } | null = null

const connectedPlayersAt = (demo: AsyncParser, tick: number): CachedPlayer[] =>
  demo.getPlayersAtTick(tick).filter(p => p.connected && (p.teamId === 2 || p.teamId === 3))

/**
 * The connected RED/BLU players at the tick. Where nobody is (the last ticks of a demo, after the players left the
 * finished match), the fullest roster of the five minutes before: the latest tick with the most connected players,
 * so the board still lists everyone who finished the match.
 */
export function rosterAt(demo: AsyncParser, tick: number): { players: CachedPlayer[]; tick: number } {
  const players = connectedPlayersAt(demo, tick)
  if (players.length > 0) return { players, tick }
  if (rosterMemo && rosterMemo.demo === demo && rosterMemo.tick === tick) {
    return { players: connectedPlayersAt(demo, rosterMemo.rosterTick), tick: rosterMemo.rosterTick }
  }
  let found = tick
  let roster: CachedPlayer[] = []
  for (let t = tick - ROSTER_STEP; t >= Math.max(0, tick - ROSTER_LOOKBACK); t -= ROSTER_STEP) {
    const candidate = connectedPlayersAt(demo, t)
    if (candidate.length > roster.length) {
      roster = candidate
      found = t
    }
  }
  rosterMemo = { demo, tick, rosterTick: found }
  return { players: roster, tick: found }
}

/** Player stats at the tick for every connected RED/BLU player (rosterAt); BLU table first. */
export function scoreboardAt(demo: AsyncParser, x: HighlanderExtras | undefined, tick: number): ScoreboardView {
  const index = scoreIndex(demo, x)
  const scoringOk = !!x && x.meta.available.scoring
  const resourceOk = !!x && x.meta.available.resource
  const columns: ScoreColumns = {
    damage: scoringOk || resourceOk,
    heals: scoringOk || resourceOk,
    ubers: index.sources.ubers !== 'none',
    backstabs: index.sources.killDetails,
    headshots: index.sources.killDetails,
    caps: scoringOk || index.sources.caps !== 'none',
    destroyed: index.sources.destroyed,
  }

  const teams: ScoreTeam[] = [
    { team: 3, rows: [] },
    { team: 2, rows: [] },
  ]
  const at = (list: number[]) => countAtOrBefore(list, tick)
  const roster = rosterAt(demo, tick)
  for (const player of roster.players) {
    const p = demo.playerIndexOfEntity(player.user.entityId)
    if (p < 0) continue
    const scoring = x && scoringOk && hasLocalTables(x, p) ? scoringAt(x, p, tick) : null
    const resource = x && resourceOk ? resourceAt(x, p, tick) : null
    const row: ScoreRow = {
      entityId: player.user.entityId,
      p,
      name: player.user.name,
      classId: player.classId,
      // the end-of-demo roster (rosterAt) lists a finished match: nobody is shown as dead there
      alive: roster.tick !== tick || player.health > 0,
      kills: at(index.kills[p] ?? []),
      assists: at(index.assists[p] ?? []),
      deaths: at(index.deaths[p] ?? []),
      damage: scoring ? scoring.damage : resource ? resource.damage : null,
      heals: scoring ? scoring.heals : resource ? resource.healing : null,
      ubers: at(index.ubers[p] ?? []),
      backstabs: at(index.backstabs[p] ?? []),
      headshots: at(index.headshots[p] ?? []),
      caps: scoring ? scoring.caps : at(index.caps[p] ?? []),
      destroyed: at(index.destroyed[p] ?? []),
      classes: (index.classes[p] ?? []).filter(c => c.tick <= tick).map(c => c.cls),
    }
    if (row.classes.length === 0 && player.classId >= 1) row.classes.push(player.classId)
    teams[player.teamId === 3 ? 0 : 1].rows.push(row)
  }
  for (const t of teams) {
    t.rows.sort(
      (a, b) =>
        (CLASS_ORDER_MAP[a.classId] ?? 99) - (CLASS_ORDER_MAP[b.classId] ?? 99) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    )
  }
  return {
    tick,
    rosterTick: roster.tick,
    columns,
    teams,
    sources: {
      damage: scoringOk ? 'scoring' : resourceOk ? 'resource' : 'none',
      assists: index.sources.assists,
      ubers: index.sources.ubers,
      caps: scoringOk ? 'scoring' : index.sources.caps,
    },
  }
}

/** K / A / D of one player at the tick, for the player-list tooltip. */
export function kadAt(demo: AsyncParser, x: HighlanderExtras | undefined, p: number, tick: number): { kills: number; assists: number; deaths: number } {
  const index = scoreIndex(demo, x)
  return {
    kills: countAtOrBefore(index.kills[p] ?? [], tick),
    assists: countAtOrBefore(index.assists[p] ?? [], tick),
    deaths: countAtOrBefore(index.deaths[p] ?? [], tick),
  }
}
