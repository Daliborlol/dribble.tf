// Third-person weapons with a pack (as/tpweapons): the held item's world model, bone-merged onto the public player
// model's baked pose (src/assetpack/thirdPerson.ts), plus the extra wearables of the loadout (banner backpacks, the
// Quick-Fix and Vaccinator packs) and of the held weapon (Botkiller heads). Mounted inside PlayerModel's rotated
// group, so it shares the body's visibility (death, POV, a fully cloaked spy), crouch scale and outline, and takes
// the body's opacity, tint and emissive (cloak fade, uber and crit tints). The team skin follows the drawn team
// (the disguise team while drawn as the disguise).
//
// Without a pack, with assets.enabled or assets.models off, or while a model is absent, loading or failed, nothing is
// drawn and nothing is requested (D21). Copies share the pack cache's geometry and textures; each copy owns its
// skeleton and its material clones, which it frees on unmount (the GPU disposal rule).

import React, { useEffect, useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'

import { useAssetPackActive } from '@pack/pack'
import { copyCharacterShading } from '@pack/characterShading'
import { packTeamSkin, usePackModel } from '@pack/models'
import type { PackModelHandle } from '@pack/models'
import {
  followsWeapon,
  mergeOntoPose,
  registerThirdPersonCopy,
  thirdPersonModels,
  thirdPersonPose,
  thirdPersonPoseItem,
  thirdPersonPoseKey,
} from '@pack/thirdPerson'
import type { ThirdPersonPose } from '@pack/thirdPerson'
import { measureThirdPersonAnchor, setThirdPersonAnchor } from '@highlander/combat/weaponAnchors'

export interface PackWeaponsProps {
  /** CLASS_MAP name of the drawn model ('scout', 'demoman', ...) */
  classKey: string
  /** Drawn team, 'red' | 'blue' */
  team: string
  weaponDef: number
  loadoutDefs: string
  opacity: number
  tint: string | null
  emissive: number
}

type EmissiveMaterial = THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number }

interface Piece {
  handle: PackModelHandle
  copy: THREE.Object3D
  materials: THREE.Material[]
  merged: number
  meshes: number
}

/** Per-copy material clones, so one player's cloak or tint never reaches another's copy of the same weapon. */
function ownMaterials(root: THREE.Object3D): THREE.Material[] {
  const clones = new Map<THREE.Material, THREE.Material>()
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const swap = (m: THREE.Material) => {
      let c = clones.get(m)
      if (!c) {
        c = m.clone()
        copyCharacterShading(m, c)
        c.userData.packOpaque = !m.transparent
        clones.set(m, c)
      }
      return c
    }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material)
  })
  return Array.from(clones.values())
}

/** Bounds of the merged pose, so frustum culling sees the weapon where it is drawn and not at its bind pose. */
function boundSkinnedMeshes(copy: THREE.Object3D) {
  copy.updateMatrixWorld(true)
  copy.traverse(node => {
    const mesh = node as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    mesh.skeleton.update()
    mesh.computeBoundingSphere()
    mesh.computeBoundingBox()
  })
}

interface PieceProps extends Omit<PackWeaponsProps, 'classKey' | 'weaponDef' | 'loadoutDefs'> {
  modelKey: string
  pose: ThirdPersonPose
  classKey: string
  kind: 'weapon' | 'wearable' | 'loadout'
  /** Loadout wearables of an item not held: drawn only when they sit on the body (not on weapon_bone) */
  bodyOnly: boolean
  /** The held weapon's item def: its muzzle and bounds anchor the pack particle effects (weaponAnchors.ts) */
  anchorDef?: number
}

