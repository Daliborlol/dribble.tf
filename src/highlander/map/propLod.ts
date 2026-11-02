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
// triangle ranges (at most every REBUILD_FRAMES frames). The sprp fade distances hide rows beyond `fadeMax`
// in POV and spectator views only, never in RTS (asset contract 4.5). It is camera-driven, not tick-driven, and
// allocates nothing per frame after setup. Public props.glb has no `lod` extras, so nothing here runs for it.

import * as THREE from 'three'

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
}

interface BatchPair {
  kind: 'batch'
  rows: Row[]
  near: BatchSide
  far: null
  level: Int8Array
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
  const slots = rowCount * 2
  for (const mesh of meshes) {
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
  return { meshes, sorted, ranges }
}

export class PropLodController {
  private pairs: Pair[] = []
  private inverse = new THREE.Matrix4()
  private camera = new THREE.Vector3()
  private frame = 0
  private enabled = true
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
        this.pairs.push({
          kind: 'batch',
          rows,
          near: batchSide(near, rows.length),
          far: null,
          level: new Int8Array(rows.length).fill(-2),
          dirty: true,
          written: false,
        })
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
    const write = (side: BatchSide) => {
      side.meshes.forEach((mesh, m) => {
        const index = mesh.geometry.index!
        const dst = index.array as Uint32Array | Uint16Array
        const src = side.sorted[m]
        const range = side.ranges[m]
        let n = 0
        for (let i = 0; i < pair.rows.length; i++) {
          const level = pair.level[i]
          if (level < 0) continue
          const slot = i * 2 + level
          const start = range[slot * 2]
          const count = range[slot * 2 + 1]
          if (count) dst.set(src.subarray(start, start + count), n)
          n += count
        }
        mesh.geometry.setDrawRange(0, n)
        index.clearUpdateRanges()
        index.addUpdateRange(0, Math.max(1, n))
        index.needsUpdate = true
        mesh.userData.dribbleLodCount = n
      })
    }
    write(pair.near)
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
    this.pairs = []
  }
}
