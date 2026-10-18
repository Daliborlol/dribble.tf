// Dropped items (contract section 5 F6, setting map.drops): death ammo packs, building gibs and dropped
// weapons as small boxes at their networked transform.

import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

import { DROP } from '@highlander/extras/enums'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'

import { DROP_AMMO_SIZE, DROP_GIB_SIZE, DROP_WEAPON_SIZE } from './constants'
import { drawn, tickFOf, useInstancedMesh, useRenderTickRef } from './frame'
import { MATERIALS, UNIT_BOX } from './geometry'
import { forEachDropAt } from './markers'

const SIZES = {
  [DROP.AMMO_PACK]: new THREE.Vector3(...DROP_AMMO_SIZE),
  [DROP.GIB]: new THREE.Vector3(...DROP_GIB_SIZE),
  [DROP.WEAPON]: new THREE.Vector3(...DROP_WEAPON_SIZE),
}
const _m = new THREE.Matrix4()
const _c = new THREE.Vector3()
const _up = new THREE.Vector3()

export const Drops = React.memo(({ renderTick }: { renderTick: number }) => {
  const x = useExtras()
  const enabled = useHlSetting<boolean>('map.drops') !== false
  const tickRef = useRenderTickRef(renderTick)
  const lastTickF = useRef(NaN)

  const active = !!x && enabled && x.meta.available.drops
  const capacity = useMemo(() => {
    const counts = [0, 0, 0]
    if (active && x) for (let j = 0; j < x.drops.count; j++) counts[Math.min(2, x.drops.kind[j])]++
    return counts
  }, [active, x])
  const ammo = useInstancedMesh(UNIT_BOX, MATERIALS.dropAmmo, capacity[0], { count: 0 })
  const gib = useInstancedMesh(UNIT_BOX, MATERIALS.dropGib, capacity[1], { count: 0 })
  const weapon = useInstancedMesh(UNIT_BOX, MATERIALS.dropWeapon, capacity[2], { count: 0 })

  useEffect(() => {
    lastTickF.current = NaN
    return () => {
      drawn.dropsAmmo = drawn.dropsGib = drawn.dropsWeapon = 0
    }
  }, [capacity])

  useFrame(() => {
    if (!x || !active) return
    const tickF = tickFOf(tickRef.current)
    if (tickF === lastTickF.current) return
    lastTickF.current = tickF
    const meshes = [ammo, gib, weapon]
    const counts = [0, 0, 0]
    forEachDropAt(x, tickF, (_j, kind, pos, quat) => {
      const k = Math.min(2, kind)
      const mesh = meshes[k]
      if (!mesh || counts[k] >= capacity[k]) return
      const size = SIZES[k as 0 | 1 | 2]
      // Ammo packs and gibs rest on their origin; weapons are centred on theirs.
      const lift = k === DROP.WEAPON ? 0 : size.z / 2
      _c.copy(pos).add(_up.set(0, 0, lift).applyQuaternion(quat))
      _m.compose(_c, quat, size)
      mesh.setMatrixAt(counts[k]++, _m)
    })
    meshes.forEach((mesh, k) => {
      if (!mesh) return
      mesh.count = counts[k]
      mesh.instanceMatrix.needsUpdate = true
    })
    drawn.dropsAmmo = counts[0]
    drawn.dropsGib = counts[1]
    drawn.dropsWeapon = counts[2]
  })

  if (!active) return null
  return (
    <group name="mapdyn-drops">
      {ammo && <primitive object={ammo} />}
      {gib && <primitive object={gib} />}
      {weapon && <primitive object={weapon} />}
    </group>
  )
})
