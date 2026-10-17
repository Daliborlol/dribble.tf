// One-time analysis of the loaded map geometry around pickup spots (scene space):
// - floor: the highest visible map triangle under each spot (map items sit about 11 units above the floor,
//   but the old textured koth_product GLB puts its floors 9 units below the same origins), so kits and
//   respawn rings rest on the floor on every pipeline;
// - baked: whether the GLB already draws a kit there (textured GLBs only: geometry whose material is a TF2
//   kit material near the spot). The koth_product GLB carries those materials only inside its two
//   resupply-locker models, so its field pickups are not baked and get placeholders like bsp-to-glb maps.
//
// The result is a pure function of the static map geometry and the spot list, computed once per map load
// (one pass over the triangles of the meshes that overlap any spot), so drawing stays deterministic.

import * as THREE from 'three'

export interface Spot {
  x: number
  y: number
  z: number
}

export interface SpotSurface {
  /** Floor height under each spot, NaN when no floor was found within the search range. */
  floor: Float32Array
  /** 1 when the map GLB already draws a kit at the spot. */
  baked: Uint8Array
  /** Diagnostics for probes. */
  trianglesTested: number
  bakedBlobs: number
}

const CELL = 64
/** Search range below / above the spot origin for the floor. */
const FLOOR_BELOW = 40
const FLOOR_ABOVE = 2
const KIT_MATERIAL = /models\/items\/(medkit|ammo_box|ammopack)/i
const LOCKER_MATERIAL = /resupply_locker/i
/** A kit blob counts for a spot when its centre lies this close (xy) and within this height band. */
const BAKED_XY = 40
const BAKED_Z = 48
/** Kit-material geometry this close to resupply-locker geometry is the locker's interior, not a pickup. */
const LOCKER_XY = 120

