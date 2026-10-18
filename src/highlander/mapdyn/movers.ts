// Brush movers (contract section 5 F6 and section 11.3): doors, setup gates, trains, rotating brushes and
// func_brush toggles drive their GLB brush-entity nodes from the extras `movers` group.
//
// Everything here is a pure function of (extras, mapNodes, tickF) except the node writes themselves,
// which MoverNodeDriver caches only to skip redundant matrix updates. Seeking to a tick therefore always
// yields the same node transforms and visibility (D12).
//
// Rules per node (a brush-entity parent node of `useInstance().mapNodes`, keyed by BSP model index):
// - Nodes whose BSP model never has a mover instance in this demo keep their GLB state (never touched).
// - Otherwise, at tick T the node follows the newest instance alive at T (created <= T < deleted): its
//   transform is `xformAt(tickF)` (interpolated across snapshot gaps) and it is visible while the `vis`
//   track reads 1. While no instance is alive (before the entity exists, after it was killed) it is hidden:
//   a door that the map kills after opening must not snap back closed.
// - Render-mode-10 nodes of non-door classes stay hidden whatever `vis` says (invisible in game, 11.3).
//   Render-mode-10 door-class nodes with geometry follow `vis` as the stand-in for the prop door.
// - restoreNode() puts every touched node back to its GLB matrix and initial visibility on unbind.

import * as THREE from 'three'

import { trackIndexAt, xformAt } from '@highlander/extras/track'
import type { HighlanderExtras, XMovers } from '@highlander/extras/types'
import { getMapNodeInfo, restoreNode, sceneXformToNode, type MapNodeInfo } from '@highlander/map/mapNodes'

import { DOOR_LIKE_CLASSES, RENDER_MODE_NONE } from './constants'

export const NONE_U32 = 0xffffffff

export interface MoverIndex {
  /** BSP model index -> mover instance indices, in table order (sorted by created). */
  byModel: Map<number, number[]>
  /** Mover instances with a brush model (bspModel >= 0). */
  withModel: number
}

const indexCache = new WeakMap<HighlanderExtras, MoverIndex>()

/** Instance lists per BSP model, built once per extras object. */
export function moverIndexOf(x: HighlanderExtras): MoverIndex {
  const cached = indexCache.get(x)
  if (cached) return cached
  const m = x.movers
  const byModel = new Map<number, number[]>()
  let withModel = 0
  for (let j = 0; j < m.count; j++) {
    const b = m.bspModel[j]
    if (b < 0) continue
    withModel++
    const list = byModel.get(b)
    if (list) list.push(j)
    else byModel.set(b, [j])
  }
  const index = { byModel, withModel }
  indexCache.set(x, index)
  return index
}

/** created <= tick < deleted (0xFFFFFFFF: alive at demo end). */
export function isAlive(created: ArrayLike<number>, deleted: ArrayLike<number>, j: number, tick: number) {
  return created[j] <= tick && (deleted[j] === NONE_U32 || tick < deleted[j])
}

/** The newest instance of `list` alive at `tick`, or -1. */
export function aliveInstance(m: XMovers, list: readonly number[], tick: number): number {
  for (let k = list.length - 1; k >= 0; k--) {
    const j = list[k]
    if (isAlive(m.created, m.deleted, j, tick)) return j
  }
  return -1
}

/** Raw `vis` of mover instance j at tick: 1 from Enter and re-Enter, 0 while dormant (Leave). */
export function moverVisAt(m: XMovers, j: number, tick: number): boolean {
  const i = trackIndexAt(m.vis, j, tick)
  return i < 0 ? true : m.vis.v[i] !== 0
}

/** Section 11.3: render-mode-10 brushes of non-door classes are never drawn in game. */
export function isAlwaysHiddenNode(info: MapNodeInfo | undefined): boolean {
  return !!info && info.renderMode === RENDER_MODE_NONE && !DOOR_LIKE_CLASSES.has(info.classname)
}

export interface MoverSample {
  /** Alive instance at the tick, -1 when none. */
  instance: number
  /** Raw vis of that instance (false when none is alive). */
  vis: boolean
  /** True when `pos`/`quat` hold the instance transform (scene space). */
  hasXform: boolean
}

/**
 * Mover state of one BSP model at tickF. Writes the interpolated scene-space transform into pos/quat when
 * an instance is alive and has an xform entry. Pure function of its inputs.
 */
export function sampleMover(
  x: HighlanderExtras,
  list: readonly number[],
  tickF: number,
  pos: THREE.Vector3,
  quat: THREE.Quaternion,
  out: MoverSample
): MoverSample {
  const m = x.movers
  const tick = Math.floor(tickF)
  const j = aliveInstance(m, list, tick)
  out.instance = j
  if (j < 0) {
    out.vis = false
    out.hasXform = false
    return out
  }
  out.vis = moverVisAt(m, j, tick)
  out.hasXform = xformAt(m.xform, j, tickF, pos, quat, Math.max(1, x.meta.snapshotInterval || 1))
  return out
}

