// Debug-bridge probes of the F6 layer (contract section 3.10), registered when MapDynamicsLayer loads:
//   hl.probe('mapdyn.movers', tick?)   mover instances with a brush model alive at the tick:
//                                      { instance, bspModel, cls, classname, name, pos, quat, vis, visible,
//                                        nodeFound, node: { visible, pos } | null }
//   hl.probe('mapdyn.pickups', tick?)  pickups alive at the tick: { instance, kind, size, visible, respawnIn,
//                                      progress, takenTick, nextTick, estimated, pos, floor, baked }
//   hl.probe('mapdyn.surface', remeasure?) floor and baked-kit analysis of the kit spots (surface.ts)
//   hl.probe('mapdyn.slabs', tick?)    prop-door slabs: { bspModel, name, visible, center }
//   hl.probe('mapdyn.markers', tick?)  death markers and live drops at the tick
//   hl.probe('mapdyn.state')           what the mounted components drew in their last frame
//   hl.probe('mapdyn.summary')         demo-wide counts (node coverage of mover instances, slabs, lockers)
// `tick` is a cache tick (default renderTick). pos is scene space; node.pos is the node's world position,
// which equals pos once the layer applied that tick.

import * as THREE from 'three'

import { registerHlProbe } from '@highlander/debug'
import type { HighlanderExtras } from '@highlander/extras/types'
import { getMapNodeInfo } from '@highlander/map/mapNodes'
import { getState, useInstance } from '@zus/store'

import { getActiveSlabs } from './DoorSlabs'
import { drawn } from './frame'
import { getActiveLockers } from './ResupplyLockers'
import { forEachDropAt, deathMarkersAt } from './markers'
import {
  getActiveMoverDriver,
  isAlwaysHiddenNode,
  moverIndexOf,
  sampleMover,
  type MoverSample,
} from './movers'
import { analyzeEntries, getActiveKitEntries, getActiveKitSurface } from './Pickups'
import { PICKUP_KIND_NAMES, PICKUP_SIZE_NAMES, samplePickup, type PickupSample } from './pickups'
import { slabMatrixAt } from './slabs'

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
const _pickup: PickupSample = {
  alive: false,
  visible: false,
  takenTick: NaN,
  nextTick: NaN,
  progress: 0,
  respawnIn: 0,
  estimated: false,
}

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
  const rows: unknown[] = []
  // entries are the pickup instances in table order (or the map-meta items), so entry k = instance k
  const surface = getActiveKitSurface()
  const floorOf = (k: number) => (surface && !Number.isNaN(surface.floor[k]) ? r2(surface.floor[k]) : null)
  const bakedOf = (k: number) => (surface ? surface.baked[k] === 1 : null)
  if (x.meta.available.pickups) {
    for (let j = 0; j < p.count; j++) {
      const s = samplePickup(x, j, t, _pickup)
      if (!s.alive) continue
      rows.push({
        instance: j,
        kind: PICKUP_KIND_NAMES[p.kind[j]] ?? p.kind[j],
        size: PICKUP_SIZE_NAMES[p.size[j]] ?? p.size[j],
        visible: s.visible,
        respawnIn: s.visible ? null : Math.round(s.respawnIn * 10) / 10,
        progress: s.visible ? null : r4(s.progress),
        takenTick: s.visible ? null : s.takenTick,
        nextTick: s.visible ? null : s.nextTick,
        estimated: s.visible ? null : s.estimated,
        pos: [r2(p.x[j]), r2(p.y[j]), r2(p.z[j])],
        floor: floorOf(j),
        baked: bakedOf(j),
      })
    }
    return rows
  }
  // map-meta fallback: always visible
  return getActiveKitEntries().map((e, k) => ({
    instance: -1,
    kind: PICKUP_KIND_NAMES[e.kind],
    size: PICKUP_SIZE_NAMES[e.size],
    visible: true,
    respawnIn: null,
    pos: [r2(e.x), r2(e.y), r2(e.z)],
    floor: floorOf(k),
    baked: bakedOf(k),
  }))
})

// `remeasure` re-runs the analysis on the loaded map and reports its duration (debug only, not drawn).
registerHlProbe('mapdyn.surface', (remeasure?: boolean) => {
  const surface = getActiveKitSurface()
  if (!surface) return null
  let ms: number | null = null
  if (remeasure) {
    const world = useInstance.getState().threeScene?.getObjectByName('world')
    const pipeline = useInstance.getState().mapStatus.pipeline
    if (world) {
      const start = performance.now()
      analyzeEntries(world, surface.entries, pipeline !== 'bsp-to-glb')
      ms = Math.round((performance.now() - start) * 10) / 10
    }
  }
  let floors = 0
  let baked = 0
  const offsets: number[] = []
  surface.entries.forEach((e, k) => {
    if (!Number.isNaN(surface.floor[k])) {
      floors++
      offsets.push(Math.round((e.z - surface.floor[k]) * 100) / 100)
    }
    if (surface.baked[k]) baked++
  })
  offsets.sort((a, b) => a - b)
  return {
    entries: surface.entries.length,
    withFloor: floors,
    baked,
    originAboveFloor: offsets.length
      ? { min: offsets[0], median: offsets[offsets.length >> 1], max: offsets[offsets.length - 1] }
      : null,
    ...surface.analysis,
    ms,
  }
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
  const markers = deathMarkersAt(x, t, []).map(m => ({
    instance: m.instance,
    player: m.player,
    team: m.team,
    gib: m.gib,
    age: m.age,
    pos: [r2(m.x), r2(m.y), r2(m.z)],
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
  let found = 0
  const missing: number[] = []
  for (const [bspModel, list] of index.byModel) {
    if (nodes?.has(bspModel)) found += list.length
    else missing.push(bspModel)
  }
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
      instances: x.movers.count,
      withModel: index.withModel,
      withNode: found,
      pct: index.withModel ? Math.round((10000 * found) / index.withModel) / 100 : null,
      missingModels: missing.sort((a, b) => a - b).slice(0, 40),
      mapNodes: nodes?.size ?? 0,
      boundNodes: getActiveMoverDriver()?.bindingCount() ?? 0,
    },
    slabs: getActiveSlabs().map(s => s.name),
    lockers: getActiveLockers()
      .filter(l => !l.name.endsWith(':front'))
      .map(l => ({ name: l.name, team: l.team, source: l.source })),
    pickups: x.pickups.count,
    ragdolls: x.ragdolls.count,
    drops: x.drops.count,
  }
})
