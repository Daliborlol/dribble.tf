// Debug-bridge probes of the F6 layer (contract section 3.10), registered when MapDynamicsLayer loads:
//   hl.probe('mapdyn.movers', tick?)   mover instances with a brush model alive at the tick:
//                                      { instance, bspModel, cls, classname, name, pos, quat, vis, visible,
//                                        nodeFound, node: { visible, pos } | null }
//   hl.probe('mapdyn.pickups', tick?)  kit spots that draw at the tick, one row per spot (its current
//                                      instance): { instance, spot, kind, size, visible, respawnIn, progress,
//                                      takenTick, nextTick, estimated, pos, floor, baked }, then one row per
//                                      moving pickup (thrown or dropped item, P2) drawn at the tick:
//                                      { instance, spot: null, moving: true, kind, size, visible, inFlight, pos }
//   hl.probe('mapdyn.kits', tick?)     which pickups are map kits: spots, the instances skipped (reason
//                                      'moving': thrown or dropped items, drawn along their motion; 'model':
//                                      other models; 'dropped': kit models on no map spot) and, with a tick,
//                                      the stale or skipped instances alive then
//   hl.probe('mapdyn.moving', tick?, floors?) moving pickups (P2): every thrown or dropped item with its
//                                      lifetime, track and, at the tick, whether and where it draws; with floors
//                                      the visible floor under each rest position (surface.ts, debug only)
//   hl.probe('mapdyn.surface', remeasure?) the floor analyses of the kit spots and of the mid-air death
//                                      markers (surface.ts); remeasure re-runs both in one call and times them
//   hl.probe('mapdyn.slabs', tick?)    prop-door slabs: { bspModel, name, visible, center }
//   hl.probe('mapdyn.markers', tick?)  death markers ({ pos: ragdoll origin, ground: drawn height, dropped })
//                                      and live drops at the tick
//   hl.probe('mapdyn.state')           what the mounted components drew in their last frame
//   hl.probe('mapdyn.summary')         demo-wide counts (node coverage of mover instances, slabs, lockers, kits)
// `tick` is a cache tick (default renderTick). pos is scene space; node.pos is the node's world position,
// which equals pos once the layer applied that tick.

import * as THREE from 'three'

import { registerHlProbe } from '@highlander/debug'
import type { HighlanderExtras } from '@highlander/extras/types'
import { getMapNodeInfo } from '@highlander/map/mapNodes'
import { getState, useInstance } from '@zus/store'

import { getActiveMarkerGround } from './DeathMarkers'
import { getActiveSlabs } from './DoorSlabs'
import { drawn } from './frame'
import { getActiveLockers } from './ResupplyLockers'
import { MARKER_SURFACE, airborneMarkerSpots, deathMarkersAt, forEachDropAt } from './markers'
import {
  getActiveMoverDriver,
  isAlive,
  isAlwaysHiddenNode,
  moverIndexOf,
  sampleMover,
  type MoverSample,
} from './movers'
import { getActiveKits, getMovingDrawn, kitSurfaceOptions } from './Pickups'
import {
  PICKUP_KIND_NAMES,
  PICKUP_SIZE_NAMES,
  newMovingSample,
  newPickupSample,
  pickupModel,
  sampleKitSpot,
  sampleMovingPickup,
  samplePickup,
} from './pickups'
import { slabMatrixAt } from './slabs'
import { analyzeSpots, type SpotSurface } from './surface'
import { getSurfaceJobStats, getWorldGroup, movingMapNodes } from './useMapSurface'

const r2 = (v: number) => Math.round(v * 100) / 100
const r4 = (v: number) => Math.round(v * 10000) / 10000
const vec = (v: THREE.Vector3) => [r2(v.x), r2(v.y), r2(v.z)]

const readyExtras = (): HighlanderExtras | undefined => {
  const s = useInstance.getState()
  return s.extrasStatus === 'ready' ? s.extras : undefined
}
const renderTickNow = () => Math.max(1, getState().playback.tick - 2)
const tickArg = (tick: unknown) =>
  typeof tick === 'number' && Number.isFinite(tick) ? Math.max(0, Math.floor(tick)) : renderTickNow()

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _world = new THREE.Vector3()
const _matrix = new THREE.Matrix4()
const _mover: MoverSample = { instance: -1, vis: false, hasXform: false }
const _pickup = newPickupSample()
const _moving = newMovingSample()