const cellKey = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`

const isVisibleChain = (object: THREE.Object3D, root: THREE.Object3D) => {
  for (let o: THREE.Object3D | null = object; o && o !== root.parent; o = o.parent) if (!o.visible) return false
  return true
}

const _box = new THREE.Box3()

export function analyzeSpots(world: THREE.Object3D, spots: Spot[], detectBaked: boolean): SpotSurface {
  const n = spots.length
  const floor = new Float32Array(n).fill(NaN)
  const baked = new Uint8Array(n)
  let trianglesTested = 0
  const grid = new Map<string, number[]>()
  spots.forEach((s, i) => {
    const key = cellKey(s.x, s.y)
    const list = grid.get(key)
    if (list) list.push(i)
    else grid.set(key, [i])
  })

  const kitBlobs: THREE.Vector3[] = []
  const lockerBlobs: THREE.Vector3[] = []
  world.updateMatrixWorld(true)
  world.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !isVisibleChain(mesh, world)) return
    const geometry = mesh.geometry
    const position = geometry.attributes.position as THREE.BufferAttribute | undefined
    if (!position) return
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    _box.copy(geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const kitGroups: number[] = []
    if (detectBaked) {
      materials.forEach((m, i) => {
        const name = m?.name ?? ''
        if (KIT_MATERIAL.test(name) || LOCKER_MATERIAL.test(name)) kitGroups.push(i)
      })
    }
    let overlaps = kitGroups.length > 0
    for (let i = 0; i < n && !overlaps; i++) {
      const s = spots[i]
      overlaps =
        s.x >= _box.min.x && s.x <= _box.max.x && s.y >= _box.min.y && s.y <= _box.max.y &&
        _box.min.z <= s.z + FLOOR_ABOVE && _box.max.z >= s.z - FLOOR_BELOW
    }
    if (!overlaps) return

    const e = mesh.matrixWorld.elements
    const index = geometry.index
    const groups = geometry.groups.length
      ? geometry.groups
      : [{ start: 0, count: index ? index.count : position.count, materialIndex: 0 }]
    const v = new Float32Array(9)
    const vertex = (k: number, o: number) => {
      const i = index ? index.getX(k) : k
      const a = position.getX(i), b = position.getY(i), c = position.getZ(i)
      v[o] = e[0] * a + e[4] * b + e[8] * c + e[12]
      v[o + 1] = e[1] * a + e[5] * b + e[9] * c + e[13]
      v[o + 2] = e[2] * a + e[6] * b + e[10] * c + e[14]
    }
    for (const group of groups) {
      const materialIndex = group.materialIndex ?? 0
      const materialName = materials[materialIndex]?.name ?? ''
      const isKit = detectBaked && KIT_MATERIAL.test(materialName)
      const isLocker = detectBaked && LOCKER_MATERIAL.test(materialName)
      const blobs = new Map<string, { sum: THREE.Vector3; count: number }>()
      const end = Math.min(group.start + group.count, index ? index.count : position.count)
      for (let k = group.start; k + 2 < end; k += 3) {
        vertex(k, 0)
        vertex(k + 1, 3)
        vertex(k + 2, 6)
        if (isKit || isLocker) {
          const cx = (v[0] + v[3] + v[6]) / 3, cy = (v[1] + v[4] + v[7]) / 3, cz = (v[2] + v[5] + v[8]) / 3
          const key = cellKey(cx, cy)
          const blob = blobs.get(key) ?? { sum: new THREE.Vector3(), count: 0 }
          blob.sum.x += cx
          blob.sum.y += cy
          blob.sum.z += cz
          blob.count++
          blobs.set(key, blob)
        }
        // floor: spots in the cells the triangle's xy bounds cover
        const minX = Math.min(v[0], v[3], v[6]), maxX = Math.max(v[0], v[3], v[6])
        const minY = Math.min(v[1], v[4], v[7]), maxY = Math.max(v[1], v[4], v[7])
        const cx0 = Math.floor(minX / CELL), cx1 = Math.floor(maxX / CELL)
        const cy0 = Math.floor(minY / CELL), cy1 = Math.floor(maxY / CELL)
        if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 4096) continue // huge sky/backdrop triangles
        for (let gx = cx0; gx <= cx1; gx++) {
          for (let gy = cy0; gy <= cy1; gy++) {
            const list = grid.get(`${gx},${gy}`)
            if (!list) continue
            for (const i of list) {
              const s = spots[i]
              if (s.x < minX || s.x > maxX || s.y < minY || s.y > maxY) continue
              trianglesTested++
              const det = (v[4] - v[7]) * (v[0] - v[6]) + (v[6] - v[3]) * (v[1] - v[7])
              if (Math.abs(det) < 1e-6) continue
              const l1 = ((v[4] - v[7]) * (s.x - v[6]) + (v[6] - v[3]) * (s.y - v[7])) / det
              const l2 = ((v[7] - v[1]) * (s.x - v[6]) + (v[0] - v[6]) * (s.y - v[7])) / det
              const l3 = 1 - l1 - l2
              if (l1 < 0 || l2 < 0 || l3 < 0) continue
              const z = l1 * v[2] + l2 * v[5] + l3 * v[8]
              if (z > s.z + FLOOR_ABOVE || z < s.z - FLOOR_BELOW) continue
              if (Number.isNaN(floor[i]) || z > floor[i]) floor[i] = z
            }
          }
        }
      }
      for (const blob of blobs.values()) {
        const center = blob.sum.divideScalar(blob.count)
        if (isKit) kitBlobs.push(center)
        else if (isLocker) lockerBlobs.push(center)
      }
    }
  })

  const pickupKits = kitBlobs.filter(
    k => !lockerBlobs.some(l => Math.hypot(l.x - k.x, l.y - k.y) < LOCKER_XY)
  )
  spots.forEach((s, i) => {
    baked[i] = pickupKits.some(k => Math.hypot(k.x - s.x, k.y - s.y) < BAKED_XY && Math.abs(k.z - s.z) < BAKED_Z)
      ? 1
      : 0
  })
  return { floor, baked, trianglesTested, bakedBlobs: pickupKits.length }
}
