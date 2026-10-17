// POV subject (contract D16 and section 5 F4): the one player whose view, FOV, viewmodel, scope and weapon HUD the
// POV mode shows. It is the focused player while he lives. While he is dead, `pov.deadPov` decides: 'stay' keeps
// his own (dead) camera; 'spectated' follows his networked observer state: a death camera during DEATHCAM and
// FREEZECAM, then the teammate he spectates in IN_EYE (or CHASE) mode.
//
// povSubjectAt is a pure function of the demo data and the tick (D12): it reads the base caches (health, team,
// connection, deaths) and the extras `misc` track, never the scene.

import { useMemo } from 'react'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { useInstance, useStore } from '@zus/store'
import { OBS_MODE } from '@highlander/extras/enums'
import { miscAt } from '@highlander/extras/getters'
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

/** Base death events can trail the health drop by up to one 4-tick health bucket; look this far ahead for them. */
const DEATH_LOOKAHEAD = 4
/**
 * The server sets the observer target to the killer on the death tick but switches the observer mode to DEATHCAM
 * one to three ticks later. While the mode still reads NONE this soon after a death, the target already is the
 * killer, so the death camera looks at him from the first tick instead of snapping to him a few ticks later.
 */
const DEATHCAM_GRACE_TICKS = 8
const NONE_U8 = 255

// Death ticks per victim entity id, ascending, built once per parsed demo from the base `deaths`.
const deathIndex = new WeakMap<AsyncParser, Map<number, number[]>>()

function deathTicksOf(demo: AsyncParser, entityId: number): number[] {
  let index = deathIndex.get(demo)
  if (!index) {
    index = new Map()
    for (const key in demo.deaths) {
      for (const death of demo.deaths[key]) {
        const victim = death.victim?.user?.entityId
        if (victim === undefined) continue
        let list = index.get(victim)
        if (!list) index.set(victim, (list = []))
        list.push(death.tick)
      }
    }
    for (const list of index.values()) list.sort((a, b) => a - b)
    deathIndex.set(demo, index)
  }
  return index.get(entityId) ?? []
}

/** The latest base death of `entityId` at or before `tick` (plus the health-bucket lookahead), or null. */
export function latestDeathTick(demo: AsyncParser, entityId: number, tick: number): number | null {
  const list = deathTicksOf(demo, entityId)
  let lo = 0, hi = list.length
  const limit = tick + DEATH_LOOKAHEAD
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid] <= limit) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? list[lo - 1] : null
}

/** Base health of player index p at a cache tick (4-tick buckets, as the actors use it); 0 outside the demo. */
export function baseHealthAt(demo: AsyncParser, p: number, tick: number): number {
  if (p < 0 || tick < 0 || tick >= demo.ticks) return 0
  return demo.playerCache.healthCache.get(p, tick) || 0
}

/** True when DemoViewer renders an actor for p at the tick (connected, on RED or BLU) and he is alive. */
export function aliveWithActorAt(demo: AsyncParser, p: number, tick: number): boolean {
  if (p < 0 || p >= demo.nextMappedPlayer) return false
  if (baseHealthAt(demo, p, tick) <= 0) return false
  if (!demo.playerCache.connectedCache.get(p, tick)) return false
  const team = demo.playerCache.metaCache.getMeta(p, tick).teamId
  return team === 2 || team === 3
}

/** Entity id of player index p, or -1. */
export function entityIdOfPlayer(demo: AsyncParser, p: number): number {
  return demo.entityPlayerMap.get(p)?.user.entityId ?? -1
}

export function povSubjectAt(x: HighlanderExtras | undefined, demo: AsyncParser, focusedEntityId: number, tick: number, opts: { deadPov: 'stay' | 'spectated'; chase: boolean }): PovSubject {
  const focusedP = demo.playerIndexOfEntity(focusedEntityId)
  const own: PovSubject = { focusedEntityId, focusedP, entityId: focusedEntityId, p: focusedP, camera: opts.chase ? 'chase' : 'own' }
  if (focusedP < 0 || baseHealthAt(demo, focusedP, tick) > 0) return own

  // Dead from here on
  if (opts.deadPov === 'stay') return { ...own, camera: 'stay' }

  const deathTick = latestDeathTick(demo, focusedEntityId, tick) ?? undefined
  const deathcam: PovSubject = { focusedEntityId, focusedP, entityId: focusedEntityId, p: focusedP, camera: 'deathcam', deathTick }

  const misc = x && x.meta.available.misc ? miscAt(x, focusedP, tick) : null
  if (!misc) return deathcam
  const { obsMode, obsTarget } = misc
  const targetEntityId = obsTarget === NONE_U8 ? -1 : entityIdOfPlayer(demo, obsTarget)

  if ((obsMode === OBS_MODE.IN_EYE || obsMode === OBS_MODE.CHASE) && targetEntityId > 0 && obsTarget !== focusedP && aliveWithActorAt(demo, obsTarget, tick)) {
    const camera: PovCameraKind = obsMode === OBS_MODE.CHASE || opts.chase ? 'chase' : 'spectated'
    return { focusedEntityId, focusedP, entityId: targetEntityId, p: obsTarget, camera }
  }

  const freshDeath = obsMode === OBS_MODE.NONE && deathTick !== undefined && tick - deathTick <= DEATHCAM_GRACE_TICKS
  if (obsMode === OBS_MODE.DEATHCAM || obsMode === OBS_MODE.FREEZECAM || freshDeath) {
    // A suicide (or a non-player killer such as a sentry, target 255) has no killer actor to look at
    if (targetEntityId > 0 && obsTarget !== focusedP) return { ...deathcam, killerEntityId: targetEntityId }
  }
  return deathcam
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

/** usePovSubject for non-React code (probes, useFrame callbacks): the subject at `tick` from the stores. */
export function getPovSubject(tick: number): PovSubject | null {
  const { focusedObject, parsedDemo, extras, extrasStatus } = useInstance.getState()
  const settings = useStore.getState().settings
  const focusedEntityId = focusedObject?.userData?.entityId as number | undefined
  if (useStore.getState().scene.controls.mode !== 'pov' || focusedEntityId === undefined || !parsedDemo) return null
  const pov = settings.highlander?.pov
  return povSubjectAt(extrasStatus === 'ready' ? extras : undefined, parsedDemo, focusedEntityId, tick, {
    deadPov: pov?.deadPov ?? 'spectated',
    chase: !!pov?.chase,
  })
}
