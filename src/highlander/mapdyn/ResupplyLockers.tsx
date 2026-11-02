// Static resupply cabinets (see lockers.ts). Only on bsp-to-glb maps: the old textured GLB of
// koth_product_final already contains the lockers.

import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import * as THREE from 'three'

import { TEAM_FX, teamKey } from '@highlander/constants'

import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { useMapMeta } from '@highlander/map/mapMeta'
import { useInstance, useStore } from '@zus/store'

import { drawn, useInstancedMesh } from './frame'
import { MATERIALS, UNIT_BOX } from './geometry'
import { buildLockers, type LockerBox } from './lockers'
import { PackInstances, slotKey, type PackSlots } from './packModels'

/**
 * The pack locker model has one skin for both teams, so its copies take a team tint: white moved this far toward
 * the team's effect colour (the placeholder boxes keep their own colours).
 */
const PACK_LOCKER_TINT = 0.5
const WHITE = new THREE.Color(1, 1, 1)
const packTint = (team: number) => {
  const key = teamKey(team)
  return key ? WHITE.clone().lerp(new THREE.Color(TEAM_FX[key]), PACK_LOCKER_TINT) : WHITE
}

let activeLockers: LockerBox[] = []
export const getActiveLockers = () => activeLockers

export const ResupplyLockers = React.memo(() => {
  const x = useExtras()
  // Lockers belong to the supplies the "Pickups" toggle shows (no separate setting in section 6.3).
  const enabled = useHlSetting<boolean>('map.pickups') !== false
  const bsp = useInstance(s => s.mapStatus.state === 'ready' && s.mapStatus.pipeline === 'bsp-to-glb')
  const map = useStore(s => s.scene.map)
  const meta = useMapMeta(bsp ? map : '')

  const origin = x?.derived.sceneOrigin
  const lockers = useMemo(
    () => (x && enabled && bsp && origin ? buildLockers(meta, origin) : []),
    [x, enabled, bsp, meta, origin]
  )
  const mesh = useInstancedMesh(UNIT_BOX, MATERIALS.locker, lockers.length, { name: 'mapdyn-lockers' })
  // W-items: locker props drawn from the pack model of their model string; the boxes stay for the rest
  const models = useMemo(() => {
    const counts = new Map<string, number>()
    for (const box of lockers) if (box.model && !box.name.endsWith(':front')) counts.set(box.model.key, (counts.get(box.model.key) ?? 0) + 1)
    return Array.from(counts.entries())
  }, [lockers])
  const slots = useMemo<PackSlots>(() => new Map(), [])
  const [slotVersion, setSlotVersion] = useState(0)
  const onSlots = useCallback(() => setSlotVersion(v => v + 1), [])

  useLayoutEffect(() => {
    activeLockers = lockers
    slots.forEach(slot => slot.begin())
    let n = 0
    for (const box of lockers) {
      const slot = box.model ? slots.get(slotKey(box.model.key)) : undefined
      if (slot) {
        if (!box.name.endsWith(':front')) slot.add(box.model!.matrix, packTint(box.team))
        continue
      }
      if (!mesh) continue
      mesh.setMatrixAt(n, box.matrix)
      mesh.setColorAt(n, box.color)
      n++
    }
    slots.forEach(slot => slot.finish())
    if (mesh) {
      mesh.count = n
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    drawn.lockers = lockers.length
    return () => {
      if (activeLockers === lockers) activeLockers = []
      drawn.lockers = 0
    }
  }, [lockers, mesh, slots, slotVersion])

  if (!mesh) return null
  return (
    <>
      <primitive object={mesh} />
      {models.map(([key, count]) => (
        <PackInstances key={key} modelKey={key} capacity={count} slots={slots} onChange={onSlots} />
      ))}
    </>
  )
})
