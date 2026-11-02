// Far VTX LODs and sprp fades of pack static props (asset task M3-props2).
//
// scripts/lib/static-props.mjs (pack output only) writes a far partner for every instanced node whose model has
// a usable VTX LOD: `userData.dribble.lod = { level: 0 | 1, pair, distance }`, both nodes with the same instance
// rows. The merged exact-light batch (`lod.rows`) holds both levels in one primitive per material: its vertices
// carry `_prop` = 2 + row x 2 + (far ? 1 : 0), and the node lists `lodDistance` per row (0: no far LOD). Every
// node lists `fadeMax` per row (0: none).
//
// Each frame the controller measures the camera's distance to every row and draws it with LOD 0 below the
// row's distance and with the far LOD beyond it (10 % hysteresis). Instanced nodes compact their rows into
// `instanceMatrix`/`instanceColor` and set `count`; merged batches rewrite their index buffer from per-row
// triangle ranges (at most every REBUILD_FRAMES frames), from the first changed row on and only in the meshes
// that hold a changed row. The sprp fade distances hide rows beyond `fadeMax`
// in POV and spectator views only, never in RTS (asset contract 4.5). It is camera-driven, not tick-driven, and
// allocates nothing per frame after setup. Public props.glb has no `lod` extras, so nothing here runs for it.

import * as THREE from 'three'
import type { LodLayout } from '@highlander/map/propBatch'

const HYSTERESIS = 0.1
const REBUILD_FRAMES = 10

type Row = { x: number; y: number; z: number; lodDistance: number; fadeMax: number }

interface InstancedSide {
  meshes: THREE.InstancedMesh[]
  matrices: Float32Array[]
  colors: (Float32Array | null)[]
}

interface InstancedPair {
  kind: 'instanced'
  rows: Row[]
  near: InstancedSide
  far: InstancedSide | null
  level: Int8Array // -1 hidden, 0 near, 1 far
}

interface BatchSide {
  meshes: THREE.Mesh[]
  /** Per mesh: indices sorted by (row, level), and the [start, count] of each (row x 2 + level) in it. */
  sorted: Uint32Array[]
  ranges: Int32Array[]
  /** Per mesh: the local bounds of each row's vertices (min x, y, z, max x, y, z; empty rows stay inverted). */
  boxes: Float32Array[]
}

interface BatchPair {
  kind: 'batch'
  rows: Row[]
  near: BatchSide
  far: null
  level: Int8Array
  /** The level each row had when the index buffers were last written (-2: never). */
  writtenLevel: Int8Array
  dirty: boolean
  written: boolean
}

type Pair = InstancedPair | BatchPair

export interface PropLodStats {
  pairs: number
  rows: number
  near: number
  far: number
  hidden: number
  rebuilds: number
}

/** Rows of a staticProps node in glTF axes (the props root's local space): Source (x, y, z) -> (x, z, -y). */
function rowsOf(info: any): Row[] {
  const origins: number[][] = info.origins ?? []
  return origins.map((o, i) => ({
    x: o[0],
    y: o[2],
    z: -o[1],
    lodDistance: info.lodDistance ? Number(info.lodDistance[i]) || 0 : Number(info.lod?.distance) || 0,
    fadeMax: Number(info.fadeMax?.[i]) || 0,
  }))
}

function meshesUnder(node: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  node.traverse(child => {
    if ((child as THREE.Mesh).isMesh) out.push(child as THREE.Mesh)
  })
  return out
}

