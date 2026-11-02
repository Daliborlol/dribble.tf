// Default-sequence poses for the skinned props of the older textured map GLBs (koth_product_final and the
// other textured_compressed.glb maps). Their exporter baked every skinned prop_dynamic in its reference (bind)
// pose, but Source always draws a sequence frame, and most of these models only stand upright through the root
// bone rotation of their sequences: the rolling shutters of koth_product's spawns lie on their side (drum
// vertical, sheet beside it), lockers and lanterns turn 90 degrees.
//
// With the pack, a skinned prop whose triangle count and bone names match a pack model of role 'mapprop' or
// 'locker' takes that model's rest pose, which the models stage sets to frame 0 of the default sequence. The
// pack model also keeps the reference pose in its node extras (`dribble.refPose`, models stage `refPose`), so a
// root bone becomes   map root bone x reference^-1 x default-sequence pose   (the map's placement of the prop
// kept), and every other bone takes the pack's local pose. The map's own mesh, materials and skinning stay.
// No pack, a pack without these models, or assets.models off: nothing changes and nothing is requested.

import { useEffect, useSyncExternalStore } from 'react'
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { Bone, Object3D, SkinnedMesh } from 'three'

import { useAssetSetting } from './hooks'
import { loadPackItem, releaseAssetItem } from './items'
import { loadPackModel } from './loaders'
import { getAssetPackState, subscribeAssetPack } from './pack'

const PROP_ROLES = new Set(['mapprop', 'locker'])

interface BonePose {
  position: Vector3
  quaternion: Quaternion
  scale: Vector3
  /** Reference (bind) pose as a local matrix. */
  ref: Matrix4
}

type PoseTable = Map<string, BonePose>

interface PropGroup {
  bones: Bone[]
  meshes: SkinnedMesh[]
  triangles: number
}

export interface MapPropPoseRow {
  key: string | null
  bones: number
  meshes: number
  triangles: number
  posed: boolean
  reason: string | null
}

// Pose tables are a few dozen numbers per model, read from the pack; one load per model and page.
const tables = new Map<string, Promise<PoseTable | null>>()
let lastRows: MapPropPoseRow[] = []

/** Rows of the last application, for the probe `assets.mapProps`. */
export const mapPropPoseRows = (): MapPropPoseRow[] => lastRows

function loadPoseTable(key: string): Promise<PoseTable | null> {
  let promise = tables.get(key)
  if (!promise) {
    promise = loadPackItem(key, url => loadPackModel(url)).then(model => {
      if (!model) {
        tables.delete(key)
        return null
      }
      const table: PoseTable = new Map()
      let withRef = 0
      model.gltf.scene.traverse(node => {
        if (!(node as Bone).isBone) return
        const ref = node.userData?.dribble?.refPose
        const hasRef = Array.isArray(ref) && ref.length === 10
        if (hasRef) withRef++
        table.set(node.name, {
          position: node.position.clone(),
          quaternion: node.quaternion.clone(),
          scale: node.scale.clone(),
          // A bone without refPose has no channel in the default sequence: its rest pose is the reference.
          ref: hasRef
            ? new Matrix4().compose(
                new Vector3(ref[0], ref[1], ref[2]),
                new Quaternion(ref[3], ref[4], ref[5], ref[6]),
                new Vector3(ref[7], ref[8], ref[9])
              )
            : new Matrix4().compose(node.position, node.quaternion, node.scale),
        })
      })
      model.dispose()
      releaseAssetItem(key)
      // A model built before the models stage kept reference poses cannot tell the two poses apart.
      return withRef > 0 ? table : null
    })
    tables.set(key, promise)
  }
  return promise
}

function collectGroups(root: Object3D): PropGroup[] {
  const groups = new Map<Bone, PropGroup>()
  root.traverse(node => {
    const mesh = node as SkinnedMesh
    if (!mesh.isSkinnedMesh || !mesh.skeleton?.bones.length) return
    const first = mesh.skeleton.bones[0]
    let group = groups.get(first)
    if (!group) {
      group = { bones: mesh.skeleton.bones.slice(), meshes: [], triangles: 0 }
      groups.set(first, group)
    }
    group.meshes.push(mesh)
    const geometry = mesh.geometry
    group.triangles += (geometry.index ? geometry.index.count : geometry.attributes.position?.count ?? 0) / 3
  })
  return [...groups.values()]
}

