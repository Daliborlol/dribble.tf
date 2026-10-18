// F1 core: what a player looks like at a tick (contract section 5 F1). Pure functions of the extras, the base
// caches, the tick, the settings and the POV subject, so seeking to the same tick always gives the same result (D12).
//
// computeFxState feeds three consumers: useActorFx (model, tint, crouch, nameplate), the PlayerFxLayer overlays
// and the fx.* probes.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { CLASS_MAP } from '@constants/mappings'
import { CLOAK_TINT, HULL, TEAM_FX, teamKey } from '@highlander/constants'
import { COND, condSet, HL } from '@highlander/extras/enums'
import {
  cloakMeterAt,
  disguiseAt,
  hasLocalTables,
  invisAt,
  loadoutAt,
  miscAt,
  weaponStateAt,
  type DisguiseState,
} from '@highlander/extras/getters'
import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { itemInfo, itemKind, killIconFor } from '@highlander/items'
import type { ActorFx, NameplateExtra } from '@highlander/scene/actorFx'

import type { DisguiseViewSetting, FxSettings } from './fxSettings'
import type { PovInfo } from './pov'

export const SPY = 8
export const DEMOMAN = 4

/** Body height scale of a crouched player (HULL.duckHeight / HULL.height = 0.756). */
export const CROUCH_SCALE = HULL.duckHeight / HULL.height
/** Nameplate DECLOAK tag after the CLOAKED falling edge. */
export const DECLOAK_TAG_TICKS = 66
/** Decloak ring after the CLOAKED falling edge. */
export const DECLOAK_RING_TICKS = 20
/** Disguise smoke after the DISGUISING onset. */
export const DISGUISE_SMOKE_TICKS = 30
/** MEDIC! tag after a m_bSaveMeParity change. */
export const MEDIC_CALL_TICKS = 133

const toHex = (rgb: readonly number[]) =>
  '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')

/** CLOAK_TINT as colours: RED '#ff8066', BLU '#6680ff' (the spy_invis proxy tint by the spy's real team). */
export const CLOAK_TINT_HEX = { red: toHex(CLOAK_TINT.red), blue: toHex(CLOAK_TINT.blue) } as const
export const JARATE_COLOR = '#e8d34a'
export const MILK_COLOR = '#f2f2f2'
export const GAS_COLOR = '#7a8a5a'
export const BLEED_COLOR = '#b01515'
/** Vaccinator uber shell colour by resist cond: 58 bullet, 59 blast, 60 fire. */
export const VACC_COLORS: Record<number, string> = { 58: '#ffd24a', 59: '#ff8a3d', 60: '#ff4a3d' }

/** The rage buff items whose full meter shows a tag (items.json `bt`): banners 1 to 3, Phlogistinator 5, Heatmaker 6. */
const RAGE_TAGS: Record<number, string> = { 1: 'BANNER', 2: 'BANNER', 3: 'BANNER', 5: 'MMMPH', 6: 'FOCUS' }

export type DisguiseView = 'true' | 'enemy' | 'pov'
export type TeamName = 'red' | 'blue'

/**
 * The disguise view in effect (D9): 'auto' is 'pov' while a POV subject exists and 'true' otherwise. A forced
 * 'pov' without a POV subject (RTS, spectator) has nobody to be an enemy of, so it falls back to 'true' as well.
 */
export function resolveDisguiseView(setting: DisguiseViewSetting, pov: PovInfo | null): DisguiseView {
  if (setting === 'true' || setting === 'enemy') return setting
  return pov ? 'pov' : 'true'
}

const isPlayingTeam = (team: number) => team === 2 || team === 3
const teamIdOf = (team: string) => (team === 'red' ? 2 : team === 'blue' ? 3 : 0)
const asTeamName = (team: string): TeamName | null => (team === 'red' || team === 'blue' ? team : null)

/**
 * Tick of the latest edge of `bit` in p's cond track at or before `tick` (rising: off to on, falling: on to off),
 * when it lies less than `window` ticks back; null otherwise. Walks only the entries inside the window.
 */
