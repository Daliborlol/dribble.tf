// Model-space skinning for pack players. The bones of a copy no longer go through
// Object3D: a flat parent-first node list computes each node's matrix relative to the copy's parent (the packPlayer
// group) and the skeletons' boneMatrices are written directly, for the bones the meshes use. The group's world matrix
// reaches the vertices through modelMatrix, so a moving player costs no skeleton work and three's scene update skips
// the bones. What three's chain did per bone per frame (compose, multiply into the world, multiply by the inverse,
// upload) stays one affine multiply per node and one per used bone.
//
// Three-side contract of an installed copy:
// - skeleton.update is a no-op (three calls it per frame); boneMatrices are written here;
// - a SkinnedMesh keeps a constant bindMatrixInverse: the inverse of its chain inside the frame, so
//   world = group.matrixWorld * M[bone] * boneInverse * bindMatrix * position, as attached skinning gave;
// - subtrees without a mesh have a no-op updateMatrixWorld. updateWorldMatrix still works (attachments, measuring).
// A glow child (xrayGlow.ts) copies the flag and the inverse from its mesh (`userData.flatSkin`).

import * as THREE from 'three'

const sceneUpdate = THREE.Object3D.prototype.updateMatrixWorld
const noop = () => {}

const usedCache = new WeakMap<THREE.BufferGeometry, Set<number>>()

/** Skeleton slots a geometry's vertices reference with a non-zero weight. */
function usedSlots(geometry: THREE.BufferGeometry): Set<number> {
  let used = usedCache.get(geometry)
  if (used) return used
  used = new Set<number>()
  const index = geometry.attributes.skinIndex as THREE.BufferAttribute | undefined
  const weight = geometry.attributes.skinWeight as THREE.BufferAttribute | undefined
  if (index && weight) {
    for (let v = 0; v < index.count; v++) {
      if (weight.getX(v) > 0) used.add(index.getX(v))
      if (weight.getY(v) > 0) used.add(index.getY(v))
      if (weight.getZ(v) > 0) used.add(index.getZ(v))
      if (weight.getW(v) > 0) used.add(index.getW(v))
    }
  }
  usedCache.set(geometry, used)
  return used
}

interface SkeletonOut {
  skeleton: THREE.Skeleton
  slots: Int32Array
  /** node index per slot, or EXT + index into the external rig's matrices */
  src: Int32Array
  /** boneInverses of the slots, 16 per slot */
  inv: Float64Array
}

const EXT = 1 << 24
const _chain = new THREE.Matrix4()
const _local = new Float64Array(16)
const _out = new Float64Array(16)

/** out = a * b, both affine (TRS): the last row stays 0 0 0 1. */
function mul(a: Float64Array, ao: number, b: Float64Array, bo: number, out: Float64Array, oo: number) {
  const a0 = a[ao], a1 = a[ao + 1], a2 = a[ao + 2]
  const a4 = a[ao + 4], a5 = a[ao + 5], a6 = a[ao + 6]
  const a8 = a[ao + 8], a9 = a[ao + 9], a10 = a[ao + 10]
  const a12 = a[ao + 12], a13 = a[ao + 13], a14 = a[ao + 14]
  const b0 = b[bo], b1 = b[bo + 1], b2 = b[bo + 2]
  const b4 = b[bo + 4], b5 = b[bo + 5], b6 = b[bo + 6]
  const b8 = b[bo + 8], b9 = b[bo + 9], b10 = b[bo + 10]
  const b12 = b[bo + 12], b13 = b[bo + 13], b14 = b[bo + 14]
  out[oo] = a0 * b0 + a4 * b1 + a8 * b2
  out[oo + 1] = a1 * b0 + a5 * b1 + a9 * b2
  out[oo + 2] = a2 * b0 + a6 * b1 + a10 * b2
  out[oo + 3] = 0
  out[oo + 4] = a0 * b4 + a4 * b5 + a8 * b6
  out[oo + 5] = a1 * b4 + a5 * b5 + a9 * b6
  out[oo + 6] = a2 * b4 + a6 * b5 + a10 * b6
  out[oo + 7] = 0
  out[oo + 8] = a0 * b8 + a4 * b9 + a8 * b10
  out[oo + 9] = a1 * b8 + a5 * b9 + a9 * b10
  out[oo + 10] = a2 * b8 + a6 * b9 + a10 * b10
  out[oo + 11] = 0
  out[oo + 12] = a0 * b12 + a4 * b13 + a8 * b14 + a12
  out[oo + 13] = a1 * b12 + a5 * b13 + a9 * b14 + a13
  out[oo + 14] = a2 * b12 + a6 * b13 + a10 * b14 + a14
  out[oo + 15] = 1
}

