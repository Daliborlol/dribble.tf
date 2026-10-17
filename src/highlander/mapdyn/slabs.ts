// Prop-door slabs (contract section 5 F6, section 11.3): map-meta doors whose brush node has no geometry
// (every face is a tool texture; the visual in game is a prop door) get a NEUTRAL slab from the node's
// localMins/localMaxs, attached to the door's mover transform.
//
// Render-mode-10 doors without geometry and without a door prop draw nothing in game (logic doors such as
// tow_tetsudo's Dispcontrol helpers), so they get no slab either.

import * as THREE from 'three'

import type { HighlanderExtras } from '@highlander/extras/types'
import type { MapMeta } from '@highlander/map/mapMeta'
import { getMapNodeInfo } from '@highlander/map/mapNodes'

import { RENDER_MODE_NONE } from './constants'
import { angleQuaternion, moverIndexOf, sampleMover, type MoverSample } from './movers'

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
    seen.add(bspModel)
    out.push({
      bspModel,
      name: info.targetname ?? door.name,
      center: new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2),
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
      staticQuat: angleQuaternion(info.angles, new THREE.Quaternion()),
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
