// Pack models for the extras projectiles (asset phase W-projectiles). A kind whose model the asset pack lists under
// the role `projectile:<name>` draws that model instead of its placeholder body; energy rings, fireballs, orbs and
// gas keep their placeholders (no model), and the base rocket, pipe and sticky stay with Projectiles.tsx.
//
// Each pack model is drawn rigid in its rest pose; every mesh of every skin becomes one InstancedMesh that
// shares the model cache's geometry and skin material, so a frame costs one draw call per mesh and skin whatever
// the projectile count. A set owns only its InstancedMesh objects; geometry and materials belong to the model
// cache (src/assetpack/models.ts) and are freed when the last usePackModel releases them. Without a pack,
// usePackModel(null) requests nothing and every kind keeps its placeholder (asset contract D21).

import { useEffect, useMemo } from 'react'

import * as THREE from 'three'

import { useAssetPack } from '@pack/pack'
import { packTeamSkin, usePackModel } from '@pack/models'
import type { PackModelHandle } from '@pack/models'
import { PROJ } from '@highlander/extras/enums'

/** Pack role name per extras projectile kind (manifest `role: "projectile:<name>"`). */
export const PACK_PROJECTILE_ROLES: Readonly<Record<number, string>> = {
  [PROJ.CANNONBALL]: 'cannonball',
  [PROJ.FLARE]: 'flare',
  [PROJ.ARROW]: 'arrow',
  [PROJ.REPAIR_BOLT]: 'repairBolt',
  [PROJ.HEALING_BOLT]: 'healingBolt',
  [PROJ.JARATE]: 'jarate',
  [PROJ.MILK]: 'milk',
  [PROJ.CLEAVER]: 'cleaver',
  [PROJ.STUN_BALL]: 'stunBall',
  [PROJ.ORNAMENT]: 'ornament',
  [PROJ.SYRINGE]: 'syringe',
}

/** Fixed hook order: usePackProjectileSets calls usePackModel once per entry. */
const PACK_KINDS = Object.keys(PACK_PROJECTILE_ROLES).map(Number)

interface MeshSource {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  local: THREE.Matrix4
}

function drawn(node: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = node; n; n = n.parent) {
    if (!n.visible) return false
    if (n === root) return true
  }
  return true
}

/**
 * The drawn meshes of one skin copy, with their matrices relative to the copy root. Studio models come as skinned
 * meshes; a projectile model is rigid, so its rest pose is baked into the matrix: with one bone exactly (what the
 * skinning shader computes at rest), with more bones the bind pose, which is the rest pose of a rigid model.
 */
function meshSources(handle: PackModelHandle, skin: number): MeshSource[] | null {
  const copy = handle.instantiate(skin)
  copy.position.set(0, 0, 0)
  copy.quaternion.identity()
  copy.scale.set(1, 1, 1)
  copy.updateMatrixWorld(true)
  const out: MeshSource[] = []
  copy.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || !drawn(mesh, copy)) return
    const local = mesh.matrixWorld.clone()
    const skinned = mesh as THREE.SkinnedMesh
    if (skinned.isSkinnedMesh && skinned.skeleton?.bones.length === 1) {
      const bone = skinned.skeleton.bones[0]
      local
        .multiply(skinned.bindMatrixInverse)
        .multiply(bone.matrixWorld)
        .multiply(skinned.skeleton.boneInverses[0])
        .multiply(skinned.bindMatrix)
    }
    out.push({ geometry: mesh.geometry, material: mesh.material, local })
  })
  handle.release(copy)
  return out.length === 0 ? null : out
}

const _m = new THREE.Matrix4()

/** One kind's pack model as InstancedMeshes, one group of meshes per skin. */
export class PackProjectileSet {
  readonly key: string
  readonly role: string
  readonly meshes: THREE.InstancedMesh[] = []
  private readonly skins: { sources: MeshSource[]; meshes: THREE.InstancedMesh[] }[] = []
  private readonly info: PackModelHandle['info']
  readonly capacity: number
  count = 0
  dropped = 0

