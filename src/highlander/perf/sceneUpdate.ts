// Three's scene update walks hidden subtrees too: an ancestor that composes its matrix marks its world matrix dirty,
// and that forces every descendant, whatever its matrixWorldAutoUpdate says. On the pack scenes about half of the
// nodes it visits are hidden: the six blueprint slots (720 nodes), the building copies of the levels not shown, dead
// and culled players with their weapons.

import * as THREE from 'three'

const base = THREE.Object3D.prototype.updateMatrixWorld

/**
 * `node`'s subtree takes no part in the scene update while `node` is hidden. Code that reads a matrix of such a node
 * goes through updateWorldMatrix (getWorldPosition and friends), which is not affected. Showing the node again
 * forces its whole subtree in the next update.
 */
export function skipUpdateWhileHidden(node: THREE.Object3D): void {
  node.updateMatrixWorld = function (this: THREE.Object3D, force?: boolean) {
    if (!this.visible) {
      this.matrixWorldNeedsUpdate = true
      return
    }
    base.call(this, force)
  }
}

/**
 * Hides every bone subtree that holds nothing drawable: three's render list walks every visible node each frame,
 * while invisible nodes keep their matrices up to date (the scene update ignores `visible` below the hidden node's
 * skip above only for non-bones), so the skeleton skins exactly as before.
 */
export function hideBoneSubtrees(root: THREE.Object3D): void {
  const drawable = (node: THREE.Object3D) => {
    let found = false
    node.traverse(n => {
      const o = n as THREE.Mesh & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean; isCamera?: boolean; isLight?: boolean }
      if (o.isMesh || o.isPoints || o.isLine || o.isSprite || o.isCamera || o.isLight) found = true
    })
    return found
  }
  const walk = (node: THREE.Object3D) => {
    for (const child of node.children) {
      if ((child as THREE.Bone).isBone && !drawable(child)) child.visible = false
      else walk(child)
    }
  }
  walk(root)
}

/**
 * `geometries.update` walks every attribute of every drawn geometry each frame through a WeakMap (about 5 lookups per
 * draw), only to notice that nothing changed. Once a static geometry has been drawn its attributes can stop being
 * enumerable: that loop is a `for in`, while everything else reads them by name. Disposing makes them enumerable
 * again, so three's dispose handler still finds the buffers. Only for geometries whose attributes never change.
 */
export function freezeGeometryAttributes(geometry: THREE.BufferGeometry): void {
  const attrs = geometry.attributes as Record<string, unknown>
  const names = Object.keys(attrs)
  if (!names.length) return
  for (const name of names) Object.defineProperty(attrs, name, { enumerable: false, value: attrs[name], writable: true, configurable: true })
  geometry.dispose = function (this: THREE.BufferGeometry) {
    const a = this.attributes as Record<string, unknown>
    for (const name of Object.getOwnPropertyNames(a)) Object.defineProperty(a, name, { enumerable: true, value: a[name], writable: true, configurable: true })
    delete (this as Partial<THREE.BufferGeometry>).dispose
    this.dispose()
  }
}

/** Freezes `mesh`'s geometry right after its first draw (its buffers exist then). */
export function freezeGeometryAfterFirstDraw(mesh: THREE.Mesh): void {
  const own = Object.prototype.hasOwnProperty.call(mesh, 'onAfterRender') ? mesh.onAfterRender : null
  mesh.onAfterRender = function (this: THREE.Mesh, ...args: Parameters<THREE.Mesh['onAfterRender']>) {
    if (own) {
      mesh.onAfterRender = own
      own.apply(this, args)
    } else delete (mesh as Partial<THREE.Mesh>).onAfterRender
    freezeGeometryAttributes(mesh.geometry as THREE.BufferGeometry)
  } as THREE.Mesh['onAfterRender']
}

const noUpdate = () => {}

/**
 * Leaf nodes of a pack copy that draw nothing (attachments, unused bones' helpers) leave the scene update; whoever reads
 * one goes through updateWorldMatrix. About 700 nodes on a 9v9 scene.
 */
export function skipEmptyLeaves(copy: THREE.Object3D): void {
  copy.traverse(node => {
    if (node === copy || node.children.length) return
    const o = node as THREE.Mesh & { isBone?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean; isCamera?: boolean; isLight?: boolean }
    if (o.isMesh || o.isBone || o.isPoints || o.isLine || o.isSprite || o.isCamera || o.isLight) return
    node.updateMatrixWorld = noUpdate
  })
}

