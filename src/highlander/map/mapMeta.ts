// map-meta.json v1 (contract section 4.4; owner M1, read by F5 and F6).
// The type follows maps.md section 6 and the 11 files scripts/convert-bsp.mjs writes (koth_product_final
// gets only this file, from `--only-meta true`). All positions are raw Source units, Z up;
// scene = Source - sceneOrigin, where sceneOrigin is the demo's boundaryMin after ParseWorker applied any
// OVERWRITE_MAP_BOUNDARIES shift (koth_product_final, tow_tetsudo_b10c), i.e. parsedDemo.world.boundaryMin.

import { useEffect, useState } from 'react'
import * as THREE from 'three'

import { fetchJsonFile, fetchMapConversion, getMapFileUrl, getMapFolder } from '@utils/mapAssets'

type Vec3 = [number, number, number]
type XYZ = { x: number; y: number; z: number }

export interface MapMetaBrushRef {
  bspModelIndex: number | null
  node: string | null
  mins: Vec3
  maxs: Vec3
}
export interface MapMetaSpawn {
  team: number
  origin: Vec3
  yaw: number
  name?: string
  controlPoint?: string
  disabled?: boolean
  roundRed?: string
  roundBlue?: string
}
export interface MapMetaControlPoint {
  name: string
  index: number
  printName: string
  origin: Vec3
  defaultOwner: number
  startLocked: boolean
  group: number
  hidden: boolean
  captureAreas: number[]
}
export interface MapMetaCaptureArea extends MapMetaBrushRef {
  name: string | null
  capPoint: string
  timeToCap: number
  canCap: Record<string, boolean>
  numCappers: Record<string, number> // keyed by team "2" / "3"
  parent: string | null
  startDisabled: boolean
}
export interface MapMetaKoth {
  timerLength: number
  unlockPoint: number
}
export interface MapMetaRoundTimer {
  name: string
  timerLength: number
  setupLength: number
  maxLength: number | null
  startPaused: boolean
  showInHud: boolean
}
export interface MapMetaPathNode {
  name: string
  origin: Vec3
  distance: number
  next: string | null
  alt?: string
  speed?: number
  flags?: number
}
export interface MapMetaPayload {
  watcher: string
  team: number
  train: string
  startNode: string
  goalNode: string
  canRecede: boolean
  path: MapMetaPathNode[] // `distance` is cumulative along the path
  length: number
  linked: { pathTrack: string; controlPoint: string; pathIndex: number; distance: number }[]
  cart: {
    origin: Vec3
    brush: MapMetaBrushRef | null
    models: string[]
    attached: { classname: string; name: string | null }[]
  } | null
}
export interface MapMetaDoor extends MapMetaBrushRef {
  name: string
  classname: string
  origin: Vec3
  moveDir: Vec3
  lip: number
  speed: number
  spawnflags: number
  props: string[]
}
export interface MapMetaRespawnRoom extends MapMetaBrushRef {
  name: string
  team: number
}
export interface MapMetaRespawnVisualizer extends MapMetaBrushRef {
  room: string
  team: number
  solidToEnemies: boolean
}
export interface MapMetaResupply extends MapMetaBrushRef {
  team: number
  locker: string
}
export interface MapMetaItem {
  kind: 'health' | 'ammo'
  size: 'small' | 'medium' | 'full'
  origin: Vec3
  team?: number
  disabled?: boolean
}
export interface MapMetaTeleport extends MapMetaBrushRef {
  name: string | null
  team?: number
  destination: Vec3
}
export interface MapMetaGameplayProp {
  model: string
  name?: string
  parent?: string
  origin: Vec3
  angles: Vec3
  skin?: number
}
export interface MapMetaLightColor {
  color: number[]
  brightness: number
}
export interface MapMetaLight {
  environment: {
    sun: MapMetaLightColor
    sunHDR: MapMetaLightColor
    ambient: MapMetaLightColor
    ambientHDR: MapMetaLightColor
    pitch: number
    yaw: number
    sunSpreadAngle: number
    direction: Vec3 // sunlight travel direction
  } | null
  shadow: { direction: Vec3; color: number[]; distance: number } | null
  sunSprite: { direction: Vec3; color: number[]; size: number } | null
}

