// Third-person weapons from the pack (as/tpweapons). The public player GLBs (public/models/players) have no
// skeleton: each is the TF2 mesh with one pose baked in. The models stage recovers that pose from the pack's own
// player model (scripts/assets/models/playerPose.mjs) and writes it as the item `thirdperson:<class>`: a GLB of
// bone nodes under a root `pose`, plus the third-person model of each item def (`weapons`) and its extra wearable
// (`wearables`). A weapon copy is bone-merged onto that pose: every copy node whose name (case-insensitive) is a
// pose bone takes that bone's matrix, as TF2's bone merge does; the others keep their own pose under their parent.
// The player model does not animate, so the merge runs once per copy.
//
// Spaces: bone matrices are in the pack copy's space (Source axes, `models.ts`); the root's matrix maps that space
// into the public GLB's coordinates, so a copy drawn under a group with that matrix, inside PlayerModel's rotated
// group, sits in the public model's hand. All numbers come from the pack (D19).

import { Matrix4, Quaternion, Vector3 } from 'three'
import type { Object3D } from 'three'

import { getAssetPackState } from './pack'
import type { PackModelHandle, PackModelItem } from './models'

export interface ThirdPersonPoseItem extends PackModelItem {
  role: 'player:pose'
  class: string
  weapons: Record<string, string>
  wearables: Record<string, string>
  bones: string[]
  pose: { clip: string | null; frame: number; rms: number; scale: number; pairs: number }
}

export interface ThirdPersonPose {
  /** Pack copy space -> public player GLB coordinates */
  fit: Matrix4
  /** Lower-case bone name -> matrix in pack copy space */
  bones: Map<string, Matrix4>
}

/** Manifest key of a class's pose item (`classKey` as in CLASS_MAP: 'scout', 'demoman', ...). */
export const thirdPersonPoseKey = (classKey: string) => `thirdperson:${classKey}`

/** The pose item of a class while the pack is ready, else null. */
export function thirdPersonPoseItem(classKey: string): ThirdPersonPoseItem | null {
  const item = getAssetPackState().manifest?.items?.[thirdPersonPoseKey(classKey)] as ThirdPersonPoseItem | undefined
  return item && item.kind === 'model' && item.role === 'player:pose' ? item : null
}

/** Model keys a class draws for item `def`: the weapon and the extra wearable, each null when the pack lacks it. */
export function thirdPersonModels(classKey: string, def: number): { weapon: string | null; wearable: string | null } {
  const item = thirdPersonPoseItem(classKey)
  const items = getAssetPackState().manifest?.items
  if (!item || !items || def < 0) return { weapon: null, wearable: null }
  const weapon = item.weapons?.[String(def)] ?? null
  const wearable = item.wearables?.[String(def)] ?? null
  return { weapon: weapon && items[weapon] ? weapon : null, wearable: wearable && items[wearable] ? wearable : null }
}

const poses = new WeakMap<PackModelHandle, ThirdPersonPose>()

/** Matrices of a loaded pose item, read once per handle. */
export function thirdPersonPose(handle: PackModelHandle): ThirdPersonPose {
  let pose = poses.get(handle)
  if (pose) return pose
  const copy = handle.instantiate()
  const fit = new Matrix4()
  const bones = new Map<string, Matrix4>()
  // the deepest node named `pose` (a scene group of that name may wrap it)
  let root: Object3D | null = null
  copy.traverse(node => {
    if (node.name === 'pose') root = node
  })
  if (root) {
    const node = root as Object3D
    node.updateMatrix()
    fit.copy(node.matrix)
    for (const child of node.children) {
      child.updateMatrix()
      bones.set(child.name.toLowerCase(), child.matrix.clone())
    }
  }
  handle.release(copy)
  pose = { fit, bones }
  poses.set(handle, pose)
  return pose
}

const _inv = new Matrix4()
const _local = new Matrix4()
const _p = new Vector3()
const _q = new Quaternion()
const _s = new Vector3()

/**
 * Bone-merges `copy` (a pack model copy, detached, at the identity) onto `pose`: the merged nodes' local transforms
 * are set so that their matrix relative to the copy equals the pose bone's. Returns the number of merged nodes;
 * 0 means the model shares no bone with the player and has nothing to attach to.
 */
export function mergeOntoPose(copy: Object3D, pose: ThirdPersonPose): number {
  copy.updateMatrixWorld(true)
  let merged = 0
  // traverse visits parents before children, so a merged parent is in place before its children are solved
  copy.traverse(node => {
    if (node === copy || !node.parent) return
    const target = pose.bones.get(node.name.toLowerCase())
    if (!target) return
    _local.copy(_inv.copy(node.parent.matrixWorld).invert()).multiply(target)
    _local.decompose(_p, _q, _s)
    node.position.copy(_p)
    node.quaternion.copy(_q)
    node.scale.copy(_s)
    node.updateMatrixWorld(true)
    merged++
  })
  return merged
}

/** True when the copy has a `weapon_bone` node: an extra wearable that follows the weapon (Botkiller heads). */
export function followsWeapon(copy: Object3D): boolean {
  let found = false
  copy.traverse(node => {
    if (node.name.toLowerCase() === 'weapon_bone') found = true
  })
  return found
}

/** A mounted third-person copy, for the `assets.tpweapons` probe (modelProbes.ts). */
export interface ThirdPersonRow {
  modelKey: string
  classKey: string
  team: string
  kind: 'weapon' | 'wearable' | 'loadout'
  merged: number
  meshes: number
  copy: Object3D
}

const mounted = new Set<ThirdPersonRow>()

/** Registers a mounted copy; returns the unregister function. */
export function registerThirdPersonCopy(row: ThirdPersonRow): () => void {
  mounted.add(row)
  return () => {
    mounted.delete(row)
  }
}

/** Probe rows: one per mounted copy, with whether it is drawn (every ancestor visible) and its world position. */
export function thirdPersonRows() {
  const p = new Vector3()
  return Array.from(mounted).map(({ copy, ...row }) => {
    let drawn = !!copy.parent
    for (let n: Object3D | null = copy; n && drawn; n = n.parent) if (!n.visible) drawn = false
    copy.updateWorldMatrix(true, false)
    p.setFromMatrixPosition(copy.matrixWorld)
    return { ...row, drawn, position: [p.x, p.y, p.z].map(v => Math.round(v * 10) / 10) }
  })
}
