// Objective markers in the scene (contract section 5 F5, ObjectivesLayer), gated by hud.objective:
//
//   cart        at the cart mover (cart.movers instance alive at the tick; else the track train with z - 48): a
//               60 x 36 x 6 slab, a bomb cylinder r 15 x 46 along X at z 30, four wheels r 7 at (+-22, +-18, 7)
//               and a light sphere r 3 at z 48 in the attackers' TEAM_FX, blinking every 20 ticks while the cart
//               moves, #ff2020 while it rolls back. Tug of war: a NEUTRAL body with one light per team.
//   push zone   the map-meta capture area parented to the train: a ring of radius half its XY diagonal (100
//               when unknown) at cart z + 2, attackers' TEAM_FX, opacity 0.12, 0.24 while someone pushes
//   track       the map-meta payload path as a 3-unit ribbon at path z + 4: the pushed part (progress x length)
//               in the attackers' TEAM_TRAIL, the rest NEUTRAL at 0.35; checkpoint posts (r 3, h 40) at the
//               linked distances in the owner's colour
//   points      KOTH and control-point maps: a disc r 48 h 3 at cp.pos (map-meta origin as fallback) in the
//               owner's TEAM_DARK or NEUTRAL, a progress arc (r 36, 6 wide) at z 6 in the capping team's
//               TEAM_FX, angle = progress x 2 pi; locked: a #3a3a3a disc and a dashed ring
//
// Everything is placed in useFrame from (extras, renderTick + frameProgress); nothing accumulates across frames.

import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

