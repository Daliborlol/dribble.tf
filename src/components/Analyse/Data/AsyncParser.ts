import { fetchMapConversion } from '@utils/mapAssets'

import { getMapBoundaries } from '../MapBoundaries'
import { PlayerCache, CachedPlayer } from './PlayerCache'
import { BuildingCache, CachedBuilding } from './BuildingCache'
import { ProjectileCache, CachedProjectile } from './ProjectileCache'
import { ChatEntry, Header, PlayerRef, Round, Vector, World } from './Types'
import { POSITION_FIXED_SCALE } from './PositionEncoding'

/**
 * Posted by the base worker when parser2's result is not used: it has no timeline (ticks <= 1 or no players, task
 * B1), or it starts DELAYED_START_FALLBACK_SECONDS or more after the 100-packet warmup (task B2, ParseWorker.ts
 * delayedStartOf; then `parser2` also says where it started and the world bounds it read).
 */
export interface ParserFallbackRequest {
  map: string
  trigger: 'no-timeline' | 'delayed-start'
  reason: string
  parser2: {
    ticks: number
    players: number
    parseMs: number
    startTick?: number
    startDemoTick?: number
    firstPacketTick?: number | null
    warmupEndTick?: number
    delaySeconds?: number
    world?: World
  }
}

/**
 * The fork's fallback cache builder replaced parser2 for this demo (`parsedDemo.parserFallbackInfo`). It starts
 * the cache at the end of the 100-packet warmup even when the demo's world bounds are still zero (tow_tetsudo's
 * plhud.nut uses them for HUD values) and then offsets positions by `bounds.boundaryMin`. Its output has
 * positionScale 32 instead of parser2's 1024 and no endTick, endDemoTick, shots or activeWeaponDef, which nothing
 * reads.
 */
export interface ParserFallbackInfo extends ParserFallbackRequest {
  /**
   * The map's bounds: its OVERWRITE_MAP_BOUNDARIES entry, else its conversion.json worldBounds, else (after a
   * delayed start) the world bounds parser2 read, the scene origin its result would have had.
   */
  bounds?: { boundaryMin: Vector; boundaryMax: Vector }
  boundsSource: 'override' | 'parser2' | 'conversion' | 'none'
  /** The cache started without world bounds (false when the demo's own bounds became ready). */
  startedWithoutWorld: boolean
  parseMs: number
}

/** What AsyncParser posts to the fresh base worker for the fallback parse. */
export type ParserFallbackWork = ParserFallbackRequest &
  Pick<ParserFallbackInfo, 'bounds' | 'boundsSource'>

const isZeroBounds = (w: World) =>
  [w.boundaryMin, w.boundaryMax].every(v => v.x === 0 && v.y === 0 && v.z === 0)

/** Bounds for the fallback parse; never rejects. */
async function resolveFallbackBounds(
  request: ParserFallbackRequest
): Promise<Pick<ParserFallbackInfo, 'bounds' | 'boundsSource'>> {
  const { map } = request
  // The override first: ParseWorker shifts positions to it anyway, so offsetting by it makes that shift zero
  const override = getMapBoundaries(map)
  if (override) {
    return {
      bounds: {
        boundaryMin: { ...override.boundaryMin },
        boundaryMax: { ...override.boundaryMax },
      },
      boundsSource: 'override',
    }
  }
  const worldBounds = (await fetchMapConversion(map).catch(() => null))?.worldBounds
  if (worldBounds?.boundaryMin && worldBounds?.boundaryMax) {
    return {
      bounds: {
        boundaryMin: { ...worldBounds.boundaryMin },
        boundaryMax: { ...worldBounds.boundaryMax },
      },
      boundsSource: 'conversion',
    }
  }
  // After a delayed start on a map without a converted folder: the bounds parser2 read (its scene origin)
  const parser2World = request.parser2.world
  if (parser2World && !isZeroBounds(parser2World)) {
    return {
      bounds: {
        boundaryMin: { ...parser2World.boundaryMin },
        boundaryMax: { ...parser2World.boundaryMax },
      },
      boundsSource: 'parser2',
    }
  }
  return { boundsSource: 'none' } // unknown map: positions stay in Source coordinates
}

