// Slabs for prop doors (see slabs.ts), one InstancedMesh for the whole map.

import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { useMapMeta } from '@highlander/map/mapMeta'
import { useInstance, useStore } from '@zus/store'

import { drawn, tickFOf, useRenderTickRef } from './frame'
import { MATERIALS, UNIT_BOX } from './geometry'
import { buildSlabs, slabMatrixAt, type Slab } from './slabs'

const _matrix = new THREE.Matrix4()

/** The slabs of the mounted layer, for probes. */
let activeSlabs: Slab[] = []
export const getActiveSlabs = () => activeSlabs

export const DoorSlabs = React.memo(({ renderTick }: { renderTick: number }) => {
  const x = useExtras()
  const enabled = useHlSetting<boolean>('map.movers') !== false
  const mapNodes = useInstance(s => s.mapNodes)
  const map = useStore(s => s.scene.map)
  // Only bsp-to-glb maps have brush-entity nodes (and a map-meta.json); others never request it.
  const meta = useMapMeta(mapNodes && mapNodes.size > 0 ? map : '')
  const tickRef = useRenderTickRef(renderTick)
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const lastTickF = useRef(NaN)

  const active = !!x && enabled && x.meta.available.movers
  const slabs = useMemo(() => (active ? buildSlabs(x, meta, mapNodes) : []), [active, x, meta, mapNodes])

  useEffect(() => {
    activeSlabs = slabs
    lastTickF.current = NaN
    return () => {
      if (activeSlabs === slabs) activeSlabs = []
      drawn.slabs = 0
    }
  }, [slabs])

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh || !x) return
    const tickF = tickFOf(tickRef.current)
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

  if (!active || slabs.length === 0) return null
  return (
    <instancedMesh
      ref={meshRef}
      name="mapdyn-slabs"
      args={[UNIT_BOX, MATERIALS.slab, slabs.length]}
      count={0}
      frustumCulled={false}
    />
  )
})