export function recentFlagEdge(x: HighlanderExtras, p: number, tick: number, bit: number, rising: boolean, window: number): number | null {
  const c = x.players.cond
  const flags = x.derived.flags
  const i = trackIndexAt(c, p, tick)
  if (i < 0) return null
  const lo = c.offsets[p]
  for (let j = i; j >= lo; j--) {
    const t = c.ticks[j]
    if (tick - t >= window) return null
    const now = (flags[j] & bit) !== 0
    const before = j > lo && (flags[j - 1] & bit) !== 0
    if (rising ? now && !before : before && !now) return t
  }
  return null
}

/** Crouch: `view.duck` bit 0 where the player has view data, else the base duck bit 0 (section 5 F1). */
export function crouchScaleAt(x: HighlanderExtras, demo: AsyncParser, p: number, tick: number): number {
  if (x.meta.available.view) {
    const v = x.players.view
    const i = trackIndexAt(v, p, tick)
    if (i >= 0) return (v.duck[i] & 1) !== 0 ? CROUCH_SCALE : 1
  }
  return (demo.playerCache.getDuck(p, tick) & 1) !== 0 ? CROUCH_SCALE : 1
}

export interface FxInput {
  x: HighlanderExtras
  demo: AsyncParser
  /** player index of the actor */
  p: number
  /** base class and team of the actor ('red' | 'blue') */
  classId: number
  team: string
  /** integer cache tick (renderTick) */
  tick: number
  settings: FxSettings
  /** the POV subject and his team, null outside POV mode */
  pov: PovInfo | null
  /** also build fx.nameplate (the React path); the overlay layer skips it */
  nameplate: boolean
}

export interface FxState {
  fx: ActorFx
  flags: number
  /** invisibility in the spectator view (cap 0.95) and in the enemy view (cap 1) */
  inv: number
  invE: number
  view: DisguiseView
  /** the actor is on the other team from the POV subject in the 'pov' view */
  enemy: boolean
  disguise: DisguiseState | null
  drawnAsDisguise: boolean
  /** team of the drawn model: the disguise team while drawn as the disguise */
  drawnTeam: TeamName | null
  /** HL.CLOAKED or a cloak fade still visible */
  cloaked: boolean
  /** Gas Passer (cond 123, no HL bit) */
  gas: boolean
  /** index of p's players.cond entry at the tick, -1 without one */
  condIndex: number
}

/** Raw ETFCond test on the cond entry `i` (condAt without the lookup). */
function condOn(x: HighlanderExtras, i: number, cond: number): boolean {
  if (i < 0) return false
  const c = x.players.cond
  return condSet(c.w0[i], c.w1[i], c.w2[i], c.w3[i], c.w4[i], cond)
}

