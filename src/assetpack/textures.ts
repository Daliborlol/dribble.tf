// Pack texture binding (asset contract 4.6 and 12.3). Textures are shared, reference-counted per key and owned
// by this module; materials stay owned by their object. DDSLoader loads through dynamic import(), so a page
// without a pack runs none of the loader code. The module-level cache holds textures only, never a demo, an
// extras object or a store snapshot (Highlander contract 12.3).
//
// A texture item (12.3, written by scripts/assets/maps/stage.mjs): `file` is textures/<key>.dds for DXT data,
// else textures/<key>.webp; `webp` names the WebP sidecar, which the manifest also lists as item `<key>@webp`
// when `file` is the DDS (the builder lists pack files by item.file only).

import * as THREE from 'three'
import type { Material, Object3D, Texture, WebGLRenderer } from 'three'

import { loadPackItem, releaseAssetItem } from './items'
import { assetPackFile, getAssetPackState } from './pack'
import type { AssetPackManifestItem } from './types'

export type PackTextureFormat = 'dds' | 'webp' | null

/** `material.userData.dribble.texture`, written by the converters (contract 12.3). */
export interface PackTextureRecord {
  key: string
  /** UV set: 0 = TEXCOORD_0, 1 = TEXCOORD_1. */
  uv: number
  skins?: string[]
  /** VMT alpha rule (2.6); the item's alpha when absent. */
  alpha?: 'opaque' | 'test' | 'blend'
  cutoff?: number
  /** The opacity the flat material drew with (world translucent kinds without a VMT alpha). */
  flatAlpha?: number
  /** Pack props (M3-props2): base colour = 1 / flat albedo, over vertex colours that hold albedo x light. */
  colorScale?: number[]
  /** Pack props: the flat vertex alpha that the texture's alpha replaces. */
  vertexAlpha?: number
  /** WorldVertexTransition: the second base texture, blended by the vertex attribute. */
  blend?: { key: string; attribute: string }
  /**
   * $detail (as/mapfx): the detail texture, its UV scale, blend factor and mode (0 mod2x, 1 additive, 7 mod2x,
   * 8 multiply), and for $seamless_detail the world-space triplanar scale.
   */
  detail?: { key: string; scale: number; factor: number; mode: number; seamless?: number }
}

export interface PackTextureItem extends AssetPackManifestItem {
  kind: 'texture'
  webp?: string | null
  srgb?: boolean
  oneBitAlpha?: boolean
  alpha?: 'opaque' | 'test' | 'blend'
  alphaCutoff?: number
  width?: number
  height?: number
  mips?: number
}

const formats = new WeakMap<WebGLRenderer, PackTextureFormat>()
let activeFormat: PackTextureFormat = null

/** The format the page's renderer picked (null before the first texture load). */
export const activePackTextureFormat = (): PackTextureFormat => activeFormat
let warnedFormat = false

