import { AsyncParser, CachedDeath } from '@components/Analyse/Data/AsyncParser'
import type { HighlanderExtras } from '@highlander/extras/types'
import { findTicks } from '@highlander/extras/findTicks'
import { medigunAt } from '@highlander/extras/getters'
import { deathIndex } from '@highlander/objectives/deaths'
import { prettyPointName } from '@highlander/objectives/format'
import { teamOfAt } from '@highlander/objectives/scoreboardModel'
import { eventsOf, teamNameAt } from '@highlander/objectives/stopwatch'

export interface MatchKillEvent {
  type: 'kill'
  tick: number
  killer: CachedDeath['killer']
  victim: CachedDeath['victim']
  assister: CachedDeath['assister']
  weapon: string
  killerTeam: number
  victimTeam: number
  assisterTeam: number
  /** extras annotations, when the extras are ready */
  crit?: number
  customKill?: number
}

export interface MatchUberEvent {
  type: 'uber'
  tick: number
  medicName: string
  medicTeam: number
  medicEntityId: number
  /** medigun type name, when the extras know it */
  medigun?: string
}

/** Highlander match-feed rows: captures, buildings, medic drops and spy moments (extras only). */
export interface MatchNoteEvent {
  type: 'note'
  category: 'caps' | 'buildings' | 'drops' | 'spy'
  tick: number
  text: string
  team: number
  /** player to watch when the row is clicked, 0 for none */
  entityId: number
  /** names the player filter matches */
  names: string[]
}

export type MatchEvent = MatchKillEvent | MatchUberEvent | MatchNoteEvent

// ─── KILLSTREAK DETECTION ────────────────────────────────────────────────────────

export const KILLSTREAK_GRACE_PERIOD_SECONDS = 10

export interface KillstreakInfo {
  streakCount: number
  streakIndex: number // 1-based position within the streak
}

export interface AnnotatedMatchKillEvent extends MatchKillEvent {
  streak: KillstreakInfo | null
}

export function annotateKillstreaks(
  kills: MatchKillEvent[],
  tickRate: number
): AnnotatedMatchKillEvent[] {
  const graceTicks = KILLSTREAK_GRACE_PERIOD_SECONDS * tickRate

  // Pass 1: Build streak groups
  // Track last kill tick per player and current group
  const lastKillTick = new Map<string, number>()
  const currentGroupStart = new Map<string, number>() // steamId → index of group start
  const groups = new Map<number, number[]>() // startIndex → [indices in this group]

  for (let i = 0; i < kills.length; i++) {
    const kill = kills[i]
    const { killer, victim } = kill

    // Skip world kills and self-kills
    if (!killer || killer.user.steamId === victim.user.steamId) continue

    const steamId = killer.user.steamId
    const prevTick = lastKillTick.get(steamId)

    if (prevTick !== undefined && kill.tick - prevTick <= graceTicks) {
      // Extend current group
      const groupStart = currentGroupStart.get(steamId)!
      groups.get(groupStart)!.push(i)
    } else {
      // Start new group
      currentGroupStart.set(steamId, i)
      groups.set(i, [i])
    }

    lastKillTick.set(steamId, kill.tick)
  }

  // Pass 2: Annotate kills that belong to groups of 2+
  const streakMap = new Map<number, KillstreakInfo>()
  for (const [, indices] of groups) {
    if (indices.length < 2) continue
    for (let j = 0; j < indices.length; j++) {
      streakMap.set(indices[j], {
        streakCount: indices.length,
        streakIndex: j + 1,
      })
    }
  }

  return kills.map((kill, i) => ({
    ...kill,
    streak: streakMap.get(i) ?? null,
  }))
}

/**
 * Every base death in tick order. With the extras, Dead Ringer feign deaths are dropped (the game never shows
 * them to spectators) and each kill carries its crit type and custom kill (headshot 1, backstab 2).
 */