registerHlProbe('mapdyn.movers', (tick?: number) => {
  const x = readyExtras()
  if (!x) return []
  const t = tickArg(tick)
  const nodes = useInstance.getState().mapNodes
  const index = moverIndexOf(x)
  const m = x.movers
  const rows: unknown[] = []
  for (const [bspModel, list] of [...index.byModel.entries()].sort((a, b) => a[0] - b[0])) {
    const s = sampleMover(x, list, t, _pos, _quat, _mover)
    if (s.instance < 0) continue
    const node = nodes?.get(bspModel)
    const info = node ? getMapNodeInfo(node) : undefined
    node?.getWorldPosition(_world)
    rows.push({
      instance: s.instance,
      bspModel,
      cls: m.cls[s.instance],
      classname: info?.classname ?? null,
      name: info?.targetname ?? null,
      pos: s.hasXform ? vec(_pos) : null,
      quat: s.hasXform ? [r4(_quat.x), r4(_quat.y), r4(_quat.z), r4(_quat.w)] : null,
      vis: s.vis,
      visible: s.vis && !isAlwaysHiddenNode(info),
      nodeFound: !!node,
      node: node ? { visible: node.visible, pos: vec(_world) } : null,
    })
  }
  return rows
})

registerHlProbe('mapdyn.pickups', (tick?: number) => {
  const x = readyExtras()
  if (!x) return []
  const t = tickArg(tick)
  const p = x.pickups
  const kits = getActiveKits()
  const surface = kits.surface
  const floorOf = (k: number) => (surface && !Number.isNaN(surface.floor[k]) ? r2(surface.floor[k]) : null)
  const bakedOf = (k: number) => (surface ? surface.baked[k] === 1 : null)
  const rows: unknown[] = []
  kits.entries.forEach((e, k) => {
    if (e.instances.length === 0) {
      // map-meta fallback: always visible
      rows.push({
        instance: -1,
        spot: k,
        kind: PICKUP_KIND_NAMES[e.kind],
        size: PICKUP_SIZE_NAMES[e.size],
        visible: true,
        respawnIn: null,
        pos: [r2(e.x), r2(e.y), r2(e.z)],
        floor: floorOf(k),
        baked: bakedOf(k),
      })
      return
    }
    const s = sampleKitSpot(x, e, t, _pickup)
    if (!s.alive) return
    const j = s.instance
    rows.push({
      instance: j,
      spot: k,
      kind: PICKUP_KIND_NAMES[p.kind[j]] ?? p.kind[j],
      size: PICKUP_SIZE_NAMES[p.size[j]] ?? p.size[j],
      visible: s.visible,
      respawnIn: s.visible ? null : Math.round(s.respawnIn * 10) / 10,
      progress: s.visible ? null : r4(s.progress),
      takenTick: s.visible ? null : s.takenTick,
      nextTick: s.visible ? null : s.nextTick,
      estimated: s.visible ? null : s.estimated,
      pos: [r2(p.x[j]), r2(p.y[j]), r2(p.z[j])],
      floor: floorOf(k),
      baked: bakedOf(k),
    })
  })
  for (const m of kits.moving) {
    const s = sampleMovingPickup(x, m, t, _moving)
    if (!s.drawn) continue
    rows.push({
      instance: m.instance,
      spot: null,
      moving: true,
      kind: PICKUP_KIND_NAMES[m.kind] ?? m.kind,
      size: PICKUP_SIZE_NAMES[m.size] ?? m.size,
      visible: true,
      inFlight: s.inFlight,
      pos: [r2(s.x), r2(s.y), r2(s.z)],
      bottom: r2(s.bottomZ),
    })
  }
  return rows
})

