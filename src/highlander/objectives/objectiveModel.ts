// Objective HUD values at a tick (contract section 5 F5): mode, round timer, KOTH clocks, payload bar, control
// point icons, tug of war bars, the stopwatch line and the team header. A pure function of the extras, the
// map-meta and the tick; the HUD snapshot calls it once per hudTick and the `objective.hud` probe calls it
// directly.

import { capProgressAt, rulesAt, teamAt, timerSecondsAt } from '@highlander/extras/getters'
import { CPF, ROUND_STATE, RULES, STOPWATCH_STATE, TEAM_ROLE, TIMER } from '@highlander/extras/enums'
import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras, Instances } from '@highlander/extras/types'
import type { MapMeta, MapMetaControlPoint } from '@highlander/map/mapMeta'

import { formatClock } from './format'
import {
  BLU,
  gamesWonAt,
  RED,
  stopwatchGameAt,
  stopwatchHalfAt,
  stopwatchIndex,
  stopwatchLineAt,
  teamNameAt,
} from './stopwatch'

export type ObjectiveMode = 'koth' | 'payload' | 'cp' | 'tow' | 'none'

/**
 * The map-meta gameMode wins; without map-meta: KOTH from objectives.koth, tug of war from pd entries (checked
 * before watchers, because tow_tetsudo also has a train watcher), payload from watchers, control points from
 * cp.count.
 */
export function objectiveModeOf(x: HighlanderExtras, meta: MapMeta | null | undefined): ObjectiveMode {
  switch (meta?.gameMode) {
    case 'koth':
      return 'koth'
    case 'payload':
    case 'payload-race':
      return 'payload'
    case 'tug-of-war':
      return 'tow'
    case 'attack-defend':
    case 'control-points':
      return 'cp'
  }
  if (x.objectives.koth) return 'koth'
  if (x.meta.available.pd) return 'tow'
  if (x.meta.available.watchers) return 'payload'
  if (x.objectives.cp.count > 0) return 'cp'
  return 'none'
}

const NONE_U32 = 0xffffffff

/** The newest instance of the group alive at the tick (created <= tick < deleted), or -1. */
export function aliveInstanceAt(inst: Instances, tick: number, candidates?: ArrayLike<number>): number {
  let best = -1
  const n = candidates ? candidates.length : inst.count
  for (let c = 0; c < n; c++) {
    const j = candidates ? candidates[c] : c
    if (!(j >= 0 && j < inst.count)) continue
    const created = inst.created[j]
    const deleted = inst.deleted[j]
    if (created > tick || (deleted !== NONE_U32 && deleted <= tick)) continue
    if (best < 0 || created >= inst.created[best]) best = j
  }
  return best
}

export interface ClockView { seconds: number; text: string; running: boolean }
export interface TimerView { seconds: number; text: string; setup: boolean }
export interface PointView {
  index: number
  owner: number
  capping: number
  /** 0..1 toward `capping` */
  progress: number
  /** players of the capping team in the zone */
  cappers: number
  locked: boolean
  /** seconds until the point unlocks, null when not counting down */
  unlockIn: number | null
  blocked: boolean
  name: string
}
export interface PayloadView {
  attackTeam: number
  /** 0..1 */
  progress: number
  checkpoints: { at: number; owner: number; index: number }[]
  /** capture value on the cart, -1 blocked */
  cappers: number
  /** -1 rolling back, 0 stopped, 1..3 push speed */
  speed: number
  /** seconds until the cart rolls back, only below 5 s */
  recedeIn: number | null
}
export interface TowView {
  red: number
  blu: number
  max: number
  /** cart position, 0 at the BLU end, 1 at the RED end; null without a watcher */
  progress: number | null
  speed: number
  cappers: number
}
export interface HeaderSide { team: number; name: string; value: number }
export interface HeaderView {
  blu: HeaderSide
  red: HeaderSide
  /** "Game N, half H" in stopwatch; otherwise null (the HUD shows the timer there) */
  center: string | null
  stopwatch: boolean
}
export interface StopwatchView {
  line: string | null
  game: number
  half: 1 | 2
  overtime: boolean
  rule: string
}
export interface ObjectiveView {
  tick: number
  mode: ObjectiveMode
  timer: TimerView | null
  overtime: boolean
  /** OVERTIME flashes every 33 ticks */
  overtimeOn: boolean
  koth: { blu: ClockView | null; red: ClockView | null; point: PointView | null } | null
  payload: PayloadView | null
  points: PointView[] | null
  tow: TowView | null
  stopwatch: StopwatchView | null
  header: HeaderView
  attackTeam: number
}

