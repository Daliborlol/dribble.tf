// Texture binding for pack objects (asset contract 4.6 and 12.3). W-pack wrote this file because M3-world's
// src/assetpack/textures.ts was not on `assets` when W-pack started (contract 12.2). It has exactly the 12.3
// exports; the integrator who merges the second of the two turns it into `export * from './textures'`.
//
// Textures are shared and owned by this module (reference-counted per key, disposed at zero). Materials stay
// owned by their object. Nothing here holds a demo, an extras object or a store snapshot.

import {
  LinearFilter,
  Material,
  Object3D,
  RepeatWrapping,
  RGBA_S3TC_DXT1_Format,
  RGB_S3TC_DXT1_Format,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  WebGLRenderer,
} from 'three'

import { releaseAssetItem, loadPackItem } from './items'
import { getAssetPackState } from './pack'

export type PackTextureFormat = 'dds' | 'webp' | null

interface TextureItem {
  kind: 'texture'
  file: string | null
  webp?: string | null
  srgb?: boolean
  oneBitAlpha?: boolean
  alpha?: 'opaque' | 'test' | 'blend'
  alphaCutoff?: number | null
  mips?: number
}

const formats = new WeakMap<WebGLRenderer, PackTextureFormat>()

/** 'dds' when the renderer has S3TC, else 'webp' (contract 3.6); cached per renderer. */
export function packTextureFormat(renderer: WebGLRenderer): PackTextureFormat {
  let format = formats.get(renderer)
  if (format === undefined) {
    const s3tc = !!renderer?.extensions?.has?.('WEBGL_compressed_texture_s3tc')
    format = s3tc ? 'dds' : 'webp'
    formats.set(renderer, format)
  }
  return format
}

const textureItem = (key: string): TextureItem | null => {
  const item = getAssetPackState().manifest?.items?.[key] as TextureItem | undefined
  return item && item.kind === 'texture' ? item : null
}

type DdsLoaderCtor = new () => { loadAsync(url: string): Promise<Texture> }
let ddsLoader: Promise<DdsLoaderCtor> | null = null
const loadDdsLoader = () => {
  if (!ddsLoader) {
    ddsLoader = import('three/examples/jsm/loaders/DDSLoader.js').then(m => m.DDSLoader as unknown as DdsLoaderCtor)
    ddsLoader.catch(() => {
      ddsLoader = null
    })
  }
  return ddsLoader
}

const isDds = (path: string | null | undefined) => !!path && path.endsWith('.dds')

async function loadTexture(key: string, item: TextureItem, format: PackTextureFormat): Promise<Texture | null> {
  const base = getAssetPackState().url
  const dds = format === 'dds' && isDds(item.file) ? item.file : null
  const webp = item.webp ?? (item.file && !isDds(item.file) ? item.file : null)
  if (!base || (!dds && !webp)) return null
  return loadPackItem(key, async () => {
    let texture: Texture
    if (dds) {
      const Loader = await loadDdsLoader()
      texture = await new Loader().loadAsync(base + dds)
      // DDSLoader maps every DXT1 to the RGB format; one-bit alpha needs the RGBA one (contract 4.6).
      if (item.oneBitAlpha && texture.format === RGB_S3TC_DXT1_Format) texture.format = RGBA_S3TC_DXT1_Format
      if ((item.mips ?? 1) <= 1) texture.minFilter = LinearFilter
    } else {
      texture = await new TextureLoader().loadAsync(base + webp)
    }
    texture.flipY = false
    texture.wrapS = texture.wrapT = RepeatWrapping
    if (item.srgb !== false) texture.colorSpace = SRGBColorSpace
    texture.anisotropy = 4
    texture.name = key
    texture.needsUpdate = true
    return texture
  })
}

interface Entry {
  refs: number
  promise: Promise<Texture | null>
  texture: Texture | null
}

const cache = new Map<string, Entry>()
const warned = new Set<string>()

/** Reference-counted per key; never rejects. null = absent, unsupported or failed. */
export function acquirePackTexture(key: string, renderer: WebGLRenderer): Promise<Texture | null> {
  let entry = cache.get(key)
  if (!entry) {
    const item = textureItem(key)
    const format = packTextureFormat(renderer)
    const created: Entry = { refs: 0, texture: null, promise: Promise.resolve(null) }
    created.promise = (item ? loadTexture(key, item, format) : Promise.resolve(null))
      .catch(() => null)
      .then(texture => {
        if (!texture && item && !warned.has(key) && format !== 'dds' && !item.webp && isDds(item.file)) {
          warned.add(key)
          console.warn(`[assets] ${key}: no WebP and no S3TC support; using the flat albedo`)
        }
        if (cache.get(key) !== created || created.refs <= 0) {
          // Released while loading.
          texture?.dispose()
          return null
        }
        created.texture = texture
        return texture
      })
    entry = created
    cache.set(key, entry)
  }
  entry.refs++
  return entry.promise
}

export function releasePackTexture(key: string): void {
  const entry = cache.get(key)
  if (!entry) return
  entry.refs--
  if (entry.refs > 0) return
  cache.delete(key)
  if (entry.texture) {
    entry.texture.dispose()
    entry.texture = null
  }
  releaseAssetItem(key)
}

export interface PackTextureBinding {
  bound: number
  failed: number
  release(): void
}

interface TextureRef {
  key: string
  uv?: number
  skins?: string[]
}

/**
 * Binds the sidecar textures of every material under `root` that carries `userData.dribble.texture`
 * (skin `opts.skin` picks `skins[skin]`). A failed texture keeps the material's flat albedo. Resolves once
 * every texture loaded or failed; the caller then warms the object up and only then shows it.
 */
export async function bindPackTextures(
  root: Object3D,
  renderer: WebGLRenderer,
  opts?: { skin?: number }
): Promise<PackTextureBinding> {
  const skin = opts?.skin ?? 0
  const materials = new Set<Material>()
  root.traverse(node => {
    const material = (node as any).material as Material | Material[] | undefined
    if (Array.isArray(material)) material.forEach(m => m && materials.add(m))
    else if (material) materials.add(material)
  })
  const acquired: string[] = []
  let bound = 0
  let failed = 0
  await Promise.all(
    Array.from(materials).map(async material => {
      const ref = (material.userData?.dribble?.texture ?? null) as TextureRef | null
      if (!ref || typeof ref.key !== 'string') return
      const key = (ref.skins?.[skin] ?? ref.key).toLowerCase()
      acquired.push(key)
      const texture = await acquirePackTexture(key, renderer)
      if (!texture) {
        failed++
        return
      }
      const item = textureItem(key)
      const m = material as any
      m.map = texture
      if (m.color) m.color.setRGB(1, 1, 1)
      if (typeof ref.uv === 'number') texture.channel = ref.uv
      if (item?.alpha === 'test') {
        m.alphaTest = item.alphaCutoff ?? 0.5
      } else if (item?.alpha === 'blend') {
        m.transparent = true
        m.depthWrite = false
      }
      m.needsUpdate = true
      bound++
    })
  )
  let released = false
  return {
    bound,
    failed,
    release: () => {
      if (released) return
      released = true
      for (const key of acquired) releasePackTexture(key)
    },
  }
}