/** ?assetsTex=webp forces the WebP sidecars (to test the fallback on a desktop GPU). */
const forcedFormat = (): PackTextureFormat | undefined => {
  try {
    const value = new URLSearchParams(window.location.search).get('assetsTex')
    return value === 'webp' || value === 'dds' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * DDS needs both S3TC extensions, because three resolves sRGB S3TC formats to null without the sRGB one
 * (contract 3.6); else WebP. Cached per renderer.
 */
export function packTextureFormat(renderer: WebGLRenderer): PackTextureFormat {
  const cached = formats.get(renderer)
  if (cached !== undefined) return cached
  const forced = forcedFormat()
  const ext = renderer.extensions
  const s3tc = ext.has('WEBGL_compressed_texture_s3tc') && ext.has('WEBGL_compressed_texture_s3tc_srgb')
  const format: PackTextureFormat = forced ?? (s3tc ? 'dds' : 'webp')
  if (!s3tc && !forced && !warnedFormat) {
    warnedFormat = true
    console.info('[assets] no S3TC sRGB support; using the WebP texture sidecars')
  }
  formats.set(renderer, format)
  activeFormat = format
  return format
}

export const getPackTextureItem = (key: string): PackTextureItem | null => {
  const item = getAssetPackState().manifest?.items?.[key]
  return item && item.kind === 'texture' ? (item as PackTextureItem) : null
}

interface Entry {
  count: number
  promise: Promise<Texture | null>
  texture: Texture | null
  variants: Map<number, Texture>
  disposed: boolean
}

const entries = new Map<string, Entry>()

let ddsLoader: Promise<import('three/examples/jsm/loaders/DDSLoader.js').DDSLoader> | null = null
const getDdsLoader = () => {
  if (!ddsLoader) {
    ddsLoader = import('three/examples/jsm/loaders/DDSLoader.js').then(({ DDSLoader }) => new DDSLoader())
    ddsLoader.catch(() => {
      ddsLoader = null
    })
  }
  return ddsLoader
}

function finishTexture(texture: Texture, item: PackTextureItem, renderer: WebGLRenderer) {
  texture.flipY = false
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = item.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  texture.userData.dribblePack = true
  texture.needsUpdate = true
}

async function loadDds(url: string, item: PackTextureItem, renderer: WebGLRenderer): Promise<Texture> {
  const loader = await getDdsLoader()
  const texture = (await loader.loadAsync(url)) as THREE.CompressedTexture
  // DDSLoader maps every DXT1 to the RGB format and drops the 1-bit alpha (contract 4.6).
  if (item.oneBitAlpha && texture.format === THREE.RGB_S3TC_DXT1_Format)
    texture.format = THREE.RGBA_S3TC_DXT1_Format
  texture.generateMipmaps = false
  texture.minFilter = texture.mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  finishTexture(texture, item, renderer)
  return texture
}

async function loadWebp(url: string, item: PackTextureItem, renderer: WebGLRenderer): Promise<Texture> {
  const texture = await new THREE.TextureLoader().loadAsync(url)
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  finishTexture(texture, item, renderer)
  return texture
}

function startLoad(key: string, renderer: WebGLRenderer): Promise<Texture | null> {
  const item = getPackTextureItem(key)
  if (!item) return Promise.resolve(null)
  const format = packTextureFormat(renderer)
  if (format === 'dds' && item.file.endsWith('.dds'))
    return loadPackItem(key, url => loadDds(url, item, renderer))
  if (format && item.file.endsWith('.webp')) return loadPackItem(key, url => loadWebp(url, item, renderer))
  if (format && item.webp && getPackTextureItem(`${key}@webp`))
    return loadPackItem(`${key}@webp`, url => loadWebp(url, item, renderer))
  const webpUrl = format && item.webp ? assetPackFile(item.webp) : null
  if (webpUrl) return loadPackItem(key, () => loadWebp(webpUrl, item, renderer))
  return Promise.resolve(null)
}

function disposeEntry(entry: Entry) {
  entry.disposed = true
  entry.variants.forEach(texture => texture.dispose())
  entry.variants.clear()
  entry.texture?.dispose()
  entry.texture = null
}

/**
 * Reference-counted per key; never rejects. Null means absent, unsupported or failed (loadPackItem warned once
 * and marked the item failed; it is never retried).
 */
export function acquirePackTexture(key: string, renderer: WebGLRenderer): Promise<Texture | null> {
  let entry = entries.get(key)
  if (!entry) {
    const created: Entry = { count: 0, texture: null, variants: new Map(), disposed: false, promise: null! }
    created.promise = startLoad(key, renderer)
      .then(texture => {
        if (created.disposed) {
          texture?.dispose()
          return null
        }
        created.texture = texture
        return texture
      })
      .catch(() => null)
    entries.set(key, created)
    entry = created
  }
  entry.count++
  return entry.promise
}

export function releasePackTexture(key: string): void {
  const entry = entries.get(key)
  if (!entry) return
  entry.count--
  if (entry.count > 0) return
  entries.delete(key)
  disposeEntry(entry)
  releaseAssetItem(key)
  releaseAssetItem(`${key}@webp`)
}

/**
 * The shared texture for UV set `channel`: the texture itself, or a clone that shares its source (one GPU
 * upload) when another material reads it from another UV set. Clones are disposed with the key.
 */
export function packTextureForChannel(texture: Texture, channel: number): Texture {
  if (texture.channel === channel) return texture
  for (const entry of entries.values()) {
    if (entry.texture !== texture) continue
    let variant = entry.variants.get(channel)
    if (!variant) {
      variant = texture.clone()
      variant.channel = channel
      variant.userData = { ...texture.userData }
      variant.needsUpdate = true
      entry.variants.set(channel, variant)
    }
    return variant
  }
  return texture
}

/** The alpha rule of contract 2.6 on a material that now draws `item`'s texture. */
export function applyPackTextureAlpha(
  material: Material,
  record: PackTextureRecord,
  item: PackTextureItem | null,
  translucentByName = false
): void {
  const alpha = record.alpha ?? item?.alpha ?? 'opaque'
  if (alpha === 'test') {
    material.alphaTest = record.cutoff || item?.alphaCutoff || 0.5
    material.transparent = false
    material.depthWrite = true
    material.opacity = 1
  } else if (alpha === 'blend') {
    material.alphaTest = 0
    material.transparent = true
    material.depthWrite = false
    material.opacity = 1
  } else if (translucentByName) {
    // The flat material was translucent by the converter's name rules, not by the VMT: keep its opacity.
    material.transparent = true
    material.depthWrite = false
    material.opacity = record.flatAlpha ?? 0.5
  } else {
    material.alphaTest = 0
    material.transparent = false
    material.depthWrite = true
    material.opacity = 1
  }
}

export interface PackTextureBinding {
  bound: number
  failed: number
  release(): void
}

/**
 * Binds the pack textures of every mesh material under `root` that carries `userData.dribble.texture`: `map`,
 * `colorSpace` (on the texture), `channel` and the alpha rule; `needsUpdate`. Resolves once every texture loaded
 * or failed; a failed one leaves that material as it was. The caller then runs warmUpObject (4.3) and only then
 * shows the object; `release()` releases every key this call acquired.
 */
export async function bindPackTextures(
  root: Object3D,
  renderer: WebGLRenderer,
  opts: { skin?: number } = {}
): Promise<PackTextureBinding> {
  const jobs: { material: THREE.MeshBasicMaterial; record: PackTextureRecord; key: string }[] = []
  const seen = new Set<Material>()
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      if (!material || seen.has(material)) continue
      seen.add(material)
      const record = material.userData?.dribble?.texture as PackTextureRecord | undefined
      if (!record?.key) continue
      const key = (record.skins?.[opts.skin ?? 0] ?? record.key).toLowerCase()
      jobs.push({ material: material as THREE.MeshBasicMaterial, record, key })
    }
  })
  const keys = jobs.map(job => job.key)
  const textures = await Promise.all(keys.map(key => acquirePackTexture(key, renderer)))
  let bound = 0
  let failed = 0
  jobs.forEach((job, i) => {
    const texture = textures[i]
    if (!texture) {
      failed++
      return
    }
    job.material.map = packTextureForChannel(texture, job.record.uv ?? 0)
    // The flat albedo the converter left as the base colour gives way to the texture.
    if (job.material.color) job.material.color.setRGB(1, 1, 1)
    applyPackTextureAlpha(job.material, job.record, getPackTextureItem(job.key))
    job.material.needsUpdate = true
    bound++
  })
  let released = false
  return {
    bound,
    failed,
    release() {
      if (released) return
      released = true
      keys.forEach(releasePackTexture)
    },
  }
}

