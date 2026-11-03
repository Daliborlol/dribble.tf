// Analysis of the loaded map geometry around query spots (scene space), shared by the kit placeholders
// (Pickups.tsx) and the death markers (DeathMarkers.tsx):
// - floor: the highest visible map triangle under each spot within [z - below, z + above]. Map items sit
//   about 11 units above the floor (the old textured koth_product GLB puts its floors 8 to 20 units below the
//   same origins), so kits and respawn rings rest on the floor on every pipeline; the marker of a mid-air
//   death drops to the floor below it (upward-facing triangles only, a long search band);
// - baked: whether the GLB already draws a kit there (textured GLBs only: geometry whose material is a TF2
//   kit material near the spot). The koth_product GLB carries those materials only inside its two
//   resupply-locker models, so its field pickups are not baked and get placeholders like bsp-to-glb maps.
//
// Only static map geometry counts. Brush-entity nodes (`useInstance().mapNodes`: doors, trains, func_brush
// toggles, visualizers) move or toggle with the demo, so they are skipped: the result must not depend on the
// tick at which the analysis ran. Instanced meshes (the PAK props of props.glb) count per instance.
//
// SurfaceJob walks the triangles in slices (`step(budget)`), so neither a map load nor a props.glb arrival
// pays the whole pass in one frame. Every test is a maximum over triangles, so the result does not depend on
// the slicing: it is a pure function of the static map geometry, the visibility settings, the spots and the
// options, and drawing stays deterministic (D12).

import * as THREE from 'three'

export interface Spot {
  x: number
  y: number
  z: number
}

export interface SurfaceOptions {
  /** Search band for the floor under each spot: from z - below to z + above. */
  below: number
  above: number
  /** Only triangles that face up count (floors), else both sides. */
  upwardOnly: boolean
  /** Look for kits baked into a textured map GLB (kit materials near the spot). */
  detectBaked: boolean
}

export interface SpotSurface {
  /** Floor height under each spot, NaN when no floor was found within the search band. */
  floor: Float32Array
  /** 1 when the map GLB already draws a kit at the spot. */
  baked: Uint8Array
  /** Diagnostics for probes: step() calls (frames) the analysis took, meshes and triangles visited. */
  steps: number
  meshes: number
  trianglesScanned: number
  trianglesTested: number
  bakedBlobs: number
}

const CELL = 64
const KIT_MATERIAL = /models\/items\/(medkit|ammo_box|ammopack)/i
const LOCKER_MATERIAL = /resupply_locker/i
/** A kit blob counts for a spot when its centre lies this close (xy) and within this height band. */
const BAKED_XY = 40
const BAKED_Z = 48
/** Kit-material geometry this close to resupply-locker geometry is the locker's interior, not a pickup. */
const LOCKER_XY = 120
/** Triangles covering more grid cells than this are sky or backdrop faces, never a floor. */
const MAX_TRIANGLE_CELLS = 4096
/** upwardOnly: the normal's z share must reach this (slopes up to about 78 degrees). */
const MIN_UP = 0.2

const cellOf = (v: number) => Math.floor(v / CELL)
/** Numeric grid key; scene coordinates stay far inside +/- 16384 cells. */
const cellKey = (gx: number, gy: number) => (gx + 16384) * 32768 + (gy + 16384)

interface Group {
  start: number
  end: number
  kit: boolean
  locker: boolean
}

interface Item {
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
  index: THREE.BufferAttribute | null
  /** world matrix elements (column-major, as THREE.Matrix4.elements) */
  e: ArrayLike<number>
  groups: Group[]
}

interface Blob {
  x: number
  y: number
  z: number
  count: number
}

const _box = new THREE.Box3()
const _instance = new THREE.Matrix4()
const _world = new THREE.Matrix4()

export class SurfaceJob {
  private started = false
  private finished = false
  private items: Item[] = []
  private grid = new Map<number, number[]>()
  private readonly floor: Float32Array
  private readonly baked: Uint8Array
  private kitBlobs: Blob[] = []
  private lockerBlobs: Blob[] = []
  private groupBlobs = new Map<number, Blob>()
  private item = 0
  private group = 0
  private k = -1
  private scanned = 0
  private tested = 0
  private steps = 0
  private readonly v = new Float64Array(9)
  /** World positions of the current item's vertices (transformed once per item, reused across items). */
  private worldVertices = new Float32Array(0)
  private transformedItem = -1

  constructor(
    private readonly world: THREE.Object3D,
    private readonly spots: readonly Spot[],
    private readonly options: SurfaceOptions,
    private readonly exclude: ReadonlySet<THREE.Object3D> = new Set()
  ) {
    this.floor = new Float32Array(spots.length).fill(NaN)
    this.baked = new Uint8Array(spots.length)
  }