import { getState, useInstance } from '@zus/store'
import { DARK_METAL, METAL, NEUTRAL, TEAM_DARK, TEAM_FX, TEAM_TRAIL } from '@highlander/constants'
import { registerHlProbe } from '@highlander/debug'
import { CPF } from '@highlander/extras/enums'
import { capProgressAt } from '@highlander/extras/getters'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { trackIndexAt, xformAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { useDemoMapMeta } from '@highlander/hud/hudSnapshot'
import { getLoadedMapMeta, sourceToScene, type MapMeta } from '@highlander/map/mapMeta'
import { aliveInstanceAt, attackTeamAt, metaPointMap, objectiveModeOf, type ObjectiveMode } from '@highlander/objectives/objectiveModel'

const TRAIN_TO_CART_Z = 48
const BLINK_TICKS = 20
const ROLLBACK_LIGHT = '#ff2020'
const ARC_SEGMENTS = 64
const TRACK_STEP = 16
const TRACK_WIDTH = 3

const fxColor = (team: number) => (team === 2 ? TEAM_FX.red : team === 3 ? TEAM_FX.blue : NEUTRAL)
const darkColor = (team: number) => (team === 2 ? TEAM_DARK.red : team === 3 ? TEAM_DARK.blue : NEUTRAL)
const trailColor = (team: number) => (team === 2 ? TEAM_TRAIL.red : team === 3 ? TEAM_TRAIL.blue : NEUTRAL)

const getReadyExtras = (): HighlanderExtras | undefined => {
  const s = useInstance.getState()
  return s.extrasStatus === 'ready' ? s.extras : undefined
}

// ─── shared geometry ───────────────────────────────────────────────────────────

const SLAB_GEOMETRY = new THREE.BoxGeometry(60, 36, 6)
const BOMB_GEOMETRY = new THREE.CylinderGeometry(15, 15, 46, 20).rotateZ(Math.PI / 2) // axis along X
const WHEEL_GEOMETRY = new THREE.CylinderGeometry(7, 7, 4, 14) // axis along Y
const LIGHT_GEOMETRY = new THREE.SphereGeometry(3, 12, 8)
const HALO_GEOMETRY = new THREE.SphereGeometry(11, 12, 8)
const DISC_GEOMETRY = new THREE.CylinderGeometry(48, 48, 3, 40).rotateX(Math.PI / 2)
const ARC_GEOMETRY = new THREE.RingGeometry(33, 39, ARC_SEGMENTS, 1, Math.PI / 2, Math.PI * 2)
const POST_GEOMETRY = new THREE.CylinderGeometry(3, 3, 40, 10).rotateX(Math.PI / 2).translate(0, 0, 20)

/** A ring of `dashes` arc pieces (every other one drawn), flat in the XY plane. */
function dashedRing(inner: number, outer: number, dashes: number): THREE.BufferGeometry {
  const positions: number[] = []
  const step = (Math.PI * 2) / (dashes * 2)
  for (let k = 0; k < dashes; k++) {
    const a0 = k * 2 * step
    const a1 = a0 + step
    const p = (r: number, a: number) => [r * Math.cos(a), r * Math.sin(a), 0]
    const [i0, o0, i1, o1] = [p(inner, a0), p(outer, a0), p(inner, a1), p(outer, a1)]
    positions.push(...i0, ...o0, ...o1, ...i0, ...o1, ...i1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.computeVertexNormals()
  return g
}
const DASHED_RING_GEOMETRY = dashedRing(44, 50, 24)

const WHEEL_MATERIAL = new THREE.MeshLambertMaterial({ color: METAL })
const BOMB_MATERIAL = new THREE.MeshLambertMaterial({ color: DARK_METAL })
const NEUTRAL_MATERIAL = new THREE.MeshLambertMaterial({ color: NEUTRAL })
const LOCKED_RING_MATERIAL = new THREE.MeshBasicMaterial({ color: '#d0d0d0', transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide })

const glowMaterial = (color: string, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })

// ─── layer ─────────────────────────────────────────────────────────────────────

export const ObjectivesLayer = React.memo(({ renderTick }: { renderTick: number }) => {
  const x = useExtras()
  const on = useHlSetting<boolean>('hud.objective')
  const meta = useDemoMapMeta()
  const demo = useInstance(s => s.parsedDemo)
  if (!x || !on || !demo) return null
  const mode = objectiveModeOf(x, meta)
  const origin = demo.world.boundaryMin
  return (
    <group name="hl-objectives">
      {x.meta.available.carts && (mode === 'payload' || mode === 'tow') && <CartObject renderTick={renderTick} mode={mode} meta={meta} />}
      {meta && (mode === 'payload' || mode === 'tow') && meta.payload.length > 0 && (
        <PayloadTrack renderTick={renderTick} meta={meta} mode={mode} origin={origin} />
      )}
      {(mode === 'koth' || mode === 'cp') && x.meta.available.objectiveResource && (
        <ControlPoints x={x} meta={meta} origin={origin} renderTick={renderTick} />
      )}
    </group>
  )
})

// ─── cart ──────────────────────────────────────────────────────────────────────

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()

interface CartPose { found: boolean; pos: THREE.Vector3; quat: THREE.Quaternion; speed: number; cappers: number; source: 'prop' | 'train' | 'none'; mover: number }

/** The cart transform and watcher state at tickF (pure). */
export function cartPoseAt(x: HighlanderExtras, tickF: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): CartPose {
  const tick = Math.floor(tickF)
  const gap = x.meta.snapshotInterval || 1
  let source: CartPose['source'] = 'none'
  let mover = aliveInstanceAt(x.movers, tick, x.objectives.cart.movers)
  if (mover >= 0 && xformAt(x.movers.xform, mover, tickF, outPos, outQuat, gap)) source = 'prop'
  else {
    mover = aliveInstanceAt(x.movers, tick, x.objectives.cart.trains)
    if (mover >= 0 && xformAt(x.movers.xform, mover, tickF, outPos, outQuat, gap)) {
      outPos.z -= TRAIN_TO_CART_Z
      source = 'train'
    }
  }
  let speed = 0, cappers = 0
  const w = x.objectives.watchers
  const j = aliveInstanceAt(w, tick)
  if (j >= 0) {
    const k = trackIndexAt(w.state, j, tick)
    if (k >= 0) {
      speed = w.state.speed[k]
      cappers = w.state.cappers[k]
    }
  }
  return { found: source !== 'none', pos: outPos, quat: outQuat, speed, cappers, source, mover }
}

function pushZoneRadius(meta: MapMeta | null): number {
  const payload = meta?.payload?.[0]
  const area = payload ? meta!.captureAreas.find(a => a.parent === payload.train) : undefined
  if (!area) return 100
  const dx = area.maxs[0] - area.mins[0]
  const dy = area.maxs[1] - area.mins[1]
  const r = Math.sqrt(dx * dx + dy * dy) / 2
  return r > 8 ? r : 100
}

const CartObject = ({ renderTick, mode, meta }: { renderTick: number; mode: ObjectiveMode; meta: MapMeta | null }) => {
  const group = useRef<THREE.Group>(null)
  const ring = useRef<THREE.Mesh>(null)
  const lightA = useRef<THREE.Group>(null)
  const lightB = useRef<THREE.Group>(null)
  const tow = mode === 'tow'
  const materials = useMemo(
    () => ({
      slab: new THREE.MeshLambertMaterial({ color: TEAM_DARK.blue }),
      lightA: glowMaterial(TEAM_FX.blue),
      haloA: glowMaterial(TEAM_FX.blue, 0.45),
      lightB: glowMaterial(TEAM_FX.red),
      haloB: glowMaterial(TEAM_FX.red, 0.45),
      ring: new THREE.MeshBasicMaterial({ color: TEAM_FX.blue, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
    }),
    []
  )
  useEffect(() => () => Object.values(materials).forEach(m => m.dispose()), [materials])
  const radius = pushZoneRadius(meta)
  const ringGeometry = useMemo(() => new THREE.RingGeometry(Math.max(4, radius - 8), radius, 56), [radius])
  useEffect(() => () => ringGeometry.dispose(), [ringGeometry])

  useFrame(() => {
    const g = group.current
    const x = getReadyExtras()
    if (!g || !x) return
    const tickF = renderTick + useInstance.getState().frameProgress
    const pose = cartPoseAt(x, tickF, _pos, _quat)
    g.visible = pose.found
    if (ring.current) ring.current.visible = pose.found
    if (!pose.found) return
    g.position.copy(pose.pos)
    g.quaternion.copy(pose.quat)
    if (ring.current) {
      ring.current.position.set(pose.pos.x, pose.pos.y, pose.pos.z + 2)
    }

    const blinkOn = Math.floor(tickF / BLINK_TICKS) % 2 === 0
    if (tow) {
      // forward (speed > 0) is BLU pushing toward the RED end
      if (lightA.current) lightA.current.visible = pose.speed > 0 ? blinkOn : true
      if (lightB.current) lightB.current.visible = pose.speed < 0 ? blinkOn : true
      materials.ring.color.set(pose.speed < 0 ? TEAM_FX.red : pose.speed > 0 ? TEAM_FX.blue : NEUTRAL)
    } else {
      const attack = attackTeamAt(x, Math.floor(tickF))
      const color = pose.speed < 0 ? ROLLBACK_LIGHT : fxColor(attack)
      materials.lightA.color.set(color)
      materials.haloA.color.set(color)
      materials.slab.color.set(darkColor(attack))
      if (lightA.current) lightA.current.visible = pose.speed > 0 ? blinkOn : true
      materials.ring.color.set(fxColor(attack))
    }
    materials.ring.opacity = pose.cappers > 0 ? 0.24 : 0.12
  })

  const body = tow ? NEUTRAL_MATERIAL : BOMB_MATERIAL
  return (
    <>
      <group ref={group} name="hl-cart" visible={false}>
        <mesh geometry={SLAB_GEOMETRY} material={tow ? NEUTRAL_MATERIAL : materials.slab} position={[0, 0, 6]} />
        <mesh geometry={BOMB_GEOMETRY} material={body} position={[0, 0, 30]} />
        {[
          [22, 18],
          [22, -18],
          [-22, 18],
          [-22, -18],
        ].map(([wx, wy]) => (
          <mesh key={`${wx}:${wy}`} geometry={WHEEL_GEOMETRY} material={WHEEL_MATERIAL} position={[wx, wy, 7]} />
        ))}
        <group ref={lightA} position={[tow ? -8 : 0, 0, 48]}>
          <mesh geometry={LIGHT_GEOMETRY} material={materials.lightA} />
          <mesh geometry={HALO_GEOMETRY} material={materials.haloA} />
        </group>
        {tow && (
          <group ref={lightB} position={[8, 0, 48]}>
            <mesh geometry={LIGHT_GEOMETRY} material={materials.lightB} />
            <mesh geometry={HALO_GEOMETRY} material={materials.haloB} />
          </group>
        )}
      </group>
      <mesh ref={ring} name="hl-push-zone" geometry={ringGeometry} material={materials.ring} visible={false} renderOrder={2} />
    </>
  )
}

// ─── track ─────────────────────────────────────────────────────────────────────

interface TrackModel {
  pushed: THREE.BufferGeometry
  rest: THREE.BufferGeometry
  /** cumulative distance at each sample */
  cum: Float32Array
  total: number
  samples: number
  posts: { pos: THREE.Vector3; pointIndex: number }[]
}

function buildTrack(x: HighlanderExtras, meta: MapMeta, origin: { x: number; y: number; z: number }): TrackModel | null {
  const payload = meta.payload[0]
  const nodes = payload.path.map(n => sourceToScene(n.origin, origin))
  if (nodes.length < 2) return null
  // resample the polyline every TRACK_STEP units
  const pts: THREE.Vector3[] = [nodes[0].clone()]
  const cumList: number[] = [0]
  let total = 0
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i]
    const len = a.distanceTo(b)
    if (len < 1e-3) continue
    const n = Math.max(1, Math.ceil(len / TRACK_STEP))
    for (let k = 1; k <= n; k++) {
      pts.push(a.clone().lerp(b, k / n))
      cumList.push(total + (len * k) / n)
    }
    total += len
  }
  if (pts.length < 2 || total <= 0) return null

  const positions = new Float32Array(pts.length * 2 * 3)
  const side = new THREE.Vector3()
  const dir = new THREE.Vector3()
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)]
    dir.subVectors(next, prev).setZ(0)
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0)
    dir.normalize()
    side.set(-dir.y, dir.x, 0).multiplyScalar(TRACK_WIDTH / 2)
    const z = pts[i].z + 4
    positions.set([pts[i].x + side.x, pts[i].y + side.y, z, pts[i].x - side.x, pts[i].y - side.y, z], i * 6)
  }
  const index: number[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3
    index.push(a, b, d, a, d, c)
  }
  const posAttr = new THREE.BufferAttribute(positions, 3)
  const make = () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', posAttr)
    g.setIndex(index)
    g.computeBoundingSphere()
    return g
  }

  // checkpoint posts at the linked distances, scaled to the resampled length
  const posts: TrackModel['posts'] = []
  const scale = payload.length > 0 ? total / payload.length : 1
  const cum = Float32Array.from(cumList)
  const byName = metaPointMap(x, meta).byName
  for (const link of payload.linked) {
    const pointIndex = byName.get(link.controlPoint)
    if (pointIndex === undefined) continue
    const d = Math.min(total, Math.max(0, link.distance * scale))
    const pos = pointAtDistance(pts, cum, d)
    pos.z += 4
    posts.push({ pos, pointIndex })
  }
  return { pushed: make(), rest: make(), cum, total, samples: pts.length, posts }
}