export function getAllKills(parser: AsyncParser, extras?: HighlanderExtras): MatchKillEvent[] {
  if (extras) {
    const kills: MatchKillEvent[] = []
    for (const row of deathIndex(parser, extras).rows) {
      if (row.feign) continue
      const death = row.death
      kills.push({
        type: 'kill',
        tick: death.tick,
        killer: death.killer,
        victim: death.victim,
        assister: death.assister,
        weapon: death.weapon,
        killerTeam: death.killerTeam,
        victimTeam: death.victimTeam,
        assisterTeam: death.assisterTeam,
        crit: row.kill?.critType ?? 0,
        customKill: row.kill?.customKill ?? 0,
      })
    }
    return kills
  }

  const kills: MatchKillEvent[] = []

  for (const tickKey in parser.deaths) {
    const deaths = parser.deaths[tickKey]
    for (const death of deaths) {
      kills.push({
        type: 'kill',
        tick: death.tick,
        killer: death.killer,
        victim: death.victim,
        assister: death.assister,
        weapon: death.weapon,
        killerTeam: death.killerTeam,
        victimTeam: death.victimTeam,
        assisterTeam: death.assisterTeam,
      })
    }
  }

  kills.sort((a, b) => a.tick - b.tick)
  return kills
}

const MEDIGUN_NAMES: Record<string, string> = { medigun: 'Medi Gun', kritzkrieg: 'Kritzkrieg', quickfix: 'Quick-Fix', vaccinator: 'Vaccinator' }

/**
 * Uber pops. With the extras: the player_chargedeployed events (exact tick and medigun type). Without them, or
 * on old demos that never recorded the event: a charge drop below 95 % in the base uber cache (16-tick steps).
 */
export function getUberPops(parser: AsyncParser, extras?: HighlanderExtras): MatchUberEvent[] {
  const deployed = extras ? eventsOf(extras, 'uberDeployed') : []
  if (extras && deployed.length > 0) {
    const events: MatchUberEvent[] = []
    for (const e of deployed) {
      const ref = parser.entityPlayerMap.get(e.medic)
      if (!ref) continue
      const type = medigunAt(extras, e.medic, e.tick)?.type
      events.push({
        type: 'uber',
        tick: e.tick,
        medicName: ref.user.name,
        medicTeam: teamOfAt(parser, e.medic, e.tick),
        medicEntityId: ref.user.entityId,
        medigun: type ? MEDIGUN_NAMES[type] : undefined,
      })
    }
    return events
  }

  const events: MatchUberEvent[] = []
  const { uberCache, metaCache } = parser.playerCache
  const step = 1 << uberCache.sparse

  for (let i = 0; i < parser.nextMappedPlayer; i++) {
    const entity = parser.entityPlayerMap.get(i)
    if (!entity) continue

    for (let tick = step; tick < parser.ticks; tick += step) {
      const prevCharge = uberCache.getOrNull(i, tick - step)
      const currCharge = uberCache.getOrNull(i, tick)

      // Detect when charge crosses below 95 from a near-full state.
      // Uber drains ~3% per 16-tick sample, so a single-step drop from
      // >=95 to <95 reliably catches the first moment of activation.
      if (prevCharge !== null && currCharge !== null && prevCharge >= 95 && currCharge < 95) {
        const meta = metaCache.getMeta(i, tick)
        if (meta.classId === 5) {
          events.push({
            type: 'uber',
            tick,
            medicName: entity.user.name,
            medicTeam: meta.teamId,
            medicEntityId: entity.user.entityId,
          })
        }
      }
    }
  }

  events.sort((a, b) => a.tick - b.tick)
  return events
}

const NONE_U8 = 255
const BUILDING_NAMES: Record<number, string> = { 0: 'Dispenser', 1: 'Teleporter', 2: 'Sentry', 3: 'Sapper' }