  constructor(handle: PackModelHandle, role: string, capacity: number, skinSources: MeshSource[][]) {
    this.key = handle.key
    this.role = role
    this.info = handle.info
    this.capacity = capacity
    skinSources.forEach((sources, skin) => {
      const meshes = sources.map((src, k) => {
        const mesh = new THREE.InstancedMesh(src.geometry, src.material, capacity)
        mesh.name = `hl-proj-pack-${role}-${skin}-${k}`
        mesh.frustumCulled = false
        mesh.count = 0
        mesh.visible = false
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        this.meshes.push(mesh)
        return mesh
      })
      this.skins.push({ sources, meshes })
    })
  }

  begin(): void {
    this.count = 0
    for (const mesh of this.meshes) mesh.count = 0
  }

  /** Adds one projectile at `matrix` (+X forward, +Z up, Source units) in the skin of `team`. */
  push(matrix: THREE.Matrix4, team: number): boolean {
    const skin = this.skins[Math.min(packTeamSkin(this.info, team), this.skins.length - 1)]
    const first = skin.meshes[0]
    if (!first || first.count >= this.capacity) {
      this.dropped++
      return false
    }
    for (let k = 0; k < skin.meshes.length; k++) {
      const mesh = skin.meshes[k]
      mesh.setMatrixAt(mesh.count++, _m.multiplyMatrices(matrix, skin.sources[k].local))
    }
    this.count++
    return true
  }

  end(): void {
    for (const mesh of this.meshes) {
      mesh.visible = mesh.count > 0
      if (mesh.count) mesh.instanceMatrix.needsUpdate = true
    }
  }

  /** Frees the instance buffers only; geometry and materials belong to the model cache. */
  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose()
  }
}

/** The manifest key of a role, or null when the pack is not ready or lists no such model. */
function keyOfRole(manifest: any, role: string): string | null {
  const items = manifest?.items
  if (!items) return null
  const want = `projectile:${role}`
  let best: string | null = null
  for (const key of Object.keys(items)) {
    const item = items[key]
    if (item?.kind === 'model' && item.role === want && (best === null || key < best)) best = key
  }
  return best
}

/**
 * Pack sets by extras kind for the kinds in `kinds` (others stay null). Each set appears once its model is loaded,
 * bound and compiled; until then, and without a pack, the caller draws the placeholder.
 */
export function usePackProjectileSets(kinds: readonly number[], capacity: number): (PackProjectileSet | null)[] {
  const pack = useAssetPack()
  const manifest = pack.status === 'ready' ? pack.manifest : null
  const keys = useMemo(
    () => PACK_KINDS.map(kind => (kinds.includes(kind) ? keyOfRole(manifest, PACK_PROJECTILE_ROLES[kind]) : null)),
    // `kinds` is a module constant at every call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manifest]
  )
  // one usePackModel per PACK_KINDS entry, always in the same order
  const handles = PACK_KINDS.map((_, i) => usePackModel(keys[i])) // eslint-disable-line react-hooks/rules-of-hooks
  const sets = useMemo(() => {
    const out: (PackProjectileSet | null)[] = []
    PACK_KINDS.forEach((kind, i) => {
      const handle = handles[i]
      if (!handle) return
      const skins: MeshSource[][] = []
      for (let skin = 0; skin < Math.max(1, handle.info.skins | 0); skin++) {
        const sources = meshSources(handle, skin)
        if (!sources) return // nothing drawn: placeholder
        skins.push(sources)
      }
      out[kind] = new PackProjectileSet(handle, PACK_PROJECTILE_ROLES[kind], capacity, skins)
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, handles)
  useEffect(() => () => sets.forEach(set => set?.dispose()), [sets])
  return sets
}

/** Draw-call meshes of every set, for <primitive> children. */
export function packSetMeshes(sets: (PackProjectileSet | null)[]): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = []
  for (const set of sets) if (set) out.push(...set.meshes)
  return out
}