export interface MapMeta {
  schema: 'dribble.map-meta'
  version: 1
  map: string
  gameMode:
    | 'koth'
    | 'payload'
    | 'payload-race'
    | 'tug-of-war'
    | 'attack-defend'
    | 'control-points'
    | 'unknown'
  bspVersion: number
  coordinateSpace: 'source'
  sceneTransform: string
  worldBounds: { boundaryMin: XYZ; boundaryMax: XYZ }
  camera: {
    rtsCenter: XYZ
    cameraOffset: XYZ
    focusSource: Vec3
    method: string
    /**
     * The converter's line-of-sight search: clear false means every candidate was blocked and the
     * camera looks almost straight down. focusShift is the distance in units between the objective
     * focus and the framed point (the focus slides along the objective when it is enclosed).
     */
    occlusion?: {
      clear: boolean
      elevationDeg: number
      quarterTurns?: number
      azimuthDeg?: number
      distance?: number
      focusShift?: number
    }
  } | null
  spawns: MapMetaSpawn[]
  controlPoints: MapMetaControlPoint[]
  captureAreas: MapMetaCaptureArea[]
  koth: MapMetaKoth | null
  roundTimers: MapMetaRoundTimer[]
  payload: MapMetaPayload[]
  doors: MapMetaDoor[]
  respawnRooms: MapMetaRespawnRoom[]
  respawnVisualizers: MapMetaRespawnVisualizer[]
  resupply: MapMetaResupply[]
  items: MapMetaItem[]
  teleports: MapMetaTeleport[]
  gameplayProps: MapMetaGameplayProp[]
  light: MapMetaLight | null
  sky: { name: string; camera: { origin: Vec3; scale: number } | null } | null
  fog: {
    enabled: boolean
    color: number[]
    start: number
    end: number
    maxDensity: number
    farZ: number
  } | null
  water: { material: string; triangles: number; mins: Vec3; maxs: Vec3; surfaceZ: number }[]
}

const pending = new Map<string, Promise<MapMeta | null>>()
const resolved = new Map<string, MapMeta | null>()

const isMapMeta = (value: unknown): value is MapMeta =>
  !!value &&
  typeof value === 'object' &&
  (value as MapMeta).schema === 'dribble.map-meta' &&
  (value as MapMeta).version === 1

/** fetchMapMeta's marker for "conversion.json could not be read": resolve null without caching it. */
const NO_CONVERSION = Symbol('no conversion.json')

/**
 * Cached per folder; null when the map has no folder or no map-meta.json. Only a folder whose conversion.json
 * lists `files.meta` is requested (X1): the bsp-to-glb maps and koth_product_final list it, the other textured
 * folders (the 6v6 sample's cp_snakewater_final1 and the rest) do not, so they never send a request that would
 * 404. A missing file, a body that is not JSON (the dev server and the Netlify rewrite answer a missing file with
 * index.html and 200) and a schema mismatch are cached as null, like a loaded file. A failed request, and a
 * conversion.json that could not be read, are not cached: they resolve null, getLoadedMapMeta() stays undefined
 * and the next call retries.
 */
export function fetchMapMeta(map: string): Promise<MapMeta | null> {
  const folder = getMapFolder(map)
  if (!folder) return Promise.resolve(null)

  let request = pending.get(folder)
  if (!request) {
    const created: Promise<MapMeta | null> = fetchMapConversion(map)
      .then(conversion => {
        if (!conversion) return NO_CONVERSION
        const file = conversion.files?.meta
        const url = file ? getMapFileUrl(map, file) : undefined
        return url ? fetchJsonFile(url) : null
      })
      .then(json => {
        if (json === NO_CONVERSION) {
          if (pending.get(folder) === created) pending.delete(folder)
          return null
        }
        const meta = isMapMeta(json) ? json : null
        if (pending.get(folder) === created) resolved.set(folder, meta)
        return meta
      })
      .catch(error => {
        if (pending.get(folder) === created) pending.delete(folder)
        console.warn(`map-meta.json for ${folder} unavailable`, error)
        return null
      })
    pending.set(folder, created)
    request = created
  }
  return request
}

/**
 * The map-meta once fetchMapMeta has resolved for this map's folder: MapMeta, or null when the map has
 * none; undefined before that (not requested yet, in flight, or the request failed). A sync read for
 * useFrame code; useMapMeta() starts the fetch, so do not call fetchMapMeta() per frame.
 */
export function getLoadedMapMeta(map: string): MapMeta | null | undefined {
  const folder = getMapFolder(map)
  return folder ? resolved.get(folder) : null
}

/** Hook; null while loading and for maps without map-meta.json. */
export function useMapMeta(map: string): MapMeta | null {
  const [state, setState] = useState<{ map: string; meta: MapMeta | null }>(() => ({
    map,
    meta: getLoadedMapMeta(map) ?? null,
  }))

  useEffect(() => {
    let cancelled = false
    const apply = (meta: MapMeta | null) =>
      setState(prev => (prev.map === map && prev.meta === meta ? prev : { map, meta }))
    const cached = getLoadedMapMeta(map)
    if (cached !== undefined) apply(cached)
    else
      fetchMapMeta(map).then(meta => {
        if (!cancelled) apply(meta)
      })
    return () => {
      cancelled = true
    }
  }, [map])

  return state.map === map ? state.meta : (getLoadedMapMeta(map) ?? null)
}

/** Raw Source position to scene space (scene = Source - sceneOrigin). */
export function sourceToScene(
  p: [number, number, number],
  sceneOrigin: { x: number; y: number; z: number }
): THREE.Vector3 {
  return new THREE.Vector3(p[0] - sceneOrigin.x, p[1] - sceneOrigin.y, p[2] - sceneOrigin.z)
}