/** The actor's look at `tick` (section 5 F1 tables). */
export function computeFxState(input: FxInput): FxState {
  const { x, demo, p, classId, team, tick, settings: s, pov } = input
  const a = x.meta.available
  const hasCond = !!a.cond

  const condIndex = hasCond ? trackIndexAt(x.players.cond, p, tick) : -1
  const flags = condIndex < 0 ? 0 : x.derived.flags[condIndex]
  const gas = condOn(x, condIndex, COND.GAS)
  // Only spies cloak in these game modes; the enemy-view value (cap 1) gives the spectator one (cap 0.95)
  const invE = hasCond && (classId === SPY || (flags & HL.CLOAKED) !== 0) ? invisAt(x, p, tick, 1) : 0
  const inv = Math.min(0.95, invE)
  const cloaked = (flags & HL.CLOAKED) !== 0 || inv > 0

  const view = resolveDisguiseView(s.disguiseView, pov)
  const teamId = teamIdOf(team)
  const enemy = view === 'pov' && !!pov && isPlayingTeam(pov.team) && isPlayingTeam(teamId) && pov.team !== teamId

  // Disguise: drawn as the disguise in the enemy view, and in the 'pov' view for a spy on the other team
  const disguise = hasCond && (flags & (HL.DISGUISED | HL.DISGUISING)) !== 0 ? disguiseAt(x, p, tick) : null
  const disguiseTeam = disguise ? teamKey(disguise.team) : null
  const canDrawDisguise =
    !!disguise && (flags & HL.DISGUISED) !== 0 && !!a.disguise && disguise.cls >= 1 && disguise.cls <= 9 && !!disguiseTeam
  const drawnAsDisguise = canDrawDisguise && (view === 'enemy' || enemy)

  const baseTeam = asTeamName(team)
  const drawnTeam: TeamName | null = drawnAsDisguise ? (disguiseTeam as TeamName) : baseTeam

  // Cloak, then one tint by priority (section 5 F1)
  let opacity = 1
  let tint: string | null = null
  let emissive = 0
  let hidden = false

  if (s.cloak && hasCond) {
    const cloakTint = baseTeam ? CLOAK_TINT_HEX[baseTeam] : null
    if (enemy) {
      // the POV player's own client: no floor, and no model at all once fully invisible
      if (invE > 0) {
        opacity = 1 - invE
        tint = cloakTint
        emissive = 0.6 * invE
        hidden = invE >= 0.99
      }
    } else if (inv > 0) {
      opacity = Math.max(1 - inv, s.cloakFloor)
      tint = cloakTint
      emissive = 0.6 * inv
    }
  }

  if (tint === null && s.conditions && hasCond) {
    const fxColor = drawnTeam ? TEAM_FX[drawnTeam] : null
    // INVULNERABLE_WEARINGOFF (cond 8) is added while INVULNERABLE is still set (tf_player_shared.cpp:9050-9060),
    // so the wearing-off flicker is tested before the steady uber glow, or it would never show.
    if (s.fxUber && fxColor && (flags & HL.UBER_FADING) !== 0) {
      tint = fxColor
      emissive = Math.floor(tick / 4) % 2 ? 0 : 0.9
    } else if (s.fxUber && fxColor && (flags & HL.UBER) !== 0) {
      tint = fxColor
      emissive = 0.9 + 0.15 * Math.sin(2 * Math.PI * tick * 0.015)
    } else if (s.fxCrit && fxColor && (flags & (HL.CRIT | HL.CRIT_BONUS)) !== 0 && !cloaked && !drawnAsDisguise) {
      tint = fxColor
      emissive = (flags & HL.CRIT) !== 0 ? 0.45 : 0.22
    } else if (s.fxDebuffs && (flags & HL.JARATED) !== 0) {
      tint = JARATE_COLOR
      emissive = 0.35
    } else if (s.fxDebuffs && (flags & HL.MILKED) !== 0) {
      tint = MILK_COLOR
      emissive = 0.35
    } else if (s.fxDebuffs && gas) {
      tint = GAS_COLOR
      emissive = 0.35
    } else if (s.fxCrit && fxColor && (flags & HL.MINICRIT) !== 0 && !cloaked && !drawnAsDisguise) {
      tint = fxColor
      emissive = 0.25
    }
  }

  const scaleZ = crouchScaleAt(x, demo, p, tick)

  const fx: ActorFx = {
    modelClassId: drawnAsDisguise && disguise ? disguise.cls : classId,
    modelTeam: drawnAsDisguise && disguiseTeam ? disguiseTeam : team,
    opacity,
    tint,
    emissive,
    hidden,
    scaleZ,
    nameplate: null,
  }

  const state: FxState = { fx, flags, inv, invE, view, enemy, disguise, drawnAsDisguise, drawnTeam, cloaked, gas, condIndex }
  if (input.nameplate) fx.nameplate = computeNameplateExtra(input, state)
  return state
}

/** Display name of a class id ('Scout'), '' for unknown ids. */
export function className(classId: number): string {
  const name = CLASS_MAP[classId]
  return name && name !== 'empty' ? name.charAt(0).toUpperCase() + name.slice(1) : ''
}

function playerName(demo: AsyncParser, p: number): string | undefined {
  if (!(p >= 0) || p === 255) return undefined
  return demo.entityPlayerMap.get(p)?.user.name
}