function pointAtDistance(pts: THREE.Vector3[], cum: Float32Array, d: number): THREE.Vector3 {
  let lo = 0, hi = cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (cum[mid] < d) lo = mid + 1
    else hi = mid
  }
  if (lo === 0) return pts[0].clone()
  const a = cum[lo - 1], b = cum[lo]
  return pts[lo - 1].clone().lerp(pts[lo], b > a ? (d - a) / (b - a) : 0)
}

const PayloadTrack = ({ renderTick, meta, mode, origin }: { renderTick: number; meta: MapMeta; mode: ObjectiveMode; origin: { x: number; y: number; z: number } }) => {
  const x = useExtras()
  const track = useMemo(() => (x ? buildTrack(x, meta, origin) : null), [x, meta, origin])
  const materials = useMemo(
    () => ({
      pushed: new THREE.MeshBasicMaterial({ color: TEAM_TRAIL.blue, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      rest: new THREE.MeshBasicMaterial({ color: NEUTRAL, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
      posts: (track?.posts ?? []).map(() => new THREE.MeshLambertMaterial({ color: NEUTRAL })),
    }),
    [track]
  )
  useEffect(
    () => () => {
      track?.pushed.dispose()
      track?.rest.dispose()
      materials.pushed.dispose()
      materials.rest.dispose()
      materials.posts.forEach(m => m.dispose())
    },
    [track, materials]
  )

  useFrame(() => {
    const x = getReadyExtras()
    if (!track || !x) return
    const tick = renderTick
    const quads = track.samples - 1
    let k = 0
    if (mode === 'payload') {
      const w = x.objectives.watchers
      const j = aliveInstanceAt(w, tick)
      const s = j >= 0 ? trackIndexAt(w.state, j, tick) : -1
      const progress = s >= 0 ? w.state.progress[s] / 65535 : 0
      const d = progress * track.total
      let lo = 0, hi = track.cum.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (track.cum[mid] < d) lo = mid + 1
        else hi = mid
      }
      k = Math.min(quads, lo)
      materials.pushed.color.set(trailColor(attackTeamAt(x, tick)))
    }
    track.pushed.setDrawRange(0, k * 6)
    track.rest.setDrawRange(k * 6, (quads - k) * 6)
    const st = x.objectives.cp.state
    track.posts.forEach((post, i) => {
      const e = trackIndexAt(st, post.pointIndex, tick)
      const owner = e >= 0 ? st.owner[e] : 0
      materials.posts[i]?.color.set(owner > 1 ? fxColor(owner) : NEUTRAL)
    })
  })

  if (!track) return null
  return (
    <group name="hl-payload-track">
      <mesh geometry={track.pushed} material={materials.pushed} renderOrder={1} />
      <mesh geometry={track.rest} material={materials.rest} renderOrder={1} />
      {track.posts.map((post, i) => (
        <mesh key={i} geometry={POST_GEOMETRY} material={materials.posts[i]} position={post.pos} />
      ))}
    </group>
  )
}

// ─── control points ────────────────────────────────────────────────────────────

/** Scene position of point i: cp.pos, or the map-meta origin while cp.pos is unset (raw 0, 0, 0). */
export function pointPosition(x: HighlanderExtras, meta: MapMeta | null, origin: { x: number; y: number; z: number }, i: number): THREE.Vector3 | null {
  const p = x.objectives.cp.pos
  const px = p[i * 3], py = p[i * 3 + 1], pz = p[i * 3 + 2]
  const unset = !Number.isFinite(px) || (Math.abs(px + origin.x) < 0.01 && Math.abs(py + origin.y) < 0.01 && Math.abs(pz + origin.z) < 0.01)
  if (!unset) return new THREE.Vector3(px, py, pz)
  const m = metaPointMap(x, meta).byDemo[i]
  return m ? sourceToScene(m.origin, origin) : null
}

const _ray = new THREE.Raycaster()
const _rayOrigin = new THREE.Vector3()
const DOWN = new THREE.Vector3(0, 0, -1)

const visibleInScene = (o: THREE.Object3D | null) => {
  for (let n = o; n; n = n.parent) if (!n.visible) return false
  return true
}

/**
 * Height of the highest visible map surface at the point, at most 40 units above its origin. The textured
 * koth_product GLB models the raised capture base around the origin; a disc at the origin itself would be
 * buried in it. On bsp-to-glb maps the base is a stock prop (not rendered), so this finds the floor.
 */
function pointSurfaceZ(pos: THREE.Vector3): number {
  const world = useInstance.getState().threeScene?.getObjectByName('world')
  if (!world) return pos.z
  _ray.set(_rayOrigin.set(pos.x, pos.y, pos.z + 40), DOWN)
  _ray.far = 48
  let best = pos.z
  for (const hit of _ray.intersectObject(world, true)) {
    if (hit.point.z > best && hit.point.z <= pos.z + 40 && visibleInScene(hit.object)) best = hit.point.z
  }
  return best
}

const ControlPoints = ({ x, meta, origin, renderTick }: { x: HighlanderExtras; meta: MapMeta | null; origin: { x: number; y: number; z: number }; renderTick: number }) => {
  // re-measure the surface when the map (re)loads
  const mapState = useInstance(s => s.mapStatus.state)
  const points = useMemo(() => {
    const out: { index: number; pos: THREE.Vector3 }[] = []
    for (let i = 0; i < x.objectives.cp.count; i++) {
      if (x.objectives.cp.visible[i] === 0) continue
      const pos = pointPosition(x, meta, origin, i)
      if (!pos) continue
      if (mapState === 'ready') pos.z = pointSurfaceZ(pos)
      out.push({ index: i, pos })
    }
    return out
  }, [x, meta, origin, mapState])
  return (
    <group name="hl-control-points">
      {points.map(p => (
        <ControlPointDisc key={p.index} index={p.index} pos={p.pos} renderTick={renderTick} />
      ))}
    </group>
  )
}

const ControlPointDisc = ({ index, pos, renderTick }: { index: number; pos: THREE.Vector3; renderTick: number }) => {
  const arc = useRef<THREE.Mesh>(null)
  const dashed = useRef<THREE.Mesh>(null)
  const materials = useMemo(
    () => ({
      disc: new THREE.MeshLambertMaterial({ color: NEUTRAL }),
      arc: new THREE.MeshBasicMaterial({ color: NEUTRAL, side: THREE.DoubleSide, depthWrite: false, transparent: true, opacity: 0.95 }),
    }),
    []
  )
  const arcGeometry = useMemo(() => ARC_GEOMETRY.clone(), [])
  useEffect(
    () => () => {
      materials.disc.dispose()
      materials.arc.dispose()
      arcGeometry.dispose()
    },
    [materials, arcGeometry]
  )

  useFrame(() => {
    const x = getReadyExtras()
    if (!x) return
    const tickF = renderTick + useInstance.getState().frameProgress
    const tick = Math.floor(tickF)
    const st = x.objectives.cp.state
    const e = trackIndexAt(st, index, tick)
    const owner = e >= 0 ? st.owner[e] : 0
    const capping = e >= 0 ? st.capping[e] : 0
    const locked = e >= 0 && (st.flags[e] & CPF.LOCKED) !== 0
    materials.disc.color.set(locked ? '#3a3a3a' : owner > 1 ? darkColor(owner) : NEUTRAL)
    if (dashed.current) dashed.current.visible = locked
    const progress = capping > 1 ? capProgressAt(x, index, tickF) : 0
    const segments = Math.round(progress * ARC_SEGMENTS)
    arcGeometry.setDrawRange(0, segments * 6)
    materials.arc.color.set(fxColor(capping))
    if (arc.current) arc.current.visible = segments > 0
  })

  return (
    <group position={pos} name={`hl-point-${index}`}>
      <mesh geometry={DISC_GEOMETRY} material={materials.disc} position={[0, 0, 1.5]} />
      <mesh ref={arc} geometry={arcGeometry} material={materials.arc} position={[0, 0, 6]} renderOrder={2} visible={false} />
      <mesh ref={dashed} geometry={DASHED_RING_GEOMETRY} material={LOCKED_RING_MATERIAL} position={[0, 0, 4]} visible={false} />
    </group>
  )
}

// ─── probe ─────────────────────────────────────────────────────────────────────

/** objectives.scene(tick): what the layer draws at a cache tick (cart pose and lights, track split, points). */
registerHlProbe('objectives.scene', (tickArg?: number) => {
  const s = useInstance.getState()
  const x = s.extrasStatus === 'ready' ? s.extras : undefined
  const demo = s.parsedDemo
  if (!x || !demo) return { error: 'extras not ready' }
  const tick = Math.max(0, Math.floor(tickArg ?? Math.max(1, getState().playback.tick - 2)))
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion()
  const pose = cartPoseAt(x, tick, pos, quat)
  const w = x.objectives.watchers
  const j = aliveInstanceAt(w, tick)
  const k = j >= 0 ? trackIndexAt(w.state, j, tick) : -1
  const node = s.threeScene?.getObjectByName('hl-cart')
  return {
    tick,
    mode: objectiveModeOf(x, null),
    carts: x.meta.available.carts,
    cart: pose.found
      ? {
          source: pose.source,
          mover: pose.mover,
          pos: [pos.x, pos.y, pos.z].map(v => Math.round(v * 10) / 10),
          speed: pose.speed,
          cappers: pose.cappers,
          sceneNode: node ? { visible: node.visible, pos: [node.position.x, node.position.y, node.position.z].map(v => Math.round(v * 10) / 10) } : null,
        }
      : null,
    watcherProgress: k >= 0 ? w.state.progress[k] / 65535 : null,
    points: Array.from({ length: x.objectives.cp.count }, (_, i) => {
      const st = x.objectives.cp.state
      const e = trackIndexAt(st, i, tick)
      const pos = pointPosition(x, getLoadedMapMeta(demo.header?.map ?? '') ?? null, demo.world.boundaryMin, i)
      return {
        index: i,
        pos: pos ? [pos.x, pos.y, pos.z].map(v => Math.round(v * 10) / 10) : null,
        surfaceZ: pos ? Math.round(pointSurfaceZ(pos) * 10) / 10 : null,
        owner: e >= 0 ? st.owner[e] : null,
        capping: e >= 0 ? st.capping[e] : null,
        locked: e >= 0 ? (st.flags[e] & CPF.LOCKED) !== 0 : null,
        progress: Math.round(capProgressAt(x, i, tick) * 1000) / 1000,
      }
    }),
  }
})
