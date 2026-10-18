import init, { parse_demo_cache_with_progress } from '../../../libs/parser2/parser2.js'
// The fork's cache builder (same crate as the Highlander extras). Only the fallback below loads its wasm.
import initFallback, { parse_demo_cache_fallback } from '../../../libs/hlextras/hlextras.js'
import type {
  CachedDemo,
  ParserFallbackInfo,
  ParserFallbackRequest,
  ParserFallbackWork,
  ParserPerformanceStats,
} from './AsyncParser'
import { PlayerCache } from './PlayerCache'
import { BuildingCache } from './BuildingCache'
import { ProjectileCache } from './ProjectileCache'
import { getMapBoundaries } from '../MapBoundaries'
import { ChatEntry, PlayerRef } from './Types'
import { POSITION_FIXED_SCALE } from './PositionEncoding'

declare function postMessage(message: any, transfer?: any[]): void

// Messages in: { buffer } parses with parser2; { buffer, fallback: ParserFallbackWork } parses with the fork's
// fallback export. Messages out: { progress }, { error }, the CachedDemo, or, when parser2 produced no timeline,
// { fallbackRequest: ParserFallbackRequest, fileBuffer }: AsyncParser then ends this worker (its parser2 heap
// cannot shrink) and posts the file to a fresh one with the map's bounds.

type WasmPlayerCache = {
  position: Uint32Array[]
  viewAngles: Uint32Array[]
  health: Uint16Array[]
  meta: Uint8Array[]
  connected: Uint8Array[]
  uber: Uint16Array[]
  healTarget: Uint16Array[]
  duck?: Uint8Array[]
}

type WasmProjectileCache = {
  ids: number[]
  position: Uint32Array[]
  rotation: Uint32Array[]
  team: Uint8Array[]
  type: Uint8Array[]
}

type WasmPlayer = {
  id: number
  entityId: number
  userId: number
  steamId: string
  name: string
  team: string
}

// parser2 and the fork's fallback export share this shape. Only parser2 writes endTick, endDemoTick, shots and
// playerCache.activeWeaponDef (nothing reads them); only the fallback writes startedWithoutWorld.
type WasmResult = {
  header: CachedDemo['header']
  ticks: number
  startTick: number
  startDemoTick: number
  tickBase: number
  endTick?: number
  endDemoTick?: number
  intervalPerTick: number
  positionScale?: number
  angleScale?: number
  world: CachedDemo['world']
  players: WasmPlayer[]
  playerCache: WasmPlayerCache
  projectileCache: WasmProjectileCache
  chat: ChatEntry[]
  deaths: CachedDemo['deaths']
  rounds: CachedDemo['rounds']
  startedWithoutWorld?: boolean
}

let wasmReady: Promise<unknown> | null = null

const ensureWasm = () => {
  if (!wasmReady) {
    wasmReady = init()
  }
  return wasmReady
}

let fallbackWasmReady: Promise<unknown> | null = null

const ensureFallbackWasm = () => {
  if (!fallbackWasmReady) {
    fallbackWasmReady = initFallback()
  }
  return fallbackWasmReady
}

/**
 * parser2 starts its cache only after 100 warmup packets with non-zero world bounds. tow_tetsudo's plhud.nut writes
 * HUD values into m_WorldMins/m_WorldMaxs, and on some demos (1429417) they stay zero, so parser2 returns one tick
 * and no players. Such a result has no timeline to play.
 */
const hasTimeline = (result: WasmResult) => result.ticks > 1 && (result.players?.length ?? 0) > 0

const shiftVectorCache = (
  arrays: Uint32Array[],
  deltaXFixed: number,
  deltaYFixed: number,
  deltaZFixed: number
) => {
  if (deltaXFixed === 0 && deltaYFixed === 0 && deltaZFixed === 0) return

  for (const array of arrays) {
    for (let i = 0; i < array.length; i += 3) {
      const x = array[i]
      const y = array[i + 1]
      const z = array[i + 2]
      if ((x | y | z) === 0) continue
      array[i] = x + deltaXFixed
      array[i + 1] = y + deltaYFixed
      array[i + 2] = z + deltaZFixed
    }
  }
}

const pushBuffers = (target: ArrayBufferLike[], arrays: ArrayBufferView[]) => {
  for (const arr of arrays) {
    // A buffer listed twice makes postMessage throw (DataCloneError)
    if (!target.includes(arr.buffer)) target.push(arr.buffer)
  }
}

const sumBytes = (arrays: ArrayBufferView[]) => {
  let total = 0
  for (const arr of arrays) total += arr.byteLength
  return total
}

/**
 * @global postMessage
 * @param event
 */
