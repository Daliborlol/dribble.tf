import init, { parse_demo_cache_with_progress } from '../../../libs/parser2/parser2.js'
// The fork's cache builder (same crate as the Highlander extras). Only the fallback below loads its wasm.
import initFallback, { parse_demo_cache_fallback } from '../../../libs/hlextras/hlextras.js'
import type {
  CachedDemo,
  ParserFallbackInfo,
  ParserFallbackRequest,
  ParserPerformanceStats,
  ParseWorkerRequest,
} from './AsyncParser'
import { PlayerCache } from './PlayerCache'
import { BuildingCache } from './BuildingCache'
import { ProjectileCache } from './ProjectileCache'
import { getMapBoundaries } from '../MapBoundaries'
import { ChatEntry, PlayerRef } from './Types'
import { POSITION_FIXED_SCALE } from './PositionEncoding'

declare function postMessage(message: any, transfer?: any[]): void

// Messages in (ParseWorkerRequest): { buffer } parses with parser2; { buffer, fallback: ParserFallbackWork } parses
// with the fork's fallback export; { buffer, lateStart: true } parses with parser2 and keeps a late start. Messages
// out: { progress }, { error }, the CachedDemo, or, when parser2 produced no timeline or started it late
// (delayedStartOf), { fallbackRequest: ParserFallbackRequest, fileBuffer }: AsyncParser then ends this worker (its
// parser2 heap cannot shrink) and posts the file to a fresh one with the map's bounds. When that fallback parse fails
// after a delayed start, parser2's late timeline is still worth showing, so the worker hands the file back with
// { fallbackFailed: { error }, fileBuffer } instead of { error }, and AsyncParser parses it again with { lateStart }.

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

/** Both cache builders start after this many warmup packets with players (lib.rs parse_demo_cache_internal). */
export const WARMUP_PACKETS = 100

/**
 * A parser2 start at least this many seconds after the warmup end goes to the fallback (task B2). Survey of the 133
 * local demos (scripts/hl/parser2-survey.mjs --parser2): parser2 starts exactly at the warmup end on all 131 demos
 * it starts normally (delay 0 ticks); 1428628 (tow_tetsudo) starts 55.2 s after it. Below a few seconds the second
 * parse (as long as parser2's own, 0.6 to 5 s) costs more than the lost seconds are worth.
 */
export const DELAYED_START_FALLBACK_SECONDS = 5

// SDK public/demofile/demoformat.h: demoheader_t (1072 bytes, "HL2DEMO", DEMO_PROTOCOL 3), then frames of
// `cmd u8, tick i32`; dem_signon and dem_packet carry democmdinfo_t (76 bytes) and two sequence numbers.
const DEMO_HEADER_BYTES = 1072
const DEMO_PROTOCOL = 3
const MESSAGE_META_BYTES = 84

/**
 * Frame scan of a demo file (header 1072 bytes, then frames of `type u8, tick i32` plus a type-specific body; the
 * same walk as scripts/hl/lib/demo-frames.mjs). Returns the tick of the first Message frame and of the
 * WARMUP_PACKETS-th frame: the warmup end, where the cache builders start when the players exist from the first
 * frame (they do on every local demo): demo tick 94 at 66 Hz, 188 on the 33 Hz 6v6 sample. A tick is null when the
 * file has no such Message frame or is not an HL2DEMO file of demo protocol 3. Reads only frame headers.
 */
export function demoWarmup(bytes: Uint8Array): { firstPacketTick: number | null; warmupEndTick: number | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = bytes.byteLength
  let firstPacketTick: number | null = null
  const stamp = String.fromCharCode(...bytes.subarray(0, 8))
  if (size < DEMO_HEADER_BYTES || stamp !== 'HL2DEMO\0' || view.getInt32(8, true) !== DEMO_PROTOCOL) {
    return { firstPacketTick, warmupEndTick: null }
  }
  let offset = DEMO_HEADER_BYTES
  for (let frame = 1; offset + 5 <= size; frame++) {
    const type = view.getUint8(offset)
    if (type === 7) break // Stop
    const tick = view.getInt32(offset + 1, true)
    let next: number
    if (type === 1 || type === 2) {
      if (offset + 5 + MESSAGE_META_BYTES + 4 > size) break
      next = offset + 5 + MESSAGE_META_BYTES + 4 + view.getUint32(offset + 5 + MESSAGE_META_BYTES, true)
    } else if (type === 3) next = offset + 5
    else if (type === 4 || type === 6 || type === 8) {
      if (offset + 9 > size) break
      next = offset + 9 + view.getUint32(offset + 5, true)
    } else if (type === 5) {
      if (offset + 13 > size) break
      next = offset + 13 + view.getUint32(offset + 9, true)
    } else break // not a demo frame
    if (next > size) break // a cut frame: the parsers stop before it
    if (type === 2 && firstPacketTick === null) firstPacketTick = tick
    if (frame === WARMUP_PACKETS) return { firstPacketTick, warmupEndTick: type === 2 ? tick : null }
    offset = next
  }
  return { firstPacketTick, warmupEndTick: null }
}

