// The baked pose of a public player model (public/models/players/<class>_<team>.glb), recovered from the pack's
// own player model, so third-person weapons can be bone-merged onto a player model that has no skeleton.
//
// The public player GLBs are the TF2 meshes with their bones and animations removed and one pose baked in. The
// pack exports `models/player/<class>.mdl` (bind pose and skeleton) and the models it includes (the class's
// animations). Vertices are paired by material and texture coordinate (the same mesh on both sides); every
// animation of the includes is sampled at a few frames, the pack mesh is skinned in that pose and a similarity
// transform (scale, rotation, translation; Horn's quaternion method) is fitted from the posed pack vertices to the
// public ones. The best pose gives every bone's matrix, which the runtime copies onto the weapon's bones of the
// same name (TF2's bone merge).
//
// Everything this returns is read from the user's files and the public GLB, so it is pack data (D19).
//
//   createPoseFitter({ publicDoc, playerDoc, frames? }) -> { addAnimations(doc), result() }, result() = {
//     clip, frame, rms, handRms, scale, pairs, fit: number[16], bones: { [name]: number[16] }
//   }
// Matrices are column major (glTF order). `bones` are in the pack copy's space (Source model axes, as
// `src/assetpack/models.ts` instantiates a model: the GLB's glTF scene turned back by +90 degrees about X), and
// `fit` maps that space into the public GLB's own coordinates.

import * as THREE from 'three'

const lowerName = s => String(s ?? '').toLowerCase()
// Material base names: the public GLBs carry Blender suffixes (.001) and sometimes no folder
const materialName = n => lowerName(n).replace(/\.\d+$/, '').replace(/^.*\//, '')
const UV_CELL = 400
const UV_TOLERANCE = 0.0012
const SAME_POINT = 0.3

/** Base vertices: [{ mat, u, v, pos }] with KHR_texture_transform applied. */
function publicVertices(doc) {
  const out = []
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial()
    const uv = prim.getAttribute('TEXCOORD_0')
    const pos = prim.getAttribute('POSITION')
    if (!uv || !pos || !mat) continue
    const tt = mat.getBaseColorTextureInfo()?.getExtension('KHR_texture_transform')
    const off = tt?.getOffset() ?? [0, 0]
    const sc = tt?.getScale() ?? [1, 1]
    const a = [], b = []
    for (let i = 0; i < uv.getCount(); i++) {
      uv.getElement(i, a)
      pos.getElement(i, b)
      out.push({ mat: materialName(mat.getName()), u: a[0] * sc[0] + off[0], v: a[1] * sc[1] + off[1], pos: new THREE.Vector3(b[0], b[1], b[2]) })
    }
  }
  return out
}

function packSkeleton(doc) {
  const root = doc.getRoot()
  const skin = root.listSkins()[0]
  if (!skin) throw new Error('player model has no skin')
  const nodes = root.listNodes()
  const index = new Map(nodes.map((n, i) => [n, i]))
  const parent = new Int32Array(nodes.length).fill(-1)
  for (const n of nodes) for (const c of n.listChildren()) parent[index.get(c)] = index.get(n)
  const joints = skin.listJoints().map(j => index.get(j))
  const ibm = skin.getInverseBindMatrices()
  const ibms = joints.map((_, i) => new THREE.Matrix4().fromArray(ibm.getElement(i, [])))
  const defaults = nodes.map(n => ({ t: n.getTranslation(), r: n.getRotation(), s: n.getScale() }))
  const byName = new Map(nodes.map((n, i) => [lowerName(n.getName()), i]))
  // parents before children
  const order = []
  const seen = new Uint8Array(nodes.length)
  const visit = i => { if (seen[i]) return; if (parent[i] >= 0) visit(parent[i]); seen[i] = 1; order.push(i) }
  nodes.forEach((_, i) => visit(i))
  const vertices = []
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    const uv = prim.getAttribute('TEXCOORD_0'), pos = prim.getAttribute('POSITION')
    const J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0')
    if (!uv || !pos || !J || !W) continue
    const mat = materialName(prim.getMaterial()?.getName())
    for (let i = 0; i < uv.getCount(); i++) {
      const p = pos.getElement(i, [])
      vertices.push({ mat, uv: uv.getElement(i, []), pos: new THREE.Vector3(p[0], p[1], p[2]), j: J.getElement(i, []), w: W.getElement(i, []) })
    }
  }
  return { nodes, parent, joints, ibms, defaults, byName, order, vertices }
}