function candidateKeys(triangles: number): string[] {
  const items = getAssetPackState().manifest?.items ?? {}
  const keys: string[] = []
  for (const [key, item] of Object.entries(items) as [string, any][]) {
    if (item?.kind === 'model' && PROP_ROLES.has(item.role) && item.triangles === triangles) keys.push(key)
  }
  return keys.sort()
}

// GLTFLoader makes node names unique per file, so the second copy of a prop has bones named `root_1`.
const poseOf = (table: PoseTable, name: string): BonePose | undefined =>
  table.get(name) ?? table.get(name.replace(/_\d+$/, ''))

const _ref = new Matrix4()
const _idle = new Matrix4()
const _m = new Matrix4()

type Saved = { bone: Bone; position: Vector3; quaternion: Quaternion; scale: Vector3 }

/** Poses one group from a table; returns the saved local poses, or null when the table does not fit. */
function poseGroup(group: PropGroup, table: PoseTable): Saved[] | null {
  const boneSet = new Set<Object3D>(group.bones)
  if (group.bones.length !== table.size) return null
  for (const bone of group.bones) if (!poseOf(table, bone.name)) return null
  const saved: Saved[] = []
  for (const bone of group.bones) {
    const pose = poseOf(table, bone.name)!
    saved.push({ bone, position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() })
    const isRoot = !bone.parent || !boneSet.has(bone.parent)
    if (isRoot) {
      _m.compose(bone.position, bone.quaternion, bone.scale)
      _ref.copy(pose.ref).invert()
      _idle.compose(pose.position, pose.quaternion, pose.scale)
      _m.multiply(_ref).multiply(_idle)
      _m.decompose(bone.position, bone.quaternion, bone.scale)
    } else {
      bone.position.copy(pose.position)
      bone.quaternion.copy(pose.quaternion)
      bone.scale.copy(pose.scale)
    }
    bone.updateMatrix()
  }
  return saved
}

function refreshBounds(groups: PropGroup[]) {
  for (const group of groups) {
    for (const mesh of group.meshes) {
      // The bone world matrices are current (updateMatrixWorld above); the bounds follow the new pose.
      mesh.skeleton.update()
      mesh.computeBoundingSphere()
      mesh.computeBoundingBox()
    }
  }
}

/**
 * Applies the default-sequence poses to the skinned props of a loaded map root while the pack serves models,
 * and restores the baked poses on cleanup (map change, assets.models off).
 */
export function useMapPropPoses(root: Object3D | null): void {
  const pack = useSyncExternalStore(subscribeAssetPack, getAssetPackState, getAssetPackState)
  const enabled = useAssetSetting('enabled')
  const models = useAssetSetting('models')
  const active = !!root && pack.status === 'ready' && enabled && models

  useEffect(() => {
    if (!active || !root) return
    const groups = collectGroups(root)
    if (groups.length === 0) return
    let alive = true
    const saved: Saved[] = []
    const posed: PropGroup[] = []
    ;(async () => {
      const rows: MapPropPoseRow[] = []
      for (const group of groups) {
        const row: MapPropPoseRow = {
          key: null,
          bones: group.bones.length,
          meshes: group.meshes.length,
          triangles: group.triangles,
          posed: false,
          reason: 'no pack model',
        }
        rows.push(row)
        for (const key of candidateKeys(group.triangles)) {
          const table = await loadPoseTable(key)
          if (!alive) return
          if (!table) continue
          const done = poseGroup(group, table)
          if (!done) {
            row.reason = `bones differ from ${key}`
            continue
          }
          saved.push(...done)
          posed.push(group)
          Object.assign(row, { key, posed: true, reason: null })
          break
        }
      }
      if (posed.length) {
        root.updateMatrixWorld(true)
        refreshBounds(posed)
      }
      lastRows = rows
    })()
    return () => {
      alive = false
      for (const s of saved) {
        s.bone.position.copy(s.position)
        s.bone.quaternion.copy(s.quaternion)
        s.bone.scale.copy(s.scale)
        s.bone.updateMatrix()
      }
      if (saved.length) {
        root.updateMatrixWorld(true)
        refreshBounds(posed)
      }
      lastRows = []
    }
  }, [active, root])
}
