// RoundBanner content (contract section 5 F5): for 330 ticks after each roundWin event, "<team name> wins the
// round" with the reason in words; after a stopwatch first half, what the next attackers must beat; after a
// decided stopwatch game, who won it and the games score.

import { rulesAt, teamAt, timerSecondsAt } from '@highlander/extras/getters'
import { TEAM_ROLE } from '@highlander/extras/enums'
import type { HighlanderExtras } from '@highlander/extras/types'

import { formatClock, points } from './format'
import type { ObjectiveMode } from './objectiveModel'
import { BLU, gamesWonAt, RED, scoreAfterWin, stopwatchIndex, teamNameAt, type StopwatchWin } from './stopwatch'

export const BANNER_TICKS = 330
export const BANNER_FADE_TICKS = 33

export interface BannerView {
  eventTick: number
  team: number
  title: string
  reason: string
  sub: string | null
  /** stopwatch details behind `sub` */
  stopwatch: { decided: boolean; half: 1 | 2; game: number; points?: number; seconds?: number } | null
}

function reasonWords(reason: number, mode: ObjectiveMode): string {
  switch (reason) {
    case 1:
      return mode === 'koth'
        ? 'held the point until the clock ran out'
        : mode === 'payload'
          ? 'delivered the cart'
          : mode === 'tow'
            ? 'reached the point limit'
            : 'captured every point'
    case 2:
      return 'eliminated the other team'
    case 3:
      return 'reached the capture limit'
    case 4:
      return 'defended until time ran out'
    case 5:
      return 'stalemate'
    case 6:
      return mode === 'tow' ? 'led when time ran out' : 'won on the time limit'
    case 7:
      return 'reached the win limit'
    case 8:
      return 'reached the win difference limit'
    case 9:
      return 'captured the reactor'
    case 10:
      return 'collected the cores'
    case 11:
      return 'returned the reactor'
    case 12:
      return 'scored the most points'
    case 13:
      return 'scored'
    case 14:
    case 15:
    case 16:
      return 'won on the stopwatch'
    default:
      return ''
  }
}

function roleTeam(x: HighlanderExtras, role: number, tick: number): number {
  for (const team of [RED, BLU]) if (teamAt(x, team, tick)?.role === role) return team
  return -1
}

function bannerFor(x: HighlanderExtras, win: StopwatchWin, mode: ObjectiveMode): BannerView {
  const tick = win.tick
  const hasTeam = win.team === RED || win.team === BLU
  const view: BannerView = {
    eventTick: tick,
    team: hasTeam ? win.team : 0,
    title: hasTeam ? `${win.winnerName} wins the round` : 'Stalemate',
    reason: hasTeam ? reasonWords(win.winReason, mode) : '',
    sub: null,
    stopwatch: null,
  }
  if (!win.stopwatch) return view

  if (win.decided) {
    const games = gamesWonAt(x, tick)
    const otherTeam = win.team === RED ? BLU : RED
    const otherName = teamNameAt(x, otherTeam, tick)
    const a = games.get(win.winnerName) ?? 0
    const b = otherName === win.winnerName ? 0 : games.get(otherName) ?? 0
    view.sub = `${win.winnerName} wins game ${win.game} (${a}-${b})`
    view.stopwatch = { decided: true, half: win.half, game: win.game }
    return view
  }

  if (win.half === 1) {
    // the first-half defenders attack next (the team names follow the players across the side switch)
    const att = roleTeam(x, TEAM_ROLE.ATTACKERS, tick)
    const def = roleTeam(x, TEAM_ROLE.DEFENDERS, tick)
    if (att > 0 && def > 0) {
      const n = scoreAfterWin(x, att, tick)
      const rules = rulesAt(x, tick)
      const seconds = rules ? timerSecondsAt(x, rules.swTimer, tick) : 0
      view.sub = `${teamNameAt(x, def, tick)} must beat ${points(n)} in ${formatClock(seconds)}`
      view.stopwatch = { decided: false, half: 1, game: win.game, points: n, seconds }
    }
  }
  return view
}

/** The banner of the newest roundWin with 0 <= tick - eventTick < 330, or null. */
export function bannerAt(x: HighlanderExtras, mode: ObjectiveMode, tick: number): BannerView | null {
  const wins = stopwatchIndex(x).wins
  for (let i = wins.length - 1; i >= 0; i--) {
    const age = tick - wins[i].tick
    if (age < 0) continue
    return age < BANNER_TICKS ? bannerFor(x, wins[i], mode) : null
  }
  return null
}

/** 1 until the last 33 ticks of the banner, then a linear fade; 0 outside the window. */
export function bannerOpacity(eventTick: number, tickF: number): number {
  const age = tickF - eventTick
  if (!(age >= 0) || age >= BANNER_TICKS) return 0
  return Math.min(1, (BANNER_TICKS - age) / BANNER_FADE_TICKS)
}
