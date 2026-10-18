// Frame helpers and the drawn-state record the F6 probes report.

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

import { useInstance } from '@zus/store'

/** renderTick as a ref, so useFrame callbacks read the latest prop without re-subscribing. */
export function useRenderTickRef(renderTick: number) {
  const ref = useRef(renderTick)
  ref.current = renderTick
  return ref
}

export interface InstancedMeshOptions {
  name?: string
  /** initial draw count (default: the capacity, as three's constructor sets it) */
  count?: number
  renderOrder?: number
}

/**
 * An InstancedMesh of `capacity` instances (null for 0), never frustum-culled, that this hook disposes when it is
 * replaced or the component unmounts. Render it with `<primitive object={mesh} />`. The layers do not declare
 * `<instancedMesh>` in JSX because react-three-fiber frees removed JSX objects only from an idle-priority scheduler
 * task, which never runs in this app (its scheduler is never idle), so every remount would strand the instance
 * buffers on the GPU. The geometry and material stay shared: InstancedMesh.dispose() frees only its own buffers.
 */
export function useInstancedMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
  { name, count, renderOrder }: InstancedMeshOptions = {}
): THREE.InstancedMesh | null {
  const mesh = useMemo(() => {
    if (!(capacity > 0)) return null
    const m = new THREE.InstancedMesh(geometry, material, capacity)
    m.frustumCulled = false
    if (name !== undefined) m.name = name
    if (count !== undefined) m.count = count
    if (renderOrder !== undefined) m.renderOrder = renderOrder
    return m
  }, [geometry, material, capacity, name, count, renderOrder])
  useEffect(
    () => () => {
      mesh?.dispose()
    },
    [mesh]
  )
  return mesh
}

/** tickF = renderTick + frameProgress (contract section 1.2); frameProgress is 0 while paused. */
export function tickFOf(renderTick: number): number {
  return renderTick + (useInstance.getState().frameProgress || 0)
}

export type KitMode = 'full' | 'overlay' | 'none'

/**
 * How pickups draw on the loaded map. bsp-to-glb maps have no kit geometry, so F6 draws the placeholders
 * ('full'); textured GLBs (koth_product_final, the 6v6 maps) bake the kits in, so F6 only overlays the taken
 * state ('overlay'). A missing map draws placeholders too; nothing while the map is still loading.
 */
export function kitModeOf(state: string | undefined, pipeline: string | undefined): KitMode {
  if (state === 'ready') return pipeline === 'bsp-to-glb' ? 'full' : 'overlay'
  if (state === 'missing' || state === 'error') return 'full'
  return 'none'
}

/** What the mounted F6 components drew in their last update (read by the `mapdyn.state` probe). */
export const drawn = {
  kitMode: 'none' as KitMode,
  pickupSource: 'none' as 'extras' | 'meta' | 'none',
  kits: 0,
  wires: 0,
  rings: 0,
  slabs: 0,
  lockers: 0,
  markers: 0,
  dropsAmmo: 0,
  dropsGib: 0,
  dropsWeapon: 0,
  tickF: NaN,
}
