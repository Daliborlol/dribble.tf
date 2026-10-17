// POV subject (contract D16 and section 5 F4). S0 writes the types and a stub: the subject is always the
// focused player with camera 'own'. F4 writes the dead-POV policy, chase and death cameras.

import { useMemo } from 'react'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { useInstance, useStore } from '@zus/store'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import type { HighlanderExtras } from '@highlander/extras/types'

export type PovCameraKind = 'own' | 'spectated' | 'chase' | 'deathcam' | 'stay'
export interface PovSubject {
  focusedEntityId: number; focusedP: number      // the player the user picked
  entityId: number; p: number                    // the player whose view, FOV, viewmodel and HUD are shown
  camera: PovCameraKind
  killerEntityId?: number                        // deathcam: the actor the camera looks at
  deathTick?: number                             // deathcam: the focused player's latest death at or before the tick
}
export function povSubjectAt(_x: HighlanderExtras | undefined, demo: AsyncParser, focusedEntityId: number, _tick: number, _opts: { deadPov: 'stay' | 'spectated'; chase: boolean }): PovSubject {
  const focusedP = demo.playerIndexOfEntity(focusedEntityId)
  return { focusedEntityId, focusedP, entityId: focusedEntityId, p: focusedP, camera: 'own' }
}
/** Null unless the controls mode is 'pov' and focusedObject is set. */
export function usePovSubject(renderTick: number): PovSubject | null {
  const controlsMode = useStore(s => s.scene.controls.mode)
  const focusedEntityId = useInstance(s => s.focusedObject?.userData?.entityId as number | undefined)
  const demo = useInstance(s => s.parsedDemo)
  const extras = useExtras()
  const deadPov = useHlSetting<'stay' | 'spectated'>('pov.deadPov')
  const chase = useHlSetting<boolean>('pov.chase')

  return useMemo(() => {
    if (controlsMode !== 'pov' || focusedEntityId === undefined || !demo) return null
    return povSubjectAt(extras, demo, focusedEntityId, renderTick, { deadPov, chase })
  }, [controlsMode, focusedEntityId, demo, extras, renderTick, deadPov, chase])
}
