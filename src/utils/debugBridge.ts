//
// ─── DEBUG BRIDGE ───────────────────────────────────────────────────────────────
//
// A small automation surface for headless validation (screenshots, seeking, camera
// control). It is installed as `window.__dribble` only when the page URL carries
// `?debug=1` (or `?debug=true`), or when running under the Vite dev server. In a normal
// production page load it does nothing.
//
// Tick semantics: `goToTick(T)` sets the *playback* tick. DemoViewer renders cache tick
// `max(1, T - 2)` (INTERP_DELAY_TICKS), which is what `renderTick` in getState() reports.
//
// Everything returned from the bridge is plain JSON so it can cross page.evaluate().
//

import { dispatch, getState as getStoreState, useInstance, useStore } from '@zus/store'
import {
  changeControlsModeAction,
  changePlaySpeedAction,
  goToTickAction,
  jumpToPlayerPOVCamera,
  jumpToRtsCamera,
  jumpToSpectatorCamera,
  updateSettingsOptionAction,
} from '@zus/actions'
import { CLASS_MAP } from '@constants/mappings'
import { ControlsMode, SavedSetupCamera } from '@constants/types'
import { listHlProbes, runHlProbe } from '@highlander/debug'
import { findTicks, FindKind } from '@highlander/extras/findTicks'
import type { InstanceState } from '@zus/store'

const INTERP_DELAY_TICKS = 2

export interface DebugBridgePlayer {
  index: number
  entityId: number
  userId: number
  steamId: string
  name: string
  team: string
  teamId: number
  classId: number
  className: string
  health: number
  alive: boolean
  connected: boolean
}

export interface DebugBridgeState {
  ready: boolean
  parser: { status: string; progress: number; error?: string }
  demo: null | {
    map: string
    ticks: number
    intervalPerTick: number
    playerCount: number
    deathCount: number
    roundCount: number
    chatCount: number
  }
  playback: {
    tick: number
    renderTick: number
    maxTicks: number
    playing: boolean
    speed: number
    intervalPerTick: number
  }
  scene: {
    map: string
    controlsMode: string
    focusedEntityId: number | null
    lastFocusedEntityId: number | null
    mapLoaded: boolean
    actorCount: number
  }
  perf: {
    renderCalls: number
    renderTriangles: number
    visibleChunkCount: number
    currentCluster: number | null
  }
  downloads: { name: string; type: string; status: string; progress: number }[]
}

const CLASS_NAMES = new Set(Object.values(CLASS_MAP).filter(name => name !== 'empty'))

