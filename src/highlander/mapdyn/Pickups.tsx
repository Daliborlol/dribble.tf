// Health and ammo pickups (contract section 5 F6, setting map.pickups), all instanced.
//
// Placeholders: white health boxes with a red cross and olive ammo boxes with a gold band, bobbing and
// turning slowly on the floor. While taken: a faint wire box where the kit rests plus a ring on the floor
// that fills until the kit returns. Where the map GLB already draws the kit (a baked kit on an old textured
// GLB, see surface.ts) only the taken state is drawn over it, so no kit is ever drawn twice.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { useMapMeta } from '@highlander/map/mapMeta'
import { useInstance, useStore } from '@zus/store'

import {
  AMMO_BAND_COLOR,
  AMMO_RING_COLOR,
  AMMO_SIZE,
  HEALTH_BODY_COLOR,
  HEALTH_RING_COLOR,
  HEALTH_SIZE,
  PICKUP_BOB,
  PICKUP_BOB_RATE,
  PICKUP_FLOOR_OFFSET,
  PICKUP_YAW_RATE,
} from './constants'
import { drawn, kitModeOf, tickFOf, useRenderTickRef } from './frame'
import { MATERIALS, RING_MATERIAL, UNIT_BOX, UNIT_BOX_FRAME, createRingGeometry } from './geometry'
import { buildKitEntries, samplePickup, type KitEntry, type PickupSample } from './pickups'
import { analyzeSpots, type SpotSurface } from './surface'

/** Ring height above the floor. */
const RING_LIFT = 1.2

const Z_AXIS = new THREE.Vector3(0, 0, 1)
const NO_ROTATION = new THREE.Quaternion()
const COLORS = {
  healthWire: new THREE.Color(HEALTH_BODY_COLOR),
  ammoWire: new THREE.Color(AMMO_BAND_COLOR),
  healthRing: new THREE.Color(HEALTH_RING_COLOR),
  ammoRing: new THREE.Color(AMMO_RING_COLOR),
}

const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _sample: PickupSample = {
  alive: false,
  visible: false,
  takenTick: NaN,
  nextTick: NaN,
  progress: 0,
  respawnIn: 0,
  estimated: false,
}

export const ringRadius = (width: number) => width * 0.75 + 6

/** Per kit spot: floor height and whether the map already draws the kit. */
export interface KitSurface {
  entries: KitEntry[]
  floor: Float32Array
  baked: Uint8Array
  analysis: Omit<SpotSurface, 'floor' | 'baked'> & { spots: number }
}

let activeEntries: KitEntry[] = []
let activeSurface: KitSurface | null = null
export const getActiveKitEntries = () => activeEntries
export const getActiveKitSurface = () => activeSurface

/** Floor and baked flags per entry, from one analysis of the unique spots. */
function analyzeEntries(world: THREE.Object3D, entries: KitEntry[], detectBaked: boolean): KitSurface {
  const keyOf = (e: KitEntry) => `${Math.round(e.x * 4)},${Math.round(e.y * 4)},${Math.round(e.z * 4)}`
  const spotIndex = new Map<string, number>()
  const spots: { x: number; y: number; z: number }[] = []
  const entrySpot = entries.map(e => {
    const key = keyOf(e)
    let i = spotIndex.get(key)
    if (i === undefined) {
      i = spots.length
      spotIndex.set(key, i)
      spots.push({ x: e.x, y: e.y, z: e.z })
    }
    return i
  })
  const result = analyzeSpots(world, spots, detectBaked)
  const floor = new Float32Array(entries.length)
  const baked = new Uint8Array(entries.length)
  entrySpot.forEach((i, k) => {
    floor[k] = result.floor[i]
    baked[k] = result.baked[i]
  })
  return {
    entries,
    floor,
    baked,
    analysis: { ms: result.ms, trianglesTested: result.trianglesTested, bakedBlobs: result.bakedBlobs, spots: spots.length },
  }
}