const DEG = Math.PI / 180

/** Source AngleQuaternion (contract Appendix B.1), angles in degrees (pitch, yaw, roll). */
export function angleQuaternion(angles: readonly number[], out: THREE.Quaternion): THREE.Quaternion {
  const [pitch, yaw, roll] = [angles[0] || 0, angles[1] || 0, angles[2] || 0]
  const sy = Math.sin((yaw * DEG) / 2), cy = Math.cos((yaw * DEG) / 2)
  const sp = Math.sin((pitch * DEG) / 2), cp = Math.cos((pitch * DEG) / 2)
  const sr = Math.sin((roll * DEG) / 2), cr = Math.cos((roll * DEG) / 2)
  return out.set(
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
    cr * cp * cy + sr * sp * sy
  )
}

interface Binding {
  bspModel: number
  node: THREE.Object3D
  info: MapNodeInfo | undefined
  instances: number[]
  alwaysHidden: boolean
  /** Last transform written to the node (NaN: none yet). */
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
  /** What the last update decided (for probes). */
  instance: number
  visible: boolean
}

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _sample: MoverSample = { instance: -1, vis: false, hasXform: false }

/**
 * Applies mover transforms and visibility to GLB brush-entity nodes. One driver per mounted layer;
 * `bind` takes the extras and the current mapNodes, `update(tickF)` runs once per frame, `unbind`
 * restores every node it touched.
 */
export class MoverNodeDriver {
  private bindings: Binding[] = []
  private touched = new Set<THREE.Object3D>()
  private extras: HighlanderExtras | null = null
  private lastTickF = NaN

  get bound(): boolean {
    return this.extras !== null
  }

  bind(x: HighlanderExtras, nodes: Map<number, THREE.Object3D>): void {
    this.unbind()
    const index = moverIndexOf(x)
    for (const [bspModel, node] of nodes) {
      const instances = index.byModel.get(bspModel)
      if (!instances || instances.length === 0) continue // no instance in this demo: GLB state
      const info = getMapNodeInfo(node)
      this.bindings.push({
        bspModel,
        node,
        info,
        instances,
        alwaysHidden: isAlwaysHiddenNode(info),
        px: NaN,
        py: NaN,
        pz: NaN,
        qx: NaN,
        qy: NaN,
        qz: NaN,
        qw: NaN,
        instance: -1,
        visible: node.visible,
      })
    }
    this.extras = x
    this.lastTickF = NaN
  }

  /** Restores every node this driver changed (GLB matrix and initial visibility). */
  unbind(): void {
    for (const node of this.touched) restoreNode(node)
    this.touched.clear()
    this.bindings = []
    this.extras = null
    this.lastTickF = NaN
  }

  /** Per frame. Does nothing while tickF is unchanged (paused) unless `force`. */
  update(tickF: number, force = false): void {
    const x = this.extras
    if (!x || (!force && tickF === this.lastTickF)) return
    this.lastTickF = tickF
    const origin = x.derived.sceneOrigin
    for (const b of this.bindings) {
      const s = sampleMover(x, b.instances, tickF, _pos, _quat, _sample)
      b.instance = s.instance
      const visible = s.instance >= 0 && s.vis && !b.alwaysHidden
      if (s.hasXform) {
        if (
          _pos.x !== b.px || _pos.y !== b.py || _pos.z !== b.pz ||
          _quat.x !== b.qx || _quat.y !== b.qy || _quat.z !== b.qz || _quat.w !== b.qw
        ) {
          sceneXformToNode(b.node, _pos, _quat, origin)
          b.px = _pos.x
          b.py = _pos.y
          b.pz = _pos.z
          b.qx = _quat.x
          b.qy = _quat.y
          b.qz = _quat.z
          b.qw = _quat.w
          this.touched.add(b.node)
        }
      }
      if (b.node.visible !== visible) {
        b.node.visible = visible
        this.touched.add(b.node)
      }
      b.visible = visible
    }
  }

  /** Current node states (for probes): what the last update applied. */
  snapshot(): { bspModel: number; name: string; instance: number; visible: boolean; nodeVisible: boolean }[] {
    return this.bindings.map(b => ({
      bspModel: b.bspModel,
      name: b.node.name,
      instance: b.instance,
      visible: b.visible,
      nodeVisible: b.node.visible,
    }))
  }

  bindingCount(): number {
    return this.bindings.length
  }
}

/** The driver of the mounted layer, for probes (null while no layer is mounted). */
let activeDriver: MoverNodeDriver | null = null
export const setActiveMoverDriver = (driver: MoverNodeDriver | null) => {
  activeDriver = driver
}
export const getActiveMoverDriver = () => activeDriver
