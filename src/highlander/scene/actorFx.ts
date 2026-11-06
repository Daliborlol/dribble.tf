// Per-actor visual state that Actors.tsx applies to each player (contract sections 6.4 and 5 F1).
// S0 shipped the types and DEFAULT_ACTOR_FX; F1 writes the body of useActorFx. The rules live in
// src/highlander/players/fxState.ts, shared with the PlayerFxLayer overlays and the fx.* probes.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { playerIndexOf } from '@highlander/extras/getters'
import type { HighlanderExtras } from '@highlander/extras/types'
import { computeFxState } from '@highlander/players/fxState'
import type { FxSettings } from '@highlander/players/fxSettings'
import { povInfoOf } from '@highlander/players/pov'
import type { PovSubject } from '@highlander/pov/subject'

export interface NameplateExtra {
  disguise?: { cls: number; team: number; disguising: boolean; targetName?: string; health?: number }
  cloakPct?: number
  chargePct?: number           // demoman shield charge bar
  weaponIcon?: string          // kill icon file of the shown weapon (players.nameplateWeapon)
  tags?: string[]
  opacity?: number
  pinned?: boolean             // exempt from the distance fade (S0) and the nearest-12 cap (X1)
  nameOverride?: string        // spy drawn as his disguise: the disguise target's name
  healthOverride?: number      // spy drawn as his disguise: disguise health
  classOverride?: number       // spy drawn as his disguise: disguise class
  teamOverride?: string        // spy drawn as his disguise: disguise team, 'red' | 'blue' (F1 addition)
}
export interface ActorFx {
  modelClassId: number; modelTeam: string; opacity: number; tint: string | null; emissive: number; hidden: boolean; scaleZ: number; nameplate: NameplateExtra | null
  /** Item def held in third person (the disguise weapon while drawn as the disguise); -1 for none or unknown. */
  weaponDef: number
  /** Loadout weapon defs, comma separated ('' while drawn as the disguise), for the pack's extra wearables. */
  loadoutDefs: string
}

/**
 * Defaults: base class and team, opacity 1, no tint, emissive 0, not hidden, scaleZ 1, no nameplate extra.
 * `modelClassId` 0 and `modelTeam` '' mean "the actor's base class and team": Actors.tsx draws the base model
 * for them, so useActorFx may return this object as it is. `defaultActorFx` fills the two fields in instead.
 */
export const DEFAULT_ACTOR_FX: Readonly<ActorFx> = Object.freeze({
  modelClassId: 0,
  modelTeam: '',
  opacity: 1,
  tint: null,
  emissive: 0,
  hidden: false,
  scaleZ: 1,
  nameplate: null,
  weaponDef: -1,
  loadoutDefs: '',
})

/** DEFAULT_ACTOR_FX with the actor's base class and team. */
export function defaultActorFx(classId: number, team: string): ActorFx {
  return { ...DEFAULT_ACTOR_FX, modelClassId: classId, modelTeam: team }
}

/**
 * The actor's model class and team, cloak opacity and tint, condition tint, crouch scale and nameplate items at `tick`
 * (section 5 F1). Returns the frozen DEFAULT_ACTOR_FX while the extras are not ready, while Highlander is off and for
 * players the extras do not know; the result is a new object otherwise (never mutated). A pure function of its
 * arguments, so a store selector can run it on every tick and render only when `actorFxEqual` says it changed.
 */
export function actorFxAt(
  x: HighlanderExtras | undefined,
  demo: AsyncParser | undefined,
  settings: FxSettings,
  subject: PovSubject | null,
  entityId: number,
  tick: number,
  classId: number,
  team: string
): ActorFx {
  if (!settings.enabled || !x || !demo) return DEFAULT_ACTOR_FX
  const p = playerIndexOf(x, entityId)
  if (p < 0) return DEFAULT_ACTOR_FX
  const pov = povInfoOf(demo, subject, tick)
  return computeFxState({ x, demo, p, classId, team, tick, settings, pov, nameplate: true }).fx
}
