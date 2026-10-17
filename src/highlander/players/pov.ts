// POV helpers for F1: the POV subject (D16, F4's povSubjectAt) and the actor whose own povCamera renders.
// React code uses usePovSubject; useFrame callbacks and probes use these store reads, which mirror it.

import type * as THREE from 'three'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { getState, useInstance } from '@zus/store'
import { getHlSetting } from '@highlander/extras/hooks'
import type { HighlanderExtras } from '@highlander/extras/types'
import { povSubjectAt, type PovSubject } from '@highlander/pov/subject'

/** The POV subject as F1 needs it: who he is and his team at the tick (2 RED, 3 BLU; anything else has no enemies). */
export interface PovInfo {
  p: number
  entityId: number
  team: number
}

/** Base team id of player p at a cache tick (0 when unknown). */
export function teamOfPlayer(demo: AsyncParser, p: number, tick: number): number {
  if (p < 0) return 0
  return demo.playerCache.metaCache.getMeta(p, Math.max(0, Math.floor(tick))).teamId
}

export function povInfoOf(demo: AsyncParser, subject: PovSubject | null, tick: number): PovInfo | null {
  if (!subject) return null
  return { p: subject.p, entityId: subject.entityId, team: teamOfPlayer(demo, subject.p, tick) }
}

/** Same as usePovSubject for non-React code: null unless the controls mode is 'pov' and a player is focused. */
export function currentPovSubject(x: HighlanderExtras | undefined, demo: AsyncParser, tick: number): PovSubject | null {
  if (getState().scene.controls.mode !== 'pov') return null
  const focusedEntityId = useInstance.getState().focusedObject?.userData?.entityId as number | undefined
  if (focusedEntityId === undefined) return null
  const deadPov = getHlSetting<'stay' | 'spectated'>('pov.deadPov') ?? 'spectated'
  const chase = !!getHlSetting<boolean>('pov.chase')
  return povSubjectAt(x, demo, focusedEntityId, tick, { deadPov, chase })
}

/** Entity id of the actor whose own `povCamera` this is (the same walk as Actors.tsx), else undefined. */
function povCameraOwnerOf(camera?: THREE.Object3D): number | undefined {
  if (camera?.name !== 'povCamera') return undefined
  for (let node: THREE.Object3D | null = camera; node; node = node.parent) {
    if (node.name === 'actor') return node.userData?.entityId
  }
  return undefined
}

/**
 * The actor the scene renders from his own povCamera (Actors.tsx `isFocusedPOV`): in POV mode the focused actor,
 * or, while a camera override is set, the actor owning that povCamera. A chase or death camera owns none.
 */
export function povCameraOwnerEntityId(): number | undefined {
  if (getState().scene.controls.mode !== 'pov') return undefined
  const { focusedObject, povCameraOverride } = useInstance.getState()
  if (!focusedObject) return undefined
  if (povCameraOverride) return povCameraOwnerOf(povCameraOverride)
  return focusedObject.userData?.entityId
}