export interface CachedDeath {
  tick: number
  victim: PlayerRef
  assister: PlayerRef | null
  killer: PlayerRef | null
  weapon: string
  victimTeam: number
  assisterTeam: number
  killerTeam: number
}

export interface ParserPerformanceStats {
  workerTotalMs: number
  parseMs: number
  hydrateMs: number
  transferMs: number
  playerCount: number
  projectileCount: number
  ticks: number
  playerCacheBytes: number
  projectileCacheBytes: number
  transferBytes: number
  totalBytes: number
}

export interface CachedDemo {
  header: Header
  playerCache: PlayerCache
  ticks: number
  startTick: number // server tick of cache tick 0
  startDemoTick: number
  tickBase: number // server tick = demo tick + tickBase
  positionScale: number
  chat: ChatEntry[]
  deaths: { [tick: string]: CachedDeath[] }
  rounds: Round[]
  buildingCache: BuildingCache
  projectileCache: ProjectileCache
  intervalPerTick: number
  world: World
  nextMappedPlayer: number
  entityPlayerMap: Map<number, PlayerRef>
  now: number
  perf?: ParserPerformanceStats
  fileBuffer?: ArrayBuffer // the input file, handed back by the worker
  parserFallback?: ParserFallbackInfo // set when the fallback parse replaced parser2
}

export class AsyncParser {
  buffer: ArrayBuffer
  header!: Header
  playerCache!: PlayerCache
  nextMappedPlayer = 0
  entityPlayerMap: Map<number, PlayerRef> = new Map()
  ticks!: number
  startTick = 0
  startDemoTick = 0
  tickBase = 0
  positionScale = POSITION_FIXED_SCALE
  chat: ChatEntry[] = []
  deaths: { [tick: string]: CachedDeath[] } = {}
  rounds!: Round[]
  buildingCache!: BuildingCache
  projectileCache!: ProjectileCache
  intervalPerTick!: number
  world!: World
  progressCallback: (progress: number) => void
  perf?: ParserPerformanceStats
  /** True when parser2 could not start this demo and the fork's fallback cache builder parsed it. */
  parserFallback = false
  parserFallbackInfo?: ParserFallbackInfo
  private fileBuffer?: ArrayBuffer
  private entityIndexMap?: Map<number, number>

  constructor(buffer: ArrayBuffer, progressCallback: (progress: number) => void) {
    this.buffer = buffer
    this.progressCallback = progressCallback
  }

  cache(): Promise<void> {
    return this.getCachedData().then((cachedData: CachedDemo) => {
      this.ticks = cachedData.ticks
      this.startTick = cachedData.startTick ?? 0
      this.startDemoTick = cachedData.startDemoTick ?? 0
      this.tickBase = cachedData.tickBase ?? 0
      this.positionScale = cachedData.positionScale ?? POSITION_FIXED_SCALE
      this.fileBuffer = cachedData.fileBuffer
      cachedData.fileBuffer = undefined
      this.header = cachedData.header
      this.playerCache = cachedData.playerCache
      this.buildingCache = cachedData.buildingCache
      this.projectileCache = cachedData.projectileCache
      this.chat = cachedData.chat
      this.deaths = cachedData.deaths
      this.rounds = cachedData.rounds
      this.intervalPerTick = cachedData.intervalPerTick
      this.world = cachedData.world
      this.nextMappedPlayer = cachedData.nextMappedPlayer
      this.entityPlayerMap = cachedData.entityPlayerMap
      this.entityIndexMap = undefined
      this.perf = cachedData.perf
      this.parserFallback = !!cachedData.parserFallback
      this.parserFallbackInfo = cachedData.parserFallback

      if (cachedData.perf) {
        const toMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        console.info('[Perf][ParserCache]', {
          ticks: cachedData.perf.ticks,
          players: cachedData.perf.playerCount,
          projectiles: cachedData.perf.projectileCount,
          memory: {
            total: toMb(cachedData.perf.totalBytes),
            playerCache: toMb(cachedData.perf.playerCacheBytes),
            projectileCache: toMb(cachedData.perf.projectileCacheBytes),
            transfer: toMb(cachedData.perf.transferBytes),
          },
          timings: {
            workerTotalMs: Math.round(cachedData.perf.workerTotalMs),
            parseMs: Math.round(cachedData.perf.parseMs),
            hydrateMs: Math.round(cachedData.perf.hydrateMs),
            transferMs: Math.round(cachedData.perf.transferMs),
          },
        })
      }
    })
  }

