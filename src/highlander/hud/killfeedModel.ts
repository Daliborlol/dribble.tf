// Killfeed lines (contract section 5 F5): base deaths annotated with the extras `kill` events, plus building and
// capture lines. Built once per (demo, extras, options) as a tick-sorted list; the lines on screen at a tick are
// a binary-searched window of it, so the killfeed is a pure function of the tick.
//
// Kill icon URLs come from one eager glob of src/assets/kill_icons, resolved once per weapon in module Maps:
// no image request ever 404s and no row builds a `new URL` per render.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { KILL_ICON_ALIASES } from '@constants/killIconAliases'
import { DEATH_FLAG } from '@highlander/extras/enums'
import type { HighlanderExtras } from '@highlander/extras/types'
import { deathIndex, lowerBoundOf } from '@highlander/objectives/deaths'
import { prettyPointName } from '@highlander/objectives/format'
import { teamOfAt } from '@highlander/objectives/scoreboardModel'
import { eventsOf, teamNameAt } from '@highlander/objectives/stopwatch'

export const KILLFEED_LINGER_TICKS = 200

// ─── kill icons ────────────────────────────────────────────────────────────────

const ICON_FILES = import.meta.glob<string>('/src/assets/kill_icons/*.png', { eager: true, query: '?url', import: 'default' })
const ICONS = new Map<string, string>()
for (const [path, url] of Object.entries(ICON_FILES)) ICONS.set(path.slice(path.lastIndexOf('/') + 1, -'.png'.length), url)

/** URL of a kill icon by file basename, undefined when the file does not exist. */
export const killIconFile = (name: string): string | undefined => ICONS.get(name)

export const SKULL_ICON = ICONS.get('skull') ?? ''
export const CRIT_ICON = ICONS.get('crit') ?? ''

const weaponIcons = new Map<string, { name: string; url: string; found: boolean }>()

/** Icon of a player_death weapon string (alias table, then the file itself, else the skull). */
export function weaponIcon(weapon: string): { name: string; url: string; found: boolean } {
  let icon = weaponIcons.get(weapon)
  if (!icon) {
    const name = KILL_ICON_ALIASES[weapon] || weapon
    const url = ICONS.get(name)
    icon = { name, url: url ?? SKULL_ICON, found: !!url }
    weaponIcons.set(weapon, icon)
  }
  return icon
}

/** Headshot variant: `<icon>hs.png`, then `<icon>_hs.png`; undefined when neither exists. */
export function headshotIcon(name: string): string | undefined {
  return ICONS.get(`${name}hs`) ?? ICONS.get(`${name}_hs`)
}

/** Backstab icon: `<icon>_backstab.png` (Sharp Dresser), else backstab.png. */
export function backstabIcon(name: string): string {
  return ICONS.get(`${name}_backstab`) ?? ICONS.get('backstab') ?? SKULL_ICON
}

// ─── lines ─────────────────────────────────────────────────────────────────────

export interface FeedActor { entityId: number; name: string; team: number }

export interface KillfeedLine {
  key: string
  tick: number
  kind: 'kill' | 'building' | 'capture'
  killer: FeedActor | null
  assister: FeedActor | null
  victim: FeedActor | null
  /** building lines: "<owner>'s Sentry" in the owner's colour */
  victimLabel: string | null
  icon: string
  iconName: string
  /** 2 crit, 1 mini-crit */
  crit: number
  /** "HS" text badge: a headshot whose weapon has no headshot icon */
  hsBadge: boolean
  dom: boolean
  rev: boolean
  feign: boolean
  /** capture lines */
  team: number
  text: string | null
}

export interface KillfeedOptions { feign: boolean; objectives: boolean }
export interface KillfeedModel { lines: KillfeedLine[]; ticks: number[]; feigns: number; hiddenFeigns: number }

const BUILDING_LABEL: Record<number, string> = { 0: 'Dispenser', 2: 'Sentry', 3: 'Sapper' }

function buildingLabel(x: HighlanderExtras, building: number, type: number): string {
  if (type === 1) {
    const mode = building >= 0 ? x.buildings.mode[building] : -1
    return mode === 1 ? 'Teleporter Exit' : mode === 0 ? 'Teleporter Entrance' : 'Teleporter'
  }
  return BUILDING_LABEL[type] ?? 'Building'
}

const NONE_U8 = 255
const modelCache = new WeakMap<AsyncParser, { x: HighlanderExtras | undefined; key: string; model: KillfeedModel }>()

