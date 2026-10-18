// Actor lookups shared by the overlay layer and the fx.* probes: player index, base class, team and health at a
// tick, then the F1 state of fxState.ts.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { playerIndexOf } from '@highlander/extras/getters'
import type { HighlanderExtras } from '@highlander/extras/types'

import type { FxSettings } from './fxSettings'
import { computeFxState, computeOverlays, type FxState, type OverlayState } from './fxState'
import type { PovInfo } from './pov'

export interface ActorInputs {
  x: HighlanderExtras
  demo: AsyncParser
  settings: FxSettings
  pov: PovInfo | null
  /** entity id of the actor whose own povCamera renders the scene */
  povOwner: number | undefined
}

export interface ActorAt {
  p: number
  classId: number
  teamId: number
  team: string
  health: number
  /** alive, on RED or BLU, and not the actor the scene renders from his own povCamera */
  drawn: boolean
  state: FxState
  overlays: OverlayState | null
}

/** Base player values and the F1 state of an actor at a cache tick, null for entity ids the extras do not know. */
export function actorAt(inputs: ActorInputs, entityId: number, tick: number, nameplate: boolean): ActorAt | null {
  const { x, demo, settings, pov, povOwner } = inputs
  const p = playerIndexOf(x, entityId)
  if (p < 0) return null
  const meta = demo.playerCache.metaCache.getMeta(p, tick)
  const health = demo.playerCache.healthCache.get(p, tick)
  const team = meta.teamId === 2 ? 'red' : meta.teamId === 3 ? 'blue' : ''
  const state = computeFxState({ x, demo, p, classId: meta.classId, team, tick, settings, pov, nameplate })
  const drawn = health > 0 && team !== '' && entityId !== povOwner
  const overlays = drawn
    ? computeOverlays({ x, demo, p, classId: meta.classId, team, tick, settings, pov, nameplate: false }, state)
    : null
  return { p, classId: meta.classId, teamId: meta.teamId, team, health, drawn, state, overlays }
}
