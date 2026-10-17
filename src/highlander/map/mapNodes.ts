// GLB brush-entity nodes (contract sections 4.5 item 7 and Appendix B.2; owner M1, read by F6).
// S0 writes the signatures: getMapNode reads the store, sceneXformToNode is Appendix B.2,
// restoreNode is a stub until M1 records each node's GLB matrix and initial visibility.

import * as THREE from 'three'

import { useInstance } from '@zus/store'

/** The brush-entity parent node of a BSP model index (`useInstance().mapNodes`, filled by World.tsx in M1). */
export function getMapNode(bspModelIndex: number): THREE.Object3D | undefined {
  return useInstance.getState().mapNodes?.get(bspModelIndex)
}

const C = new THREE.Matrix4().makeRotationX(-Math.PI / 2)     // Source -> glTF axes: (x, y, z) -> (x, z, -y)
const C_INV = new THREE.Matrix4().makeRotationX(Math.PI / 2)
const ONE = new THREE.Vector3(1, 1, 1)
export function sceneXformToNode(node: THREE.Object3D, scenePos: THREE.Vector3, quat: THREE.Quaternion, origin: { x: number; y: number; z: number }) {
  const source = new THREE.Matrix4().compose(new THREE.Vector3(scenePos.x + origin.x, scenePos.y + origin.y, scenePos.z + origin.z), quat, ONE)
  node.matrix.copy(C).multiply(source).multiply(C_INV)
  node.matrixAutoUpdate = false
  node.matrixWorldNeedsUpdate = true
  node.updateMatrixWorld(true)
}

/** Back to the GLB matrix and initial visibility. S0 stub: does nothing (M1 implements it). */
export function restoreNode(_node: THREE.Object3D): void {}