export const Pickups = React.memo(({ renderTick }: { renderTick: number }) => {
  const x = useExtras()
  const enabled = useHlSetting<boolean>('map.pickups') !== false
  const mapState = useInstance(s => s.mapStatus.state)
  const pipeline = useInstance(s => s.mapStatus.pipeline)
  const map = useStore(s => s.scene.map)
  // map-meta items are only the fallback when the extras have no pickups (old textured maps have no meta file).
  const meta = useMapMeta(x && !x.meta.available.pickups ? map : '')
  const tickRef = useRenderTickRef(renderTick)
  const lastTickF = useRef(NaN)

  const mode = kitModeOf(mapState, pipeline)
  const { source, entries } = useMemo(
    () =>
      x && enabled && mode !== 'none'
        ? buildKitEntries(x, meta, true)
        : { source: 'none' as const, entries: [] as KitEntry[] },
    [x, enabled, mode, meta]
  )
  const capacity = entries.length
  const ringGeometry = useMemo(() => createRingGeometry(capacity), [capacity])
  useEffect(() => () => ringGeometry.dispose(), [ringGeometry])

  // Floor heights and baked kits, once per map load (World replaces its root on every reload).
  const [surface, setSurface] = useState<KitSurface | null>(null)
  useEffect(() => {
    const world = mapState === 'ready' ? useInstance.getState().threeScene?.getObjectByName('world') : undefined
    setSurface(world && entries.length ? analyzeEntries(world, entries, pipeline !== 'bsp-to-glb') : null)
  }, [entries, mapState, pipeline])

  const healthBody = useRef<THREE.InstancedMesh>(null)
  const healthCross = useRef<THREE.InstancedMesh>(null)
  const ammoBody = useRef<THREE.InstancedMesh>(null)
  const ammoBand = useRef<THREE.InstancedMesh>(null)
  const wire = useRef<THREE.InstancedMesh>(null)
  const ring = useRef<THREE.InstancedMesh>(null)

  useEffect(() => {
    activeEntries = entries
    activeSurface = surface && surface.entries === entries ? surface : null
    drawn.kitMode = mode
    drawn.pickupSource = source
    lastTickF.current = NaN
    return () => {
      if (activeEntries === entries) activeEntries = []
      activeSurface = null
      drawn.kits = drawn.wires = drawn.rings = 0
      drawn.pickupSource = 'none'
    }
  }, [entries, mode, source, surface])

  useFrame(() => {
    if (!x || capacity === 0) return
    const tickF = tickFOf(tickRef.current)
    if (tickF === lastTickF.current) return
    lastTickF.current = tickF

    const known = surface && surface.entries === entries ? surface : null
    const bob = PICKUP_BOB + PICKUP_BOB * Math.sin(tickF * PICKUP_BOB_RATE)
    _q.setFromAxisAngle(Z_AXIS, (tickF * PICKUP_YAW_RATE) % (Math.PI * 2))
    let hb = 0, hc = 0, ab = 0, an = 0, w = 0, r = 0
    const progress = ring.current?.geometry.getAttribute('aProgress') as THREE.InstancedBufferAttribute | undefined

    for (let k = 0; k < entries.length; k++) {
      const e = entries[k]
      let visible = true
      let fill = 0
      if (e.instance >= 0) {
        const s = samplePickup(x, e.instance, tickF, _sample)
        if (!s.alive) continue
        visible = s.visible
        fill = s.progress
      }
      // Until the map has been analysed, textured GLBs assume a baked kit (never draw a duplicate).
      const baked = mode === 'full' ? false : known ? known.baked[k] === 1 : true
      const floorZ = known && !Number.isNaN(known.floor[k]) ? known.floor[k] : e.z - PICKUP_FLOOR_OFFSET
      const [width, height] = (e.kind === 0 ? HEALTH_SIZE : AMMO_SIZE)[e.size] ?? HEALTH_SIZE[1]
      if (visible) {
        if (baked) continue
        const base = floorZ + bob
        _p.set(e.x, e.y, base + height / 2)
        _m.compose(_p, _q, _s.set(width, width, height))
        if (e.kind === 0) {
          healthBody.current?.setMatrixAt(hb++, _m)
          const arm = width * 0.72, thick = width * 0.24
          _p.set(e.x, e.y, base + height + 0.6)
          _m.compose(_p, _q, _s.set(arm, thick, 1.2))
          healthCross.current?.setMatrixAt(hc++, _m)
          _m.compose(_p, _q, _s.set(thick, arm, 1.2))
          healthCross.current?.setMatrixAt(hc++, _m)
        } else {
          ammoBody.current?.setMatrixAt(ab++, _m)
          _p.set(e.x, e.y, base + height * 0.55)
          _m.compose(_p, _q, _s.set(width + 0.8, width + 0.8, height * 0.3))
          ammoBand.current?.setMatrixAt(an++, _m)
        }
        continue
      }
      // Taken: a ghost of the kit where it rests plus the respawn ring on the floor.
      _p.set(e.x, e.y, floorZ + PICKUP_BOB + height / 2)
      _m.compose(_p, NO_ROTATION, _s.set(width + 2, width + 2, height + 2))
      if (wire.current) {
        wire.current.setMatrixAt(w, _m)
        wire.current.setColorAt(w, e.kind === 0 ? COLORS.healthWire : COLORS.ammoWire)
        w++
      }
      const radius = ringRadius(width)
      _p.set(e.x, e.y, floorZ + RING_LIFT)
      _m.compose(_p, NO_ROTATION, _s.set(radius, radius, 1))
      if (ring.current && progress) {
        ring.current.setMatrixAt(r, _m)
        ring.current.setColorAt(r, e.kind === 0 ? COLORS.healthRing : COLORS.ammoRing)
        progress.setX(r, fill)
        r++
      }
    }

    const finish = (mesh: THREE.InstancedMesh | null, count: number) => {
      if (!mesh) return
      mesh.count = count
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    finish(healthBody.current, hb)
    finish(healthCross.current, hc)
    finish(ammoBody.current, ab)
    finish(ammoBand.current, an)
    finish(wire.current, w)
    finish(ring.current, r)
    if (progress) progress.needsUpdate = true
    drawn.kits = hb + ab
    drawn.wires = w
    drawn.rings = r
    drawn.tickF = tickF
  })

  if (!x || capacity === 0) return null
  return (
    <group name="mapdyn-pickups">
      <instancedMesh ref={healthBody} args={[UNIT_BOX, MATERIALS.healthBody, capacity]} count={0} frustumCulled={false} />
      <instancedMesh ref={healthCross} args={[UNIT_BOX, MATERIALS.healthCross, capacity * 2]} count={0} frustumCulled={false} />
      <instancedMesh ref={ammoBody} args={[UNIT_BOX, MATERIALS.ammoBody, capacity]} count={0} frustumCulled={false} />
      <instancedMesh ref={ammoBand} args={[UNIT_BOX, MATERIALS.ammoBand, capacity]} count={0} frustumCulled={false} />
      <instancedMesh ref={wire} args={[UNIT_BOX_FRAME, MATERIALS.wire, capacity]} count={0} frustumCulled={false} />
      <instancedMesh ref={ring} args={[ringGeometry, RING_MATERIAL, capacity]} count={0} frustumCulled={false} renderOrder={2} />
    </group>
  )
})