// Moving pickups (P2): thrown lunchbox items and dropped kits, drawn along their xform track.
registerHlProbe('mapdyn.moving', (tick?: number, floors?: boolean) => {
  const x = readyExtras()
  if (!x) return null
  const t = tickArg(tick)
  const kits = getActiveKits()
  const p = x.pickups
  const xf = p.xform
  const rows = kits.moving.map(m => {
    const j = m.instance
    const a = xf.offsets[j], b = xf.offsets[j + 1]
    const s = sampleMovingPickup(x, m, t, _moving)
    return {
      instance: j,
      model: pickupModel(x, j),
      kind: PICKUP_KIND_NAMES[m.kind] ?? m.kind,
      size: PICKUP_SIZE_NAMES[m.size] ?? m.size,
      bottomOffset: m.bottom,
      created: p.created[j],
      deleted: p.deleted[j] === 0xffffffff ? null : p.deleted[j],
      entries: b - a,
      firstTick: xf.ticks[a],
      restTick: xf.ticks[b - 1],
      start: [r2(xf.x[a]), r2(xf.y[a]), r2(xf.z[a])],
      rest: [r2(xf.x[b - 1]), r2(xf.y[b - 1]), r2(xf.z[b - 1])],
      drawn: s.drawn,
      inFlight: s.drawn ? s.inFlight : null,
      pos: s.drawn ? [r2(s.x), r2(s.y), r2(s.z)] : null,
      bottom: s.drawn ? r2(s.bottomZ) : null,
    }
  })
  const out: Record<string, unknown> = { tick: t, mode: kits.mode, count: rows.length, drawnLastFrame: getMovingDrawn(), rows }
  const world = getWorldGroup()
  if (floors && world && rows.length) {
    // The visible floor under each rest position, within 120 units below and 4 above the collision box bottom:
    // under the centre and on a 5 x 5 grid over the box footprint (a thrown plate's box is 34 x 34 units,
    // LUNCHBOX_DROPPED_MINS/MAXS). On a slope the box rests on the highest floor point under it, so `bottom -
    // floorMax` is about 0 when the track ends on the floor; the centre floor then lies lower.
    const HALF = 17
    const grid = [-HALF, -HALF / 2, 0, HALF / 2, HALF]
    const spots: { x: number; y: number; z: number }[] = []
    for (const r of rows) {
      const z = r.rest[2] - (r.bottomOffset as number)
      for (const dx of grid) for (const dy of grid) spots.push({ x: r.rest[0] + dx, y: r.rest[1] + dy, z })
    }
    const surface = analyzeSpots(world, spots, { below: 120, above: 4, upwardOnly: true, detectBaked: false }, movingMapNodes())
    const per = grid.length * grid.length
    out.floors = rows.map((r, k) => {
      const bottom = r.rest[2] - (r.bottomOffset as number)
      const values: number[] = []
      for (let i = 0; i < per; i++) {
        const f = surface.floor[k * per + i]
        if (!Number.isNaN(f)) values.push(f)
      }
      const center = surface.floor[k * per + (per >> 1)]
      const max = values.length ? Math.max(...values) : NaN
      const min = values.length ? Math.min(...values) : NaN
      return {
        instance: r.instance,
        bottom: r2(bottom),
        floor: Number.isNaN(center) ? null : r2(center),
        bottomAboveFloor: Number.isNaN(center) ? null : r2(bottom - center),
        footprint: { samples: values.length, floorMin: Number.isNaN(min) ? null : r2(min), floorMax: Number.isNaN(max) ? null : r2(max) },
        bottomAboveFloorMax: Number.isNaN(max) ? null : r2(bottom - max),
      }
    })
  }
  return out
})