export function killfeedModel(demo: AsyncParser, x: HighlanderExtras | undefined, opts: KillfeedOptions): KillfeedModel {
  const key = `${opts.feign ? 1 : 0}${opts.objectives ? 1 : 0}`
  const cached = modelCache.get(demo)
  if (cached && cached.x === x && cached.key === key) return cached.model

  const actor = (p: number, entityId: number, name: string, tick: number, fallbackTeam: number): FeedActor => {
    const team = p >= 0 ? teamOfAt(demo, p, tick) : 0
    return { entityId, name, team: team === 2 || team === 3 ? team : fallbackTeam }
  }
  const playerActor = (p: number, tick: number): FeedActor | null => {
    if (!(p >= 0) || p === NONE_U8) return null
    const ref = demo.entityPlayerMap.get(p)
    if (!ref) return null
    return actor(p, ref.user.entityId, ref.user.name, tick, 0)
  }

  const lines: KillfeedLine[] = []
  const deaths = deathIndex(demo, x)
  let hiddenFeigns = 0
  for (const row of deaths.rows) {
    if (row.feign && !opts.feign) {
      hiddenFeigns++
      continue
    }
    const d = row.death
    const kill = row.kill
    let icon = weaponIcon(d.weapon)
    let url = icon.url
    let hsBadge = false
    if (kill?.customKill === 1) {
      const hs = headshotIcon(icon.name)
      if (hs) url = hs
      else hsBadge = true
    } else if (kill?.customKill === 2) {
      url = backstabIcon(icon.name)
    }
    const flags = kill?.deathFlags ?? 0
    lines.push({
      key: `k${row.tick}-${row.victimEntity}-${lines.length}`,
      tick: row.tick,
      kind: 'kill',
      killer: d.killer && !row.suicide ? actor(row.killer, d.killer.user.entityId, d.killer.user.name, row.tick, d.killerTeam) : null,
      assister: d.assister ? actor(row.assister, d.assister.user.entityId, d.assister.user.name, row.tick, d.assisterTeam) : null,
      victim: actor(row.victim, row.victimEntity, d.victim.user.name, row.tick, d.victimTeam),
      victimLabel: null,
      icon: url,
      iconName: icon.name,
      crit: kill?.critType ?? 0,
      hsBadge,
      dom: (flags & DEATH_FLAG.DOMINATION) !== 0,
      rev: (flags & DEATH_FLAG.REVENGE) !== 0,
      feign: row.feign,
      team: 0,
      text: null,
    })
  }

  if (x && opts.objectives) {
    for (const e of eventsOf(x, 'destroyed')) {
      const icon = weaponIcon(e.weapon || 'skull')
      const owner = playerActor(e.owner, e.tick)
      const ownerTeam = owner?.team || (e.building >= 0 ? x.buildings.team[e.building] : 0)
      lines.push({
        key: `b${e.tick}-${e.building}-${lines.length}`,
        tick: e.tick,
        kind: 'building',
        killer: playerActor(e.attacker, e.tick),
        assister: playerActor(e.assister, e.tick),
        victim: owner ? { ...owner, team: ownerTeam } : null,
        victimLabel: `${owner ? `${owner.name}'s ` : ''}${buildingLabel(x, e.building, e.type)}`,
        icon: icon.url,
        iconName: icon.name,
        crit: 0,
        hsBadge: false,
        dom: false,
        rev: false,
        feign: false,
        team: ownerTeam,
        text: null,
      })
    }
    for (const e of eventsOf(x, 'captured')) {
      const names = e.cappers
        .map(p => demo.entityPlayerMap.get(p)?.user.name)
        .filter((n): n is string => !!n)
      const shown = names.slice(0, 3).join(', ')
      const more = names.length > 3 ? ` +${names.length - 3}` : ''
      lines.push({
        key: `c${e.tick}-${e.cp}-${lines.length}`,
        tick: e.tick,
        kind: 'capture',
        killer: null,
        assister: null,
        victim: null,
        victimLabel: null,
        icon: '',
        iconName: '',
        crit: 0,
        hsBadge: false,
        dom: false,
        rev: false,
        feign: false,
        team: e.team,
        text: `${teamNameAt(x, e.team, e.tick)} captured ${prettyPointName(e.cpName, e.cp)}${shown ? ` (${shown}${more})` : ''}`,
      })
    }
  }

  lines.sort((a, b) => a.tick - b.tick)
  const model: KillfeedModel = { lines, ticks: lines.map(l => l.tick), feigns: deaths.feigns, hiddenFeigns }
  modelCache.set(demo, { x, key, model })
  return model
}

/** The newest `maxLines` lines with tick - 200 < line tick <= tick, oldest first. */
export function killfeedLinesAt(model: KillfeedModel, tick: number, maxLines: number): KillfeedLine[] {
  const end = lowerBoundOf(model.ticks, tick + 1)
  const start = lowerBoundOf(model.ticks, tick - KILLFEED_LINGER_TICKS + 1)
  return model.lines.slice(Math.max(start, end - Math.max(1, maxLines)), end)
}
