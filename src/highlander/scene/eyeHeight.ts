// POV eye height above the player origin (contract section 5 F4, eyeHeight.ts). First version by S0; F4 refines it.

import { getState, useInstance } from '@zus/store'
import { DUCK_EYE_HEIGHT, EYE_HEIGHT, LEGACY_EYE_HEIGHT } from '@highlander/constants'
import { registerHlProbe } from '@highlander/debug'
import { eyeZAt } from '@highlander/extras/getters'
import { getHlSetting } from '@highlander/extras/hooks'

/**
 * LEGACY_EYE_HEIGHT (83) when `enabled` or `pov.eyeHeight` is off. Otherwise the networked view offset
 * (`eyeZAt`) when the extras have it, else DUCK_EYE_HEIGHT while the base duck bit 0 is set, else the class
 * eye height. `tick` is a cache tick (the actor's renderTick).
 */
export function getEyeHeight(entityId: number, classId: number, tick: number): number {
  if (!getHlSetting<boolean>('enabled') || !getHlSetting<boolean>('pov.eyeHeight'))
    return LEGACY_EYE_HEIGHT

  const { parsedDemo, extras, extrasStatus } = useInstance.getState()
  const p = parsedDemo ? parsedDemo.playerIndexOfEntity(entityId) : -1

  if (p >= 0 && extras && extrasStatus === 'ready' && extras.meta.available.view) {
    const eyeZ = eyeZAt(extras, p, tick)
    if (eyeZ !== null && eyeZ > 0) return eyeZ
  }

  if (p >= 0 && parsedDemo && (parsedDemo.playerCache.getDuck(p, tick) & 1) !== 0)
    return DUCK_EYE_HEIGHT

  return EYE_HEIGHT[classId] ?? LEGACY_EYE_HEIGHT
}

// Probe: the eye height every rendered player gets at a cache tick (default: the current renderTick).
registerHlProbe('eyeHeight.at', (tick?: number) => {
  const demo = useInstance.getState().parsedDemo
  if (!demo) return []
  const atTick = Math.max(1, Math.floor(tick ?? getState().playback.tick - 2))
  return demo
    .getPlayersAtTick(atTick)
    .filter(({ connected, teamId }) => connected && (teamId === 2 || teamId === 3))
    .map(player => {
      const p = demo.playerIndexOfEntity(player.user.entityId)
      return {
        entityId: player.user.entityId,
        name: player.user.name,
        classId: player.classId,
        duck: p >= 0 ? demo.playerCache.getDuck(p, atTick) : 0,
        eyeHeight: getEyeHeight(player.user.entityId, player.classId, atTick),
      }
    })
})