export class FlatRig {
  /** matrices of the nodes relative to the copy's parent, 16 per node */
  readonly matrices: Float64Array = new Float64Array(0)
  readonly nodeIndex = new Map<THREE.Object3D, number>()
  /** a mesh that is not skinned hangs under a bone: this copy stays on the Object3D path */
  readonly unsupported: boolean = false
  installed = false
  private count = 0
  private parent = new Int32Array(0)
  private poseIndex = new Int32Array(0)
  private external = new Int32Array(0)
  private scales = new Float64Array(0)
  private locals = new Float64Array(0)
  private outs: SkeletonOut[] = []
  private skinned: THREE.SkinnedMesh[] = []

  /**
   * `poseBones`: the rig's bones in pose order (the body), else null. `targetOf`: merged node -> body node, with
   * `body` its rig (a merged piece): a merged node takes the body bone's matrix, as bone merge does.
   */
  constructor(
    private copy: THREE.Object3D,
    poseBones: (THREE.Object3D | null)[] | null,
    targetOf: Map<THREE.Object3D, THREE.Object3D> | null,
    body: FlatRig | null
  ) {
    const skeletons = new Map<THREE.Skeleton, Set<number>>()
    let plainUnderBone = false
    copy.traverse(node => {
      const mesh = node as THREE.SkinnedMesh
      if (!mesh.isMesh || mesh.userData?.xrayGlow) return
      if (mesh.isSkinnedMesh && mesh.skeleton) {
        this.skinned.push(mesh)
        let used = skeletons.get(mesh.skeleton)
        if (!used) skeletons.set(mesh.skeleton, (used = new Set()))
        usedSlots(mesh.geometry as THREE.BufferGeometry).forEach(slot => used!.add(slot))
      } else {
        for (let p: THREE.Object3D | null = node.parent; p && p !== copy; p = p.parent) if ((p as THREE.Bone).isBone) plainUnderBone = true
      }
    })
    if (plainUnderBone) {
      this.unsupported = true
      return
    }
    const need = new Set<THREE.Object3D>()
    const mark = (node: THREE.Object3D | null | undefined) => {
      for (let p = node ?? null; p && !need.has(p); p = p === copy ? null : p.parent) need.add(p)
    }
    poseBones?.forEach(mark)
    skeletons.forEach((used, skeleton) => used.forEach(slot => mark(skeleton.bones[slot])))
    const nodes: THREE.Object3D[] = []
    const visit = (node: THREE.Object3D) => {
      if (!need.has(node)) return
      this.nodeIndex.set(node, nodes.length)
      nodes.push(node)
      node.children.forEach(visit)
    }
    visit(copy)
    const n = (this.count = nodes.length)
    this.parent = new Int32Array(n).fill(-1)
    this.poseIndex = new Int32Array(n).fill(-1)
    this.external = new Int32Array(n).fill(-1)
    this.scales = new Float64Array(n * 3)
    this.locals = new Float64Array(n * 16)
    this.matrices = new Float64Array(n * 16)
    const poseOf = new Map<THREE.Object3D, number>()
    poseBones?.forEach((bone, i) => bone && poseOf.set(bone, i))
    nodes.forEach((node, i) => {
      if (node !== copy) this.parent[i] = this.nodeIndex.get(node.parent!) ?? -1
      this.poseIndex[i] = poseOf.get(node) ?? -1
      this.scales.set([node.scale.x, node.scale.y, node.scale.z], i * 3)
      const target = targetOf?.get(node)
      const e = target && body ? body.nodeIndex.get(target) : undefined
      if (e !== undefined) this.external[i] = e
      node.updateMatrix()
      this.locals.set(node.matrix.elements, i * 16)
    })
    skeletons.forEach((used, skeleton) => {
      const slots = Int32Array.from(Array.from(used).sort((a, b) => a - b))
      const src = new Int32Array(slots.length)
      const inv = new Float64Array(slots.length * 16)
      slots.forEach((slot, k) => {
        const own = this.nodeIndex.get(skeleton.bones[slot])!
        src[k] = this.external[own] >= 0 ? EXT + this.external[own] : own
        inv.set(skeleton.boneInverses[slot].elements, k * 16)
      })
      this.outs.push({ skeleton, slots, src, inv })
    })
  }