function instancedSide(node: THREE.Object3D): InstancedSide {
  const meshes = meshesUnder(node).filter(mesh => (mesh as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[]
  return {
    meshes,
    matrices: meshes.map(mesh => (mesh.instanceMatrix.array as Float32Array).slice()),
    colors: meshes.map(mesh => (mesh.instanceColor ? (mesh.instanceColor.array as Float32Array).slice() : null)),
  }
}

function batchSide(node: THREE.Object3D, rowCount: number): BatchSide {
  const meshes = meshesUnder(node).filter(mesh => mesh.geometry.index && mesh.geometry.attributes._prop)
  const sorted: Uint32Array[] = []
  const ranges: Int32Array[] = []
  const boxes: Float32Array[] = []
  const slots = rowCount * 2
  for (const mesh of meshes) {
    // The runtime bake (propBatch.ts) writes the index already sorted, with its ranges and row bounds.
    const layout = mesh.userData.dribbleLodLayout as LodLayout | undefined
    if (layout && layout.ranges.length === slots * 2 && layout.boxes.length === rowCount * 6) {
      sorted.push(Uint32Array.from(mesh.geometry.index!.array as ArrayLike<number>))
      ranges.push(layout.ranges)
      boxes.push(layout.boxes)
      continue
    }
    const position = mesh.geometry.attributes.position
    const vertexProp = mesh.geometry.attributes._prop
    const box = new Float32Array(rowCount * 6)
    for (let r = 0; r < rowCount; r++) box.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], r * 6)
    for (let v = 0; v < position.count; v++) {
      const r = Math.min(slots - 1, Math.max(0, Math.round(vertexProp.getX(v)) - 2)) >> 1
      const x = position.getX(v)
      const y = position.getY(v)
      const z = position.getZ(v)
      const o = r * 6
      if (x < box[o]) box[o] = x
      if (y < box[o + 1]) box[o + 1] = y
      if (z < box[o + 2]) box[o + 2] = z
      if (x > box[o + 3]) box[o + 3] = x
      if (y > box[o + 4]) box[o + 4] = y
      if (z > box[o + 5]) box[o + 5] = z
    }
    boxes.push(box)
    const index = mesh.geometry.index!.array as ArrayLike<number>
    const prop = mesh.geometry.attributes._prop
    const triangles = index.length / 3
    const slotOf = (t: number) => Math.min(slots - 1, Math.max(0, Math.round(prop.getX(index[t * 3])) - 2))
    const counts = new Int32Array(slots)
    for (let t = 0; t < triangles; t++) counts[slotOf(t)]++
    const range = new Int32Array(slots * 2)
    let start = 0
    for (let r = 0; r < slots; r++) {
      range[r * 2] = start * 3
      range[r * 2 + 1] = counts[r] * 3
      start += counts[r]
    }
    const cursor = new Int32Array(slots)
    const out = new Uint32Array(index.length)
    for (let t = 0; t < triangles; t++) {
      const r = slotOf(t)
      const at = range[r * 2] + cursor[r]
      out[at] = index[t * 3]
      out[at + 1] = index[t * 3 + 1]
      out[at + 2] = index[t * 3 + 2]
      cursor[r] += 3
    }
    sorted.push(out)
    ranges.push(range)
  }
  return { meshes, sorted, ranges, boxes }
}

const _inverse = new THREE.Matrix4()
const _ray = new THREE.Ray()
const _box = new THREE.Box3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _hit = new THREE.Vector3()

/**
 * A merged batch spans the whole map, so three's Mesh.raycast would test every drawn triangle (about 1.4M on
 * pl_vigil). This one tests each row's bounds first and then only the triangles of the rows the ray reaches, at
 * the level the row is drawn with, as the InstancedMesh of the instanced nodes did per instance.
 */
function batchRaycast(pair: BatchPair, side: BatchSide, m: number) {
  const mesh = side.meshes[m]
  return (raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) => {
    const material = mesh.material as THREE.Material
    if (material === undefined) return
    const position = mesh.geometry.attributes.position
    const src = side.sorted[m]
    const range = side.ranges[m]
    const box = side.boxes[m]
    const cull = material.side === THREE.FrontSide
    _inverse.copy(mesh.matrixWorld).invert()
    _ray.copy(raycaster.ray).applyMatrix4(_inverse)
    for (let i = 0; i < pair.rows.length; i++) {
      const level = pair.level[i]
      if (level < 0) continue
      const slot = i * 2 + level
      const count = range[slot * 2 + 1]
      if (!count) continue
      const o = i * 6
      _box.min.set(box[o], box[o + 1], box[o + 2])
      _box.max.set(box[o + 3], box[o + 4], box[o + 5])
      if (!_ray.intersectsBox(_box)) continue
      const start = range[slot * 2]
      for (let t = start; t < start + count; t += 3) {
        const a = src[t]
        const b = src[t + 1]
        const c = src[t + 2]
        _a.fromBufferAttribute(position, a)
        _b.fromBufferAttribute(position, b)
        _c.fromBufferAttribute(position, c)
        if (!_ray.intersectTriangle(_a, _b, _c, cull, _hit)) continue
        const point = _hit.clone().applyMatrix4(mesh.matrixWorld)
        const distance = raycaster.ray.origin.distanceTo(point)
        if (distance < raycaster.near || distance > raycaster.far) continue
        const normal = new THREE.Vector3()
        THREE.Triangle.getNormal(_a, _b, _c, normal)
        intersects.push({ distance, point, object: mesh, face: { a, b, c, normal, materialIndex: 0 }, faceIndex: t / 3 })
      }
    }
  }
}