  getCachedData(): Promise<CachedDemo> {
    return new Promise((resolve, reject) => {
      // Runs once with parser2, and a second time with the fallback when parser2 hands the file back
      const run = (message: { buffer: ArrayBuffer; fallback?: ParserFallbackWork }) => {
        const worker = new Worker(new URL('./ParseWorker.ts', import.meta.url), { type: 'module' })
        worker.postMessage(message, [message.buffer])
        worker.onerror = (event: ErrorEvent) => {
          reject(event.message || 'Demo parser worker failed.')
          worker.terminate()
        }
        worker.onmessage = (event: MessageEvent) => {
          if (event.data.error) {
            reject(event.data.error)
            worker.terminate()
            return
          }
          if (event.data.fallbackRequest) {
            // parser2 produced no timeline or started it late. Its wasm heap is only freed with its worker (D18),
            // so the fallback parse runs in a fresh one, with the file the worker handed back.
            worker.terminate()
            const request = event.data.fallbackRequest as ParserFallbackRequest
            const buffer = event.data.fileBuffer as ArrayBuffer
            void resolveFallbackBounds(request).then(where => {
              console.warn(
                `[parser] ${request.reason} on ${request.map || 'this demo'}: parsing again with the fallback cache builder (${where.boundsSource} bounds)`
              )
              try {
                run({ buffer, fallback: { ...request, ...where } })
              } catch (error) {
                reject(error instanceof Error ? error.message : String(error))
              }
            })
            return
          }
          if (event.data.progress) {
            this.progressCallback(event.data.progress)
            return
          }
          const cachedData: CachedDemo = event.data
          PlayerCache.rehydrate(cachedData.playerCache)
          BuildingCache.rehydrate(cachedData.buildingCache)
          ProjectileCache.rehydrate(cachedData.projectileCache)

          // Compute transfer time (worker posted at cachedData.now)
          if (cachedData.perf) {
            cachedData.perf.transferMs = performance.now() - cachedData.now
          }

          resolve(event.data)
          // The wasm heap of the base parse is only freed with the worker (D18)
          worker.terminate()
        }
      }
      run({ buffer: this.buffer })
    })
  }

  /** The demo file the base worker handed back. Returns it once, then forgets it. */
  takeFileBuffer(): ArrayBuffer | undefined {
    const buffer = this.fileBuffer
    this.fileBuffer = undefined
    return buffer
  }

  /** Entity id of every player index p (0 for indices without a player), length nextMappedPlayer. */
  playerEntityIds(): Uint32Array {
    const ids = new Uint32Array(this.nextMappedPlayer)
    for (let p = 0; p < this.nextMappedPlayer; p++) {
      ids[p] = this.entityPlayerMap.get(p)?.user.entityId ?? 0
    }
    return ids
  }

  /** Player index p of an entity id, -1 when unknown. */
  playerIndexOfEntity(entityId: number): number {
    if (!this.entityIndexMap) {
      this.entityIndexMap = new Map()
      for (const [p, ref] of this.entityPlayerMap) {
        const entityId = ref.user.entityId
        if (!this.entityIndexMap.has(entityId)) this.entityIndexMap.set(entityId, p)
      }
    }
    return this.entityIndexMap.get(entityId) ?? -1
  }

  getPlayersAtTick(tick: number) {
    const players: CachedPlayer[] = []
    for (let i = 0; i < this.nextMappedPlayer; i++) {
      let entity = this.entityPlayerMap.get(i)
      if (entity) {
        players.push(this.playerCache.getPlayer(tick, i, entity.user as any))
      }
    }

    // fake teams in 1v1 ffa
    if (players.length === 2 && players[0].teamId === 0 && players[0].teamId === 0) {
      players[0].teamId = 2
      players[0].team = 'red'
      players[1].teamId = 3
      players[1].team = 'blue'
    }
    return players
  }

  getBuildingAtTick(tick: number): CachedBuilding[] {
    return this.buildingCache.getBuildings(tick)
  }

  getProjectilesAtTick(tick: number): CachedProjectile[] {
    return this.projectileCache.getProjectiles(tick)
  }
}
