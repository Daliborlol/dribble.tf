// Team names, stopwatch halves, games won and the stopwatch line (contract section 5 F5, D17).
//
// TF2 has no networked counter of stopwatch games (m_iRoundsWon has no writer), and m_iScore resets when a game
// is decided and swaps between the teams at the side switch. So games are derived from the roundWin events:
// a win decides a game when a rules entry in effect within [tick, tick + 3] has RULES.STOPWATCH_WINNER. The game
// is credited to the team NAME (mp_tournament_*teamname at the event tick), because the names follow the
// players across the swap. If a demo has stopwatch wins but STOPWATCH_WINNER never shows, every second
// stopwatch win (counted since the last tournament restart) decides a game instead, and `rule` says so.
//
// Everything here is a pure function of the extras and the tick; the per-demo index is built once per extras
// object (WeakMap).

import { convarAt, rulesAt, teamAt, timerSecondsAt } from '@highlander/extras/getters'
import { ROUND_STATE, RULES, STOPWATCH_STATE, TEAM_ROLE, TIMER } from '@highlander/extras/enums'
import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras, HlEvent } from '@highlander/extras/types'

import { formatClock, points } from './format'

export const RED = 2
export const BLU = 3

const NAME_KEY: Record<number, string> = { 2: 'mp_tournament_redteamname', 3: 'mp_tournament_blueteamname' }

/** Side label of a team number: RED, BLU or ''. */
export const sideLabel = (team: number) => (team === RED ? 'RED' : team === BLU ? 'BLU' : '')

/** The tournament name of the team playing on `team`'s side at the tick (RED / BLU when unset). */
export function teamNameAt(x: HighlanderExtras, team: number, tick: number): string {
  const key = NAME_KEY[team]
  const value = key ? convarAt(x, key, tick)?.trim() : undefined
  return value || sideLabel(team)
}

export type EventOf<T extends HlEvent['t']> = Extract<HlEvent, { t: T }>

/** HlEvents of one type in tick order (hydration keeps the events sorted by tick). */
export function eventsOf<T extends HlEvent['t']>(x: HighlanderExtras, type: T): EventOf<T>[] {
  const idx = x.derived.eventsByType[type]
  if (!idx) return []
  return idx.map(i => x.events[i] as EventOf<T>)
}

/** True when any rules entry in effect during [from, to] has `bit`. */
function rulesBitInWindow(x: HighlanderExtras, from: number, to: number, bit: number): boolean {
  const r = x.objectives.rules
  const lo = r.offsets[0] ?? 0, hi = r.offsets[1] ?? 0
  const first = trackIndexAt(r, 0, from) // the entry in effect at `from`; later entries start after it
  for (let i = first >= 0 ? first : lo; i < hi; i++) {
    if (i !== first && r.ticks[i] > to) break
    if ((r.flags[i] & bit) !== 0) return true
  }
  return false
}

/** Stopwatch timer flags at the tick (0 without a timer). */
function swTimerFlags(x: HighlanderExtras, timer: number, tick: number): number {
  if (!(timer >= 0)) return 0
  const s = x.objectives.timers.state
  const i = trackIndexAt(s, timer, tick)
  return i < 0 ? 0 : s.flags[i]
}

/**
 * Stopwatch half at the tick: 1 while the stopwatch timer watches capture time stamps (TIMER.CAPTURE_WATCH) or
 * before it exists (the first-half timer is created when setup ends), 2 while it counts down.
 */
export function stopwatchHalfAt(x: HighlanderExtras, tick: number): 1 | 2 {
  const rules = rulesAt(x, tick)
  if (!rules || !(rules.swTimer >= 0)) return 1
  return (swTimerFlags(x, rules.swTimer, tick) & TIMER.CAPTURE_WATCH) !== 0 ? 1 : 2
}

