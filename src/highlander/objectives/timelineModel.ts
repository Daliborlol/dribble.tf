// Timeline markers (contract section 5 F5): medic, objective, spy and engineer moments on the playback slider,
// and the `[` / `]` marker jumps. Marker ticks are playback ticks (cache tick + 2). Built once per
// (demo, extras); the enabled categories filter at read time.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { getDurationFromTicks } from '@utils/parser'
import { findTicks } from '@highlander/extras/findTicks'
import { medigunAt } from '@highlander/extras/getters'
import { BUILDING_TYPE } from '@highlander/extras/enums'
import type { HighlanderExtras } from '@highlander/extras/types'

import { deathIndex } from './deaths'
import { prettyPointName } from './format'
import { teamOfAt } from './scoreboardModel'
import { eventsOf, teamNameAt } from './stopwatch'

/** Playback tick = cache tick + 2 (DemoViewer INTERP_DELAY_TICKS). */
export const PLAYBACK_OFFSET = 2

export type TimelineCategory = 'medic' | 'objective' | 'spy' | 'engineer'
export type MarkerShape =
  | 'uber'
  | 'drop'
  | 'capture'
  | 'roundWin'
  | 'overtime'
  | 'setup'
  | 'backstab'
  | 'feign'
  | 'sapped'
  | 'decloak'
  | 'sentryBuilt'
  | 'sentryDestroyed'

export interface TimelineMarker {
  /** playback tick */
  tick: number
  category: TimelineCategory
  shape: MarkerShape
  team: number
  /** hover text: clock time and a short description */
  text: string
}

export interface TimelineCategories { medic: boolean; objective: boolean; spy: boolean; engineer: boolean }

const NONE_U8 = 255
const MEDIGUN_NAMES: Record<string, string> = { medigun: 'Uber', kritzkrieg: 'Kritz', quickfix: 'Quick-Fix', vaccinator: 'Vaccinator' }
const BUILDING_NAMES: Record<number, string> = { 0: 'Dispenser', 1: 'Teleporter', 2: 'Sentry', 3: 'Sapper' }

const cache = new WeakMap<AsyncParser, { x: HighlanderExtras; markers: TimelineMarker[] }>()

function nameOf(demo: AsyncParser, p: number): string {
  if (!(p >= 0) || p === NONE_U8) return 'world'
  return demo.entityPlayerMap.get(p)?.user.name ?? `#${p}`
}

/** Every marker of every category, sorted by tick. */
export function timelineMarkers(demo: AsyncParser, x: HighlanderExtras): TimelineMarker[] {
  const cached = cache.get(demo)
  if (cached && cached.x === x) return cached.markers

  const rate = x.meta.intervalPerTick > 0 ? 1 / x.meta.intervalPerTick : 66.67
  const out: TimelineMarker[] = []
  const add = (cacheTick: number, category: TimelineCategory, shape: MarkerShape, team: number, what: string) => {
    const tick = cacheTick + PLAYBACK_OFFSET
    out.push({ tick, category, shape, team, text: `${getDurationFromTicks(tick, rate).formatted}  ${what}` })
  }

  // medic
  for (const e of eventsOf(x, 'uberDeployed')) {
    const type = medigunAt(x, e.medic, e.tick)?.type ?? 'medigun'
    const team = teamOfAt(demo, e.medic, e.tick)
    const target = e.target >= 0 && e.target !== NONE_U8 ? ` on ${nameOf(demo, e.target)}` : ''
    add(e.tick, 'medic', 'uber', team, `${MEDIGUN_NAMES[type] ?? 'Uber'}: ${nameOf(demo, e.medic)}${target}`)
  }
  for (const e of eventsOf(x, 'medicDeath')) {
    if (!e.charged) continue
    add(e.tick, 'medic', 'drop', teamOfAt(demo, e.medic, e.tick), `Medic drop: ${nameOf(demo, e.medic)} (killed by ${nameOf(demo, e.attacker)})`)
  }

  // objective
  for (const e of eventsOf(x, 'captured')) {
    add(e.tick, 'objective', 'capture', e.team, `${teamNameAt(x, e.team, e.tick)} captured ${prettyPointName(e.cpName, e.cp)}`)
  }
  for (const e of eventsOf(x, 'roundWin')) {
    const team = e.team === 2 || e.team === 3 ? e.team : 0
    add(e.tick, 'objective', 'roundWin', team, team ? `${teamNameAt(x, team, e.tick)} wins the round` : 'Stalemate')
  }
  for (const e of eventsOf(x, 'overtimeStart')) add(e.tick, 'objective', 'overtime', 0, 'Overtime')
  for (const e of eventsOf(x, 'setupFinished')) add(e.tick, 'objective', 'setup', 0, 'Setup finished')

  // spy
  for (const row of deathIndex(demo, x).rows) {
    if (row.feign) {
      add(row.tick, 'spy', 'feign', teamOfAt(demo, row.victim, row.tick), `Dead Ringer: ${row.death.victim.user.name}`)
    } else if (row.kill?.customKill === 2) {
      add(row.tick, 'spy', 'backstab', teamOfAt(demo, row.killer, row.tick), `Backstab: ${row.death.killer?.user.name ?? '?'} on ${row.death.victim.user.name}`)
    }
  }
  for (const e of eventsOf(x, 'sapped')) {
    add(e.tick, 'spy', 'sapped', teamOfAt(demo, e.spy, e.tick), `Sapper: ${nameOf(demo, e.spy)} on ${nameOf(demo, e.owner)}'s ${BUILDING_NAMES[e.type] ?? 'building'}`)
  }
  for (const r of findTicks(x, 'decloak', { limit: 1e6 })) {
    if (r.player === undefined) continue
    add(r.tick, 'spy', 'decloak', teamOfAt(demo, r.player, r.tick), `Decloak${r.note === 'feign' ? ' (Dead Ringer)' : ''}: ${nameOf(demo, r.player)}`)
  }

  // engineer
  for (const e of eventsOf(x, 'buildDone')) {
    if (e.type !== BUILDING_TYPE.SENTRY) continue
    add(e.tick, 'engineer', 'sentryBuilt', teamOfAt(demo, e.builder, e.tick), `Sentry built: ${nameOf(demo, e.builder)}`)
  }
  for (const e of eventsOf(x, 'destroyed')) {
    if (e.type !== BUILDING_TYPE.SENTRY) continue
    const team = e.building >= 0 ? x.buildings.team[e.building] : teamOfAt(demo, e.owner, e.tick)
    add(e.tick, 'engineer', 'sentryDestroyed', team, `Sentry destroyed: ${nameOf(demo, e.owner)}'s, by ${nameOf(demo, e.attacker)}`)
  }

  out.sort((a, b) => a.tick - b.tick)
  cache.set(demo, { x, markers: out })
  return out
}

export function enabledTimelineMarkers(demo: AsyncParser, x: HighlanderExtras, categories: TimelineCategories): TimelineMarker[] {
  return timelineMarkers(demo, x).filter(m => categories[m.category])
}

/** Team colour key of a marker ('' for neutral). */
export const markerTeamKey = (team: number) => (team === 2 ? 'red' : team === 3 ? 'blue' : '')