const PackPiece = React.memo((props: PieceProps) => {
  const { modelKey, pose, team, bodyOnly, opacity, tint, emissive, classKey, kind, anchorDef } = props
  const handle = usePackModel(modelKey)

  const piece = useMemo<Piece | null>(() => {
    if (!handle) return null
    const copy = handle.instantiate(packTeamSkin(handle.info, team === 'blue' ? 3 : 2))
    const merged = mergeOntoPose(copy, pose)
    if (merged === 0 || (bodyOnly && followsWeapon(copy))) {
      handle.release(copy)
      return null
    }
    const materials = ownMaterials(copy)
    boundSkinnedMeshes(copy)
    let meshes = 0
    copy.traverse(node => {
      if ((node as THREE.Mesh).isMesh && node.visible) meshes++
    })
    return { handle, copy, materials, merged, meshes }
  }, [handle, pose, team, bodyOnly])

  useEffect(() => {
    if (!piece) return
    const unregister = registerThirdPersonCopy({ modelKey, classKey, team, kind, merged: piece.merged, meshes: piece.meshes, copy: piece.copy })
    return () => {
      unregister()
      piece.copy.removeFromParent()
      for (const m of piece.materials) m.dispose()
      piece.handle.release(piece.copy)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piece])

  // the held weapon's muzzle and bounds for the pack particle effects
  useEffect(() => {
    const measured = piece && anchorDef !== undefined ? measureThirdPersonAnchor(piece.copy, anchorDef) : null
    if (!measured) return
    setThirdPersonAnchor(measured.entityId, measured.anchor)
    return () => setThirdPersonAnchor(measured.entityId, null, measured.anchor)
  }, [piece, anchorDef])

  useLayoutEffect(() => {
    if (!piece) return
    for (const material of piece.materials) {
      const transparent = opacity < 1 || !material.userData.packOpaque
      if (material.transparent !== transparent) {
        material.transparent = transparent
        material.needsUpdate = true
      }
      material.opacity = opacity
      material.depthWrite = opacity > 0.5
      const lit = material as EmissiveMaterial
      if (lit.emissive) {
        lit.emissive.set(tint ?? '#000')
        lit.emissiveIntensity = tint ? emissive : 0
      }
    }
  }, [piece, opacity, tint, emissive])

  return piece ? <primitive object={piece.copy} /> : null
})

const Weapons = (props: PackWeaponsProps) => {
  const { classKey, weaponDef, loadoutDefs, ...look } = props
  const poseHandle = usePackModel(thirdPersonPoseItem(classKey) ? thirdPersonPoseKey(classKey) : null)
  const pose = poseHandle ? thirdPersonPose(poseHandle) : null

  const held = thirdPersonModels(classKey, weaponDef)
  // Extra wearables of the loadout's other items, each model once
  const wearables = useMemo(() => {
    const out = new Set<string>()
    for (const d of loadoutDefs ? loadoutDefs.split(',') : []) {
      const def = Number(d)
      if (def === weaponDef) continue
      const w = thirdPersonModels(classKey, def).wearable
      if (w) out.add(w)
    }
    if (held.wearable) out.delete(held.wearable)
    return Array.from(out).sort()
  }, [classKey, loadoutDefs, weaponDef, held.wearable])

  const fit = useMemo(() => pose?.fit.clone() ?? null, [pose])
  if (!pose || !fit) return null
  return (
    <group name="packWeapons" matrix={fit} matrixAutoUpdate={false}>
      {held.weapon && <PackPiece key={`w:${held.weapon}`} modelKey={held.weapon} pose={pose} classKey={classKey} kind="weapon" bodyOnly={false} anchorDef={weaponDef} {...look} />}
      {held.wearable && <PackPiece key={`e:${held.wearable}`} modelKey={held.wearable} pose={pose} classKey={classKey} kind="wearable" bodyOnly={false} {...look} />}
      {wearables.map(key => (
        <PackPiece key={`l:${key}`} modelKey={key} pose={pose} classKey={classKey} kind="loadout" bodyOnly {...look} />
      ))}
    </group>
  )
}

/** Renders nothing and subscribes to nothing beyond the pack state while no pack is active. */
export const PackWeapons = React.memo((props: PackWeaponsProps) => {
  const active = useAssetPackActive()
  if (!active || !props.classKey) return null
  return <Weapons {...props} />
})
