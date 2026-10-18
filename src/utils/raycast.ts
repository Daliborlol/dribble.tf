import * as THREE from 'three'

/**
 * True when `object` and every ancestor up to `root` are visible. The Raycaster ignores `visible`, and the map
 * hides brush-entity and 3D-skybox nodes on their parent, not on the `<name>_mesh` child that the ray hits.
 */
export function isDrawnUnder(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false
    if (node === root) return true
  }
  return true
}

export function getWorldIntersectionFromScreen({
  camera,
  domElement,
  scene,
  screenX,
  screenY,
}: {
  camera: THREE.Camera
  domElement: HTMLCanvasElement
  scene: THREE.Scene
  screenX: number
  screenY: number
}): THREE.Vector3 | null {
  const rect = domElement.getBoundingClientRect()
  if (screenX < rect.left || screenX > rect.right || screenY < rect.top || screenY > rect.bottom) {
    return null
  }

  const world = scene.getObjectByName('world')
  if (!world) return null

  const pointer = new THREE.Vector2(
    ((screenX - rect.left) / rect.width) * 2 - 1,
    -((screenY - rect.top) / rect.height) * 2 + 1
  )

  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(pointer, camera)

  const intersections = raycaster.intersectObject(world, true)
  const hit = intersections.find(intersection => isDrawnUnder(intersection.object, world))

  return hit ? hit.point.clone() : null
}
