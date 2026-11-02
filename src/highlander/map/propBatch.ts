// Runtime bake of pack static props (pol-props).
//
// A pack props file whose root says `bake: 'runtime'` (scripts/lib/static-props.mjs, pack output with LODs) stores
// every instance once, on EXT_mesh_gpu_instancing nodes that share their model's geometry: the baked instances of
// older packs are single-instance nodes with their exact VHV colours. Drawn as they are, that is one draw call per
// node and material. bakeRuntimeProps() moves every instance into place once at load and merges them into one mesh
// per material, so a material costs one draw call however many models and lighting patterns use it. With
// compressed pack textures (DDS) of the same format, size and mip count, materials that differ only by texture and
// colour scale share a mesh too: their textures go into one CompressedArrayTexture (at most MAX_LAYERS layers),
// each vertex carries its layer, and applyArrayMaterials() gives those meshes a patched copy of their material.
//
// Every vertex keeps its colour (vertex colour x instance colour, as three multiplies them), UV and position, so
// the props draw as before. LODs: the batch lists one row per instance and node (`origins`, `lodDistance`,
// `fadeMax`), and its vertices carry `_prop` = 2 + row x 2 + level, the layout propLod.ts already drives for the
// merged batch of older files. The original nodes stay in the tree without meshes, so the probes still list
// every instance. Files without `bake: 'runtime'` (public props.glb, older packs) are left alone.

import * as THREE from 'three'

/** Layers per texture array; the vertex shader indexes a uniform vec3 array of this length. */
export const MAX_LAYERS = 64

export interface PropBatchResult {
  rows: number
  meshes: number
  arrays: number
  layers: number
  vertices: number
  triangles: number
  /** Wall time of the sliced bake and main-thread time of propLod's setup of the batch (StaticProps fills both). */
  bakeMs?: number
  lodSetupMs?: number
  /** Frees the array textures (the geometry goes with the root). */
  dispose(): void
}

/** The index layout of a merged mesh, for propLod: per slot [start, count] into the index, per row its bounds. */
export interface LodLayout {
  ranges: Int32Array
  boxes: Float32Array
}

const SLICE_MS = 24

export interface ArrayMaterials {
  count: number
  dispose(): void
}

interface Piece {
  mesh: THREE.InstancedMesh
  base: number
  level: 0 | 1
  /** Exact light in the row-light carrier: vertex v of instance i is carrier vertex start + i x stride + v. */
  light: { start: number; stride: number; albedo: number[] } | null
}

interface SourceArrays {
  position: Float32Array
  normal: Float32Array | null
  color: Float32Array | null
  colorSize: number
  uv: Float32Array | null
  index: Uint32Array
}

/** `userData.dribbleArray` of a merged mesh whose materials share a texture array. */
interface ArrayInfo {
  texture: THREE.CompressedArrayTexture
  scales: Float32Array
}

const staticPropsInfo = (node: THREE.Object3D) => {
  const info = node.userData?.dribble
  return info?.kind === 'staticProps' ? info : null
}

/** True for a pack file written for the runtime bake (and without the merged batch of older files). */
export function wantsRuntimeBake(root: THREE.Object3D): boolean {
  let runtime = false
  let merged = false
  root.traverse(node => {
    const info = node.userData?.dribble
    if (info?.kind === 'staticPropsRoot' && info.bake === 'runtime') runtime = true
    if (info?.kind === 'staticProps' && info.merged) merged = true
  })
  return runtime && !merged
}

function toFloats(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, size?: number) {
  if (!attribute) return null
  const n = attribute.count
  const k = size ?? attribute.itemSize
  const out = new Float32Array(n * k)
  for (let i = 0; i < n; i++) {
    out[i * k] = attribute.getX(i)
    if (k > 1) out[i * k + 1] = attribute.getY(i)
    if (k > 2) out[i * k + 2] = attribute.getZ(i)
    if (k > 3) out[i * k + 3] = attribute.itemSize > 3 ? attribute.getW(i) : 1
  }
  return out
}