  /** Takes the copy off the Object3D bone path; anything that measures through the bones runs before this. */
  install(): void {
    if (this.installed || this.unsupported) return
    this.installed = true
    const copy = this.copy
    for (const mesh of this.skinned) {
      const chain: THREE.Object3D[] = []
      for (let p: THREE.Object3D | null = mesh; p; p = p === copy ? null : p.parent) chain.unshift(p)
      _chain.identity()
      for (const node of chain) {
        node.updateMatrix()
        _chain.multiply(node.matrix)
      }
      mesh.bindMatrixInverse.copy(_chain).invert()
      mesh.updateMatrixWorld = sceneUpdate
      mesh.userData.flatSkin = true
    }
    for (const out of this.outs) out.skeleton.update = noop
    const keep = new Set<THREE.Object3D>()
    copy.traverse(node => {
      if ((node as THREE.Mesh).isMesh) for (let p: THREE.Object3D | null = node; p && !keep.has(p); p = p === copy ? null : p.parent) keep.add(p)
    })
    const walk = (node: THREE.Object3D) => {
      for (const child of node.children) {
        if (keep.has(child)) walk(child)
        else child.updateMatrixWorld = noop
      }
    }
    walk(copy)
  }

  /** The node matrices from the pose (T, R: the body) or from the body's matrices (`ext`: a piece), then the skeletons. */
  update(T: Float32Array | null, R: Float32Array | null, ext: Float64Array | null): void {
    const { count, parent, poseIndex, external, scales, locals, matrices: M } = this
    for (let i = 0; i < count; i++) {
      const o = i * 16
      const e = external[i]
      if (e >= 0 && ext) {
        const eo = e * 16
        for (let k = 0; k < 16; k++) M[o + k] = ext[eo + k]
        continue
      }
      const b = T ? poseIndex[i] : -1
      const p = parent[i]
      if (b >= 0) {
        const r = b * 4, t = b * 3
        const x = R![r], y = R![r + 1], z = R![r + 2], w = R![r + 3]
        const sx = scales[i * 3], sy = scales[i * 3 + 1], sz = scales[i * 3 + 2]
        const x2 = x + x, y2 = y + y, z2 = z + z
        const xx = x * x2, xy = x * y2, xz = x * z2
        const yy = y * y2, yz = y * z2, zz = z * z2
        const wx = w * x2, wy = w * y2, wz = w * z2
        _local[0] = (1 - (yy + zz)) * sx
        _local[1] = (xy + wz) * sx
        _local[2] = (xz - wy) * sx
        _local[3] = 0
        _local[4] = (xy - wz) * sy
        _local[5] = (1 - (xx + zz)) * sy
        _local[6] = (yz + wx) * sy
        _local[7] = 0
        _local[8] = (xz + wy) * sz
        _local[9] = (yz - wx) * sz
        _local[10] = (1 - (xx + yy)) * sz
        _local[11] = 0
        _local[12] = T![t]
        _local[13] = T![t + 1]
        _local[14] = T![t + 2]
        _local[15] = 1
        if (p < 0) for (let k = 0; k < 16; k++) M[o + k] = _local[k]
        else mul(M, p * 16, _local, 0, M, o)
      } else if (p < 0) {
        for (let k = 0; k < 16; k++) M[o + k] = locals[o + k]
      } else {
        mul(M, p * 16, locals, o, M, o)
      }
    }
    for (const out of this.outs) {
      const dst = out.skeleton.boneMatrices
      const { slots, src, inv } = out
      for (let k = 0; k < slots.length; k++) {
        const s = src[k]
        if (s >= EXT) mul(ext!, (s - EXT) * 16, inv, k * 16, _out, 0)
        else mul(M, s * 16, inv, k * 16, _out, 0)
        const d = slots[k] * 16
        for (let c = 0; c < 16; c++) dst[d + c] = _out[c]
      }
      if (out.skeleton.boneTexture) out.skeleton.boneTexture.needsUpdate = true
    }
  }
}
