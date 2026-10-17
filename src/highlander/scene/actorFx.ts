// Per-actor visual state that Actors.tsx applies to each player (contract sections 6.4 and 5 F1).
// S0 ships the types and a stub hook that returns the defaults; F1 writes the body of useActorFx.

import { useMemo } from 'react'

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
}
export interface ActorFx { modelClassId: number; modelTeam: string; opacity: number; tint: string | null; emissive: number; hidden: boolean; scaleZ: number; nameplate: NameplateExtra | null }

/**
 * Defaults: opacity 1, no tint, emissive 0, not hidden, scaleZ 1, no nameplate extra. The model class and
 * team are the actor's base class and team, which `defaultActorFx` fills in (0 and '' here mean "base").
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
})

/** DEFAULT_ACTOR_FX with the actor's base class and team. */
export function defaultActorFx(classId: number, team: string): ActorFx {
  return { ...DEFAULT_ACTOR_FX, modelClassId: classId, modelTeam: team }
}

/** S0 stub: always the defaults (base class and team). F1 replaces the body; the signature is fixed. */
export function useActorFx(_entityId: number, _renderTick: number, classId: number, team: string): ActorFx {
  return useMemo(() => defaultActorFx(classId, team), [classId, team])
}