function sourceArrays(geometry: THREE.BufferGeometry, cache: Map<THREE.BufferGeometry, SourceArrays>): SourceArrays {
  let arrays = cache.get(geometry)
  if (arrays) return arrays
  const attrs = geometry.attributes
  const position = toFloats(attrs.position, 3)!
  const color = attrs.color ? toFloats(attrs.color) : null
  const index = geometry.index
    ? Uint32Array.from(geometry.index.array as ArrayLike<number>)
    : Uint32Array.from({ length: attrs.position.count }, (_, i) => i)
  arrays = {
    position,
    normal: attrs.normal ? toFloats(attrs.normal, 3) : null,
    color,
    colorSize: attrs.color ? attrs.color.itemSize : 0,
    uv: attrs.uv ? toFloats(attrs.uv, 2) : null,
    index,
  }
  cache.set(geometry, arrays)
  return arrays
}

// Frees a CPU copy after its one upload. This assumes nothing re-uploads the attribute or the array texture: a
// WebGL context restore, or disposing the geometry and drawing it again, would send empty data (black or broken
// props). Nothing in this app does either. Only the colours
// and the array mips are freed; `dribbleLayer` (1 byte per vertex) keeps its Uint8 copy.
function freeArray(this: THREE.BufferAttribute) {
  ;(this as unknown as { array: ArrayLike<number> }).array = new Float32Array(0)
}

type TextureSource = { key: string; texture: THREE.CompressedTexture }

/** The compressed pack texture a material samples, when it may share a texture array. */
function arrayTextureOf(
  material: THREE.Material,
  textures: Map<string, THREE.Texture | null> | null
): { signature: string; texture: THREE.CompressedTexture; scale: number[] } | null {
  const info = material.userData?.dribble
  const record = info?.texture
  if (!textures || !record?.key || info.kind !== 'opaque' || record.alpha === 'blend') return null
  const texture = textures.get(String(record.key).toLowerCase()) as THREE.CompressedTexture | null | undefined
  if (!texture?.isCompressedTexture || !texture.mipmaps?.length) return null
  const mips = texture.mipmaps as { data: ArrayBufferView; width: number; height: number }[]
  if (!mips.every(mip => mip?.data && mip.data.byteLength > 0)) return null
  const signature = [
    info.kind,
    record.alpha ?? '',
    record.cutoff ?? '',
    record.vertexAlpha ?? '',
    record.uv ?? 0,
    texture.format,
    texture.type,
    mips[0].width,
    mips[0].height,
    mips.length,
    texture.colorSpace,
    texture.wrapS,
    texture.wrapT,
    texture.minFilter,
    texture.magFilter,
    texture.anisotropy,
    texture.flipY,
  ].join('|')
  return { signature, texture, scale: (record.colorScale as number[] | undefined) ?? [1, 1, 1] }
}

function buildArrayTexture(sources: TextureSource[]): THREE.CompressedArrayTexture {
  const first = sources[0].texture
  const firstMips = first.mipmaps as { data: ArrayBufferView; width: number; height: number }[]
  const mipmaps = firstMips.map((mip, level) => {
    const size = mip.data.byteLength
    const data = new Uint8Array(size * sources.length)
    sources.forEach(({ texture }, layer) => {
      const src = (texture.mipmaps as { data: ArrayBufferView }[])[level].data
      data.set(new Uint8Array(src.buffer, src.byteOffset, size), layer * size)
    })
    return { data, width: mip.width, height: mip.height }
  })
  const array = new THREE.CompressedArrayTexture(
    mipmaps as unknown as ImageData[],
    firstMips[0].width,
    firstMips[0].height,
    sources.length,
    first.format as THREE.CompressedPixelFormat,
    first.type
  )
  array.colorSpace = first.colorSpace
  array.wrapS = first.wrapS
  array.wrapT = first.wrapT
  array.minFilter = first.minFilter
  array.magFilter = first.magFilter
  array.anisotropy = first.anisotropy
  array.flipY = first.flipY
  array.generateMipmaps = false
  array.channel = first.channel
  array.name = `dribble_props_array_${sources.length}`
  // Uploaded once: the CPU copy goes after the upload (the textures stay in the pack registry; see freeArray).
  array.onUpdate = () => {
    for (const mip of array.mipmaps as unknown as { data: Uint8Array }[]) mip.data = new Uint8Array(0)
  }
  array.needsUpdate = true
  return array
}

/**
 * Merges every instance of a runtime-bake pack file into one mesh per material or texture array (see the file
 * comment). Returns null and leaves the root untouched when the file is not one, or when anything fails.
 */
