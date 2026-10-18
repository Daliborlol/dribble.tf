// Scene and store lookups for the buildings layer: the POV-rendered actor, the POV subject, base player state and the
// enemy positions for the AIM_AT_ENEMY fallback. Kept apart from render.ts, which stays a pure function of the
// extras.

import * as THREE from 'three'

import { BUILDING_TYPE, ENEMY } from '@highlander/extras/enums'
import { getHlSetting } from '@highlander/extras/hooks'
import { trackIndexAt, xformAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { povSubjectAt } from '@highlander/pov/subject'
import { getState, useInstance } from '@zus/store'

import { buildingTop } from './render'
import { ENEMY_AIM_HEIGHT, type EnemyCentre } from './sentryAim'

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

export interface PovLabelContext {
  /** the POV subject's player index (contract D16), -1 when unknown */
  p: number
  /** the subject's own building labels hide: he is alive and the POV weapon HUD (`pov.weaponHud`) lists them */
  ownHidden: boolean
}

// One entry per extras object (no strong reference to an old demo), recomputed when the tick or an input changes
const povCache = new WeakMap<HighlanderExtras, { key: string; demo: unknown; value: PovLabelContext | null }>()

/**
 * The building labels' POV context at a cache tick: null outside POV mode, else the POV subject (section 6.5
 * `povSubjectAt`, the focused player or, while he is dead, the player he spectates) and whether his own buildings'
 * labels hide because F4's weapon HUD shows them. A pure function of the demo data, the tick and the settings.
 */
export function povLabelContext(x: HighlanderExtras, tick: number): PovLabelContext | null {
  if (getState().scene.controls.mode !== 'pov') return null
  const { focusedObject, parsedDemo } = useInstance.getState()
  const focused = focusedObject?.userData?.entityId as number | undefined
  if (focused === undefined || !parsedDemo) return null
  const deadPov = getHlSetting<'stay' | 'spectated'>('pov.deadPov') ?? 'spectated'
  const chase = getHlSetting<boolean>('pov.chase') === true
  const weaponHud = getHlSetting<boolean>('pov.weaponHud') !== false
  const key = `${tick}|${focused}|${deadPov}|${chase}|${weaponHud}`
  const hit = povCache.get(x)
  if (hit && hit.key === key && hit.demo === parsedDemo) return hit.value
  const subject = povSubjectAt(x, parsedDemo, focused, tick, { deadPov, chase })
  const value: PovLabelContext = { p: subject.p, ownHidden: weaponHud && subject.p >= 0 && baseHealth(subject.p, tick) > 0 }
  povCache.set(x, { key, demo: parsedDemo, value })
  return value
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

/** Actors.tsx does not interpolate across a jump longer than this (a teleport or respawn). */
const TELEPORT_LERP_DISTANCE = 4096

/** Base position of player p at a fractional tick, interpolated like the actors are, null when unknown. */
export function basePositionAt(p: number, tickF: number): { x: number; y: number; z: number } | null {
  const tick = Math.floor(tickF)
  const a = basePosition(p, tick)
  const f = tickF - tick
  if (!a || f <= 0) return a
  const b = basePosition(p, tick + 1)
  if (!b || Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > TELEPORT_LERP_DISTANCE) return a
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f }
}

const _q = new THREE.Quaternion()

/**
 * Resolves a sentry enemy to a scene point at tickF (AIM_AT_ENEMY mode): a player's base position at chest height
 * (WorldSpaceCenter), or a building's middle. Pure in (demo data, tickF), so the scene and the `buildings.draw`
 * probe agree at any tick. The returned object is reused by the next call.
 */
export function enemyCentreResolver(): EnemyCentre {
  const out = new THREE.Vector3()
  return (kind, index, tickF) => {
    const x = readyExtras()
    if (!x) return null
    if (kind === ENEMY.PLAYER) {
      const v = basePositionAt(index, tickF)
      return v ? out.set(v.x, v.y, v.z + ENEMY_AIM_HEIGHT) : null
    }
    if (kind === ENEMY.BUILDING && index < x.buildings.count) {
      const b = x.buildings
      if (!xformAt(b.xform, index, tickF, out, _q, x.meta.snapshotInterval || 1)) return null
      const si = trackIndexAt(b.state, index, Math.floor(tickF))
      const level = si >= 0 ? b.state.level[si] : 1
      out.z += b.type[index] === BUILDING_TYPE.SAPPER ? 4 : buildingTop(b.type[index], level, b.mini[index] !== 0, b.mode[index]) / 2
      return out
    }
    return null
  }
}