export interface StopwatchWin {
  tick: number
  team: number
  winReason: number
  /** RULES.STOPWATCH was set just before the win */
  stopwatch: boolean
  /** this win decided a stopwatch game */
  decided: boolean
  /** stopwatch half that ended with this win */
  half: 1 | 2
  /** name of the winning team at the event tick */
  winnerName: string
  /** game number this win belongs to (1-based; counts decided games before it) */
  game: number
}

export interface StopwatchIndex {
  /** a rules entry somewhere in the demo has RULES.STOPWATCH */
  isStopwatch: boolean
  wins: StopwatchWin[]
  decided: StopwatchWin[]
  roundStarts: number[]
  /** which games-won rule produced `decided` */
  rule: 'stopwatchWinner' | 'everySecondWin' | 'none'
}

const indexCache = new WeakMap<HighlanderExtras, StopwatchIndex>()

export function stopwatchIndex(x: HighlanderExtras): StopwatchIndex {
  const cached = indexCache.get(x)
  if (cached) return cached

  const r = x.objectives.rules
  let isStopwatch = false
  for (let i = r.offsets[0] ?? 0; i < (r.offsets[1] ?? 0); i++) {
    if ((r.flags[i] & RULES.STOPWATCH) !== 0) {
      isStopwatch = true
      break
    }
  }

  const roundStarts = eventsOf(x, 'roundStart').map(e => e.tick)
  const wins: StopwatchWin[] = eventsOf(x, 'roundWin').map(e => {
    const before = rulesAt(x, Math.max(0, e.tick - 1))
    const stopwatch = !!before && (before.flags & RULES.STOPWATCH) !== 0
    return {
      tick: e.tick,
      team: e.team,
      winReason: e.winReason,
      stopwatch,
      decided: stopwatch && rulesBitInWindow(x, e.tick, e.tick + 3, RULES.STOPWATCH_WINNER),
      half: stopwatchHalfAt(x, Math.max(0, e.tick - 1)),
      winnerName: teamNameAt(x, e.team, e.tick),
      game: 1,
    }
  })

  let rule: StopwatchIndex['rule'] = 'none'
  if (wins.some(w => w.decided)) rule = 'stopwatchWinner'
  else if (wins.some(w => w.stopwatch)) {
    // Fallback: every second stopwatch win decides a game, counting from the last tournament restart
    // (a roundStart whose rules report 0 rounds played).
    rule = 'everySecondWin'
    const restarts = roundStarts.filter(t => rulesAt(x, t)?.rounds === 0)
    let count = 0
    let restartIdx = 0
    for (const w of wins) {
      while (restartIdx < restarts.length && restarts[restartIdx] <= w.tick) {
        count = 0
        restartIdx++
      }
      if (!w.stopwatch) continue
      count++
      w.decided = count % 2 === 0
    }
    // a demo that ends before its first game is decided (one half) used neither rule
    if (!wins.some(w => w.decided)) rule = 'none'
  }

  let decidedCount = 0
  for (const w of wins) {
    w.game = decidedCount + 1
    if (w.decided) decidedCount++
  }

  const index: StopwatchIndex = { isStopwatch, wins, decided: wins.filter(w => w.decided), roundStarts, rule }
  indexCache.set(x, index)
  return index
}

/** Last index i of a sorted list with list[i] <= value, or -1. */
function lastAtOrBefore(list: number[], value: number): number {
  let lo = 0, hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid] <= value) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** Games won per team name by the tick (decided games with tick <= the tick). */
export function gamesWonAt(x: HighlanderExtras, tick: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const w of stopwatchIndex(x).decided) {
    if (w.tick > tick) break
    out.set(w.winnerName, (out.get(w.winnerName) ?? 0) + 1)
  }
  return out
}

/**
 * The stopwatch game in progress at the tick: its number (1 + games decided before the current round started),
 * and whether the current round already decided it.
 */
