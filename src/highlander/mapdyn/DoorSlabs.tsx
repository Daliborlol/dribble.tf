// Slabs for prop doors (see slabs.ts), one InstancedMesh for the whole map.

import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { useMapMeta } from '@highlander/map/mapMeta'
import { useInstance, useStore } from '@zus/store'

import { drawn, frameTickF, useInstancedMesh } from './frame'
import { MATERIALS, UNIT_BOX } from './geometry'
import { buildSlabs, slabMatrixAt, type Slab } from './slabs'

const _matrix = new THREE.Matrix4()

/** The slabs of the mounted layer, for probes. */
let activeSlabs: Slab[] = []
export const getActiveSlabs = () => activeSlabs

export const DoorSlabs = React.memo((_props: { renderTick: number }) => {
  const x = useExtras()
  const enabled = useHlSetting<boolean>('map.movers') !== false
  const mapNodes = useInstance(s => s.mapNodes)
  const map = useStore(s => s.scene.map)
  // Only bsp-to-glb maps have brush-entity nodes (and a map-meta.json); others never request it.
  const meta = useMapMeta(mapNodes && mapNodes.size > 0 ? map : '')
  const lastTickF = useRef(NaN)

  const active = !!x && enabled && x.meta.available.movers
  const slabs = useMemo(() => (active ? buildSlabs(x, meta, mapNodes) : []), [active, x, meta, mapNodes])
  const mesh = useInstancedMesh(UNIT_BOX, MATERIALS.slab, slabs.length, { name: 'mapdyn-slabs', count: 0 })

  useEffect(() => {
    activeSlabs = slabs
    lastTickF.current = NaN
    return () => {
      if (activeSlabs === slabs) activeSlabs = []
      drawn.slabs = 0
    }
  }, [slabs])

  useFrame(() => {
    if (!mesh || !x) return
    const tickF = frameTickF()
    if (tickF === lastTickF.current) return
    lastTickF.current = tickF
    let n = 0
    for (const slab of slabs) {
      if (!slabMatrixAt(x, slab, tickF, _matrix)) continue
      mesh.setMatrixAt(n++, _matrix)
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    drawn.slabs = n
  })

  if (!active || !mesh) return null
  return <primitive object={mesh} />
})