export async function bakeRuntimeProps(
  root: THREE.Object3D,
  textures: Map<string, THREE.Texture | null> | null,
  webgl2 = true
): Promise<PropBatchResult | null> {
  // The row-light carriers are data, never drawn: read and removed first, whatever happens next.
  // Its RGBA bytes are VHV values: linear light = (2b / 255)^2.2 x exposure + floor (the props root's `lighting`).
  let carrier: Float32Array | null = null
  const carriers: THREE.Object3D[] = []
  let lighting = { exposure: 1, floor: 0 }
  root.traverse(node => {
    const info = node.userData?.dribble
    if (info?.kind === 'staticPropsRowLight') carriers.push(node)
    if (info?.kind === 'staticPropsRoot' && info.lighting) {
      lighting = { exposure: Number(info.lighting.exposure) || 1, floor: Number(info.lighting.floor) || 0 }
    }
  })
  const table = Float32Array.from({ length: 256 }, (_, b) => Math.pow((2 * b) / 255, 2.2) * lighting.exposure + lighting.floor)
  for (const node of carriers) {
    const points = node as THREE.Points
    const color = points.geometry?.attributes?.color
    if (!carrier && color && node.userData.dribble.encoding === 'vhv') {
      carrier = new Float32Array(color.count * 3)
      for (let v = 0; v < color.count; v++) {
        carrier[v * 3] = table[Math.round(color.getX(v) * 255)]
        carrier[v * 3 + 1] = table[Math.round(color.getY(v) * 255)]
        carrier[v * 3 + 2] = table[Math.round(color.getZ(v) * 255)]
      }
    }
    node.removeFromParent()
    points.geometry?.dispose()
    ;(points.material as THREE.Material | undefined)?.dispose?.()
  }
  if (!wantsRuntimeBake(root)) return null
  root.updateMatrixWorld(true)

  // Outermost staticProps nodes (GLTFLoader may repeat the extras on a node's meshes).
  const nodes: THREE.Object3D[] = []
  root.traverse(node => {
    if (staticPropsInfo(node) && !(node.parent && staticPropsInfo(node.parent))) nodes.push(node)
  })
  const origins: number[][] = []
  const lodDistance: number[] = []
  const fadeMax: number[] = []
  const pairBase = new Map<string, number>()
  const pieces: Piece[] = []
  // rowLight = { offset, prims }: per instance one block of sum(prims) vertices, primitive after primitive.
  const lightOf = (info: any, meshes: THREE.InstancedMesh[]) => {
    const prims: number[] | undefined = info.rowLight?.prims
    if (!carrier || !prims || prims.length !== meshes.length) return meshes.map(() => null)
    const albedo: number[][] | undefined = info.rowLight.albedo
    if (!albedo || !meshes.every((mesh, p) => mesh.geometry.attributes.position.count === prims[p] && albedo[p]?.length === 3)) {
      return meshes.map(() => null)
    }
    const stride = prims.reduce((a, b) => a + b, 0)
    const count = Number(info.instances) || 0
    if ((Number(info.rowLight.offset) + stride * count) * 3 > carrier.length) return meshes.map(() => null)
    let start = Number(info.rowLight.offset)
    return prims.map((n, p) => {
      const light = { start, stride, albedo: albedo[p] }
      start += n
      return light
    })
  }
  const meshesOf = (node: THREE.Object3D) => {
    const out: THREE.InstancedMesh[] = []
    node.traverse(child => {
      if ((child as THREE.InstancedMesh).isInstancedMesh) out.push(child as THREE.InstancedMesh)
    })
    return out
  }
  for (const node of nodes) {
    const info = staticPropsInfo(node)
    if (info.lod?.level === 1) continue
    const base = origins.length
    const count = Number(info.instances) || (info.origins?.length ?? 0)
    for (let i = 0; i < count; i++) {
      origins.push(info.origins?.[i] ?? [0, 0, 0])
      lodDistance.push(info.lod ? Number(info.lod.distance) || 0 : 0)
      fadeMax.push(Number(info.fadeMax?.[i]) || 0)
    }
    if (info.lod) pairBase.set(info.lod.pair, base)
    const meshes = meshesOf(node)
    const lights = lightOf(info, meshes)
    meshes.forEach((mesh, p) => pieces.push({ mesh, base, level: 0, light: lights[p] }))
  }
  for (const node of nodes) {
    const info = staticPropsInfo(node)
    if (info.lod?.level !== 1) continue
    const base = pairBase.get(info.lod.pair)
    if (base === undefined) continue
    const meshes = meshesOf(node)
    const lights = lightOf(info, meshes)
    meshes.forEach((mesh, p) => pieces.push({ mesh, base, level: 1, light: lights[p] }))
  }
  if (!pieces.length) return null
  if (origins.length * 2 + 3 > 65535) return null

  // Pieces per material, then materials per texture array.
  const byMaterial = new Map<THREE.Material, Piece[]>()
  for (const piece of pieces) {
    const material = piece.mesh.material as THREE.Material
    if (!byMaterial.has(material)) byMaterial.set(material, [])
    byMaterial.get(material)!.push(piece)
  }
  type Group = { materials: THREE.Material[]; layers: TextureSource[] | null; scales: number[][] }
  const groups: Group[] = []
  const bySignature = new Map<string, Group[]>()
  for (const material of byMaterial.keys()) {
    const array = webgl2 ? arrayTextureOf(material, textures) : null
    if (!array) {
      groups.push({ materials: [material], layers: null, scales: [] })
      continue
    }
    const list = bySignature.get(array.signature) ?? []
    bySignature.set(array.signature, list)
    let group = list[list.length - 1]
    if (!group || group.materials.length >= MAX_LAYERS) {
      group = { materials: [], layers: [], scales: [] }
      list.push(group)
      groups.push(group)
    }
    group.materials.push(material)
    group.layers!.push({ key: String(material.userData.dribble.texture.key), texture: array.texture })
    group.scales.push(array.scale)
  }
  // A texture array of one layer is just its texture.
  for (const group of groups) {
    if (group.layers && group.layers.length < 2) {
      group.layers = null
      group.scales = []
    }
  }

  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const meshMatrix = new THREE.Matrix4()
  const instance = new THREE.Matrix4()
  const m = new THREE.Matrix4()
  const nm = new THREE.Matrix3()
  const tint = new THREE.Color()
  const cache = new Map<THREE.BufferGeometry, SourceArrays>()
  const arrays: THREE.CompressedArrayTexture[] = []
  const batch = new THREE.Group()
  batch.name = 'static_props_batch'
  batch.userData.dribble = {
    kind: 'staticPropsBatch',
    lod: { level: 0, pair: 'static_props_batch', rows: true },
    origins,
    lodDistance,
    fadeMax,
  }
  let vertices = 0
  let triangles = 0
  let layers = 0
  // The merge runs in slices of about SLICE_MS with a task boundary between them, so loading a map's props never
  // blocks the main thread for long (0.47 s in one task on pl_vigil before). The result does not depend on it.
  let sliceStart = performance.now()
  const breathe = async () => {
    if (performance.now() - sliceStart < SLICE_MS) return
    await new Promise(resolve => setTimeout(resolve, 0))
    sliceStart = performance.now()
  }
  const rowSlots = origins.length * 2

  try {
    for (const group of groups) {
      const groupPieces = group.materials.flatMap((material, layer) =>
        byMaterial.get(material)!.map(piece => ({ piece, layer }))
      )
      let vertexCount = 0
      let indexCount = 0
      let colorSize = 0
      let hasUv = false
      for (const { piece } of groupPieces) {
        const src = sourceArrays(piece.mesh.geometry, cache)
        vertexCount += (src.position.length / 3) * piece.mesh.count
        indexCount += src.index.length * piece.mesh.count
        colorSize = Math.max(colorSize, src.colorSize)
        hasUv ||= !!src.uv
      }
      if (!vertexCount || !indexCount) continue
      // The index is written sorted by slot (row x 2 + level), with each slot's [start, count] and each row's
      // bounds for propLod (`dribbleLodLayout`), which then needs no sort of its own.
      const range = new Int32Array(rowSlots * 2)
      for (const { piece } of groupPieces) {
        const length = sourceArrays(piece.mesh.geometry, cache).index.length
        for (let i = 0; i < piece.mesh.count; i++) range[((piece.base + i) * 2 + piece.level) * 2 + 1] += length
      }
      for (let r = 0, start = 0; r < rowSlots; r++) {
        range[r * 2] = start
        start += range[r * 2 + 1]
      }
      const cursor = new Int32Array(rowSlots)
      for (let r = 0; r < rowSlots; r++) cursor[r] = range[r * 2]
      const box = new Float32Array(origins.length * 6)
      for (let r = 0; r < origins.length; r++) box.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], r * 6)
      const position = new Float32Array(vertexCount * 3)
      const normal = new Int8Array(vertexCount * 3)
      const color = colorSize ? new Float32Array(vertexCount * colorSize) : null
      const uv = hasUv ? new Float32Array(vertexCount * 2) : null
      const prop = new Uint16Array(vertexCount)
      const layerAttr = group.layers ? new Uint8Array(vertexCount) : null
      const index = new Uint32Array(indexCount)
      let vo = 0
      const p = new THREE.Vector3()
      const n = new THREE.Vector3()
      for (const { piece, layer } of groupPieces) {
        const { mesh } = piece
        const src = sourceArrays(mesh.geometry, cache)
        const count = src.position.length / 3
        meshMatrix.multiplyMatrices(rootInverse, mesh.matrixWorld)
        for (let i = 0; i < mesh.count; i++) {
          await breathe()
          mesh.getMatrixAt(i, instance)
          m.multiplyMatrices(meshMatrix, instance)
          nm.getNormalMatrix(m)
          if (mesh.instanceColor) mesh.getColorAt(i, tint)
          else tint.setRGB(1, 1, 1)
          const slot = 2 + (piece.base + i) * 2 + piece.level
          // Exact rows: albedo x their own light (the instance colour only scaled the flat fallback).
          const exact = piece.light && carrier ? carrier : null
          const albedo = piece.light?.albedo ?? [1, 1, 1]
          const lightStart = piece.light ? piece.light.start + i * piece.light.stride : 0
          for (let v = 0; v < count; v++) {
            const o = (vo + v) * 3
            p.fromArray(src.position, v * 3).applyMatrix4(m)
            position[o] = p.x
            position[o + 1] = p.y
            position[o + 2] = p.z
            const b = (piece.base + i) * 6
            if (p.x < box[b]) box[b] = p.x
            if (p.y < box[b + 1]) box[b + 1] = p.y
            if (p.z < box[b + 2]) box[b + 2] = p.z
            if (p.x > box[b + 3]) box[b + 3] = p.x
            if (p.y > box[b + 4]) box[b + 4] = p.y
            if (p.z > box[b + 5]) box[b + 5] = p.z
            if (src.normal) {
              n.fromArray(src.normal, v * 3).applyMatrix3(nm).normalize()
              normal[o] = Math.round(n.x * 127)
              normal[o + 1] = Math.round(n.y * 127)
              normal[o + 2] = Math.round(n.z * 127)
            }
            if (color) {
              const c = (vo + v) * colorSize
              const s = v * src.colorSize
              if (exact) {
                const e = (lightStart + v) * 3
                color[c] = albedo[0] * exact[e]
                color[c + 1] = albedo[1] * exact[e + 1]
                color[c + 2] = albedo[2] * exact[e + 2]
              } else {
                color[c] = (src.color ? src.color[s] : 1) * tint.r
                color[c + 1] = (src.color ? src.color[s + 1] : 1) * tint.g
                color[c + 2] = (src.color ? src.color[s + 2] : 1) * tint.b
              }
              if (colorSize > 3) color[c + 3] = src.color && src.colorSize > 3 ? src.color[s + 3] : 1
            }
            if (uv && src.uv) {
              uv[(vo + v) * 2] = src.uv[v * 2]
              uv[(vo + v) * 2 + 1] = src.uv[v * 2 + 1]
            }
            prop[vo + v] = slot
            if (layerAttr) layerAttr[vo + v] = layer
          }
          const at = cursor[slot - 2]
          for (let k = 0; k < src.index.length; k++) index[at + k] = src.index[k] + vo
          cursor[slot - 2] += src.index.length
          vo += count
        }
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3, true))
      // Colours are only read by the GPU: their CPU copy goes after the upload (positions, normals and UVs stay
      // for raycasts, the index and `_prop` for propLod, and the small layer array stays; see freeArray).
      if (color) geometry.setAttribute('color', new THREE.BufferAttribute(color, colorSize).onUpload(freeArray))
      if (uv) geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
      geometry.setAttribute('_prop', new THREE.BufferAttribute(prop, 1))
      if (layerAttr) geometry.setAttribute('dribbleLayer', new THREE.BufferAttribute(layerAttr, 1))
      geometry.setIndex(new THREE.BufferAttribute(index, 1))
      const mesh = new THREE.Mesh(geometry, group.materials[0])
      mesh.userData.dribbleLodLayout = { ranges: range, boxes: box } satisfies LodLayout
      mesh.name = group.layers ? `static_props_batch_array_${group.layers.length}` : `static_props_batch:${group.materials[0].name}`
      if (group.layers) {
        const texture = buildArrayTexture(group.layers)
        arrays.push(texture)
        layers += group.layers.length
        const scales = new Float32Array(MAX_LAYERS * 3)
        group.scales.forEach((scale, i) => scales.set(scale.slice(0, 3), i * 3))
        mesh.userData.dribbleArray = { texture, scales } satisfies ArrayInfo
      }
      batch.add(mesh)
      vertices += vertexCount
      triangles += indexCount / 3
    }
  } catch (error) {
    arrays.forEach(texture => texture.dispose())
    batch.traverse(node => (node as THREE.Mesh).geometry?.dispose())
    console.warn('[assets] runtime props bake failed; drawing the instanced nodes', error)
    return null
  }

  // The instanced meshes go; a node that was itself a mesh leaves a stub with its name and extras for the probes.
  const keep = new Set(groups.map(group => group.materials[0]))
  for (const { mesh } of pieces) {
    const parent = mesh.parent
    if (staticPropsInfo(mesh) && !(parent && staticPropsInfo(parent))) {
      const stub = new THREE.Object3D()
      stub.name = mesh.name
      stub.userData = mesh.userData
      stub.matrix.copy(mesh.matrix)
      stub.matrixAutoUpdate = false
      parent?.add(stub)
    }
    mesh.removeFromParent()
    mesh.geometry.dispose()
    mesh.dispose()
    const material = mesh.material as THREE.Material
    if (!keep.has(material)) material.dispose()
  }
  root.add(batch)
  batch.updateMatrixWorld(true)

  return {
    rows: origins.length,
    meshes: batch.children.length,
    arrays: arrays.length,
    layers,
    vertices,
    triangles,
    dispose() {
      arrays.forEach(texture => texture.dispose())
    },
  }
}

