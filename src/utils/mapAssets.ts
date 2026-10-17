// Map asset lookup shared by World.tsx, Lights.tsx, the scene actions and the Highlander map code
// (contract section 4.5 item 1). One conversion.json fetch per map folder, cached as a promise.

import type { Vector } from '@components/Analyse/Data/Types'
import { MAP_NAME_SEARCH_MAP } from '@constants/mappings'

import { getAsset } from './misc'

export interface MapConversion {
  pipeline?: 'bsp-to-glb' | string
  worldBounds?: { boundaryMin: Vector; boundaryMax: Vector }
  files?: { model?: string; lightmap?: string; visibility?: string; meta?: string }
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

const conversions = new Map<string, Promise<MapConversion | null>>()

/** conversion.json of the map's folder; null when the map has no folder or the file is absent. */
export function fetchMapConversion(map: string): Promise<MapConversion | null> {
  const folder = getMapFolder(map)
  if (!folder) return Promise.resolve(null)

  let pending = conversions.get(folder)
  if (!pending) {
    pending = fetch(getAsset(`/models/maps/${folder}/conversion.json`))
      .then(response => (response.ok ? (response.json() as Promise<MapConversion>) : null))
      .then(conversion => (conversion && typeof conversion === 'object' ? conversion : null))
      .catch(error => {
        // A network failure may be temporary: do not cache it.
        conversions.delete(folder)
        console.warn(`conversion.json for ${folder} unavailable`, error)
        return null
      })
    conversions.set(folder, pending)
  }
  return pending
}

/** The bsp-to-glb pipeline loads files.model (world.glb); older maps load textured_compressed.glb. */
export function getMapModelUrl(map: string, conv: MapConversion | null): string | undefined {
  if (conv?.pipeline === 'bsp-to-glb') return getMapFileUrl(map, conv.files?.model ?? 'world.glb')
  return getMapFileUrl(map, 'textured_compressed.glb')
}