/** Nameplate items (section 5 F1). Identity overrides apply whenever the spy is drawn as his disguise. */
export function computeNameplateExtra(input: FxInput, state: FxState): NameplateExtra | null {
  const { x, demo, p, classId, tick, settings: s } = input
  const a = x.meta.available
  const { flags, inv, invE, enemy, disguise, drawnAsDisguise } = state
  const extra: NameplateExtra = {}
  let any = false

  // A spy drawn as his disguise wears the disguise's name, health, class and team on the plate as well
  if (drawnAsDisguise && disguise) {
    extra.nameOverride = playerName(demo, disguise.target)
    extra.healthOverride = disguise.health
    extra.classOverride = disguise.cls
    extra.teamOverride = teamKey(disguise.team) ?? undefined
    any = true
  }

  // In the POV player's view an enemy spy's plate disappears with him
  if (enemy && s.cloak && invE > 0.5) {
    extra.opacity = 0
    any = true
  }

  if (!s.nameplateExtras) return any ? extra : null

  const misc = a.misc ? miscAt(x, p, tick) : null
  // The active weapon's item def (activeWeaponAt without its name, slot and since lookups)
  let weaponDef = 65535
  if (a.weapon) {
    const w = x.players.weapon
    const i = trackIndexAt(w, p, tick)
    if (i >= 0 && w.id[i] !== 0xffffffff) weaponDef = w.def[i]
  }

  // Weapon icon: the active weapon, or the disguise weapon for a spy drawn as his disguise
  if (s.nameplateWeapon) {
    const def = drawnAsDisguise && disguise ? disguise.weaponDef : weaponDef
    const icon = def !== 65535 ? killIconFor(def) : undefined
    if (icon) {
      extra.weaponIcon = icon
      any = true
    }
  }

  // Disguise badge, only while the spy is drawn as himself
  if (disguise && !drawnAsDisguise) {
    const disguising = (flags & HL.DISGUISING) !== 0
    const disguised = (flags & HL.DISGUISED) !== 0
    const cls = disguising ? disguise.desiredCls || (disguised ? disguise.cls : 0) : disguise.cls
    const team = disguising ? disguise.desiredTeam || (disguised ? disguise.team : 0) : disguise.team
    extra.disguise = { cls, team, disguising, targetName: disguising ? undefined : playerName(demo, disguise.target), health: disguising ? undefined : disguise.health }
    any = true
  }

  // Cloak meter (not while drawn as the disguise: the enemy view shows no spy gear)
  if (classId === SPY && a.cloak && !drawnAsDisguise) {
    const meter = cloakMeterAt(x, p, tick)
    if (meter < 100 || state.cloaked) {
      extra.cloakPct = meter
      any = true
    }
  }

  // Demoman shield charge
  let loadout: number[] | null = null
  const loadoutOf = () => (loadout ??= a.loadout ? loadoutAt(x, p, tick) : [])
  if (classId === DEMOMAN && misc && loadoutOf().some(def => itemKind(def) === 'shield')) {
    if (misc.charge < 100 || (flags & HL.SHIELD_CHARGE) !== 0) {
      extra.chargePct = misc.charge
      any = true
    }
  }

  // Tags
  const tags: string[] = []
  if (a.cond) {
    if (flags & HL.UBER) tags.push('UBER')
    if (flags & HL.QUICKFIX_UBER) tags.push('QF')
    if (flags & HL.VACC_UBER) tags.push('VACC')
    if (flags & HL.CRIT && !drawnAsDisguise) tags.push('CRIT')
    if (flags & HL.BONK) tags.push('BONK')
    if (flags & HL.MARKED && !drawnAsDisguise) tags.push('MARKED')
    if (flags & HL.STUNNED) tags.push('STUN')
    if (state.gas) tags.push('GAS')
    if (flags & HL.TAUNTING) tags.push('TAUNT')
  }
  if (weaponDef !== 65535 && !drawnAsDisguise && itemKind(weaponDef) === 'minigun') {
    const ws = a.wstate ? weaponStateAt(x, p, tick) : null
    if (ws && (ws.state === 1 || ws.state === 3)) tags.push('REV')
  }
  if (misc && misc.rage >= 100 && !drawnAsDisguise && hasLocalTables(x, p)) {
    for (const def of loadoutOf()) {
      const tag = RAGE_TAGS[itemInfo(def)?.buffType ?? 0]
      if (tag) {
        tags.push(tag)
        break
      }
    }
  }
  // flagClearedSince(HL.CLOAKED) within the window: only while the spy is uncloaked, so a recloak ends the tag
  const decloakAt =
    a.cond && classId === SPY && (flags & HL.CLOAKED) === 0
      ? recentFlagEdge(x, p, tick, HL.CLOAKED, false, DECLOAK_TAG_TICKS)
      : null
  if (decloakAt !== null) tags.push('DECLOAK')
  const medicCall = misc !== null && misc.saveMeTick >= 0 && tick - misc.saveMeTick < MEDIC_CALL_TICKS
  if (medicCall) tags.push('MEDIC!')
  if (tags.length) {
    extra.tags = tags
    any = true
  }

  // Pinned plates skip the S0 distance fade and the X1 nearest-12 cap
  const spyMeterDown = extra.cloakPct !== undefined && extra.cloakPct < 100
  if (
    (flags & (HL.DISGUISED | HL.DISGUISING | HL.UBER | HL.QUICKFIX_UBER | HL.VACC_UBER)) !== 0 ||
    inv > 0 ||
    spyMeterDown ||
    medicCall
  ) {
    extra.pinned = true
    any = true
  }

  // A cloaked spy's plate dims with the cloak fade (the 'pov' enemy rule above hides it instead)
  if (s.cloak && extra.opacity === undefined && inv > 0.5) {
    extra.opacity = 0.6
    any = true
  }

  return any ? extra : null
}