/** Probe rows: the keys currently held, with their reference counts and load state. */
export function heldPackTextures(): { key: string; count: number; loaded: boolean }[] {
  return Array.from(entries, ([key, entry]) => ({ key, count: entry.count, loaded: !!entry.texture }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * GPU bytes of a texture item (contract 12.6): DDS as stored without its 128-byte header, WebP as
 * width x height x 4 x 4/3.
 */
export function packTextureGpuBytes(item: PackTextureItem, format: PackTextureFormat = 'dds'): number {
  if (format === 'dds' && item.file.endsWith('.dds')) return Math.max(0, (item.bytes ?? 0) - 128)
  const w = (item.webpWidth as number | undefined) ?? item.width ?? 0
  const h = (item.webpHeight as number | undefined) ?? item.height ?? 0
  return Math.round(w * h * 4 * (4 / 3))
}

export interface PackWorldInfo {
  folder: string
  /** 'pack': the textured pack world is drawn; 'fallback': it was wanted but a file failed, the public one is drawn. */
  source: 'pack' | 'fallback'
  textures: number
  bound: number
  failed: number
}

let packWorld: PackWorldInfo | null = null

/** World records which world it drew for the probe assets.textures (null: no pack world was wanted). */
export function setPackWorldInfo(
  folder: string,
  source: PackWorldInfo['source'] | null,
  counts: { textures: number; bound: number; failed: number } = { textures: 0, bound: 0, failed: 0 }
): void {
  packWorld = source ? { folder, source, ...counts } : null
}

export const getPackWorldInfo = (): PackWorldInfo | null => packWorld