// Bones and skeletons: the same numbers as three's generic compose, 4x4 multiply and toArray, for what bones are:
// affine matrices. They are 2000 to 3000 of the nodes of a pack scene.
const boneProto = THREE.Bone.prototype as unknown as THREE.Object3D & { updateMatrixWorld(force?: boolean): void }
boneProto.updateMatrixWorld = function (this: THREE.Bone, force?: boolean) {
  // frozen bones (older textured map GLBs) keep three's rules
  if (!this.matrixAutoUpdate) {
    base.call(this, force)
    return
  }
  const te = this.matrix.elements
  const p = this.position
  const q = this.quaternion
  const s = this.scale
  const x = q.x, y = q.y, z = q.z, w = q.w
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2
  const sx = s.x, sy = s.y, sz = s.z
  const a00 = (1 - (yy + zz)) * sx, a10 = (xy + wz) * sx, a20 = (xz - wy) * sx
  const a01 = (xy - wz) * sy, a11 = (1 - (xx + zz)) * sy, a21 = (yz + wx) * sy
  const a02 = (xz + wy) * sz, a12 = (yz - wx) * sz, a22 = (1 - (xx + yy)) * sz
  const a03 = p.x, a13 = p.y, a23 = p.z
  te[0] = a00; te[1] = a10; te[2] = a20; te[3] = 0
  te[4] = a01; te[5] = a11; te[6] = a21; te[7] = 0
  te[8] = a02; te[9] = a12; te[10] = a22; te[11] = 0
  te[12] = a03; te[13] = a13; te[14] = a23; te[15] = 1
  const me = this.matrixWorld.elements
  const parent = this.parent
  if (parent) {
    const pe = parent.matrixWorld.elements
    const b00 = pe[0], b10 = pe[1], b20 = pe[2], b01 = pe[4], b11 = pe[5], b21 = pe[6], b02 = pe[8], b12 = pe[9], b22 = pe[10], b03 = pe[12], b13 = pe[13], b23 = pe[14]
    me[0] = b00 * a00 + b01 * a10 + b02 * a20; me[1] = b10 * a00 + b11 * a10 + b12 * a20; me[2] = b20 * a00 + b21 * a10 + b22 * a20; me[3] = 0
    me[4] = b00 * a01 + b01 * a11 + b02 * a21; me[5] = b10 * a01 + b11 * a11 + b12 * a21; me[6] = b20 * a01 + b21 * a11 + b22 * a21; me[7] = 0
    me[8] = b00 * a02 + b01 * a12 + b02 * a22; me[9] = b10 * a02 + b11 * a12 + b12 * a22; me[10] = b20 * a02 + b21 * a12 + b22 * a22; me[11] = 0
    me[12] = b00 * a03 + b01 * a13 + b02 * a23 + b03; me[13] = b10 * a03 + b11 * a13 + b12 * a23 + b13; me[14] = b20 * a03 + b21 * a13 + b22 * a23 + b23; me[15] = 1
  } else {
    this.matrixWorld.copy(this.matrix)
  }
  this.matrixWorldNeedsUpdate = false
  const children = this.children
  for (let i = 0, l = children.length; i < l; i++) children[i].updateMatrixWorld(true)
}

THREE.Skeleton.prototype.update = function (this: THREE.Skeleton) {
  const bones = this.bones
  const inverses = this.boneInverses
  const out = this.boneMatrices
  const texture = this.boneTexture
  if (!out) return
  for (let i = 0, n = bones.length; i < n; i++) {
    const bone = bones[i]
    const o = i * 16
    const b = inverses[i].elements
    if (!bone) {
      out.set(b, o)
      continue
    }
    const a = bone.matrixWorld.elements
    const a0 = a[0], a1 = a[1], a2 = a[2], a4 = a[4], a5 = a[5], a6 = a[6], a8 = a[8], a9 = a[9], a10 = a[10], a12 = a[12], a13 = a[13], a14 = a[14]
    const b0 = b[0], b1 = b[1], b2 = b[2], b4 = b[4], b5 = b[5], b6 = b[6], b8 = b[8], b9 = b[9], b10 = b[10], b12 = b[12], b13 = b[13], b14 = b[14]
    out[o] = a0 * b0 + a4 * b1 + a8 * b2; out[o + 1] = a1 * b0 + a5 * b1 + a9 * b2; out[o + 2] = a2 * b0 + a6 * b1 + a10 * b2; out[o + 3] = 0
    out[o + 4] = a0 * b4 + a4 * b5 + a8 * b6; out[o + 5] = a1 * b4 + a5 * b5 + a9 * b6; out[o + 6] = a2 * b4 + a6 * b5 + a10 * b6; out[o + 7] = 0
    out[o + 8] = a0 * b8 + a4 * b9 + a8 * b10; out[o + 9] = a1 * b8 + a5 * b9 + a9 * b10; out[o + 10] = a2 * b8 + a6 * b9 + a10 * b10; out[o + 11] = 0
    out[o + 12] = a0 * b12 + a4 * b13 + a8 * b14 + a12; out[o + 13] = a1 * b12 + a5 * b13 + a9 * b14 + a13; out[o + 14] = a2 * b12 + a6 * b13 + a10 * b14 + a14; out[o + 15] = 1
  }
  if (texture) texture.needsUpdate = true
}
