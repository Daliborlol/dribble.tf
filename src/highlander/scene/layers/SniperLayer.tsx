// Sniper and wrangler laser dots (contract section 5 F4, SniperLayer; settings sniper.dots and sniper.beams).
//
// Every `dots` instance alive at the tick is drawn at its networked position, held between updates (the dot jumps
// between hit points, so it is not interpolated). Two billboards from one radial texture: an outer glow of size 6 at
// opacity 0.5 and an inner core of size 6 * s, s = clamp(charge / 150, 0.1, 1). Both ignore depth, so dots read
// through walls. A thin beam joins the owner's eye to the dot (opacity 0.3, 0.5 for the wrangler). The beam is a
// fixed-pixel-width line, so it stays readable from an RTS camera far away without getting fat up close.

import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

import { useInstance, useStore } from '@zus/store'
import { TEAM_FX, teamKey } from '@highlander/constants'
import { frameTime, type FrameTime } from '@highlander/combat/time'
import { registerHlProbe } from '@highlander/debug'
import { hasLocalTables, sniperChargeAt } from '@highlander/extras/getters'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { entityIdOfPlayer, getPovSubject } from '@highlander/pov/subject'
import { getActor } from '@highlander/scene/actorRegistry'
import { getEyeHeight } from '@highlander/scene/eyeHeight'
import { radialTexture } from '@highlander/scene/viewmodel/textures'

const MAX_DOTS = 12
const DOT_SIZE = 6
/** TF2 draws a sniper's own dot at size 2 in his first person view. */
const OWN_DOT_SIZE = 2
const BEAM_OPACITY = 0.3
const LASER_BEAM_OPACITY = 0.5
const BEAM_WIDTH_PX = 2.5
/**
 * Smallest on-screen sizes of a dot's outer glow and of its core, so a sniper's aim point stays findable from an RTS
 * camera far away (an uncharged dot's core is 0.6 units: under a pixel at RTS distance). The contract sizes rule up
 * close.
 */
const MIN_DOT_PX = 14
const MIN_CORE_PX = 5
/** Below the viewmodel depth clear (1e6), above ordinary transparent effects. */
const DOT_ORDER = 900

export interface DotView {
  instance: number
  owner: number
  team: number
  laser: boolean
  x: number; y: number; z: number
  chargeTick: number
}

/** Dots alive at the tick with their held positions. */
export function dotsAt(x: HighlanderExtras, tick: number): DotView[] {
  const d = x.dots
  const out: DotView[] = []
  for (let j = 0; j < d.count; j++) {
    if (d.created[j] > tick) break // sorted by created
    if (d.deleted[j] <= tick) continue
    const i = trackIndexAt(d.pos, j, tick)
    if (i < 0 || Number.isNaN(d.pos.x[i])) continue
    out.push({ instance: j, owner: d.owner[j], team: d.team[j], laser: d.laser[j] === 1, x: d.pos.x[i], y: d.pos.y[i], z: d.pos.z[i], chargeTick: d.pos.chargeTick[i] })
  }
  return out
}

/** Core size factor s = clamp(charge / 150, 0.1, 1); the wrangler laser is always full. */
export function dotScale(x: HighlanderExtras, dot: DotView, tickF: number): number {
  if (dot.laser) return 1
  let charge: number
  if (dot.owner !== 255 && x.meta.available.sniper && hasLocalTables(x, dot.owner)) {
    charge = sniperChargeAt(x, dot.owner, Math.floor(tickF))
  } else {
    charge = Number.isNaN(dot.chargeTick) ? 0 : (tickF - dot.chargeTick) * x.meta.intervalPerTick * 50
  }
  return Math.min(1, Math.max(0.1, charge / 150))
}

interface Slot { outer: THREE.Sprite; inner: THREE.Sprite; beam: Line2; beamPositions: Float32Array }

const spriteMaterials = new Map<string, THREE.SpriteMaterial>()
function spriteMaterial(color: string, opacity: number, additive: boolean): THREE.SpriteMaterial {
  const key = `${color}:${opacity}:${additive}`
  let m = spriteMaterials.get(key)
  if (!m) {
    m = new THREE.SpriteMaterial({
      map: radialTexture(),
      color,
      opacity,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: false,
      toneMapped: false,
    })
    spriteMaterials.set(key, m)
  }
  return m
}

const _eye = new THREE.Vector3()
const _cam = new THREE.Vector3()
const _time: FrameTime = { tick: 0, tickF: 0 }