const nextFrames = (count = 1) =>
  new Promise<void>(resolve => {
    let remaining = Math.max(1, Math.floor(count))
    const step = () => {
      remaining -= 1
      if (remaining <= 0) resolve()
      else requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })

const getRenderTick = () => Math.max(1, getStoreState().playback.tick - INTERP_DELAY_TICKS)

const countActors = () => {
  let count = 0
  useInstance.getState().threeScene?.traverse(child => {
    if (child.name === 'actor') count += 1
  })
  return count
}

// True once the world group holds at least one mesh (an empty placeholder GLB has none).
const isMapLoaded = () => {
  const world = useInstance.getState().threeScene?.getObjectByName('world')
  return !!world?.getObjectByProperty('type', 'Mesh')
}

const listPlayers = (tick?: number): DebugBridgePlayer[] => {
  const demo = useInstance.getState().parsedDemo
  if (!demo) return []

  const atTick = Math.max(1, Math.floor(tick ?? getRenderTick()))
  return demo.getPlayersAtTick(atTick).map((player, index) => ({
    index,
    entityId: player.user.entityId,
    userId: player.user.userId,
    steamId: player.user.steamId,
    name: player.user.name,
    team: player.team,
    teamId: player.teamId,
    classId: player.classId,
    className: CLASS_MAP[player.classId] ?? 'unknown',
    health: player.health,
    alive: player.health > 0,
    connected: !!player.connected,
  }))
}

/**
 * Resolve a player by entity id (number or numeric string), by class (`sniper`,
 * `sniper@blue`, `class:sniper:red`), or by name (exact match first, then substring;
 * case-insensitive). Only connected RED/BLU players at the current render tick count.
 */
const resolvePlayer = (query: number | string): DebugBridgePlayer | null => {
  const players = listPlayers().filter(p => p.connected && (p.teamId === 2 || p.teamId === 3))

  if (typeof query === 'number' || /^\d+$/.test(String(query).trim())) {
    const entityId = Number(query)
    return players.find(p => p.entityId === entityId) ?? null
  }

  const text = String(query).trim().toLowerCase()
  const classMatch = text.match(/^(?:class:)?([a-z]+)(?:[@:](red|blue|blu))?$/)
  if (classMatch && CLASS_NAMES.has(classMatch[1])) {
    const team = classMatch[2] === 'blu' ? 'blue' : classMatch[2]
    const candidates = players.filter(
      p => p.className === classMatch[1] && (!team || p.team === team)
    )
    return candidates.find(p => p.alive) ?? candidates[0] ?? null
  }

  return (
    players.find(p => p.name.toLowerCase() === text) ??
    players.find(p => p.name.toLowerCase().includes(text)) ??
    null
  )
}

const getBridgeState = (): DebugBridgeState => {
  const store = getStoreState()
  const instance = useInstance.getState()
  const demo = instance.parsedDemo
  const parserError = store.parser.error as unknown

  return {
    ready:
      !!demo &&
      store.parser.status === 'done' &&
      store.scene.map === demo.header?.map &&
      isMapLoaded(),
    parser: {
      status: store.parser.status,
      progress: store.parser.progress,
      ...(parserError ? { error: String(parserError) } : {}),
    },
    demo: demo
      ? {
          map: demo.header?.map,
          ticks: demo.ticks,
          intervalPerTick: demo.intervalPerTick,
          playerCount: demo.entityPlayerMap?.size ?? 0,
          deathCount: Object.values(demo.deaths ?? {}).reduce((sum, list) => sum + list.length, 0),
          roundCount: demo.rounds?.length ?? 0,
          chatCount: demo.chat?.length ?? 0,
        }
      : null,
    playback: {
      tick: store.playback.tick,
      renderTick: getRenderTick(),
      maxTicks: store.playback.maxTicks,
      playing: store.playback.playing,
      speed: store.playback.speed,
      intervalPerTick: store.playback.intervalPerTick,
    },
    scene: {
      map: store.scene.map,
      controlsMode: store.scene.controls.mode,
      focusedEntityId: instance.focusedObject?.userData?.entityId ?? null,
      lastFocusedEntityId: instance.lastFocusedPOV?.userData?.entityId ?? null,
      mapLoaded: isMapLoaded(),
      actorCount: countActors(),
    },
    perf: { ...instance.runtimePerf },
    downloads: Array.from(store.downloads.values()).map(({ name, type, status, progress }) => ({
      name,
      type,
      status,
      progress,
    })),
  }
}

// ─── HIGHLANDER ──────────────────────────────────────────────────────────────────

type ExtrasStatus = InstanceState['extrasStatus']
const TERMINAL_EXTRAS_STATUSES: ExtrasStatus[] = ['ready', 'error', 'disabled']

const hlStatus = () => {
  const { extrasStatus, extrasProgress, extrasError, extras } = useInstance.getState()
  let meta: Record<string, unknown> | null = null
  if (extras) {
    // convars can be thousands of entries; hl.probe can still reach them
    const { convars: _convars, ...rest } = extras.meta
    meta = rest
  }
  return { status: extrasStatus, progress: extrasProgress, error: extrasError ?? null, meta }
}

/** Resolves with the extras status once it is 'ready', 'error' or 'disabled' (or the current one at the timeout). */
const hlWaitReady = (timeoutMs = 90000): Promise<ExtrasStatus> =>
  new Promise(resolve => {
    const current = useInstance.getState().extrasStatus
    if (TERMINAL_EXTRAS_STATUSES.includes(current)) {
      resolve(current)
      return
    }
    let unsubscribe = () => {}
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(useInstance.getState().extrasStatus)
    }, timeoutMs)
    unsubscribe = useInstance.subscribe(state => {
      if (!TERMINAL_EXTRAS_STATUSES.includes(state.extrasStatus)) return
      clearTimeout(timer)
      unsubscribe()
      resolve(state.extrasStatus)
    })
  })

/**
 * An RTS camera spec (for setCamera or a plan step's `camera`) that looks at a player from behind and
 * above, `distance` units from his chest. `tick` is a cache tick (default: the current renderTick).
 */
const hlCameraNear = (entityId: number, tick?: number, distance = 350): SavedSetupCamera | null => {
  const demo = useInstance.getState().parsedDemo
  if (!demo) return null
  const atTick = Math.max(1, Math.floor(tick ?? getRenderTick()))
  const player = demo.getPlayersAtTick(atTick).find(p => p.user.entityId === Number(entityId))
  if (!player) return null
  const { position, viewAngles } = player
  if (position.x === 0 && position.y === 0 && position.z === 0) return null

  const yaw = (viewAngles.y * Math.PI) / 180
  const elevation = (35 * Math.PI) / 180
  const target: [number, number, number] = [position.x, position.y, position.z + 41]
  const back = distance * Math.cos(elevation)
  return {
    mode: 'rts',
    position: [
      target[0] - Math.cos(yaw) * back,
      target[1] - Math.sin(yaw) * back,
      target[2] + distance * Math.sin(elevation),
    ],
    target,
  }
}