function timerViewAt(x: HighlanderExtras, timer: number, inSetup: boolean, tick: number): TimerView | null {
  if (!(timer >= 0)) return null
  const s = x.objectives.timers.state
  const k = trackIndexAt(s, timer, tick)
  if (k < 0 || (s.flags[k] & TIMER.DISABLED) !== 0) return null
  const seconds = timerSecondsAt(x, timer, tick)
  const setup = inSetup || s.mode[k] === 0
  return { seconds, setup, text: setup ? `SETUP ${formatClock(seconds)}` : formatClock(seconds) }
}

function clockAt(x: HighlanderExtras, timer: number, tick: number): ClockView | null {
  if (!(timer >= 0)) return null
  const s = x.objectives.timers.state
  const k = trackIndexAt(s, timer, tick)
  if (k < 0) return null
  const seconds = timerSecondsAt(x, timer, tick)
  return { seconds, text: formatClock(seconds), running: s.paused[k] === 0 }
}

export interface MetaPointMap {
  /** map-meta control point of each demo point index (null when unmatched) */
  byDemo: (MapMetaControlPoint | null)[]
  /** demo point index of each map-meta control point name */
  byName: Map<string, number>
}

const pointMapCache = new WeakMap<HighlanderExtras, { meta: MapMeta | null | undefined; map: MetaPointMap }>()
const MATCH_RADIUS = 256

/**
 * Pairs the demo's control points with the map-meta ones. The indices differ between the two (steel and upward
 * number their points from 1 in the BSP, the objective resource from 0), so points are matched by position:
 * cp.pos (m_vCPPositions) against the map-meta origin, nearest within 256 units. Without networked positions
 * the map-meta points are taken in index order.
 */
export function metaPointMap(x: HighlanderExtras, meta: MapMeta | null | undefined): MetaPointMap {
  const cached = pointMapCache.get(x)
  if (cached && cached.meta === meta) return cached.map
  const cp = x.objectives.cp
  const o = x.derived.sceneOrigin
  const points = meta?.controlPoints ?? []
  const byDemo: (MapMetaControlPoint | null)[] = Array.from({ length: cp.count }, () => null)
  const used = new Set<number>()
  let positioned = 0
  for (let i = 0; i < cp.count; i++) {
    const px = cp.pos[i * 3] + o.x, py = cp.pos[i * 3 + 1] + o.y, pz = cp.pos[i * 3 + 2] + o.z
    if (!Number.isFinite(px) || (Math.abs(px) < 0.01 && Math.abs(py) < 0.01 && Math.abs(pz) < 0.01)) continue
    positioned++
    let best = -1, bestD = MATCH_RADIUS * MATCH_RADIUS
    points.forEach((m, k) => {
      if (used.has(k)) return
      const d = (m.origin[0] - px) ** 2 + (m.origin[1] - py) ** 2 + (m.origin[2] - pz) ** 2
      if (d < bestD) {
        bestD = d
        best = k
      }
    })
    if (best >= 0) {
      byDemo[i] = points[best]
      used.add(best)
    }
  }
  if (positioned === 0) {
    const ordered = [...points].sort((a, b) => a.index - b.index)
    for (let i = 0; i < cp.count && i < ordered.length; i++) byDemo[i] = ordered[i]
  }
  const byName = new Map<string, number>()
  byDemo.forEach((m, i) => {
    if (m) byName.set(m.name, i)
  })
  const map = { byDemo, byName }
  pointMapCache.set(x, { meta, map })
  return map
}

function pointName(x: HighlanderExtras, meta: MapMeta | null | undefined, index: number): string {
  const cp = metaPointMap(x, meta).byDemo[index]
  return cp?.printName || cp?.name || ''
}

const canCapKnownCache = new WeakMap<HighlanderExtras, boolean>()

/** True when some cp.state entry of the demo has a team-can-cap bit (m_bTeamCanCap reached the demo). */
function canCapKnown(x: HighlanderExtras): boolean {
  let known = canCapKnownCache.get(x)
  if (known === undefined) {
    known = false
    const flags = x.objectives.cp.state.flags
    for (let k = 0; k < flags.length; k++) {
      if ((flags[k] & (CPF.RED_CAN_CAP | CPF.BLU_CAN_CAP)) !== 0) {
        known = true
        break
      }
    }
    canCapKnownCache.set(x, known)
  }
  return known
}

