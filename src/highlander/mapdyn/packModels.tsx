// W-items: map items drawn from the local asset pack by model string (asset contract 12.4 and 12.5).
//
// A pack model is turned into one InstancedMesh per mesh of its copy, sharing the handle's geometry and materials,
// so a layer keeps its per-frame `setMatrixAt` loop and adds one draw call per model part instead of one per item.
// Skinned models draw their bind pose (map items do not animate). Every item keeps its placeholder: a layer asks
// `slots.get(slotKey(model, skin))` each frame and draws the placeholder whenever that is missing (no pack, pack
// off, model absent, still loading or failed). With no pack configured nothing here runs: `usePackModel` returns
// null before any request.

import React, { useEffect, useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'

import { usePackModel, type PackModelHandle, type PackModelItem } from '@pack/models'

/** Lower case with forward slashes, the manifest key form of a model string. */
export const packModelKey = (model: string | null | undefined) =>
  (model ?? '').replace(/\\/g, '/').toLowerCase()

export const slotKey = (model: string, skin = 0) => `${model}#${skin}`

const _t = new THREE.Matrix4()

export class PackInstancer {
  readonly parts: { mesh: THREE.InstancedMesh; local: THREE.Matrix4 }[] = []
  count = 0
  constructor(
    readonly key: string,
    readonly info: PackModelItem,
    readonly capacity: number,
    private readonly copy: THREE.Object3D,
    private readonly handle: PackModelHandle
  ) {
    copy.updateMatrixWorld(true)
    const rootInverse = new THREE.Matrix4().copy(copy.matrixWorld).invert()
    copy.traverse(node => {
      const m = node as THREE.Mesh
      if (!m.isMesh || !m.geometry || !m.material) return
      const mesh = new THREE.InstancedMesh(m.geometry, m.material, capacity)
      mesh.name = `pack:${key}`
      mesh.frustumCulled = false
      mesh.count = 0
      mesh.castShadow = m.castShadow
      mesh.receiveShadow = m.receiveShadow
      mesh.renderOrder = m.renderOrder
      const local = new THREE.Matrix4().multiplyMatrices(rootInverse, m.matrixWorld)
      const skinned = m as unknown as THREE.SkinnedMesh
      if (skinned.isSkinnedMesh && skinned.skeleton) {
        // drawn without skinning: bake the rest-pose transform of the bone that holds the first vertex
        // (world = matrixWorld * bindMatrixInverse * bone.matrixWorld * boneInverse * bindMatrix); map items are rigid
        const index = (skinned.geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined)?.getX(0) ?? 0
        const bone = skinned.skeleton.bones[index] ?? skinned.skeleton.bones[0]
        const inverse = skinned.skeleton.boneInverses[index] ?? skinned.skeleton.boneInverses[0]
        if (bone && inverse) {
          bone.updateWorldMatrix(true, false)
          local
            .copy(rootInverse)
            .multiply(m.matrixWorld)
            .multiply(skinned.bindMatrixInverse)
            .multiply(bone.matrixWorld)
            .multiply(inverse)
            .multiply(skinned.bindMatrix)
        }
      }
      this.parts.push({ mesh, local })
    })
  }

  /** Height of the model origin above the bottom of its bounds (Source units). */
  get bottomLift() {
    return -(this.info.bounds?.[0]?.[2] ?? 0)
  }

  /** Top of the bounds above the origin. */
  get top() {
    return this.info.bounds?.[1]?.[2] ?? 0
  }

  begin() {
    this.count = 0
  }

  /**
   * Adds one copy at `matrix` (model origin, Source axes), tinted by `color` (multiplies the texture; a layer
   * passes it for every copy or for none); false when full.
   */
  add(matrix: THREE.Matrix4, color?: THREE.Color): boolean {
    if (this.count >= this.capacity) return false
    for (const part of this.parts) {
      part.mesh.setMatrixAt(this.count, _t.multiplyMatrices(matrix, part.local))
      if (color) part.mesh.setColorAt(this.count, color)
    }
    this.count++
    return true
  }

  finish() {
    for (const part of this.parts) {
      part.mesh.count = this.count
      part.mesh.instanceMatrix.needsUpdate = true
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true
    }
  }

  dispose() {
    // the instance buffers are ours; geometry and materials belong to the pack model cache
    for (const part of this.parts) part.mesh.dispose()
    this.handle.release(this.copy)
  }
}

export type PackSlots = Map<string, PackInstancer>

/**
 * One model of a layer: loads it through `usePackModel`, registers a PackInstancer of `capacity` copies in `slots`
 * under `slotKey(modelKey, skin)` while it is ready, and calls `onChange` whenever it comes or goes so the layer
 * redraws (its useFrame skips unchanged ticks).
 */
export const PackInstances = React.memo(
  ({
    modelKey,
    skin = 0,
    capacity,
    slots,
    onChange,
  }: {
    modelKey: string
    skin?: number
    capacity: number
    slots: PackSlots
    onChange: () => void
  }) => {
    const handle = usePackModel(modelKey)
    const instancer = useMemo(
      () => (handle && capacity > 0 ? new PackInstancer(modelKey, handle.info, capacity, handle.instantiate(skin), handle) : null),
      [handle, modelKey, skin, capacity]
    )
    useEffect(() => () => instancer?.dispose(), [instancer])
    useLayoutEffect(() => {
      if (!instancer) return
      const key = slotKey(modelKey, skin)
      slots.set(key, instancer)
      onChange()
      return () => {
        if (slots.get(key) === instancer) slots.delete(key)
        onChange()
      }
    }, [instancer, slots, modelKey, skin, onChange])
    if (!instancer) return null
    return (
      <>
        {instancer.parts.map((part, i) => (
          <primitive key={i} object={part.mesh} />
        ))}
      </>
    )
  }
)

/** One copy of a pack model for a single object (the cart); null until it is ready, released on change. */
export function usePackCopy(modelKey: string | null, skin = 0): { copy: THREE.Object3D; info: PackModelItem } | null {
  const handle = usePackModel(modelKey)
  const copy = useMemo(() => (handle ? { copy: handle.instantiate(skin), info: handle.info, handle } : null), [handle, skin])
  useEffect(() => () => copy?.handle.release(copy.copy), [copy])
  return copy
}