//
// ─── OVERLAYS ───────────────────────────────────────────────────────────────────
//

export interface OverlayState {
  /** team colour of the TEAM_FX effects (the drawn team) */
  team: TeamName
  scaleZ: number
  quickfix: boolean
  /** Vaccinator uber shell colour, null when none */
  vacc: string | null
  vaccCond: number
  bonk: boolean
  /** crit aura: full crit (with orbiters), humiliation crit bonus alone, minicrit */
  crit: 'crit' | 'bonus' | 'mini' | null
  soldierBuff: boolean
  burning: boolean
  bleeding: boolean
  jarate: boolean
  milk: boolean
  gas: boolean
  marked: boolean
  stun: boolean
  overheal: boolean
  teleport: boolean
  /** DISGUISING onset tick while the smoke lasts, else null */
  smokeTick: number | null
  /** CLOAKED falling-edge tick while the decloak ring lasts, else null */
  decloakTick: number | null
  /** nameplates are shown: they cover the space above the head, so the stun stars and the skull move below them */
  plates: boolean
}

/** Overlay effects of an actor at `tick` (section 5 F1 overlay table); null when nothing would be drawn. */
export function computeOverlays(input: FxInput, state: FxState): OverlayState | null {
  const { x, p, classId, tick, settings: s } = input
  if (!x.meta.available.cond || !state.drawnTeam) return null
  const f = state.flags
  const on = (bit: number) => (f & bit) !== 0
  const uber = s.conditions && s.fxUber
  const crit = s.conditions && s.fxCrit
  const debuffs = s.conditions && s.fxDebuffs
  const overheal = s.conditions && s.fxOverheal
  // An enemy spy the POV player cannot see keeps only what gives cloaked spies away in game: fire and drips
  const unseen = state.fx.hidden

  let vaccCond = 0
  if (uber && on(HL.VACC_UBER)) {
    for (const cond of [COND.MEDIGUN_UBER_BULLET_RESIST, COND.MEDIGUN_UBER_BLAST_RESIST, COND.MEDIGUN_UBER_FIRE_RESIST]) {
      if (condOn(x, state.condIndex, cond)) {
        vaccCond = cond
        break
      }
    }
  }

  let critKind: OverlayState['crit'] = null
  if (crit && !state.cloaked && !state.drawnAsDisguise && !unseen) {
    if (on(HL.CRIT)) critKind = 'crit'
    else if (on(HL.CRIT_BONUS)) critKind = 'bonus'
    else if (on(HL.MINICRIT)) critKind = 'mini'
  }

  // Disguise smoke shows to everyone but enemies while the spy is cloaked (tf_player_shared.cpp:3350-3371)
  const enemyEyes = state.view === 'enemy' || state.enemy
  const spy = classId === SPY
  const smokeTick =
    spy && s.cloak && !(enemyEyes && state.cloaked)
      ? recentFlagEdge(x, p, tick, HL.DISGUISING, true, DISGUISE_SMOKE_TICKS)
      : null
  // flagClearedSince(HL.CLOAKED): only while the spy is uncloaked, so a recloak ends the ring
  const decloakTick =
    spy && s.cloak && !on(HL.CLOAKED) ? recentFlagEdge(x, p, tick, HL.CLOAKED, false, DECLOAK_RING_TICKS) : null

  const o: OverlayState = {
    team: state.drawnTeam,
    scaleZ: state.fx.scaleZ,
    quickfix: uber && !unseen && on(HL.QUICKFIX_UBER),
    vacc: !unseen && vaccCond ? VACC_COLORS[vaccCond] ?? null : null,
    vaccCond: unseen ? 0 : vaccCond,
    bonk: uber && !unseen && on(HL.BONK),
    crit: critKind,
    soldierBuff: crit && !unseen && on(HL.SOLDIER_BUFF),
    burning: debuffs && on(HL.BURNING),
    bleeding: debuffs && on(HL.BLEEDING),
    jarate: debuffs && on(HL.JARATED),
    milk: debuffs && on(HL.MILKED),
    gas: debuffs && state.gas,
    // The game hides the mark-for-death icon on stealthed and disguised players (C_TFPlayer::UpdatedMarkedForDeathEffect).
    // While nameplates show the Highlander items, the plate's MARKED tag (with a skull) carries it instead: the plate
    // covers the space above the head where the skull would float.
    marked: debuffs && !unseen && on(HL.MARKED) && !state.cloaked && !on(HL.DISGUISED) && !(s.nameplates && s.nameplateExtras),
    stun: debuffs && !unseen && on(HL.STUNNED),
    overheal: overheal && !unseen && on(HL.OVERHEALED),
    teleport: overheal && !unseen && on(HL.TELEPORTED),
    smokeTick,
    decloakTick,
    plates: s.nameplates,
  }
  return o
}

