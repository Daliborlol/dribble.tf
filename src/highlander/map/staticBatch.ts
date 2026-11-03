// Static brush batches for pack worlds (as/perf).
//
// A pack world keeps one node per brush entity, so that F6 can move doors and toggle func_brush. Most of them never
// change: koth_product_final has 146 func_illusionary nodes (151 draw calls of its 204 in an RTS overview) and
// pl_vigil_rc10 50 func_brush nodes. An entity without a targetname and without a parentname cannot be addressed
// by an input or follow a parent, so it stays exactly as the converter wrote it for the whole demo. Their opaque
// meshes are merged here, per shared material, into one mesh each under the GLB root. The original meshes stay in
// the graph, visible, with a material three never draws (`visible: false`; Mesh.raycast ignores it), so
// collectMapNodes, the probes and every raycast, isDrawnUnder's included, see the same nodes and hits as before; the
// batches do not raycast, and the floor analysis skips them. Translucent meshes keep their own draw (their
// back-to-front order is per object).
//
// Only pack worlds use this (World.tsx loadPackWorld), so public map files draw exactly as before (D21).

import * as THREE from 'three'

const BATCH_CLASSES = new Set(['func_illusionary', 'func_brush', 'func_wall'])

/** Drawn by nothing: three skips objects whose material is not visible. Shared, never compiled. */
const NOT_DRAWN = new THREE.MeshBasicMaterial({ visible: false })
NOT_DRAWN.name = 'static_brush_batched'

const _m = new THREE.Matrix4()
const _n = new THREE.Matrix3()
const _v = new THREE.Vector3()

interface Part {
  mesh: THREE.Mesh
  matrix: THREE.Matrix4
}

function batchable(node: THREE.Object3D): boolean {
  const info = node.userData?.dribble
  if (!info || info.kind !== 'brushEntity' || !BATCH_CLASSES.has(info.classname)) return false
  if (info.targetname || info.parentname) return false
  if (info.initiallyVisible === false || info.renderMode === 10 || info.hiddenByDefault === true) return false
  return node.visible
}

function attributeKey(geometry: THREE.BufferGeometry): string | null {
  if (geometry.groups.length > 1 || Object.keys(geometry.morphAttributes).length) return null
  const names = Object.keys(geometry.attributes).sort()
  if (!names.includes('position')) return null
  return names.map(n => `${n}:${geometry.attributes[n].itemSize}`).join(',') + (geometry.index ? ':i' : ':n')
}

function mergeParts(parts: Part[], inverseRoot: THREE.Matrix4): THREE.BufferGeometry {
  const first = parts[0].mesh.geometry
  const names = Object.keys(first.attributes)
  let vertexCount = 0
  let indexCount = 0
  for (const { mesh } of parts) {
    const g = mesh.geometry
    vertexCount += g.attributes.position.count
    indexCount += g.index ? g.index.count : g.attributes.position.count
  }
  const out = new THREE.BufferGeometry()
  const arrays = new Map<string, Float32Array>()
  for (const name of names) arrays.set(name, new Float32Array(vertexCount * first.attributes[name].itemSize))
  const index = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
  let vBase = 0
  let iBase = 0
  for (const { mesh, matrix } of parts) {
    const g = mesh.geometry
    const count = g.attributes.position.count
    _m.multiplyMatrices(inverseRoot, matrix)
    _n.getNormalMatrix(_m)
    for (const name of names) {
      const attr = g.attributes[name] as THREE.BufferAttribute
      const size = attr.itemSize
      const target = arrays.get(name)!
      const offset = vBase * size
      for (let i = 0; i < count; i++) {
        if (name === 'position') {
          _v.fromBufferAttribute(attr, i).applyMatrix4(_m)
          target[offset + i * 3] = _v.x
          target[offset + i * 3 + 1] = _v.y
          target[offset + i * 3 + 2] = _v.z
        } else if (name === 'normal') {
          _v.fromBufferAttribute(attr, i).applyMatrix3(_n).normalize()
          target[offset + i * 3] = _v.x
          target[offset + i * 3 + 1] = _v.y
          target[offset + i * 3 + 2] = _v.z
        } else if (name === 'tangent') {
          _v.set(attr.getX(i), attr.getY(i), attr.getZ(i)).transformDirection(_m)
          target.set([_v.x, _v.y, _v.z, attr.getW(i)], offset + i * 4)
        } else {
          target[offset + i * size] = attr.getX(i)
          if (size > 1) target[offset + i * size + 1] = attr.getY(i)
          if (size > 2) target[offset + i * size + 2] = attr.getZ(i)
          if (size > 3) target[offset + i * size + 3] = attr.getW(i)
        }
      }
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) index[iBase + i] = g.index.getX(i) + vBase
      iBase += g.index.count
    } else {
      for (let i = 0; i < count; i++) index[iBase + i] = vBase + i
      iBase += count
    }
    vBase += count
  }
  for (const name of names) out.setAttribute(name, new THREE.BufferAttribute(arrays.get(name)!, first.attributes[name].itemSize))
  out.setIndex(new THREE.BufferAttribute(index, 1))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

/** Merges the static brush-entity meshes of a loaded pack world (see above). Returns the number of batches. */
export function batchStaticBrushes(root: THREE.Object3D): number {
  root.updateMatrixWorld(true)
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const groups = new Map<string, Part[]>()
  for (const node of root.children) {
    if (!batchable(node)) continue
    for (const child of node.children) {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || !mesh.visible || mesh.children.length) continue
      if (mesh.userData?.dribble?.kind === 'overlays') continue
      const material = mesh.material
      if (!material || Array.isArray(material) || material.transparent || !material.visible) continue
      const key = attributeKey(mesh.geometry)
      if (!key) continue
      const groupKey = `${material.uuid}|${key}|${mesh.renderOrder}`
      const list = groups.get(groupKey)
      const part = { mesh, matrix: mesh.matrixWorld.clone() }
      if (list) list.push(part)
      else groups.set(groupKey, [part])
    }
  }
  let batches = 0
  for (const parts of groups.values()) {
    if (parts.length < 2) continue
    const geometry = mergeParts(parts, inverseRoot)
    const batch = new THREE.Mesh(geometry, parts[0].mesh.material)
    batch.name = 'static_brush_batch'
    batch.userData.dribble = { kind: 'staticBrushBatch', meshes: parts.length }
    batch.renderOrder = parts[0].mesh.renderOrder
    batch.raycast = () => {}
    batch.matrixAutoUpdate = false
    root.add(batch)
    batch.updateMatrixWorld(true)
    for (const { mesh } of parts) {
      mesh.userData.batchedMaterial = mesh.material
      mesh.material = NOT_DRAWN
    }
    batches++
  }
  return batches
}
