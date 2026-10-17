// Scene and store lookups for the buildings layer: the POV-rendered actor, base player state and the enemy
// positions for the AIM_AT_ENEMY fallback. Kept apart from render.ts, which stays a pure function of the extras.

import * as THREE from 'three'

import { BUILDING_TYPE, ENEMY } from '@highlander/extras/enums'
import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { getActor } from '@highlander/scene/actorRegistry'
import { getState, useInstance } from '@zus/store'

import { buildingTop } from './render'
import { ENEMY_AIM_HEIGHT } from './sentryAim'

/** DemoViewer's renderTick for code outside the React tree (probes): playback tick minus 2, at least 1. */
export const renderTickNow = () => Math.max(1, (getState().playback.tick ?? 1) - 2)

/** The extras when they are ready, else null. */
export const readyExtras = (): HighlanderExtras | null => {
  const { extras, extrasStatus } = useInstance.getState()
  return extrasStatus === 'ready' && extras ? extras : null
}

/**
 * Entity id of the actor whose own `povCamera` the scene renders from, the way Actors.tsx decides `isFocusedPOV`:
 * in POV mode the focused actor, or, while a camera override is set, the actor that owns that `povCamera` (a chase
 * or death camera owns none). Undefined outside POV.
 */
export function povRenderedEntityId(): number | undefined {
  if (getState().scene.controls.mode !== 'pov') return undefined
  const { focusedObject, povCameraOverride } = useInstance.getState()
  if (!focusedObject) return undefined
  if (!povCameraOverride) return focusedObject.userData?.entityId
  if (povCameraOverride.name !== 'povCamera') return undefined
  for (let node: THREE.Object3D | null = povCameraOverride; node; node = node.parent) {
    if (node.name === 'actor') return node.userData?.entityId
  }
  return undefined
}

/** Base health of player p at tick (0 when dead or unknown). */
export function baseHealth(p: number, tick: number): number {
  const demo = useInstance.getState().parsedDemo
  if (!demo || p < 0 || p >= demo.nextMappedPlayer) return 0
  return demo.playerCache.healthCache.get(p, tick) || 0
}

/** Base team key of player p at tick. */
export function baseTeam(p: number, tick: number): 'red' | 'blue' | null {
  const demo = useInstance.getState().parsedDemo
  if (!demo || p < 0 || p >= demo.nextMappedPlayer) return null
  const teamId = demo.playerCache.metaCache.getMeta(p, tick).teamId
  return teamId === 2 ? 'red' : teamId === 3 ? 'blue' : null
}

/** Base position of player p at tick in scene space, null when the base has none (0, 0, 0). */
export function basePosition(p: number, tick: number): { x: number; y: number; z: number } | null {
  const demo = useInstance.getState().parsedDemo
  if (!demo || p < 0 || p >= demo.nextMappedPlayer) return null
  const v = demo.playerCache.positionCache.getPosition(p, tick)
  return v.x === 0 && v.y === 0 && v.z === 0 ? null : v
}

/**
 * Resolves a sentry enemy to a scene point (AIM_AT_ENEMY mode): a player's drawn actor at chest height
 * (WorldSpaceCenter), or a building's middle.
 */
export function enemyCentreResolver(): (kind: number, index: number) => { x: number; y: number; z: number } | null {
  const out = new THREE.Vector3()
  return (kind, index) => {
    const x = readyExtras()
    if (!x) return null
    if (kind === ENEMY.PLAYER) {
      const actor = getActor(x.players.entityId[index] ?? -1)
      if (!actor) return null
      return out.copy(actor.group.position).setZ(actor.group.position.z + ENEMY_AIM_HEIGHT)
    }
    if (kind === ENEMY.BUILDING && index < x.buildings.count) {
      const b = x.buildings
      const i = trackIndexAt(b.xform, index, renderTickNow())
      if (i < 0) return null
      const si = trackIndexAt(b.state, index, renderTickNow())
      const level = si >= 0 ? b.state.level[si] : 1
      const half = b.type[index] === BUILDING_TYPE.SAPPER ? 4 : buildingTop(b.type[index], level, b.mini[index] !== 0, b.mode[index]) / 2
      return out.set(b.xform.x[i], b.xform.y[i], b.xform.z[i] + half)
    }
    return null
  }
}