/** Names of the overlay effects in `o` that draw at `tickF` (the fx.overlays probe). */
export function overlayNames(o: OverlayState | null, tickF: number): string[] {
  if (!o) return []
  const names: string[] = []
  if (o.quickfix) names.push('quickfix')
  if (o.vacc) names.push(`vacc:${o.vaccCond}`)
  if (o.bonk) names.push('bonk')
  if (o.crit === 'crit') names.push('crit', 'critOrbiters')
  else if (o.crit === 'bonus') names.push('critBonus')
  else if (o.crit === 'mini') names.push('minicrit')
  if (o.soldierBuff) names.push('soldierBuff')
  if (o.burning) names.push('burning')
  if (o.bleeding) names.push('bleeding')
  if (o.jarate) names.push('jarate')
  if (o.milk) names.push('milk')
  if (o.gas) names.push('gas')
  if (o.marked) names.push('marked')
  if (o.stun) names.push('stun')
  if (o.overheal) names.push('overheal')
  if (o.teleport) names.push('teleport')
  if (o.smokeTick !== null && tickF - o.smokeTick >= 0 && tickF - o.smokeTick < DISGUISE_SMOKE_TICKS) names.push('disguiseSmoke')
  if (o.decloakTick !== null && tickF - o.decloakTick >= 0 && tickF - o.decloakTick < DECLOAK_RING_TICKS) names.push('decloak')
  return names
}
