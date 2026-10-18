// Prop-door slabs (contract section 5 F6, section 11.3): map-meta doors whose brush node has no geometry
// (every face is a tool texture; the visual in game is a prop door) get a NEUTRAL slab from the node's
// localMins/localMaxs, attached to the door's mover transform.
//
// Render-mode-10 doors without geometry and without a door prop draw nothing in game (logic doors such as
// tow_tetsudo's Dispcontrol helpers), so they get no slab either. Neither do doors outside the map's world
// bounds: they belong to the 3D skybox (pl_vigil's dome_door_l/r), which the viewer hides.

import * as THREE from 'three'

import type { HighlanderExtras } from '@highlander/extras/types'
import type { MapMeta } from '@highlander/map/mapMeta'
import { getMapNodeInfo } from '@highlander/map/mapNodes'

import { RENDER_MODE_NONE } from './constants'
import { angleQuaternion, moverIndexOf, sampleMover, type MoverSample } from './movers'

/** A slab centre this far outside map-meta worldBounds (Source units) belongs to the 3D skybox. */
const WORLD_BOUNDS_MARGIN = 64

function outsideWorld(meta: MapMeta, p: THREE.Vector3): boolean {
  const b = meta.worldBounds
  if (!b?.boundaryMin || !b?.boundaryMax) return false
  const m = WORLD_BOUNDS_MARGIN
  return (
    p.x < b.boundaryMin.x - m || p.y < b.boundaryMin.y - m || p.z < b.boundaryMin.z - m ||
    p.x > b.boundaryMax.x + m || p.y > b.boundaryMax.y + m || p.z > b.boundaryMax.z + m
  )
}

export interface Slab {
  bspModel: number
  name: string
  /** Box centre in the entity's local frame (Source units) and full size. */
  center: THREE.Vector3
  size: THREE.Vector3
  /** Mover instances of this BSP model ([] when the door never appears in the demo). */
  instances: number[]
  /** GLB pose (scene space) and visibility, used only when the door has no instance at all. */
  staticPos: THREE.Vector3
  staticQuat: THREE.Quaternion
  staticVisible: boolean
}

export function buildSlabs(
  x: HighlanderExtras | undefined,
  meta: MapMeta | null,
  nodes: Map<number, THREE.Object3D> | undefined
): Slab[] {
  if (!x || !meta || !nodes || nodes.size === 0) return []
  const index = moverIndexOf(x)
  const origin = x.derived.sceneOrigin
  const out: Slab[] = []
  const seen = new Set<number>()
  for (const door of meta.doors) {
    const bspModel = door.bspModelIndex
    if (bspModel === null || bspModel === undefined || seen.has(bspModel)) continue
    const node = nodes.get(bspModel)
    const info = node ? getMapNodeInfo(node) : undefined
    if (!info || info.hasGeometry !== false) continue
    if (info.renderMode === RENDER_MODE_NONE && door.props.length === 0) continue
    const min = info.localMins, max = info.localMaxs
    if (!Array.isArray(min) || !Array.isArray(max)) continue
    const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
    const staticQuat = angleQuaternion(info.angles, new THREE.Quaternion())
    const sourceCenter = center.clone().applyQuaternion(staticQuat).add(new THREE.Vector3(...info.origin))
    if (outsideWorld(meta, sourceCenter)) continue
    seen.add(bspModel)
    out.push({
      bspModel,
      name: info.targetname ?? door.name,
      center,
      size: new THREE.Vector3(
        Math.max(1, max[0] - min[0]),
        Math.max(1, max[1] - min[1]),
        Math.max(1, max[2] - min[2])
      ),
      instances: index.byModel.get(bspModel) ?? [],
      staticPos: new THREE.Vector3(
        info.origin[0] - origin.x,
        info.origin[1] - origin.y,
        info.origin[2] - origin.z
      ),
      staticQuat,
      staticVisible: info.initiallyVisible !== false,
    })
  }
  return out
}

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _center = new THREE.Vector3()
const _sample: MoverSample = { instance: -1, vis: false, hasXform: false }

/**
 * World matrix of a slab at tickF, or false while the door does not draw (no alive instance, dormant, or
 * no transform yet). Pure function of (extras, slab, tickF).
 */
export function slabMatrixAt(x: HighlanderExtras, slab: Slab, tickF: number, out: THREE.Matrix4): boolean {
  if (slab.instances.length === 0) {
    if (!slab.staticVisible) return false
    _pos.copy(slab.staticPos)
    _quat.copy(slab.staticQuat)
  } else {
    const s = sampleMover(x, slab.instances, tickF, _pos, _quat, _sample)
    if (s.instance < 0 || !s.vis || !s.hasXform) return false
  }
  _center.copy(slab.center).applyQuaternion(_quat).add(_pos)
  out.compose(_center, _quat, slab.size)
  return true
}
