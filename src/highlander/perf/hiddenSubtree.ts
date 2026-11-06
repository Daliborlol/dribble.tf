// three's scene update (Object3D.updateMatrixWorld) walks hidden objects too, and matrixWorldAutoUpdate = false does not
// stop it under a moving parent: updateMatrix() marks every matrixAutoUpdate node dirty, so the parent passes force = true
// and `child.matrixWorldAutoUpdate === true || force === true` visits the child anyway. On test.dem RTS about 2150 of the
// 4000 nodes composed per frame were hidden: dead and culled players' bones, the unused level copies of each building
// and the 48 copies of the blueprint pool.
//
// An object passed here leaves the scene update while `visible` is false. Its matrices go stale until it is shown again,
// when the first update forces them. updateWorldMatrix(true, ...) still works on hidden nodes (attachments, measuring).

import * as THREE from 'three'

const sceneUpdate = THREE.Object3D.prototype.updateMatrixWorld

export function skipSceneUpdateWhileHidden(object: THREE.Object3D): void {
  let stale = false
  object.updateMatrixWorld = function (this: THREE.Object3D, force?: boolean) {
    if (!this.visible) {
      stale = true
      return
    }
    sceneUpdate.call(this, force || stale)
    stale = false
  }
}