/** Captures, building kills, medic drops and spy moments for the match feed chips (extras only). */
export function getMatchNotes(parser: AsyncParser, extras: HighlanderExtras): MatchNoteEvent[] {
  const notes: MatchNoteEvent[] = []
  const player = (p: number) => (p >= 0 && p !== NONE_U8 ? parser.entityPlayerMap.get(p)?.user : undefined)
  const name = (p: number) => player(p)?.name ?? 'world'

  for (const e of eventsOf(extras, 'captured')) {
    const cappers = e.cappers.map(p => player(p)?.name).filter((n): n is string => !!n)
    notes.push({
      type: 'note',
      category: 'caps',
      tick: e.tick,
      team: e.team,
      entityId: player(e.cappers[0] ?? -1)?.entityId ?? 0,
      names: cappers,
      text: `${teamNameAt(extras, e.team, e.tick)} captured ${prettyPointName(e.cpName, e.cp)}${cappers.length ? ` (${cappers.join(', ')})` : ''}`,
    })
  }
  for (const e of eventsOf(extras, 'destroyed')) {
    const team = e.building >= 0 ? extras.buildings.team[e.building] : teamOfAt(parser, e.owner, e.tick)
    notes.push({
      type: 'note',
      category: 'buildings',
      tick: e.tick,
      team,
      entityId: player(e.attacker)?.entityId ?? 0,
      names: [name(e.attacker), name(e.owner)],
      text: `${name(e.attacker)} destroyed ${name(e.owner)}'s ${BUILDING_NAMES[e.type] ?? 'building'}`,
    })
  }
  for (const e of eventsOf(extras, 'medicDeath')) {
    if (!e.charged) continue
    notes.push({
      type: 'note',
      category: 'drops',
      tick: e.tick,
      team: teamOfAt(parser, e.medic, e.tick),
      entityId: player(e.medic)?.entityId ?? 0,
      names: [name(e.medic), name(e.attacker)],
      text: `Medic drop: ${name(e.medic)} (killed by ${name(e.attacker)})`,
    })
  }
  // spy: backstabs, Dead Ringer feigns (listed here although the killfeed hides them), sappers, decloaks
  for (const row of deathIndex(parser, extras).rows) {
    const killer = row.death.killer?.user.name ?? '?'
    const victim = row.death.victim.user.name
    if (row.feign) {
      notes.push({
        type: 'note',
        category: 'spy',
        tick: row.tick,
        team: teamOfAt(parser, row.victim, row.tick),
        entityId: row.victimEntity,
        names: [victim],
        text: `Dead Ringer feign: ${victim} (by ${killer})`,
      })
    } else if (row.kill?.customKill === 2) {
      notes.push({
        type: 'note',
        category: 'spy',
        tick: row.tick,
        team: teamOfAt(parser, row.killer, row.tick),
        entityId: row.killerEntity,
        names: [killer, victim],
        text: `Backstab: ${killer} on ${victim}`,
      })
    }
  }
  for (const e of eventsOf(extras, 'sapped')) {
    notes.push({
      type: 'note',
      category: 'spy',
      tick: e.tick,
      team: teamOfAt(parser, e.spy, e.tick),
      entityId: player(e.spy)?.entityId ?? 0,
      names: [name(e.spy), name(e.owner)],
      text: `Sapper: ${name(e.spy)} on ${name(e.owner)}'s ${BUILDING_NAMES[e.type] ?? 'building'}`,
    })
  }
  for (const r of findTicks(extras, 'decloak', { limit: 1e6 })) {
    if (r.player === undefined) continue
    notes.push({
      type: 'note',
      category: 'spy',
      tick: r.tick,
      team: teamOfAt(parser, r.player, r.tick),
      entityId: player(r.player)?.entityId ?? 0,
      names: [name(r.player)],
      text: `Decloak${r.note === 'feign' ? ' (Dead Ringer)' : ''}: ${name(r.player)}`,
    })
  }
  notes.sort((a, b) => a.tick - b.tick)
  return notes
}