registerHlProbe('mapdyn.kits', (tick?: number) => {
  const x = readyExtras()
  if (!x) return null
  const kits = getActiveKits()
  const p = x.pickups
  const reasons: Record<string, number> = {}
  for (const s of kits.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1
  const out: Record<string, unknown> = {
    source: kits.source,
    mode: kits.mode,
    pickups: p.count,
    spots: kits.entries.length,
    kitInstances: kits.entries.reduce((n, e) => n + e.instances.length, 0),
    moving: kits.moving.length,
    skipped: reasons,
    skippedList: kits.skipped.slice(0, 40).map(s => ({
      instance: s.instance,
      reason: s.reason,
      model: s.model,
      created: p.created[s.instance],
      deleted: p.deleted[s.instance] === 0xffffffff ? null : p.deleted[s.instance],
      pos: [r2(p.x[s.instance]), r2(p.y[s.instance]), r2(p.z[s.instance])],
    })),
  }
  if (typeof tick === 'number' && Number.isFinite(tick)) {
    // instances alive at the tick that draw nothing, and why
    const t = Math.max(0, Math.floor(tick))
    const current = new Set<number>()
    for (const e of kits.entries) {
      const s = sampleKitSpot(x, e, t, _pickup)
      if (s.instance >= 0) current.add(s.instance)
    }
    const hidden: unknown[] = []
    for (const s of kits.skipped) {
      // moving items draw through their own path (mapdyn.moving)
      if (s.reason !== 'moving' && isAlive(p.created, p.deleted, s.instance, t)) hidden.push({ instance: s.instance, reason: s.reason })
    }
    kits.entries.forEach((e, k) => {
      for (const j of e.instances) {
        if (!isAlive(p.created, p.deleted, j, t)) continue
        if (!current.has(j)) hidden.push({ instance: j, spot: k, reason: 'superseded' })
        else if (samplePickup(x, j, t, _pickup).stale) hidden.push({ instance: j, spot: k, reason: 'stale' })
      }
    })
    out.tick = t
    out.hiddenAlive = hidden
  }
  return out
})

const surfaceSummary = (surface: SpotSurface | null, spots: { z: number }[]) => {
  if (!surface) return null
  let floors = 0
  const offsets: number[] = []
  spots.forEach((s, k) => {
    if (Number.isNaN(surface.floor[k])) return
    floors++
    offsets.push(Math.round((s.z - surface.floor[k]) * 100) / 100)
  })
  offsets.sort((a, b) => a - b)
  return {
    spots: spots.length,
    withFloor: floors,
    baked: surface.baked.reduce((n, b) => n + b, 0),
    originAboveFloor: offsets.length
      ? { min: offsets[0], median: offsets[offsets.length >> 1], max: offsets[offsets.length - 1] }
      : null,
    steps: surface.steps,
    meshes: surface.meshes,
    trianglesScanned: surface.trianglesScanned,
    trianglesTested: surface.trianglesTested,
    bakedBlobs: surface.bakedBlobs,
  }
}

// `remeasure` re-runs both analyses synchronously on the loaded map and reports their duration (debug
// only, not drawn).
registerHlProbe('mapdyn.surface', (remeasure?: boolean) => {
  const x = readyExtras()
  const kits = getActiveKits()
  const markers = getActiveMarkerGround()
  const airborne = x ? airborneMarkerSpots(x) : null
  const out: Record<string, unknown> = {
    // both analyses finished and none re-running
    analysed:
      (kits.surface !== null || kits.entries.length === 0) &&
      (markers?.analysed ?? true) &&
      getSurfaceJobStats().pending === 0,
    jobs: getSurfaceJobStats(),
    kits: surfaceSummary(kits.surface, kits.entries),
    markers: markers ? { airborne: markers.airborne, dropped: markers.dropped, analysed: markers.analysed } : null,
  }
  const world = getWorldGroup()
  if (remeasure && world) {
    const exclude = movingMapNodes()
    let start = performance.now()
    const kitRun = kits.entries.length ? analyzeSpots(world, kits.entries, kitSurfaceOptions(kits.mode), exclude) : null
    out.kitsMs = Math.round((performance.now() - start) * 10) / 10
    out.kitsRemeasured = surfaceSummary(kitRun, kits.entries)
    if (airborne && airborne.spots.length) {
      start = performance.now()
      const markerRun = analyzeSpots(world, airborne.spots, MARKER_SURFACE, exclude)
      out.markersMs = Math.round((performance.now() - start) * 10) / 10
      out.markersRemeasured = surfaceSummary(markerRun, airborne.spots)
    }
  }
  return out
})

registerHlProbe('mapdyn.slabs', (tick?: number) => {
  const x = readyExtras()
  if (!x) return []
  const t = tickArg(tick)
  return getActiveSlabs().map(slab => {
    const visible = slabMatrixAt(x, slab, t, _matrix)
    if (visible) _world.setFromMatrixPosition(_matrix)
    return {
      bspModel: slab.bspModel,
      name: slab.name,
      instances: slab.instances.length,
      visible,
      center: visible ? vec(_world) : null,
      size: vec(slab.size),
    }
  })
})

registerHlProbe('mapdyn.markers', (tick?: number) => {
  const x = readyExtras()
  if (!x) return { markers: [], drops: [] }
  const t = tickArg(tick)
  const markers = deathMarkersAt(x, t, [], getActiveMarkerGround()?.ground).map(m => ({
    instance: m.instance,
    player: m.player,
    team: m.team,
    gib: m.gib,
    age: m.age,
    pos: [r2(m.x), r2(m.y), r2(m.originZ)],
    ground: r2(m.z),
    dropped: m.dropped,
  }))
  const drops: unknown[] = []
  forEachDropAt(x, t, (j, kind, pos) => drops.push({ instance: j, kind, pos: vec(pos) }))
  return { markers, drops }
})

registerHlProbe('mapdyn.state', () => {
  const driver = getActiveMoverDriver()
  const nodes = driver?.snapshot() ?? []
  return {
    ...drawn,
    tickF: Number.isFinite(drawn.tickF) ? r4(drawn.tickF) : null,
    movers: {
      bound: nodes.length,
      visible: nodes.filter(n => n.nodeVisible).length,
      mismatched: nodes.filter(n => n.visible !== n.nodeVisible).map(n => n.name),
    },
  }
})

registerHlProbe('mapdyn.summary', () => {
  const x = readyExtras()
  const nodes = useInstance.getState().mapNodes
  if (!x) return { extras: false }
  const index = moverIndexOf(x)
  const m = x.movers
  let found = 0
  let changing = 0
  let changingFound = 0
  const missing: number[] = []
  const missingChanging: number[] = []
  for (const [bspModel, list] of index.byModel) {
    const hasNode = !!nodes?.has(bspModel)
    if (hasNode) found += list.length
    else missing.push(bspModel)
    // instances whose transform or visibility changes: the ones the layer has to drive
    let changes = 0
    for (const j of list) {
      if (m.xform.offsets[j + 1] - m.xform.offsets[j] > 1 || m.vis.offsets[j + 1] - m.vis.offsets[j] > 1) changes++
    }
    changing += changes
    if (hasNode) changingFound += changes
    else if (changes > 0) missingChanging.push(bspModel)
  }
  const kits = getActiveKits()
  const reasons: Record<string, number> = {}
  for (const s of kits.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1
  return {
    extras: true,
    available: {
      movers: x.meta.available.movers,
      pickups: x.meta.available.pickups,
      ragdolls: x.meta.available.ragdolls,
      drops: x.meta.available.drops,
    },
    mapStatus: useInstance.getState().mapStatus,
    movers: {
      instances: m.count,
      withModel: index.withModel,
      withNode: found,
      pct: index.withModel ? Math.round((10000 * found) / index.withModel) / 100 : null,
      missingModels: missing.sort((a, b) => a - b).slice(0, 40),
      // coverage of the instances that move or toggle (static node-less brushes such as trigger_catapult
      // need nothing drawn)
      changing,
      changingWithNode: changingFound,
      changingPct: changing ? Math.round((10000 * changingFound) / changing) / 100 : null,
      missingChangingModels: missingChanging.sort((a, b) => a - b).slice(0, 40),
      mapNodes: nodes?.size ?? 0,
      boundNodes: getActiveMoverDriver()?.bindingCount() ?? 0,
    },
    slabs: getActiveSlabs().map(s => s.name),
    lockers: getActiveLockers()
      .filter(l => !l.name.endsWith(':front'))
      .map(l => ({ name: l.name, team: l.team, source: l.source })),
    pickups: x.pickups.count,
    kitSpots: kits.entries.length,
    movingPickups: kits.moving.length,
    kitsSkipped: reasons,
    ragdolls: x.ragdolls.count,
    drops: x.drops.count,
  }
})