  get done(): boolean {
    return this.finished
  }

  /**
   * Processes up to `budget` triangles; true once the analysis is complete. The meshes are collected on the
   * first call, so visibility changes made by effects in the same commit (map.staticProps) are seen.
   */
  step(budget: number): boolean {
    if (this.finished) return true
    if (!this.started) this.start()
    this.steps++
    let left = budget
    const v = this.v
    const { below, above, upwardOnly } = this.options
    const spots = this.spots
    const grid = this.grid
    const floor = this.floor
    let det = 1
    let minX = 0, maxX = 0, minY = 0, maxY = 0
    // Spot s against the current triangle (v, det and its xy bounds): raise the spot's floor.
    const test = (s: number) => {
      const p = spots[s]
      if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return
      this.tested++
      const l1 = ((v[4] - v[7]) * (p.x - v[6]) + (v[6] - v[3]) * (p.y - v[7])) / det
      const l2 = ((v[7] - v[1]) * (p.x - v[6]) + (v[0] - v[6]) * (p.y - v[7])) / det
      const l3 = 1 - l1 - l2
      if (l1 < 0 || l2 < 0 || l3 < 0) return
      const z = l1 * v[2] + l2 * v[5] + l3 * v[8]
      if (z > p.z + above || z < p.z - below) return
      if (Number.isNaN(floor[s]) || z > floor[s]) floor[s] = z
    }
    while (this.item < this.items.length) {
      const it = this.items[this.item]
      const g = it.groups[this.group]
      if (!g) {
        this.item++
        this.group = 0
        this.k = -1
        continue
      }
      if (this.k < 0) this.k = g.start
      if (this.transformedItem !== this.item) {
        // every vertex once (a vertex is shared by several triangles), counted against the budget
        this.transformItem(it)
        left -= Math.ceil(it.position.count / 2)
      }
      const wv = this.worldVertices
      const ia = it.index ? it.index.array : null
      const blobs = g.kit || g.locker
      let k = this.k
      for (; k + 2 < g.end && left > 0; k += 3) {
        left--
        for (let c = 0; c < 3; c++) {
          const i = (ia ? ia[k + c] : k + c) * 3
          const o = c * 3
          v[o] = wv[i]
          v[o + 1] = wv[i + 1]
          v[o + 2] = wv[i + 2]
        }
        if (blobs) {
          const cx = (v[0] + v[3] + v[6]) / 3, cy = (v[1] + v[4] + v[7]) / 3, cz = (v[2] + v[5] + v[8]) / 3
          const key = cellKey(cellOf(cx), cellOf(cy))
          const blob = this.groupBlobs.get(key)
          if (blob) {
            blob.x += cx
            blob.y += cy
            blob.z += cz
            blob.count++
          } else this.groupBlobs.set(key, { x: cx, y: cy, z: cz, count: 1 })
        }
        minX = Math.min(v[0], v[3], v[6])
        maxX = Math.max(v[0], v[3], v[6])
        minY = Math.min(v[1], v[4], v[7])
        maxY = Math.max(v[1], v[4], v[7])
        const cx0 = cellOf(minX), cx1 = cellOf(maxX)
        const cy0 = cellOf(minY), cy1 = cellOf(maxY)
        const cells = (cx1 - cx0 + 1) * (cy1 - cy0 + 1)
        if (cells > MAX_TRIANGLE_CELLS) continue
        det = (v[4] - v[7]) * (v[0] - v[6]) + (v[6] - v[3]) * (v[1] - v[7])
        if (Math.abs(det) < 1e-6) continue // vertical in xy: a wall, never a floor
        if (upwardOnly) {
          const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2]
          const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2]
          const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
          if (nz <= MIN_UP * Math.sqrt(nx * nx + ny * ny + nz * nz)) continue
        }
        if (cells > spots.length) {
          // a large triangle: cheaper to test every spot than to visit every covered cell
          for (let s = 0; s < spots.length; s++) test(s)
          continue
        }
        for (let gx = cx0; gx <= cx1; gx++) {
          for (let gy = cy0; gy <= cy1; gy++) {
            const list = grid.get(cellKey(gx, gy))
            if (list) for (const s of list) test(s)
          }
        }
      }
      this.scanned += k - this.k
      this.k = k
      if (k + 2 >= g.end) {
        this.closeGroup(g)
        this.group++
        this.k = -1
      }
      if (left <= 0) return false
    }
    this.finish()
    return true
  }

  result(): SpotSurface {
    return {
      floor: this.floor,
      baked: this.baked,
      steps: this.steps,
      meshes: this.items.length,
      trianglesScanned: Math.round(this.scanned / 3),
      trianglesTested: this.tested,
      bakedBlobs: this.kitBlobs.length,
    }
  }

  /** World positions of the item's vertices into worldVertices. */
  private transformItem(it: Item) {
    const position = it.position
    const n = position.count
    if (this.worldVertices.length < n * 3) this.worldVertices = new Float32Array(n * 3)
    const out = this.worldVertices
    const e = it.e
    for (let i = 0; i < n; i++) {
      const a = position.getX(i), b = position.getY(i), d = position.getZ(i)
      out[i * 3] = e[0] * a + e[4] * b + e[8] * d + e[12]
      out[i * 3 + 1] = e[1] * a + e[5] * b + e[9] * d + e[13]
      out[i * 3 + 2] = e[2] * a + e[6] * b + e[10] * d + e[14]
    }
    this.transformedItem = this.item
  }

  private start() {
    this.started = true
    const { below, above, detectBaked } = this.options
    const spots = this.spots
    spots.forEach((s, i) => {
      const key = cellKey(cellOf(s.x), cellOf(s.y))
      const list = this.grid.get(key)
      if (list) list.push(i)
      else this.grid.set(key, [i])
    })
    const overlapsSpot = (box: THREE.Box3) => {
      for (const s of spots) {
        if (
          s.x >= box.min.x && s.x <= box.max.x && s.y >= box.min.y && s.y <= box.max.y &&
          box.min.z <= s.z + above && box.max.z >= s.z - below
        )
          return true
      }
      return false
    }

    this.world.updateMatrixWorld(true)
    const visit = (object: THREE.Object3D) => {
      if (!object.visible || this.exclude.has(object)) return
      // as/perf: the merged copies of static brush entities (map/staticBatch.ts), which are brush-entity geometry
      if (object.userData?.dribble?.kind === 'staticBrushBatch') return
      const mesh = object as THREE.Mesh
      if (mesh.isMesh) this.addMesh(mesh, overlapsSpot, detectBaked)
      for (const child of object.children) visit(child)
    }
    visit(this.world)
  }

  private addMesh(mesh: THREE.Mesh, overlapsSpot: (box: THREE.Box3) => boolean, detectBaked: boolean) {
    const geometry = mesh.geometry
    const position = geometry?.attributes.position as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined
    if (!position) return
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const index = geometry.index
    const total = index ? index.count : position.count
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const ranges = geometry.groups.length
      ? geometry.groups
      : [{ start: 0, count: total, materialIndex: 0 }]
    const groups: Group[] = ranges.map(range => {
      const name = materials[range.materialIndex ?? 0]?.name ?? ''
      return {
        start: range.start,
        end: Math.min(range.start + range.count, total),
        kit: detectBaked && KIT_MATERIAL.test(name),
        locker: detectBaked && LOCKER_MATERIAL.test(name),
      }
    })
    const hasKitMaterial = groups.some(g => g.kit || g.locker)

    const instanced = mesh as THREE.InstancedMesh
    const count = instanced.isInstancedMesh ? instanced.count : 1
    for (let i = 0; i < count; i++) {
      if (instanced.isInstancedMesh) {
        instanced.getMatrixAt(i, _instance)
        _world.multiplyMatrices(mesh.matrixWorld, _instance)
      } else _world.copy(mesh.matrixWorld)
      _box.copy(geometry.boundingBox!).applyMatrix4(_world)
      if (!hasKitMaterial && !overlapsSpot(_box)) continue
      this.items.push({ position, index, e: _world.elements.slice(), groups })
    }
  }

  private closeGroup(g: Group) {
    if (!(g.kit || g.locker)) return
    for (const blob of this.groupBlobs.values()) {
      const center = { x: blob.x / blob.count, y: blob.y / blob.count, z: blob.z / blob.count, count: blob.count }
      if (g.kit) this.kitBlobs.push(center)
      else this.lockerBlobs.push(center)
    }
    this.groupBlobs.clear()
  }

  private finish() {
    this.finished = true
    if (!this.options.detectBaked) return
    const pickupKits = this.kitBlobs.filter(
      k => !this.lockerBlobs.some(l => Math.hypot(l.x - k.x, l.y - k.y) < LOCKER_XY)
    )
    this.kitBlobs = pickupKits
    this.spots.forEach((s, i) => {
      this.baked[i] = pickupKits.some(
        k => Math.hypot(k.x - s.x, k.y - s.y) < BAKED_XY && Math.abs(k.z - s.z) < BAKED_Z
      )
        ? 1
        : 0
    })
  }
}

/** The whole analysis in one call (debug probes and remeasuring). */
export function analyzeSpots(
  world: THREE.Object3D,
  spots: readonly Spot[],
  options: SurfaceOptions,
  exclude?: ReadonlySet<THREE.Object3D>
): SpotSurface {
  const job = new SurfaceJob(world, spots, options, exclude)
  job.step(Infinity)
  return job.result()
}