/**
 * Gives every merged mesh that has a texture array a copy of its current material that samples the array by the
 * vertex's layer and scales by that layer's colour scale (the material colour keeps map.brightness). Call it after
 * applyBspMaterials; `textured` false (flat or wireframe materials) leaves the meshes as they are.
 */
export function applyArrayMaterials(root: THREE.Object3D, textured: boolean, brightness: number): ArrayMaterials {
  const made = new Map<THREE.Material, THREE.MeshBasicMaterial>()
  if (textured) {
    root.traverse(node => {
      const mesh = node as THREE.Mesh
      const info = mesh.userData?.dribbleArray as ArrayInfo | undefined
      if (!mesh.isMesh || !info) return
      const base = mesh.material as THREE.MeshBasicMaterial
      if (!(base instanceof THREE.MeshBasicMaterial) || !base.map) return
      let material = made.get(base)
      if (!material) {
        material = base.clone()
        material.map = info.texture as unknown as THREE.Texture
        delete material.userData.dribbleColorScale
        material.color.setScalar(brightness)
        const scales = info.scales
        material.onBeforeCompile = shader => {
          shader.uniforms.dribbleScales = { value: scales }
          shader.vertexShader = shader.vertexShader
            .replace(
              '#include <common>',
              `#include <common>\nattribute float dribbleLayer;\nuniform vec3 dribbleScales[${MAX_LAYERS}];\nvarying float vDribbleLayer;\nvarying vec3 vDribbleScale;`
            )
            .replace(
              '#include <uv_vertex>',
              '#include <uv_vertex>\nvDribbleLayer = dribbleLayer;\nvDribbleScale = dribbleScales[int(dribbleLayer + 0.5)];'
            )
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <map_pars_fragment>',
              'uniform highp sampler2DArray map;\nvarying float vDribbleLayer;\nvarying vec3 vDribbleScale;'
            )
            .replace(
              '#include <map_fragment>',
              'vec4 sampledDiffuseColor = texture( map, vec3( vMapUv, vDribbleLayer ) );\ndiffuseColor *= sampledDiffuseColor;\ndiffuseColor.rgb *= vDribbleScale;'
            )
        }
        material.customProgramCacheKey = () => 'dribble-props-array'
        material.name = `${base.name}#array`
        made.set(base, material)
      }
      mesh.material = material
    })
  }
  return {
    count: made.size,
    dispose() {
      made.forEach(material => material.dispose())
      made.clear()
    },
  }
}