export interface DelayedStart {
  firstPacketTick: number | null
  warmupEndTick: number
  startDemoTick: number
  /** Seconds between the warmup end and parser2's start: the part of the demo the fallback recovers. */
  delaySeconds: number
}

/**
 * parser2 starts only once the world bounds are non-zero. tow_tetsudo's plhud.nut uses them for HUD values, and on
 * 1428628 they arrive 55.2 s after the warmup. parser2 then skips that part of the demo and, because it sizes its
 * timeline from its own start by the header's tick count, leaves an equally long tail without positions. The fork's
 * fallback export starts at the warmup end. Returns the delay when it reaches DELAYED_START_FALLBACK_SECONDS.
 */
export function delayedStartOf(
  result: Pick<WasmResult, 'startDemoTick' | 'intervalPerTick'>,
  bytes: Uint8Array
): DelayedStart | null {
  const { startDemoTick, intervalPerTick } = result
  if (!Number.isFinite(startDemoTick) || !(intervalPerTick > 0)) return null
  const { firstPacketTick, warmupEndTick } = demoWarmup(bytes)
  if (warmupEndTick === null) return null
  const delaySeconds = (startDemoTick - warmupEndTick) * intervalPerTick
  if (!(delaySeconds >= DELAYED_START_FALLBACK_SECONDS)) return null
  return { firstPacketTick, warmupEndTick, startDemoTick, delaySeconds }
}

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
  const input = event.data as ParseWorkerRequest
  const buffer = input.buffer
  const fallback = input.fallback
  // After a delayed start parser2's timeline exists, only late: when the fallback fails, hand the file back so that
  // AsyncParser can load that timeline instead of failing the whole load. Both parsers copy the file into their wasm
  // heap, so `buffer` is intact here unless a transfer already took it (byteLength 0).
  const fail = (message: string) => {
    if (fallback?.trigger === 'delayed-start' && buffer?.byteLength > 0) {
      postMessage({ fallbackFailed: { error: message }, fileBuffer: buffer }, [buffer])
    } else {
      postMessage({ error: message })
    }
  }
  try {
    await (fallback ? ensureFallbackWasm() : ensureWasm())

    const parseStart = performance.now()
    // Both builders reach 100 at the end of their parse (parser2 reports nothing before that when its cache never
    // starts). Hold that 100 back until the result is the one this load keeps, so a demo that is parsed again does
    // not show 100 % first.
    let reached100 = false
    const onProgress = (progress: number) => {
      if (progress >= 100) {
        reached100 = true
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
      fail(result || 'Failed to parse demo.')
      return
    }

    if (!fallback && !hasTimeline(result as WasmResult)) {
      const empty = result as WasmResult
      const players = empty.players?.length ?? 0
      const request: ParserFallbackRequest = {
        map: empty.header?.map ?? '',
        trigger: 'no-timeline',
        reason: `parser2 produced ${empty.ticks} tick${empty.ticks === 1 ? '' : 's'} and ${players} players`,
        parser2: { ticks: empty.ticks, players, parseMs: Math.round(parseMs) },
      }
      postMessage({ fallbackRequest: request, fileBuffer: buffer }, [buffer])
      return
    }
    const delayed =
      fallback || input.lateStart ? null : delayedStartOf(result as WasmResult, new Uint8Array(buffer))
    if (delayed) {
      // parser2's output (heap and typed arrays) goes with this worker; the fallback recovers the skipped seconds
      const late = result as WasmResult
      const firstPacket =
        delayed.firstPacketTick === null
          ? ''
          : `, ${((delayed.startDemoTick - delayed.firstPacketTick) * late.intervalPerTick).toFixed(1)} s after the first packet`
      const request: ParserFallbackRequest = {
        map: late.header?.map ?? '',
        trigger: 'delayed-start',
        reason: `parser2 started at demo tick ${delayed.startDemoTick}, ${delayed.delaySeconds.toFixed(1)} s after its warmup ended at demo tick ${delayed.warmupEndTick}${firstPacket}`,
        parser2: {
          ticks: late.ticks,
          players: late.players.length,
          parseMs: Math.round(parseMs),
          startTick: late.startTick,
          startDemoTick: late.startDemoTick,
          firstPacketTick: delayed.firstPacketTick,
          warmupEndTick: delayed.warmupEndTick,
          delaySeconds: +delayed.delaySeconds.toFixed(2),
          world: { boundaryMin: { ...late.world.boundaryMin }, boundaryMax: { ...late.world.boundaryMax } },
        },
      }
      postMessage({ fallbackRequest: request, fileBuffer: buffer }, [buffer])
      return
    }
    if (fallback && !hasTimeline(result as WasmResult)) {
      const empty = result as WasmResult
      const counts = `${empty.ticks} tick(s) and ${empty.players?.length ?? 0} players`
      if (fallback.trigger === 'delayed-start') {
        fail(`the fallback cache builder produced ${counts}`) // parser2's late timeline is better than nothing
        return
      }
      // Fewer than 100 packets with players: neither parser can start this demo, so it loads empty as before
      console.warn(`fallback parser: ${counts} as well`)
    }
    if (reached100) postMessage({ progress: 100 })

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
    fail(message)
  }
}