/**
 * The lock of TF2's control point icon (CControlPointIcon::IsPointLocked, hud_controlpointicons.cpp:414-433): the
 * point is locked (m_bCPLocked, as on KOTH before it unlocks), or no team other than its owner may capture it
 * (m_bTeamCanCap), so on attack/defend maps a captured point keeps its owner's colour under a padlock. The points a
 * team must own first (m_iPreviousPoints) are not in the extras, so a point that waits for an earlier capture is
 * not marked.
 */
export function pointLockedAt(x: HighlanderExtras, flags: number, owner: number): boolean {
  if ((flags & CPF.LOCKED) !== 0) return true
  if (!canCapKnown(x)) return false
  const redCan = owner !== RED && (flags & CPF.RED_CAN_CAP) !== 0
  const bluCan = owner !== BLU && (flags & CPF.BLU_CAN_CAP) !== 0
  return !redCan && !bluCan
}

export function pointViewAt(x: HighlanderExtras, meta: MapMeta | null | undefined, i: number, tick: number): PointView {
  const s = x.objectives.cp.state
  const k = trackIndexAt(s, i, tick)
  const name = pointName(x, meta, i)
  if (k < 0) {
    return { index: i, owner: 0, capping: 0, progress: 0, cappers: 0, locked: false, unlockIn: null, blocked: false, name }
  }
  const flags = s.flags[k]
  const owner = s.owner[k]
  const capping = s.capping[k]
  const unlockTick = s.unlockTick[k]
  const unlockIn =
    (flags & CPF.LOCKED) !== 0 && Number.isFinite(unlockTick) && unlockTick > tick
      ? (unlockTick - tick) * x.meta.intervalPerTick
      : null
  return {
    index: i,
    owner,
    capping,
    progress: capping > 1 ? capProgressAt(x, i, tick) : 0,
    cappers: capping === RED ? s.numRed[k] : capping === BLU ? s.numBlu[k] : 0,
    locked: pointLockedAt(x, flags, owner),
    unlockIn,
    blocked: (flags & CPF.BLOCKED) !== 0,
    name,
  }
}

/** Team with the attackers' role at the tick (TEAM_ROLE.ATTACKERS), BLU when no team has it. */
export function attackTeamAt(x: HighlanderExtras, tick: number): number {
  for (const team of [BLU, RED]) if (teamAt(x, team, tick)?.role === TEAM_ROLE.ATTACKERS) return team
  return BLU
}

function cpOwnerAt(x: HighlanderExtras, i: number, tick: number): number {
  const s = x.objectives.cp.state
  const k = trackIndexAt(s, i, tick)
  return k < 0 ? 0 : s.owner[k]
}

function watcherAt(x: HighlanderExtras, tick: number): { progress: number; speed: number; cappers: number; recedeTick: number } | null {
  const w = x.objectives.watchers
  const j = aliveInstanceAt(w, tick)
  if (j < 0) return null
  const k = trackIndexAt(w.state, j, tick)
  if (k < 0) return null
  return { progress: w.state.progress[k] / 65535, speed: w.state.speed[k], cappers: w.state.cappers[k], recedeTick: w.state.recedeTick[k] }
}

