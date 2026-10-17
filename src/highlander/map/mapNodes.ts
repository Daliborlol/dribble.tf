// GLB brush-entity nodes (contract sections 4.5 item 7 and Appendix B.2; owner M1, read by F6).
//
// World.tsx loads a bsp-to-glb world.glb, freezes its matrices and calls collectMapNodes(), which indexes
// every brush-entity parent node (`model_<N>_<class>[_<targetname>]`) by its BSP model index N and
// remembers the node's GLB matrix and initial visibility for restoreNode(). The map lands in
// `useInstance().mapNodes`; old textured GLBs (koth_product_final) produce an empty map.
//
// Node hierarchy: the GLB root sits under the `world` group (rotation [pi/2, 0, 0], position
// -boundaryMin); brush-entity parents are direct children of the root, so their matrix is in glTF axes
// relative to the root. The mesh hangs on a `<name>_mesh` child (quantization folds its transform there),
// so the parent's matrix is exactly the entity transform: C * T(origin) * R(angles) * C^-1.

import * as THREE from 'three'

import { useInstance } from '@zus/store'

/** `userData.dribble` of a brush-entity node, as written by scripts/convert-bsp.mjs. */
export interface MapNodeInfo {
  kind: 'brushEntity' | 'respawnVisualizer'
  classname: string
  targetname: string | null
  parentname: string | null
  team?: number // teamnum; for visualizers the team of their func_respawnroom
  bspModelIndex: number
  entityIndex: number
  origin: [number, number, number] // Source units
  angles: [number, number, number] // degrees
  localMins: [number, number, number] // model-local Source bounds (placeholder boxes for prop-only doors)
  localMaxs: [number, number, number]
  hasGeometry: boolean // false: every face was a tool texture (the visual is a prop, e.g. many spawn doors)
  initiallyVisible?: boolean // false: starts hidden (func_brush StartDisabled, rendermode 6 or 10)
  renderMode?: number // 10: never drawn in game (e.g. the collision brush of a prop door or setup gate)
  startDisabled?: boolean
}

/** The `userData.dribble` of a node when it is a brush-entity node, else undefined. */
export function getMapNodeInfo(node: THREE.Object3D): MapNodeInfo | undefined {
  const info = node.userData?.dribble
  return info && (info.kind === 'brushEntity' || info.kind === 'respawnVisualizer')
    ? (info as MapNodeInfo)
    : undefined
}

/** The brush-entity parent node of a BSP model index (`useInstance().mapNodes`, filled by World.tsx). */
export function getMapNode(bspModelIndex: number): THREE.Object3D | undefined {
  return useInstance.getState().mapNodes?.get(bspModelIndex)
}

const C = new THREE.Matrix4().makeRotationX(-Math.PI / 2) // Source -> glTF axes: (x, y, z) -> (x, z, -y)
const C_INV = new THREE.Matrix4().makeRotationX(Math.PI / 2)
const ONE = new THREE.Vector3(1, 1, 1)
export function sceneXformToNode(
  node: THREE.Object3D,
  scenePos: THREE.Vector3,
  quat: THREE.Quaternion,
  origin: { x: number; y: number; z: number }
) {
  const source = new THREE.Matrix4().compose(
    new THREE.Vector3(scenePos.x + origin.x, scenePos.y + origin.y, scenePos.z + origin.z),
    quat,
    ONE
  )
  node.matrix.copy(C).multiply(source).multiply(C_INV)
  node.matrixAutoUpdate = false
  node.matrixWorldNeedsUpdate = true
  node.updateMatrixWorld(true)
}

interface NodeState {
  matrix: THREE.Matrix4
  visible: boolean
}
const glbStates = new WeakMap<THREE.Object3D, NodeState>()

/**
 * World.tsx, after freezing the GLB's matrices: brush-entity parents by BSP model index. Records each
 * node's GLB matrix and initial visibility (`initiallyVisible !== false`) for restoreNode().
 */
export function collectMapNodes(root: THREE.Object3D): Map<number, THREE.Object3D> {
  const nodes = new Map<number, THREE.Object3D>()
  root.traverse(node => {
    const info = getMapNodeInfo(node)
    if (!info) return
    const index = Number(info.bspModelIndex)
    if (!Number.isInteger(index) || index <= 0 || nodes.has(index)) return
    nodes.set(index, node)
    glbStates.set(node, { matrix: node.matrix.clone(), visible: info.initiallyVisible !== false })
  })
  return nodes
}

/** Back to the GLB matrix and initial visibility (no-op for a node collectMapNodes never saw). */
export function restoreNode(node: THREE.Object3D): void {
  const state = glbStates.get(node)
  if (!state) return
  node.matrix.copy(state.matrix)
  node.matrix.decompose(node.position, node.quaternion, node.scale)
  node.matrixAutoUpdate = false
  node.visible = state.visible
  node.matrixWorldNeedsUpdate = true
  node.updateMatrixWorld(true)
}
