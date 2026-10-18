// Static resupply cabinets (see lockers.ts). Only on bsp-to-glb maps: the old textured GLB of
// koth_product_final already contains the lockers.

import React, { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { useMapMeta } from '@highlander/map/mapMeta'
import { useInstance, useStore } from '@zus/store'

import { drawn } from './frame'
import { MATERIALS, UNIT_BOX } from './geometry'
import { buildLockers, type LockerBox } from './lockers'

let activeLockers: LockerBox[] = []
export const getActiveLockers = () => activeLockers

export const ResupplyLockers = React.memo(() => {
  const x = useExtras()
  // Lockers belong to the supplies the "Pickups" toggle shows (no separate setting in section 6.3).
  const enabled = useHlSetting<boolean>('map.pickups') !== false
  const bsp = useInstance(s => s.mapStatus.state === 'ready' && s.mapStatus.pipeline === 'bsp-to-glb')
  const map = useStore(s => s.scene.map)
  const meta = useMapMeta(bsp ? map : '')
  const meshRef = useRef<THREE.InstancedMesh>(null)

  const origin = x?.derived.sceneOrigin
  const lockers = useMemo(
    () => (x && enabled && bsp && origin ? buildLockers(meta, origin) : []),
    [x, enabled, bsp, meta, origin]
  )

  useLayoutEffect(() => {
    activeLockers = lockers
    const mesh = meshRef.current
    if (mesh) {
      lockers.forEach((box, i) => {
        mesh.setMatrixAt(i, box.matrix)
        mesh.setColorAt(i, box.color)
      })
      mesh.count = lockers.length
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    drawn.lockers = lockers.length
    return () => {
      if (activeLockers === lockers) activeLockers = []
      drawn.lockers = 0
    }
  }, [lockers])

  if (lockers.length === 0) return null
  return (
    <instancedMesh
      ref={meshRef}
      name="mapdyn-lockers"
      args={[UNIT_BOX, MATERIALS.locker, lockers.length]}
      frustumCulled={false}
    />
  )
})