export function stopwatchGameAt(x: HighlanderExtras, tick: number): { game: number; decidedWin: StopwatchWin | null } {
  const index = stopwatchIndex(x)
  const startIdx = lastAtOrBefore(index.roundStarts, tick)
  const roundStart = startIdx >= 0 ? index.roundStarts[startIdx] : -1
  let before = 0
  let decidedWin: StopwatchWin | null = null
  for (const w of index.decided) {
    if (w.tick < roundStart) before++
    else if (w.tick <= tick) decidedWin = w
  }
  return { game: before + 1, decidedWin }
}

export interface StopwatchLine {
  text: string
  /** the numbers the line shows */
  attackers: number
  points: number
  seconds: number | null
  half: 1 | 2
  state: number
}

/**
 * The stopwatch line of tf_hud_tournament.cpp:1420-1560, or null when RULES.STOPWATCH is not set at the tick
 * (also hidden while waiting for players and at game over, like the game's HUD).
 */
export function stopwatchLineAt(x: HighlanderExtras, tick: number): StopwatchLine | null {
  const rules = rulesAt(x, tick)
  if (!rules || (rules.flags & RULES.STOPWATCH) === 0) return null
  if ((rules.flags & RULES.WAITING_FOR_PLAYERS) !== 0 || rules.roundState === ROUND_STATE.GAME_OVER) return null

  let att = -1, def = -1
  for (const team of [RED, BLU]) {
    const role = teamAt(x, team, tick)?.role
    if (role === TEAM_ROLE.ATTACKERS) att = team
    else if (role === TEAM_ROLE.DEFENDERS) def = team
  }
  if (att < 0 || def < 0) return null

  const half = stopwatchHalfAt(x, tick)
  const attName = teamNameAt(x, att, tick)
  let attScore = teamAt(x, att, tick)?.score ?? 0
  let defScore = teamAt(x, def, tick)?.score ?? 0
  // CTFTeam scores reach the demo up to a second after the round restarts, so for the first ticks of a second
  // half the first-half points still sit on the attackers. They swap sides at the restart; read them swapped.
  const settingUp = (rules.flags & RULES.IN_SETUP) !== 0 || rules.roundState === ROUND_STATE.PREROUND
  if (half === 2 && settingUp && attScore > defScore) [attScore, defScore] = [defScore, attScore]

  const state = rules.swState
  if (state === STOPWATCH_STATE.NOT_SET) {
    return { text: 'No capture time set', attackers: att, points: 0, seconds: null, half, state }
  }
  if (state === STOPWATCH_STATE.OVERTIME) {
    const n = Math.max(0, defScore - attScore + 1)
    return { text: `${attName} needs ${points(n)} to win`, attackers: att, points: n, seconds: null, half, state }
  }
  const seconds = timerSecondsAt(x, rules.swTimer, tick)
  if (half === 1) {
    return { text: `${attName}: ${points(attScore)}, ${formatClock(seconds)} banked`, attackers: att, points: attScore, seconds, half, state }
  }
  const n = Math.max(0, defScore - attScore)
  return { text: `${attName}: ${points(n)} to beat in ${formatClock(seconds)}`, attackers: att, points: n, seconds, half, state }
}

/**
 * Score of `team` right after a round ended: CTFTeam scores reach the demo up to a second after the capture
 * that ended the round, so take the highest value between the win and the next round start.
 */
export function scoreAfterWin(x: HighlanderExtras, team: number, winTick: number): number {
  const t = x.objectives.teams
  const index = stopwatchIndex(x)
  const nextStart = index.roundStarts.find(s => s > winTick) ?? Infinity
  let best = teamAt(x, team, winTick)?.score ?? 0
  const lo = t.offsets[team] ?? 0, hi = t.offsets[team + 1] ?? 0
  for (let i = lo; i < hi; i++) {
    const tick = t.ticks[i]
    if (tick <= winTick) continue
    if (tick >= nextStart || tick > winTick + 330) break
    best = Math.max(best, t.score[i])
  }
  return best
}