// The dots and tickF come from the store in useFrame (frameTime), not from the renderTick prop: the prop reaches
// React a frame after DemoViewer advances playback.tick, so prop + frameProgress stepped back at tick boundaries.
export const SniperLayer = React.memo(() => {
  const extras = useExtras()
  const dotsOn = useHlSetting<boolean>('sniper.dots')
  const beamsOn = useHlSetting<boolean>('sniper.beams')
  const { size } = useThree()

  const slots = useMemo<Slot[]>(() => {
    const out: Slot[] = []
    for (let i = 0; i < MAX_DOTS; i++) {
      const outer = new THREE.Sprite(spriteMaterial(TEAM_FX.red, 0.5, true))
      const inner = new THREE.Sprite(spriteMaterial(TEAM_FX.red, 1, false))
      outer.renderOrder = DOT_ORDER
      inner.renderOrder = DOT_ORDER + 1
      outer.frustumCulled = inner.frustumCulled = false
      const geometry = new LineGeometry()
      geometry.setPositions([0, 0, 0, 0, 0, 1])
      const material = new LineMaterial({ color: TEAM_FX.red, linewidth: BEAM_WIDTH_PX, transparent: true, opacity: BEAM_OPACITY, depthWrite: false })
      const beam = new Line2(geometry, material)
      beam.frustumCulled = false
      beam.renderOrder = DOT_ORDER - 1
      const start = geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute
      out.push({ outer, inner, beam, beamPositions: start.data.array as Float32Array })
      outer.visible = inner.visible = beam.visible = false
    }
    return out
  }, [])
  // r3f does not dispose <primitive> objects: free the per-slot beam geometries and materials on unmount (the sprite
  // materials are module-level and shared)
  useEffect(
    () => () => {
      for (const slot of slots) {
        slot.beam.geometry.dispose()
        ;(slot.beam.material as LineMaterial).dispose()
      }
    },
    [slots]
  )

  // Dots alive at the drawn tick, recomputed only when the tick (or the extras, or the setting) changes
  const dotsCache = useRef<{ x: HighlanderExtras | undefined; on: boolean; tick: number; dots: DotView[] }>({ x: undefined, on: false, tick: -1, dots: [] })

  useFrame(state => {
    const x = extras
    const { tick, tickF } = frameTime(_time)
    const on = !!(x && dotsOn && x.meta.available.dots)
    const cache = dotsCache.current
    if (cache.x !== x || cache.on !== on || cache.tick !== tick) {
      cache.x = x
      cache.on = on
      cache.tick = tick
      cache.dots = on && x ? dotsAt(x, tick) : []
    }
    const dots = cache.dots
    const demo = useInstance.getState().parsedDemo
    // Whose eyes the scene renders from: his own beam would be a line along the view, so it is skipped
    const camera = state.camera
    const povOwner = camera.name === 'povCamera' ? (camera.parent?.parent?.userData?.entityId as number | undefined) : undefined
    for (let i = 0; i < MAX_DOTS; i++) {
      const slot = slots[i]
      const dot = dots[i]
      if (!x || !dot || !demo) {
        slot.outer.visible = slot.inner.visible = slot.beam.visible = false
        continue
      }
      const key = teamKey(dot.team) ?? 'red'
      const color = TEAM_FX[key]
      const ownerEntity = dot.owner === 255 ? -1 : entityIdOfPlayer(demo, dot.owner)
      const own = ownerEntity > 0 && ownerEntity === povOwner
      const s = dotScale(x, dot, tickF)
      // TF2 size up close, at least MIN_DOT_PX on screen further away
      _eye.set(dot.x, dot.y, dot.z)
      const dist = camera.getWorldPosition(_cam).distanceTo(_eye)
      const perspective = camera as THREE.PerspectiveCamera
      const pxWorld = perspective.isPerspectiveCamera ? (2 * dist * Math.tan((perspective.fov * Math.PI) / 360)) / Math.max(1, size.height) : 0
      const base = Math.max(own ? OWN_DOT_SIZE : DOT_SIZE, MIN_DOT_PX * pxWorld)
      slot.outer.material = spriteMaterial(color, 0.5, true)
      slot.inner.material = spriteMaterial(color, 1, false)
      slot.outer.position.set(dot.x, dot.y, dot.z)
      slot.inner.position.set(dot.x, dot.y, dot.z)
      slot.outer.scale.setScalar(base)
      slot.inner.scale.setScalar(Math.min(base, Math.max(base * s, MIN_CORE_PX * pxWorld)))
      slot.outer.visible = slot.inner.visible = true

      // Beam from the owner's eye (interpolated actor + eye height) to the dot
      const actor = ownerEntity > 0 ? getActor(ownerEntity) : undefined
      if (!beamsOn || !actor || own) {
        slot.beam.visible = false
        continue
      }
      const classId = demo.playerCache.metaCache.getMeta(dot.owner, tick).classId
      _eye.copy(actor.group.position)
      _eye.z += getEyeHeight(ownerEntity, classId, tick)
      const p = slot.beamPositions
      p[0] = _eye.x; p[1] = _eye.y; p[2] = _eye.z
      p[3] = dot.x; p[4] = dot.y; p[5] = dot.z
      const start = slot.beam.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute
      start.data.needsUpdate = true
      const material = slot.beam.material as LineMaterial
      material.color.set(color)
      material.opacity = dot.laser ? LASER_BEAM_OPACITY : BEAM_OPACITY
      material.resolution.set(size.width, size.height)
      slot.beam.visible = true
    }
  })

  if (!extras || !dotsOn) return null
  return (
    <group name="hlSniperDots">
      {slots.map((slot, i) => (
        <group key={i}>
          <primitive object={slot.beam} />
          <primitive object={slot.outer} />
          <primitive object={slot.inner} />
        </group>
      ))}
    </group>
  )
})

// Probe: the dots drawn at a cache tick (default: the current renderTick), with their core scale and beam owner.
registerHlProbe('sniper.dots', (tick?: number) => {
  const { extras, extrasStatus, parsedDemo } = useInstance.getState()
  if (extrasStatus !== 'ready' || !extras) return []
  const at = Math.floor(tick ?? Math.max(1, useStore.getState().playback.tick - 2))
  const subject = getPovSubject(at)
  const r = (v: number) => Math.round(v * 100) / 100
  return dotsAt(extras, at).map(dot => {
    const owner = dot.owner === 255 || !parsedDemo ? -1 : entityIdOfPlayer(parsedDemo, dot.owner)
    return {
      instance: dot.instance,
      owner: dot.owner,
      ownerEntityId: owner,
      team: dot.team,
      laser: dot.laser,
      pos: [r(dot.x), r(dot.y), r(dot.z)],
      s: r(dotScale(extras, dot, at)),
      beam: owner > 0 && !!getActor(owner) && !(subject && subject.camera !== 'chase' && subject.camera !== 'deathcam' && subject.entityId === owner),
    }
  })
})