const hl = {
  status: hlStatus,
  /** Per-player extras values at a cache tick (P1 registers the 'players.at' probe). */
  at: (tick?: number) => runHlProbe('players.at', tick ?? getRenderTick()),
  findTicks: (kind: string, opts?: Parameters<typeof findTicks>[2]) => {
    const x = useInstance.getState().extras
    return x ? findTicks(x, kind as FindKind, opts) : [] // extras may be unset; the bridge takes any string
  },
  probe: (name: string, ...args: unknown[]) => runHlProbe(name, ...args),
  probes: () => listHlProbes(),
  waitReady: hlWaitReady,
  cameraNear: hlCameraNear,
}

/** Jump to a player's POV. Seek first: only players in the scene at this tick resolve. */
const focusPlayer = async (query: number | string): Promise<DebugBridgePlayer | null> => {
  const player = resolvePlayer(query)
  if (!player) return null
  await jumpToPlayerPOVCamera(player.entityId)
  await nextFrames(2)
  return getBridgeState().scene.focusedEntityId === player.entityId ? player : null
}

const bridge = {
  version: 1,

  getState: getBridgeState,
  listPlayers,
  resolvePlayer,

  /** Wait for `count` animation frames (r3f renders once per frame). */
  frames: nextFrames,

  async goToTick(tick: number, options: { frames?: number } = {}) {
    await goToTickAction(Math.round(tick))
    await nextFrames(options.frames ?? 2)
    return getBridgeState()
  },

  /** Play/pause without the "Played/Paused" toast that togglePlaybackAction adds. */
  setPlaying(playing: boolean) {
    dispatch({ type: 'TOGGLE_PLAYBACK', payload: !!playing })
    return getBridgeState().playback
  },

  setSpeed(speed: number) {
    changePlaySpeedAction(speed)
    return getBridgeState().playback
  },

  focusPlayer,

  /**
   * 'rts' | 'spectator' | 'pov'. For 'pov' pass `player` (see resolvePlayer), otherwise the
   * next player is chosen like pressing "1". `reset: true` forgets the last POV so RTS and
   * spectator start from the map's default camera instead of the last POV position.
   */
  async setControlsMode(
    mode: ControlsMode,
    options: { player?: number | string; reset?: boolean } = {}
  ) {
    if (options.reset) useInstance.getState().setLastFocusedPOV(undefined)

    if (mode === 'pov') {
      if (options.player !== undefined) {
        const player = await focusPlayer(options.player)
        if (!player) return { ok: false, error: `No player matches "${options.player}"` }
      } else {
        await changeControlsModeAction('pov')
      }
    } else if (mode === 'spectator') {
      await jumpToSpectatorCamera()
    } else {
      await jumpToRtsCamera()
    }

    await nextFrames(2)
    return { ok: true, scene: getBridgeState().scene }
  },

  /** Camera pose in the same format saved setups use ({mode:'rts',position,target} etc). */
  getCamera(): SavedSetupCamera | null {
    return useInstance.getState().setupCameraBridge?.capture() ?? null
  },

  setCamera(camera: SavedSetupCamera) {
    const cameraBridge = useInstance.getState().setupCameraBridge
    if (!cameraBridge) return false
    cameraBridge.apply(camera)
    return true
  },

  /** Same dotted paths SettingsPanel uses, e.g. ('ui.nameplate.enabled', false). */
  setSetting(option: string, value: unknown) {
    updateSettingsOptionAction(option, value)
    return true
  },

  /** Raw store access for ad-hoc probes from page.evaluate(). */
  stores: { useStore, useInstance },

  /** Highlander extras: status, probes, interesting ticks (contract section 3.10). */
  hl,
}

export type DribbleDebugBridge = typeof bridge

declare global {
  interface Window {
    __dribble?: DribbleDebugBridge
  }
}

const isDebugBridgeEnabled = () => {
  try {
    const flag = new URLSearchParams(window.location.search).get('debug')
    return import.meta.env.DEV || flag === '1' || flag === 'true'
  } catch {
    return false
  }
}

if (typeof window !== 'undefined' && isDebugBridgeEnabled()) {
  window.__dribble = bridge
}