function checkpointsOf(x: HighlanderExtras, meta: MapMeta | null | undefined, tick: number): PayloadView['checkpoints'] {
  const cp = x.objectives.cp
  const out: PayloadView['checkpoints'] = []
  for (let i = 0; i < cp.count; i++) {
    const at = cp.pathDistance[i]
    if (at > 0) out.push({ at: Math.min(1, at), owner: cpOwnerAt(x, i, tick), index: i })
  }
  if (out.length > 0 || !meta?.payload?.length) return out
  // map-meta fallback: linked path distances over the track length, matched to points by name
  const payload = meta.payload[0]
  if (!(payload.length > 0)) return out
  const byName = metaPointMap(x, meta).byName
  for (const link of payload.linked) {
    const index = byName.get(link.controlPoint)
    if (index === undefined) continue
    out.push({ at: Math.min(1, link.distance / payload.length), owner: cpOwnerAt(x, index, tick), index })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Control point indices in m_pszCapLayoutInHUD order (commas only start new rows there), else index order. */
export function layoutOrder(x: HighlanderExtras): number[] {
  const cp = x.objectives.cp
  const seen = new Set<number>()
  const order: number[] = []
  for (const token of (cp.layout ?? '').split(/[\s,]+/)) {
    if (!/^\d+$/.test(token)) continue
    const i = Number(token)
    if (i < cp.count && !seen.has(i)) {
      seen.add(i)
      order.push(i)
    }
  }
  for (let i = 0; i < cp.count; i++) if (!seen.has(i)) order.push(i)
  return order.filter(i => cp.visible[i] !== 0)
}

export function headerAt(x: HighlanderExtras, tick: number): HeaderView {
  const index = stopwatchIndex(x)
  const redName = teamNameAt(x, RED, tick)
  const bluName = teamNameAt(x, BLU, tick)
  if (!index.isStopwatch) {
    return {
      red: { team: RED, name: redName, value: teamAt(x, RED, tick)?.score ?? 0 },
      blu: { team: BLU, name: bluName, value: teamAt(x, BLU, tick)?.score ?? 0 },
      center: null,
      stopwatch: false,
    }
  }
  const games = gamesWonAt(x, tick)
  const { game, decidedWin } = stopwatchGameAt(x, tick)
  const rules = rulesAt(x, tick)
  const center = decidedWin
    ? `Game ${game} final`
    : rules?.swState === STOPWATCH_STATE.OVERTIME
      ? `Game ${game}, overtime`
      : `Game ${game}, half ${stopwatchHalfAt(x, tick)}`
  return {
    red: { team: RED, name: redName, value: games.get(redName) ?? 0 },
    blu: { team: BLU, name: bluName, value: games.get(bluName) ?? 0 },
    center,
    stopwatch: true,
  }
}

export function objectiveViewAt(x: HighlanderExtras, meta: MapMeta | null | undefined, tick: number): ObjectiveView {
  const mode = objectiveModeOf(x, meta)
  const rules = rulesAt(x, tick)
  const flags = rules?.flags ?? 0
  // m_bInOvertime stays set through the win screen and after the match: TF2 shows OVERTIME only while a round
  // runs. After the game ends the server goes back to waiting for players with the round state RUNNING again
  // (1438891 from the gameOver tick 54347: flags 902), so that state is excluded as well.
  const overtime =
    (flags & RULES.IN_OVERTIME) !== 0 && (flags & RULES.WAITING_FOR_PLAYERS) === 0 && rules?.roundState === ROUND_STATE.RUNNING
  const attackTeam = attackTeamAt(x, tick)
  const available = x.meta.available
  const view: ObjectiveView = {
    tick,
    mode,
    timer: rules && available.timers ? timerViewAt(x, rules.hudTimer, (flags & RULES.IN_SETUP) !== 0, tick) : null,
    overtime,
    overtimeOn: Math.floor(tick / 33) % 2 === 0,
    koth: null,
    payload: null,
    points: null,
    tow: null,
    stopwatch: null,
    header: headerAt(x, tick),
    attackTeam,
  }

  if (mode === 'koth') {
    view.koth = {
      blu: rules && available.timers ? clockAt(x, rules.bluKoth, tick) : null,
      red: rules && available.timers ? clockAt(x, rules.redKoth, tick) : null,
      point: available.objectiveResource && x.objectives.cp.count > 0 ? pointViewAt(x, meta, layoutOrder(x)[0] ?? 0, tick) : null,
    }
  } else if (mode === 'payload') {
    const w = available.watchers ? watcherAt(x, tick) : null
    if (w) {
      const recede = (w.recedeTick - tick) * x.meta.intervalPerTick
      view.payload = {
        attackTeam,
        progress: Math.min(1, Math.max(0, w.progress)),
        checkpoints: available.objectiveResource ? checkpointsOf(x, meta, tick) : [],
        cappers: w.cappers,
        speed: w.speed,
        recedeIn: Number.isFinite(recede) && recede > 0 && recede < 5 && w.speed >= 0 ? recede : null,
      }
    }
  } else if (mode === 'cp') {
    if (available.objectiveResource) view.points = layoutOrder(x).map(i => pointViewAt(x, meta, i, tick))
  } else if (mode === 'tow') {
    const pd = x.objectives.pd
    const k = trackIndexAt(pd, 0, tick)
    const w = available.watchers ? watcherAt(x, tick) : null
    if (k >= 0 || w) {
      view.tow = {
        red: k >= 0 ? pd.red[k] : 0,
        blu: k >= 0 ? pd.blu[k] : 0,
        max: k >= 0 && pd.max[k] > 0 ? pd.max[k] : 100,
        progress: w ? Math.min(1, Math.max(0, w.progress)) : null,
        speed: w?.speed ?? 0,
        cappers: w?.cappers ?? 0,
      }
    }
  }

  const index = stopwatchIndex(x)
  if (index.isStopwatch) {
    const line = stopwatchLineAt(x, tick)
    view.stopwatch = {
      line: line?.text ?? null,
      game: stopwatchGameAt(x, tick).game,
      half: stopwatchHalfAt(x, tick),
      overtime: rules?.swState === STOPWATCH_STATE.OVERTIME,
      rule: index.rule,
    }
  }
  return view
}