export class PropLodController {
  private pairs: Pair[] = []
  private inverse = new THREE.Matrix4()
  private camera = new THREE.Vector3()
  private frame = 0
  private enabled = true
  /** Batch meshes whose raycast batchRaycast replaced, with the original to put back on dispose. */
  private raycasts: [THREE.Mesh, THREE.Mesh['raycast']][] = []
  rebuilds = 0

  constructor(private root: THREE.Object3D) {
    const groups = new Map<string, { near?: THREE.Object3D; far?: THREE.Object3D; info?: any }>()
    root.traverse(node => {
      const info = node.userData?.dribble
      // staticPropsBatch: the runtime bake of propBatch.ts, laid out as a merged batch.
      if ((info?.kind !== 'staticProps' && info?.kind !== 'staticPropsBatch') || !info.lod) return
      // GLTFLoader may put the extras on a group and on its meshes; the outermost node counts.
      if (node.parent?.userData?.dribble?.kind === 'staticProps') return
      const entry = groups.get(info.lod.pair) ?? {}
      if (info.lod.level === 1) entry.far = node
      else {
        entry.near = node
        entry.info = info
      }
      groups.set(info.lod.pair, entry)
    })
    groups.forEach(({ near, far, info }) => {
      if (!near || !info) return
      const rows = rowsOf(info)
      if (info.lod.rows) {
        const pair: BatchPair = {
          kind: 'batch',
          rows,
          near: batchSide(near, rows.length),
          far: null,
          level: new Int8Array(rows.length).fill(-2),
          writtenLevel: new Int8Array(rows.length).fill(-2),
          dirty: true,
          written: false,
        }
        pair.near.meshes.forEach((mesh, m) => {
          this.raycasts.push([mesh, mesh.raycast])
          mesh.raycast = batchRaycast(pair, pair.near, m)
        })
        this.pairs.push(pair)
      } else {
        // Nodes whose meshes the runtime bake (propBatch.ts) took have nothing left to switch.
        if (!meshesUnder(near).length && !(far && meshesUnder(far).length)) return
        this.pairs.push({
          kind: 'instanced',
          rows,
          near: instancedSide(near),
          far: far ? instancedSide(far) : null,
          level: new Int8Array(rows.length).fill(-2),
        })
      }
    })
  }

  get active(): boolean {
    return this.pairs.length > 0
  }

  /** map.staticProps: hidden props draw nothing and catch no raycasts. */
  setEnabled(enabled: boolean) {
    this.enabled = enabled
    this.pairs.forEach(pair => this.applyVisibility(pair))
  }