/**
 * Pairs of (pack vertex, public position) whose texture coordinate matches one pack position only. A public
 * material whose name the pack lacks (a renamed or variant material) searches every pack material.
 */
function pairVertices(pub, pack) {
  const grid = new Map()
  const cell = (m, u, v) => `${m}|${u}|${v}`
  const names = new Set(pack.map(pv => pv.mat))
  for (const pv of pack) {
    for (const m of [pv.mat, '*']) {
      const k = cell(m, Math.round(pv.uv[0] * UV_CELL), Math.round(pv.uv[1] * UV_CELL))
      let list = grid.get(k)
      if (!list) grid.set(k, (list = []))
      list.push(pv)
    }
  }
  const pairs = []
  for (const bv of pub) {
    const m = names.has(bv.mat) ? bv.mat : '*'
    const cu = Math.round(bv.u * UV_CELL), cv = Math.round(bv.v * UV_CELL)
    const found = []
    for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) {
      for (const pv of grid.get(cell(m, cu + du, cv + dv)) ?? []) {
        if (Math.hypot(pv.uv[0] - bv.u, pv.uv[1] - bv.v) < UV_TOLERANCE) found.push(pv)
      }
    }
    if (!found.length) continue
    if (found.every(c => c.pos.distanceTo(found[0].pos) < SAME_POINT)) pairs.push({ pack: found[0], pub: bv.pos })
  }
  return pairs
}

function worldMatrices(sk, local) {
  const out = new Array(sk.nodes.length)
  const m = new THREE.Matrix4(), t = new THREE.Vector3(), r = new THREE.Quaternion(), s = new THREE.Vector3()
  for (const i of sk.order) {
    const l = local[i]
    m.compose(t.fromArray(l.t), r.fromArray(l.r), s.fromArray(l.s))
    out[i] = sk.parent[i] >= 0 ? out[sk.parent[i]].clone().multiply(m) : m.clone()
  }
  return out
}

function skinned(sk, worlds, pairs) {
  const skinM = sk.joints.map((n, i) => worlds[n].clone().multiply(sk.ibms[i]))
  const v = new THREE.Vector3()
  return pairs.map(({ pack }) => {
    const out = new THREE.Vector3()
    for (let k = 0; k < 4; k++) if (pack.w[k] > 0) out.addScaledVector(v.copy(pack.pos).applyMatrix4(skinM[pack.j[k]]), pack.w[k])
    return out
  })
}

/** Eigenvector of the largest eigenvalue of a symmetric 4x4 matrix (Jacobi). */
function largestEigenvector(A0) {
  const A = A0.map(r => r.slice())
  const V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) off += A[i][j] ** 2
    if (off < 1e-20) break
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(A[p][q]) < 1e-30) continue
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q])
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1))
      const c = 1 / Math.sqrt(t * t + 1), s = t * c
      for (let k = 0; k < 4; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = c * a - s * b; A[k][q] = s * a + c * b }
      for (let k = 0; k < 4; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = c * a - s * b; A[q][k] = s * a + c * b }
      for (let k = 0; k < 4; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b }
    }
  }
  let best = 0
  for (let i = 1; i < 4; i++) if (A[i][i] > A[best][best]) best = i
  return [V[0][best], V[1][best], V[2][best], V[3][best]]
}

/** Similarity s R a + t closest to b (Horn 1987), with its RMS residual and per-pair squared errors. */
export function fitSimilarity(A, B) {
  const n = A.length
  const ma = new THREE.Vector3(), mb = new THREE.Vector3()
  for (let i = 0; i < n; i++) { ma.add(A[i]); mb.add(B[i]) }
  ma.divideScalar(n); mb.divideScalar(n)
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] // M[i][j] = sum a_i b_j
  let va = 0
  const a = new THREE.Vector3(), b = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
    a.copy(A[i]).sub(ma); b.copy(B[i]).sub(mb)
    va += a.lengthSq()
    const aa = [a.x, a.y, a.z], bb = [b.x, b.y, b.z]
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r][c] += aa[r] * bb[c]
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = M
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ]
  const q = largestEigenvector(N)
  const R = new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize()
  let num = 0
  for (let i = 0; i < n; i++) num += a.copy(A[i]).sub(ma).applyQuaternion(R).dot(b.copy(B[i]).sub(mb))
  const s = num / va
  const t = mb.clone().sub(ma.clone().applyQuaternion(R).multiplyScalar(s))
  const errors = new Float64Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    errors[i] = a.copy(A[i]).applyQuaternion(R).multiplyScalar(s).add(t).distanceToSquared(B[i])
    sum += errors[i]
  }
  return { s, R, t, rms: Math.sqrt(sum / n), errors }
}

