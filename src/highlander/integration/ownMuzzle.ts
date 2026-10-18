// X1 wiring (contract 12.4): the POV subject's own hitscan tracers leave the drawn viewmodel's muzzle.
//
// F3's hitscanAt starts the tracers of the actor whose own povCamera renders the scene at ownMuzzleAt(), which asks
// the source registered with setOwnMuzzleSource and falls back to F3's gunMuzzle (eye + forward 26 + right 8 - 10 z)
// when the source declines. F4's ViewmodelLayer publishes the mounted viewmodel in vmShared.live (subject, muzzle
// object, muzzleWorld) and clears it whenever no viewmodel is drawn (zoomed sniper, chase and death cameras,
// pov.viewmodel off, no known weapon), so the source answers only for the POV subject with a drawn viewmodel.
//
// The world position is read from the muzzle object itself, after updating its parents' world matrices: the
// actors (and their povCameras) move in useFrame callbacks that run before CombatFxLayer's, while ViewmodelLayer's
// own muzzleWorld is written after it, so muzzleWorld would trail the camera by one frame. The viewmodel pose under
// the camera changes slowly (kick, sway); the camera transform is the part that must be current.

import * as THREE from 'three'

import { setOwnMuzzleSource, type OwnMuzzleSource } from '@highlander/combat/view'
import { vmShared } from '@highlander/scene/viewmodel/shared'

/** True while `object` hangs under a scene (a viewmodel unmounted this frame is detached before vmShared clears). */
function inScene(object: THREE.Object3D): boolean {
  let node: THREE.Object3D = object
  while (node.parent) node = node.parent
  return (node as THREE.Scene).isScene === true
}

/** The drawn viewmodel muzzle of `entityId` in world (scene) space, or false when he has no viewmodel drawn. */
export const viewmodelMuzzleSource: OwnMuzzleSource = (entityId: number, out: THREE.Vector3): boolean => {
  const live = vmShared.live
  if (!live || live.subjectEntityId !== entityId || !inScene(live.muzzle)) return false
  live.muzzle.updateWorldMatrix(true, false)
  out.setFromMatrixPosition(live.muzzle.matrixWorld)
  return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z)
}

/** Registers the source (PovLayer mounts it); returns the cleanup that removes it. */
export function installOwnMuzzleSource(): () => void {
  setOwnMuzzleSource(viewmodelMuzzleSource)
  return () => setOwnMuzzleSource(null)
}