onmessage = async (event: MessageEvent) => {
  try {
    const buffer = event.data.buffer as ArrayBuffer
    const fallback = event.data.fallback as ParserFallbackWork | undefined
    await (fallback ? ensureFallbackWasm() : ensureWasm())

    const parseStart = performance.now()
    // parser2 reaches 100 at the end of its parse (and reports nothing before that when its cache never starts). Hold
    // that 100 back until the result has a timeline, so a demo that falls back does not show 100 % and start again.
    let parser2Done = false
    const onProgress = (progress: number) => {
      if (!fallback && progress >= 100) {
        parser2Done = true
        return
      }
      postMessage({ progress })
    }

    // Both copy the file into their wasm heap, so `buffer` stays intact for the hand-back below
    const result = fallback
      ? parse_demo_cache_fallback(new Uint8Array(buffer), { ...fallback.bounds }, onProgress)
      : parse_demo_cache_with_progress(new Uint8Array(buffer), onProgress)

    const parseMs = performance.now() - parseStart

    if (typeof result === 'string' || !result) {
      postMessage({ error: result || 'Failed to parse demo.' })
      return
    }

    if (!fallback && !hasTimeline(result as WasmResult)) {
      const empty = result as WasmResult
      const players = empty.players?.length ?? 0
      const request: ParserFallbackRequest = {
        map: empty.header?.map ?? '',
        reason: `parser2 produced ${empty.ticks} tick${empty.ticks === 1 ? '' : 's'} and ${players} players`,
        parser2: { ticks: empty.ticks, players, parseMs: Math.round(parseMs) },
      }
      postMessage({ fallbackRequest: request, fileBuffer: buffer }, [buffer])
      return
    }
    if (parser2Done) postMessage({ progress: 100 })
    if (fallback && !hasTimeline(result as WasmResult)) {
      // Fewer than 100 packets with players: neither parser can start this demo, so it loads empty as before
      const empty = result as WasmResult
      console.warn(`fallback parser: ${empty.ticks} tick(s) and ${empty.players?.length ?? 0} players as well`)
    }

    const hydrateStart = performance.now()

    const {
      header,
      ticks,
      startTick = 0,
      startDemoTick = 0,
      tickBase = 0,
      positionScale = POSITION_FIXED_SCALE,
      angleScale = 1,
      intervalPerTick,
      world,
      players,
      playerCache: wasmPlayerCache,
      projectileCache: wasmProjectileCache,
      chat = [],
      deaths,
      rounds,
      startedWithoutWorld = false,
    } = result as WasmResult

    // Hydrate player cache with WASM typed arrays
    const playerCache = new PlayerCache(ticks, world.boundaryMin)
    playerCache.positionCache.data = wasmPlayerCache.position
    playerCache.positionCache.scale =
      Number.isFinite(positionScale) && positionScale > 0
        ? positionScale
        : POSITION_FIXED_SCALE
    playerCache.viewAnglesCache.data = wasmPlayerCache.viewAngles
    playerCache.viewAnglesCache.scale = Number.isFinite(angleScale) ? angleScale : 1
    playerCache.healthCache.data = wasmPlayerCache.health as any
    playerCache.metaCache.data = wasmPlayerCache.meta as any
    playerCache.connectedCache.data = wasmPlayerCache.connected as any
    playerCache.uberCache.data = wasmPlayerCache.uber as any
    playerCache.healTargetCache.data = wasmPlayerCache.healTarget as any
    if (wasmPlayerCache.duck) playerCache.duckCache.data = wasmPlayerCache.duck as any

    // Empty building cache (WASM parser does not output building data)
    const buildingCache = new BuildingCache(ticks, world.boundaryMin)

    // Hydrate projectile cache with WASM typed arrays
    const projectileCache = new ProjectileCache(ticks, world.boundaryMin)
    projectileCache.positionCache.data = wasmProjectileCache.position as any
    projectileCache.positionCache.scale =
      Number.isFinite(positionScale) && positionScale > 0
        ? positionScale
        : POSITION_FIXED_SCALE
    projectileCache.rotationCache.data = wasmProjectileCache.rotation as any
    projectileCache.rotationCache.scale = Number.isFinite(angleScale) ? angleScale : 1
    projectileCache.teamNumberCache.data = wasmProjectileCache.team as any
    projectileCache.typeCache.data = wasmProjectileCache.type as any
    projectileCache.setProjectileIds(wasmProjectileCache.ids)

    // Apply map boundary override and shift position data
    const boundaryOverride = getMapBoundaries(header.map)
    if (boundaryOverride) {
      const deltaX = Math.trunc(world.boundaryMin.x - boundaryOverride.boundaryMin.x)
      const deltaY = Math.trunc(world.boundaryMin.y - boundaryOverride.boundaryMin.y)
      const deltaZ = Math.trunc(world.boundaryMin.z - boundaryOverride.boundaryMin.z)
      const posScale = Number.isFinite(positionScale) ? positionScale : POSITION_FIXED_SCALE
      const deltaXFixed = Math.trunc(deltaX * posScale)
      const deltaYFixed = Math.trunc(deltaY * posScale)
      const deltaZFixed = Math.trunc(deltaZ * posScale)

      shiftVectorCache(
        playerCache.positionCache.data as Uint32Array[],
        deltaXFixed,
        deltaYFixed,
        deltaZFixed
      )
      shiftVectorCache(
        projectileCache.positionCache.data as Uint32Array[],
        deltaXFixed,
        deltaYFixed,
        deltaZFixed
      )

      world.boundaryMin = boundaryOverride.boundaryMin
      world.boundaryMax = boundaryOverride.boundaryMax
    }

    // Build entity player map from WASM player list
    const entityPlayerMap = new Map<number, PlayerRef>()
    let nextMappedPlayer = 0

    for (const player of players) {
      entityPlayerMap.set(player.id, {
        user: {
          name: player.name,
          userId: player.userId,
          steamId: player.steamId,
          entityId: player.entityId,
          team: player.team as PlayerRef['user']['team'],
        },
      })
      if (player.id + 1 > nextMappedPlayer) {
        nextMappedPlayer = player.id + 1
      }
    }

    const hydrateMs = performance.now() - hydrateStart
    const workerTotalMs = performance.now() - parseStart

    // Compute memory stats
    const playerCacheBytes =
      sumBytes(playerCache.positionCache.data) +
      sumBytes(playerCache.viewAnglesCache.data) +
      sumBytes(playerCache.healthCache.data) +
      sumBytes(playerCache.metaCache.data) +
      sumBytes(playerCache.connectedCache.data) +
      sumBytes(playerCache.uberCache.data) +
      sumBytes(playerCache.healTargetCache.data) +
      sumBytes(playerCache.duckCache.data)
    const projectileCacheBytes =
      sumBytes(projectileCache.positionCache.data) +
      sumBytes(projectileCache.rotationCache.data) +
      sumBytes(projectileCache.teamNumberCache.data) +
      sumBytes(projectileCache.typeCache.data)
    const transferBytes = playerCacheBytes + projectileCacheBytes

    const perf: ParserPerformanceStats = {
      workerTotalMs,
      parseMs,
      hydrateMs,
      transferMs: 0, // Filled in by AsyncParser after message transfer
      playerCount: players.length,
      projectileCount: wasmProjectileCache.ids.length,
      ticks,
      playerCacheBytes,
      projectileCacheBytes,
      transferBytes,
      totalBytes: playerCacheBytes + projectileCacheBytes,
    }

    console.log(
      `${fallback ? 'fallback parser' : 'parser2'}: parse=${parseMs.toFixed(1)}ms hydrate=${hydrateMs.toFixed(1)}ms total=${workerTotalMs.toFixed(1)}ms`
    )

    const parserFallback: ParserFallbackInfo | undefined = fallback
      ? { ...fallback, startedWithoutWorld, parseMs: Math.round(parseMs) }
      : undefined

    const cachedDemo: CachedDemo = {
      ticks,
      startTick,
      startDemoTick,
      tickBase,
      positionScale: playerCache.positionCache.scale,
      header,
      playerCache,
      buildingCache,
      projectileCache,
      chat,
      deaths,
      rounds,
      intervalPerTick,
      world,
      nextMappedPlayer,
      entityPlayerMap,
      now: performance.now(),
      perf,
      // wasm-bindgen copied the file into the wasm heap, so hand the buffer back (no copy on the main thread)
      fileBuffer: buffer,
      ...(parserFallback ? { parserFallback } : {}),
    }

    // Collect typed array buffers for zero-copy transfer
    const transfers: ArrayBufferLike[] = []
    pushBuffers(transfers, playerCache.positionCache.data)
    pushBuffers(transfers, playerCache.viewAnglesCache.data)
    pushBuffers(transfers, playerCache.healthCache.data)
    pushBuffers(transfers, playerCache.metaCache.data)
    pushBuffers(transfers, playerCache.connectedCache.data)
    pushBuffers(transfers, playerCache.uberCache.data)
    pushBuffers(transfers, playerCache.healTargetCache.data)
    pushBuffers(transfers, playerCache.duckCache.data)
    pushBuffers(transfers, projectileCache.positionCache.data)
    pushBuffers(transfers, projectileCache.rotationCache.data)
    pushBuffers(transfers, projectileCache.teamNumberCache.data)
    pushBuffers(transfers, projectileCache.typeCache.data)
    if (!transfers.includes(buffer)) transfers.push(buffer)

    postMessage(cachedDemo, transfers)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(error)
    postMessage({ error: message })
  }
}
