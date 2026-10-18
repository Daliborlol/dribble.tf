// Death markers (contract section 5 F6, setting map.deathMarkers): for 330 ticks after a ragdoll appears,
// a flat X on the ground at the victim's feet in his team's TEAM_DARK, gib red when he was gibbed. After a
// mid-air death the X lies on the floor below the death point (markers.ts airborneMarkerSpots), found by the
// map surface analysis; until it finishes, the X stays at the ragdoll origin.

import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

import { useExtras, useHlSetting } from '@highlander/extras/hooks'

import { DEATH_MARKER_BAR } from './constants'
import { drawn, tickFOf, useRenderTickRef } from './frame'
import { MATERIALS, UNIT_BOX } from './geometry'
import {
  MARKER_SURFACE,
  airborneMarkerSpots,
  deathMarkerColor,
  deathMarkersAt,
  markerGround,
  maxConcurrentMarkers,
  type DeathMarker,
} from './markers'
import { useMapSurface } from './useMapSurface'

const MARKER_LIFT = 0.6
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const ARMS = [
  new THREE.Quaternion().setFromAxisAngle(Z_AXIS, Math.PI / 4),
  new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -Math.PI / 4),
]
const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _markers: DeathMarker[] = []

/** Floor per ragdoll of the mounted layer (NaN: origin), for probes; null while nothing is mounted. */
let activeGround: { airborne: number; dropped: number; analysed: boolean; ground: Float32Array } | null = null
export const getActiveMarkerGround = () => activeGround

export const DeathMarkers = React.memo(({ renderTick }: { renderTick: number }) => {
  const x = useExtras()
  const enabled = useHlSetting<boolean>('map.deathMarkers') !== false
  const tickRef = useRenderTickRef(renderTick)
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const lastTickF = useRef(NaN)

  const active = !!x && enabled && x.meta.available.ragdolls
  const capacity = useMemo(() => (active && x ? maxConcurrentMarkers(x) * 2 : 0), [active, x])
  const airborne = useMemo(() => (active && x ? airborneMarkerSpots(x) : null), [active, x])
  const surface = useMapSurface(airborne && airborne.spots.length > 0 ? airborne.spots : null, MARKER_SURFACE)
  const ground = useMemo(() => (x && airborne ? markerGround(x, airborne, surface) : null), [x, airborne, surface])

  useEffect(() => {
    lastTickF.current = NaN
    activeGround =
      ground && airborne
        ? {
            airborne: airborne.ragdolls.length,
            dropped: ground.reduce((n, z) => n + (Number.isNaN(z) ? 0 : 1), 0),
            analysed: surface !== null || airborne.ragdolls.length === 0,
            ground,
          }
        : null
    return () => {
      if (activeGround?.ground === ground) activeGround = null
      drawn.markers = 0
    }
  }, [capacity, x, ground, airborne, surface])

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh || !x) return
    const tickF = tickFOf(tickRef.current)
    if (tickF === lastTickF.current) return
    lastTickF.current = tickF
    let n = 0
    for (const marker of deathMarkersAt(x, tickF, _markers, ground)) {
      if (n + 2 > capacity) break
      const color = deathMarkerColor(marker)
      _p.set(marker.x, marker.y, marker.z + MARKER_LIFT)
      _s.set(DEATH_MARKER_BAR.length * marker.scale, DEATH_MARKER_BAR.width * marker.scale, DEATH_MARKER_BAR.height)
      for (const arm of ARMS) {
        _m.compose(_p, arm, _s)
        mesh.setMatrixAt(n, _m)
        mesh.setColorAt(n, color)
        n++
      }
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    drawn.markers = n / 2
  })

  if (!active || capacity === 0) return null
  return (
    <instancedMesh
      ref={meshRef}
      name="mapdyn-death-markers"
      args={[UNIT_BOX, MATERIALS.marker, capacity]}
      count={0}
      frustumCulled={false}
    />
  )
})