  /** Camera world position; `fades`: POV and spectator views honour the sprp fade distances. */
  update(cameraWorld: THREE.Vector3, fades: boolean) {
    if (!this.pairs.length) return
    this.frame++
    this.root.updateWorldMatrix(true, false)
    this.inverse.copy(this.root.matrixWorld).invert()
    const c = this.camera.copy(cameraWorld).applyMatrix4(this.inverse)
    for (const pair of this.pairs) {
      let changed = false
      const { rows, level } = pair
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const d = Math.hypot(row.x - c.x, row.y - c.y, row.z - c.z)
        const old = level[i]
        let next: number
        if (fades && row.fadeMax > 0 && d > row.fadeMax) next = -1
        else if ((pair.kind === 'instanced' && !pair.far) || row.lodDistance <= 0) next = 0
        else if (old === 1) next = d < row.lodDistance * (1 - HYSTERESIS) ? 0 : 1
        else if (old === 0) next = d > row.lodDistance * (1 + HYSTERESIS) ? 1 : 0
        else next = d > row.lodDistance ? 1 : 0
        if (next !== old) {
          level[i] = next
          changed = true
        }
      }
      if (pair.kind === 'instanced') {
        if (changed) this.writeInstanced(pair)
      } else {
        if (changed) pair.dirty = true
        if (pair.dirty && (this.frame % REBUILD_FRAMES === 0 || !pair.written)) this.writeBatch(pair)
      }
    }
  }

  private writeInstanced(pair: InstancedPair) {
    const write = (side: InstancedSide, want: number) => {
      side.meshes.forEach((mesh, m) => {
        const matrices = side.matrices[m]
        const colors = side.colors[m]
        const dst = mesh.instanceMatrix.array as Float32Array
        // Wireframe stashes instanceColor in userData (StaticProps setInstanceLight); keep that copy in row order too.
        const colorAttr = (mesh.instanceColor ?? mesh.userData.dribbleInstanceColor) as
          | THREE.InstancedBufferAttribute
          | null
          | undefined
        const dstColor = colorAttr?.array as Float32Array | undefined
        let n = 0
        for (let i = 0; i < pair.rows.length; i++) {
          if (pair.level[i] !== want) continue
          dst.set(matrices.subarray(i * 16, i * 16 + 16), n * 16)
          if (colors && dstColor) dstColor.set(colors.subarray(i * 3, i * 3 + 3), n * 3)
          n++
        }
        mesh.count = n
        mesh.instanceMatrix.needsUpdate = true
        if (colorAttr) colorAttr.needsUpdate = true
      })
    }
    write(pair.near, 0)
    if (pair.far) write(pair.far, 1)
    this.applyVisibility(pair)
  }

  private writeBatch(pair: BatchPair) {
    pair.dirty = false
    pair.written = true
    this.rebuilds++
    const { rows, level, writtenLevel } = pair
    // The first row whose level changed since the last write: everything before it stays where it is in every
    // mesh, so only the tail from there is rewritten and uploaded, and a mesh without a changed row is skipped.
    let first = 0
    while (first < rows.length && level[first] === writtenLevel[first]) first++
    if (first === rows.length) return
    const write = (side: BatchSide) => {
      side.meshes.forEach((mesh, m) => {
        const index = mesh.geometry.index!
        const dst = index.array as Uint32Array | Uint16Array
        const src = side.sorted[m]
        const range = side.ranges[m]
        const old = mesh.userData.dribbleLodCount as number | undefined
        // Offset of the first changed row that has triangles in this mesh.
        let n = 0
        let i = first
        for (let r = 0; r < first; r++) if (level[r] >= 0) n += range[(r * 2 + level[r]) * 2 + 1]
        for (; i < rows.length; i++) {
          if (level[i] === writtenLevel[i]) {
            if (level[i] >= 0) n += range[(i * 2 + level[i]) * 2 + 1]
            continue
          }
          if (range[i * 4 + 1] || range[i * 4 + 3]) break
        }
        if (i === rows.length && old !== undefined) return
        const from = old === undefined ? 0 : n
        for (; i < rows.length; i++) {
          if (level[i] < 0) continue
          const slot = i * 2 + level[i]
          const start = range[slot * 2]
          const count = range[slot * 2 + 1]
          if (count) dst.set(src.subarray(start, start + count), n)
          n += count
        }
        mesh.geometry.setDrawRange(0, n)
        if (n > from) {
          index.clearUpdateRanges()
          index.addUpdateRange(from, n - from)
          index.needsUpdate = true
        }
        mesh.userData.dribbleLodCount = n
      })
    }
    write(pair.near)
    writtenLevel.set(level)
    this.applyVisibility(pair)
  }

  private applyVisibility(pair: Pair) {
    const sides = [pair.near, pair.far].filter(Boolean) as (InstancedSide | BatchSide)[]
    for (const side of sides) {
      for (const mesh of side.meshes) {
        const count = (mesh as THREE.InstancedMesh).isInstancedMesh
          ? (mesh as THREE.InstancedMesh).count
          : (mesh.userData.dribbleLodCount as number | undefined) ?? 1
        mesh.visible = this.enabled && count > 0
      }
    }
  }

  stats(): PropLodStats {
    const out: PropLodStats = { pairs: this.pairs.length, rows: 0, near: 0, far: 0, hidden: 0, rebuilds: this.rebuilds }
    for (const pair of this.pairs) {
      for (let i = 0; i < pair.level.length; i++) {
        out.rows++
        if (pair.level[i] === 1) out.far++
        else if (pair.level[i] === -1) out.hidden++
        else out.near++
      }
    }
    return out
  }

  /** Back to every row at LOD 0 (before the geometry is disposed, nothing else to free). */
  dispose() {
    this.raycasts.forEach(([mesh, raycast]) => (mesh.raycast = raycast))
    this.raycasts = []
    this.pairs = []
  }
}
