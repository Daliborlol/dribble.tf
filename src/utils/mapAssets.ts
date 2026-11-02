// Map asset lookup shared by World.tsx, Lights.tsx, the scene actions and the Highlander map code
// (contract section 4.5 item 1). One conversion.json fetch per map folder, cached as a promise.

import type { Vector } from '@components/Analyse/Data/Types'
import { MAP_NAME_SEARCH_MAP } from '@constants/mappings'

import { getAsset } from './misc'

export interface MapConversion {
  pipeline?: 'bsp-to-glb' | string
  worldBounds?: { boundaryMin: Vector; boundaryMax: Vector }
  /** props: props.glb of the PAK static props (task M2, contract section 4.8). */
  files?: { model?: string; lightmap?: string; visibility?: string; meta?: string; props?: string }
  lightmap?: {
    file: string
    width: number
    height: number
    range: number
    colorSpace: 'srgb'
    uvChannel: number
  }
  lightEnvironment?: unknown
  fog?: { enabled: boolean; color: number[]; start: number; end: number } | null
  skyboxName?: string
  camera?: { rtsCenter: Vector; cameraOffset: Vector }
  /** Static prop instances: rendered from the PAK, stock (not rendered, D7), stock and solid (task M2). */
  props?: { pak: number; stock: number; stockSolid: number }
}

const SEARCH_KEYS = Object.keys(MAP_NAME_SEARCH_MAP).sort((a, b) => b.length - a.length)

/**
 * Folder in public/models/maps for a demo map name: the longest MAP_NAME_SEARCH_MAP key that prefixes
 * the name (koth_product_rc8 -> koth_product_final), else the longest key it contains (workshop paths),
 * else undefined (no converted geometry).
 */
export function getMapFolder(map: string): string | undefined {
  if (!map) return undefined
  const name = map.toLowerCase()
  const key = SEARCH_KEYS.find(k => name.startsWith(k)) ?? SEARCH_KEYS.find(k => name.includes(k))
  return key ? MAP_NAME_SEARCH_MAP[key] : undefined
}

/** URL of a file inside the map's folder, undefined without a folder. */
export function getMapFileUrl(map: string, file: string): string | undefined {
  const folder = getMapFolder(map)
  return folder ? getAsset(`/models/maps/${folder}/${file}`) : undefined
}

/**
 * GET a JSON file. Resolves null when the file is definitely absent: a non-ok status, or a body that is
 * not JSON (`npm run dev`, `vite preview` and the Netlify rewrite answer a missing file with index.html
 * and status 200). Rejects only when the request itself fails (a network error), which callers do not
 * cache, so the next call retries.
 */
export async function fetchJsonFile(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) return null
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const conversions = new Map<string, Promise<MapConversion | null>>()

/**
 * conversion.json of the map's folder; null when the map has no folder, the file is absent or the request failed
 * (isCachedMapConversion tells the last two apart).
 */
export function fetchMapConversion(map: string): Promise<MapConversion | null> {
  const folder = getMapFolder(map)
  if (!folder) return Promise.resolve(null)

  let pending = conversions.get(folder)
  if (!pending) {
    const request: Promise<MapConversion | null> = fetchJsonFile(
      getAsset(`/models/maps/${folder}/conversion.json`)
    )
      .then(json => (json && typeof json === 'object' ? (json as MapConversion) : null))
      .catch(error => {
        // Only a failed request lands here, and it may be temporary: forget it so the next call retries.
        if (conversions.get(folder) === request) conversions.delete(folder)
        console.warn(`conversion.json for ${folder} unavailable`, error)
        return null
      })
    conversions.set(folder, request)
    pending = request
  }
  return pending
}

/**
 * True while `request`, a promise fetchMapConversion(map) returned, is still the folder's cached answer: a null it
 * resolved to then means conversion.json is definitely absent. False after a failed request, which
 * fetchMapConversion drops from the cache so that the next call retries.
 */
export function isCachedMapConversion(map: string, request: Promise<MapConversion | null>): boolean {
  const folder = getMapFolder(map)
  return !!folder && conversions.get(folder) === request
}

/** The bsp-to-glb pipeline loads files.model (world.glb); older maps load textured_compressed.glb. */
export function getMapModelUrl(map: string, conv: MapConversion | null): string | undefined {
  if (conv?.pipeline === 'bsp-to-glb') return getMapFileUrl(map, conv.files?.model ?? 'world.glb')
  return getMapFileUrl(map, 'textured_compressed.glb')
}

/**
 * mapName and props of a public conversion.json, which an asset pack map entry must match before its files are
 * used (asset contract 3.5). Null without a conversion.
 */
export function publicMapIdentity(
  conv: MapConversion | null
): { mapName: string | null; props: Record<string, unknown> | null } | null {
  if (!conv) return null
  const raw = conv as MapConversion & { mapName?: unknown }
  return {
    mapName: typeof raw.mapName === 'string' ? raw.mapName : null,
    props: conv.props && typeof conv.props === 'object' ? (conv.props as unknown as Record<string, unknown>) : null,
  }
}
