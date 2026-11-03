// Where the pack particle effects attached to a player's weapon start (as/particles2): flames, airblasts, muzzle
// flashes, the medigun's full-charge sparks and the crit-boost sparks.
//
// Third person: PackWeapon registers, per mounted held-weapon copy, its `muzzle` attachment and its bounds in the
// unscaled playerBody frame (feet origin, turned by the body yaw). The weapon is posed once on the baked player
// pose, so that offset is a constant of the model; packParticlesDraw.tsx applies it to the base position, yaw and
// crouch scale at each particle's birth, which keeps the effects pure functions of the tick (D12).
//
// POV: the drawn viewmodel's muzzle, measured each frame (packParticlesDraw.tsx) as an offset along the base view
// axes from the base eye, rounded to 1/4 unit, and applied to the base view at each birth. It follows the viewmodel
// pose of the last drawn frame, which is a function of the tick while paused, so a seek to the same tick gives the
// same particles.
//
// Without a pack nothing registers and every effect keeps its placeholder point.

import * as THREE from 'three'

export interface ThirdPersonAnchor {
  /** item def of the held weapon this was measured on */
  def: number
  /** the weapon's `muzzle` attachment in the playerBody frame, null when the model has none */
  muzzle: THREE.Vector3 | null
  /** the weapon's bounds in the playerBody frame */
  center: THREE.Vector3
  half: THREE.Vector3
}

const anchors = new Map<number, ThirdPersonAnchor>()

/** Registers (or with null removes) the held weapon of `entityId`; `owner` removes only its own entry. */
export function setThirdPersonAnchor(entityId: number, anchor: ThirdPersonAnchor | null, owner?: ThirdPersonAnchor): void {
  if (anchor) anchors.set(entityId, anchor)
  else if (!owner || anchors.get(entityId) === owner) anchors.delete(entityId)
}

/** The registered held weapon of `entityId` when it is item `def`'s kind (`accept`), else null. */
export function thirdPersonAnchor(entityId: number, accept: (def: number) => boolean): ThirdPersonAnchor | null {
  const a = anchors.get(entityId)
  return a && accept(a.def) ? a : null
}

const _inv = new THREE.Matrix4()
const _m = new THREE.Matrix4()
const _box = new THREE.Box3()
const _part = new THREE.Box3()

/**
 * Measures a mounted weapon copy: its `muzzle` attachment node and mesh bounds in the frame of the nearest
 * ancestor named `playerBody`, with that group's scale undone. Returns null when the copy is not under an actor.
 */
export function measureThirdPersonAnchor(copy: THREE.Object3D, def: number): { entityId: number; anchor: ThirdPersonAnchor } | null {
  let body: THREE.Object3D | null = null
  let actor: THREE.Object3D | null = null
  for (let node = copy.parent; node; node = node.parent) {
    if (!body && node.name === 'playerBody') body = node
    if (node.name === 'actor') {
      actor = node
      break
    }
  }
  const entityId = actor?.userData?.entityId
  if (!body || typeof entityId !== 'number') return null
  body.updateWorldMatrix(true, false)
  // the body frame without its crouch scale: position and rotation only
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  body.matrixWorld.decompose(pos, quat, scale)
  _inv.compose(pos, quat, scale.set(1, 1, 1)).invert()
  copy.updateWorldMatrix(true, true)

  let muzzle: THREE.Vector3 | null = null
  const node = copy.getObjectByName('attachment_muzzle')
  if (node) muzzle = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld).applyMatrix4(_inv)

  _box.makeEmpty()
  copy.traverse(child => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const local = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh).boundingBox : mesh.geometry.boundingBox
    if (!local) return
    _part.copy(local).applyMatrix4(_m.multiplyMatrices(_inv, mesh.matrixWorld))
    _box.union(_part)
  })
  if (_box.isEmpty()) return null
  const anchor: ThirdPersonAnchor = { def, muzzle, center: _box.getCenter(new THREE.Vector3()), half: _box.getSize(new THREE.Vector3()).multiplyScalar(0.5) }
  return { entityId, anchor }
}
