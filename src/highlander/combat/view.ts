// Player anchors for the effects F3 attaches to players (flames, airblast, muzzle flashes, deflect flashes,
// hitscan tracers seen from the shooter's own eyes).
//
// `playerViewAt` is a pure function of the base caches: position and view angles at floor(tickF) lerped toward the
// next tick, like the actors. The rendering resolver replaces the position with the actor's drawn group position
// (the actors smooth their motion during playback), so a flame stays in the pyro's hands. While paused both agree.

import * as THREE from 'three'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { getState, useInstance } from '@zus/store'
import { getActor } from '@highlander/scene/actorRegistry'
import { getEyeHeight } from '@highlander/scene/eyeHeight'

const DEG = Math.PI / 180
const TELEPORT_DISTANCE = 4096

export interface PlayerView {
  p: number
  entityId: number
  classId: number
  team: number
  alive: boolean
  /** connected and on RED or BLU: DemoViewer renders an actor for him */
  drawn: boolean
  /** feet position (scene space) */
  pos: THREE.Vector3
  /** eye height above the feet */
  eye: number
  pitch: number
  yaw: number
  forward: THREE.Vector3
  right: THREE.Vector3
  up: THREE.Vector3
  /** true when `pos` is the actor's drawn position */
  fromActor: boolean
}

export function makePlayerView(): PlayerView {
  return {
    p: -1, entityId: 0, classId: 0, team: 0, alive: false, drawn: false,
    pos: new THREE.Vector3(), eye: 0, pitch: 0, yaw: 0,
    forward: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1),
    fromActor: false,
  }
}

/** Shortest-path lerp of two angles in degrees. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180
  if (!Number.isFinite(d)) d = 0
  return a + d * t
}

/** Source view vectors (contract Appendix B.4), roll 0. */
export function setViewVectors(view: PlayerView, pitchDeg: number, yawDeg: number): void {
  const sp = Math.sin(pitchDeg * DEG), cp = Math.cos(pitchDeg * DEG)
  const sy = Math.sin(yawDeg * DEG), cy = Math.cos(yawDeg * DEG)
  view.pitch = pitchDeg
  view.yaw = yawDeg
  view.forward.set(cp * cy, cp * sy, -sp)
  view.right.set(sy, -cy, 0)
  view.up.set(sp * cy, sp * sy, cp)
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

/**
 * Base-cache view of player p at tickF (pure). Returns false when the demo has no such player. Zero view angles
 * (a parser quirk Actors.tsx also works around) fall back to the other tick's angles.
 */
export function playerViewAt(demo: AsyncParser, p: number, tickF: number, out: PlayerView): boolean {
  const ref = demo.entityPlayerMap.get(p)
  if (!ref || p < 0) return false
  const pc = demo.playerCache
  const last = Math.max(0, demo.ticks - 1)
  const t0 = Math.min(Math.max(Math.floor(tickF), 0), last)
  const t1 = Math.min(t0 + 1, last)
  const f = Math.min(Math.max(tickF - t0, 0), 1)

  const meta = pc.metaCache.getMeta(p, t0)
  out.p = p
  out.entityId = ref.user.entityId
  out.classId = meta.classId
  out.team = meta.teamId
  out.alive = pc.healthCache.get(p, t0) > 0
  out.drawn = !!pc.connectedCache.get(p, t0) && (meta.teamId === 2 || meta.teamId === 3)
  out.fromActor = false

  const a = pc.positionCache.getPosition(p, t0)
  const b = pc.positionCache.getPosition(p, t1)
  _a.set(a.x, a.y, a.z)
  _b.set(b.x, b.y, b.z)
  if (f > 0 && _a.distanceTo(_b) <= TELEPORT_DISTANCE) out.pos.copy(_a).lerp(_b, f)
  else out.pos.copy(_a)

  let ang0 = pc.viewAnglesCache.getAngles(p, t0)
  let ang1 = pc.viewAnglesCache.getAngles(p, t1)
  const zero = (v: { x: number; y: number; z: number }) => v.x === 0 && v.y === 0 && v.z === 0
  if (zero(ang0)) ang0 = ang1
  if (zero(ang1)) ang1 = ang0
  setViewVectors(out, lerpAngle(ang0.x, ang1.x, f), lerpAngle(ang0.y, ang1.y, f))

  out.eye = getEyeHeight(out.entityId, out.classId, t0)
  return true
}

/** Same as playerViewAt, with the position of the actor group as drawn this frame when the actor is mounted. */
export function playerViewDrawn(demo: AsyncParser, p: number, tickF: number, out: PlayerView): boolean {
  if (!playerViewAt(demo, p, tickF, out)) return false
  const actor = getActor(out.entityId)
  if (actor) {
    actor.group.getWorldPosition(out.pos)
    out.fromActor = true
  }
  return true
}

/** Flame and airblast origin: feet + (0, 0, eye - 12) + forward * 20. */
export function pyroMuzzle(view: PlayerView, out: THREE.Vector3): THREE.Vector3 {
  out.copy(view.pos).addScaledVector(view.forward, 20)
  out.z += view.eye - 12
  return out
}

/** Muzzle flash point: feet + (0, 0, eye - 10) + forward * 26 + right * 8. */
export function gunMuzzle(view: PlayerView, out: THREE.Vector3): THREE.Vector3 {
  out.copy(view.pos).addScaledVector(view.forward, 26).addScaledVector(view.right, 8)
  out.z += view.eye - 10
  return out
}

/** Writes the world position of the drawn viewmodel's muzzle for the player with that entity id; false: none. */
export type OwnMuzzleSource = (entityId: number, out: THREE.Vector3) => boolean
let ownMuzzleSource: OwnMuzzleSource | null = null

/**
 * Lets the viewmodel integration supply the own-eyes gun muzzle (X1: the world position of F4's
 * `ViewmodelInstance.muzzle`), so the POV owner's tracers leave the drawn gun. Pass null to remove it.
 */
export function setOwnMuzzleSource(source: OwnMuzzleSource | null): void {
  ownMuzzleSource = source
}

/** Where the own-eyes tracers start: the registered viewmodel muzzle, else gunMuzzle. */
export function ownMuzzleAt(entityId: number, view: PlayerView, out: THREE.Vector3): THREE.Vector3 {
  if (ownMuzzleSource && ownMuzzleSource(entityId, out)) return out
  return gunMuzzle(view, out)
}

/**
 * Entity id of the actor whose own povCamera the scene renders from, or null (RTS, spectator, chase and death
 * cameras). Same rule as Actors.tsx `isFocusedPOV` (contract 6.2 item 8 and amendment A4).
 */
export function povCameraOwner(): number | null {
  if (getState().scene.controls.mode !== 'pov') return null
  const { focusedObject, povCameraOverride } = useInstance.getState()
  if (!focusedObject) return null
  if (!povCameraOverride) return (focusedObject.userData?.entityId as number | undefined) ?? null
  if (povCameraOverride.name !== 'povCamera') return null
  for (let node: THREE.Object3D | null = povCameraOverride; node; node = node.parent) {
    if (node.name === 'actor') return (node.userData?.entityId as number | undefined) ?? null
  }
  return null
}