const AXES = new THREE.Matrix4().makeRotationX(Math.PI / 2) // glTF scene -> pack copy (Source axes)
const AXES_INV = AXES.clone().invert()
const HAND = /^bip_(hand|lowerarm)_[lr]$|^bip_(thumb|index|middle|ring|pinky)_/i
const round = v => Math.round(v * 1e5) / 1e5

/**
 * Pose fitter over one public GLB and the pack's player model; feed it the include models' exports one at a time
 * (each can be large) and read the best pose with result().
 *
 * @param {object} o
 * @param {import('@gltf-transform/core').Document} o.publicDoc   the public player GLB (decoded)
 * @param {import('@gltf-transform/core').Document} o.playerDoc   the pack export of the player model
 * @param {number[]} [o.frames]  fractions of each clip to sample (default 0 and 0.5)
 */
export function createPoseFitter(o) {
  const sk = packSkeleton(o.playerDoc)
  const pairs = pairVertices(publicVertices(o.publicDoc), sk.vertices)
  if (pairs.length < 200) throw new Error(`only ${pairs.length} vertices pair with the public model`)
  const target = pairs.map(p => p.pub)
  const handPair = pairs.map(({ pack }) => {
    let best = 0
    for (let k = 1; k < 4; k++) if (pack.w[k] > pack.w[best]) best = k
    return HAND.test(sk.nodes[sk.joints[pack.j[best]]].getName())
  })
  const evaluate = local => {
    const worlds = worldMatrices(sk, local)
    const fit = fitSimilarity(skinned(sk, worlds, pairs), target)
    return { worlds, fit }
  }
  let best = { clip: null, frame: 0, ...evaluate(sk.defaults) }
  const fractions = o.frames ?? [0, 0.5]
  return {
    addAnimations(doc) {
      for (const anim of doc.getRoot().listAnimations()) {
        const channels = anim.listChannels()
          .map(ch => ({ i: sk.byName.get(lowerName(ch.getTargetNode()?.getName())), path: ch.getTargetPath(), out: ch.getSampler()?.getOutput() }))
          .filter(c => c.i !== undefined && c.out && (c.path === 'translation' || c.path === 'rotation'))
        if (!channels.length) continue
        const count = Math.max(...channels.map(c => c.out.getCount()))
        for (const frame of [...new Set(fractions.map(f => Math.min(count - 1, Math.floor(f * count))))]) {
          const local = sk.defaults.map(d => ({ t: d.t, r: d.r, s: d.s }))
          for (const c of channels) {
            const v = c.out.getElement(Math.min(frame, c.out.getCount() - 1), [])
            local[c.i] = { ...local[c.i], [c.path === 'translation' ? 't' : 'r']: v }
          }
          const r = evaluate(local)
          if (r.fit.rms < best.fit.rms) best = { clip: anim.getName(), frame, ...r }
        }
      }
    },
    result() {
      let handSum = 0, handCount = 0
      best.fit.errors.forEach((e, i) => { if (handPair[i]) { handSum += e; handCount++ } })
      const S = new THREE.Matrix4().compose(best.fit.t, best.fit.R, new THREE.Vector3(best.fit.s, best.fit.s, best.fit.s))
      const bones = {}
      for (let i = 0; i < sk.nodes.length; i++) {
        const name = sk.nodes[i].getName()
        if (!name || sk.nodes[i].getMesh() || sk.parent[i] < 0 || /^attachment_/i.test(name)) continue
        bones[name] = AXES.clone().multiply(best.worlds[i]).toArray().map(round)
      }
      return {
        clip: best.clip,
        frame: best.frame,
        rms: round(best.fit.rms),
        handRms: handCount ? round(Math.sqrt(handSum / handCount)) : null,
        scale: round(best.fit.s),
        pairs: pairs.length,
        fit: S.multiply(AXES_INV).toArray().map(round),
        bones,
      }
    },
  }
}
