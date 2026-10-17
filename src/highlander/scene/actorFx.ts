// Per-actor visual state that Actors.tsx applies to each player (contract sections 6.4 and 5 F1).
// S0 ships the types and a stub hook that returns the defaults; F1 writes the body of useActorFx.

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
})

/** DEFAULT_ACTOR_FX with the actor's base class and team. */
export function defaultActorFx(classId: number, team: string): ActorFx {
  return { ...DEFAULT_ACTOR_FX, modelClassId: classId, modelTeam: team }
}

/**
 * S0 stub: always DEFAULT_ACTOR_FX, which is what F1 returns while extras are not ready or `enabled` is off
 * (contract 5 F1), so S0 already runs that path. F1 replaces the body; the signature is fixed.
 */
export function useActorFx(_entityId: number, _renderTick: number, _classId: number, _team: string): ActorFx {
  return DEFAULT_ACTOR_FX
}
