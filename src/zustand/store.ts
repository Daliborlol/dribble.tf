import { create } from 'zustand'
import { redux } from 'zustand/middleware'
import CanvasDraw from 'react-canvas-draw'
import { isMobile } from 'react-device-detect'
import * as THREE from 'three'
import { cloneDeep } from 'lodash'

import { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { getMapBoundaries } from '@components/Analyse/MapBoundaries'

import { parseMapBoundaries } from '@utils/scene'
import { DEFAULT_HIGHLANDER_SETTINGS, HighlanderSettings } from '@highlander/settings'
import type { HighlanderExtras } from '@highlander/extras/types'
import { AssetSettings, DEFAULT_ASSET_SETTINGS } from '@pack/settings'

import {
  ControlsMode,
  CrosshairStyle,
  Download,
  DrawingActivation,
  ParserStatus,
  SavedSetup,
  SavedSetupCamera,
  SceneMode,
  UIPanelType,
} from '@constants/types'
import { DrawingState, createInitialDrawingState } from './drawing'
import rootReducer from './reducer'

// This "Instance Store" is meant to be used for larger objects that are problematic
// to keep in the "Standard Store". (e.g. parsed demo file (AsyncParser), three.js objects)
// We wanna keep easily accessible references to these important objects because they're
// used a lot throughout.

// three.js is fundamentally not that well suited for React based apps (often easier to
// directly manipulate the objects instead), and react-three-fiber hooks are a bit too
// restrictive (hard to pass values/references around).

export type InstanceState = {
  mapOffsetDebug: {
    cameraOffset: { x: number; y: number; z: number }
  }
  mapCenterPickerActive: boolean
  threeScene: THREE.Scene
  parsedDemo?: AsyncParser
  focusedObject?: THREE.Object3D
  lastFocusedPOV?: THREE.Object3D
  drawingCanvas?: CanvasDraw
  frameProgress: number
  runtimePerf: {
    renderCalls: number
    renderTriangles: number
    visibleChunkCount: number
    currentCluster: number | null
  }
  setupCameraBridge?: {
    capture: () => SavedSetupCamera | null
    apply: (camera: SavedSetupCamera) => void
  }
  setThreeScene: (threeScene: THREE.Scene) => void
  setParsedDemo: (parsedDemo: AsyncParser | undefined) => void
  setDrawingCanvas: (drawingCanvas: CanvasDraw) => void
  setFocusedObject: (focusedObject?: THREE.Object3D) => void
  setLastFocusedPOV: (lastFocusedPOV?: THREE.Object3D) => void
  setFrameProgress: (frameProgress: number) => void
  setMapCenterPickerActive: (mapCenterPickerActive: boolean) => void
  setMapOffsetDebug: (mapOffsetDebug: { cameraOffset: { x: number; y: number; z: number } }) => void
  setRuntimePerf: (
    runtimePerf: Partial<{
      renderCalls: number
      renderTriangles: number
      visibleChunkCount: number
      currentCluster: number | null
    }>
  ) => void
  setSetupCameraBridge: (
    setupCameraBridge?: {
      capture: () => SavedSetupCamera | null
      apply: (camera: SavedSetupCamera) => void
    }
  ) => void

  // ─── Highlander (contract section 3.3) ───
  extras?: HighlanderExtras
  extrasStatus: 'idle' | 'disabled' | 'loading' | 'ready' | 'error'
  extrasProgress: number                    // 0..100
  extrasError?: string
  setExtras: (extras?: HighlanderExtras) => void
  setExtrasStatus: (status: InstanceState['extrasStatus'], progress?: number, error?: string) => void
  povCameraOverride?: THREE.Camera          // F4 POV subject camera (section 5 F4); Controls uses it only in POV mode with a focused player
  setPovCameraOverride: (camera?: THREE.Camera) => void
  scopeActive: boolean                      // F4 ScopeOverlay visible; the base Crosshair hides while true
  setScopeActive: (active: boolean) => void
  scoreboardOpen: boolean                   // Tab held (S0 key handler); F5 Scoreboard shows while true
  setScoreboardOpen: (open: boolean) => void
  mapNodes?: Map<number, THREE.Object3D>    // M1: brush-entity parent nodes by bspModelIndex
  setMapNodes: (nodes?: Map<number, THREE.Object3D>) => void
  mapStatus: { state: 'idle' | 'loading' | 'ready' | 'missing' | 'error'; message?: string; folder?: string; pipeline?: string }
  setMapStatus: (status: InstanceState['mapStatus']) => void
  actorRegistryVersion: number              // bumped when an actor mounts or unmounts
  bumpActorRegistryVersion: () => void
}

const sameOffsetVector = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
) => a.x === b.x && a.y === b.y && a.z === b.z

const useInstance = create<InstanceState>()(set => ({
  mapOffsetDebug: {
    cameraOffset: { x: 0, y: 0, z: 0 },
  },
  mapCenterPickerActive: false,
  threeScene: new THREE.Scene(),
  parsedDemo: undefined,
  focusedObject: undefined,
  lastFocusedPOV: undefined,
  drawingCanvas: undefined,
  frameProgress: 0,
  runtimePerf: {
    renderCalls: 0,
    renderTriangles: 0,
    visibleChunkCount: 0,
    currentCluster: null,
  },
  setupCameraBridge: undefined,
  setThreeScene: (threeScene: THREE.Scene) => set({ threeScene }),
  setParsedDemo: (parsedDemo: AsyncParser | undefined) => set({ parsedDemo }),
  setDrawingCanvas: (drawingCanvas: CanvasDraw) => set({ drawingCanvas }),
  setFocusedObject: (focusedObject?: THREE.Object3D) => set({ focusedObject }),
  setLastFocusedPOV: (lastFocusedPOV?: THREE.Object3D) => set({ lastFocusedPOV }),
  setFrameProgress: (frameProgress: number) => set({ frameProgress }),
  setMapCenterPickerActive: (mapCenterPickerActive: boolean) => set({ mapCenterPickerActive }),
  setMapOffsetDebug: mapOffsetDebug =>
    set(state => {
      if (sameOffsetVector(state.mapOffsetDebug.cameraOffset, mapOffsetDebug.cameraOffset)) {
        return state
      }

      return { mapOffsetDebug }
    }),
  setRuntimePerf: runtimePerf =>
    set(state => ({
      runtimePerf: {
        ...state.runtimePerf,
        ...runtimePerf,
      },
    })),
  setSetupCameraBridge: setupCameraBridge => set({ setupCameraBridge }),

  // ─── Highlander (contract section 3.3) ───
  extras: undefined,
  extrasStatus: 'idle',
  extrasProgress: 0,
  extrasError: undefined,
  setExtras: extras => set({ extras }),
  setExtrasStatus: (extrasStatus, progress, error) =>
    set(state => ({
      extrasStatus,
      extrasProgress: progress ?? state.extrasProgress,
      extrasError: error,
    })),
  povCameraOverride: undefined,
  setPovCameraOverride: povCameraOverride =>
    set(state => (state.povCameraOverride === povCameraOverride ? state : { povCameraOverride })),
  scopeActive: false,
  setScopeActive: scopeActive => set(state => (state.scopeActive === scopeActive ? state : { scopeActive })),
  scoreboardOpen: false,
  setScoreboardOpen: scoreboardOpen =>
    set(state => (state.scoreboardOpen === scoreboardOpen ? state : { scoreboardOpen })),
  mapNodes: undefined,
  setMapNodes: mapNodes => set({ mapNodes }),
  mapStatus: { state: 'idle' },
  setMapStatus: mapStatus => set({ mapStatus }),
  actorRegistryVersion: 0,
  bumpActorRegistryVersion: () => set(state => ({ actorRegistryVersion: state.actorRegistryVersion + 1 })),
}))

// This "Standard Store" is pretty much just a typical Redux store. Note that we are using
// redux middleware on top of zustand because the project was previously using Redux. It was
// decided to shift towards zustand because of annoying React context conflict stuff.

// Note that we also have Redux devtools enabled. This is another reason we need to separate
// into the separate "Instance Store" - because those large objects cause Redux devtools to
// crap itself and annihilates performance.

export type StoreState = {
  parser: {
    status: ParserStatus
    progress: number
    error?: Error
  }
  scene: {
    players: Map<any, any>
    map: string
    bounds: {
      min: THREE.Vector3
      max: THREE.Vector3
      center: THREE.Vector3
      defaultCameraOffset: THREE.Vector3
      defaultRtsCenter: THREE.Vector3
    }
    controls: {
      mode: ControlsMode
    }
  }
  playback: {
    playing: boolean
    speed: number
    tick: number
    maxTicks: number
    forceShowPanel: boolean
    intervalPerTick: number
  }
  drawing: DrawingState
  settings: {
    scene: {
      mode: SceneMode
      interpolateFrames: boolean
      rtsCenters: Record<string, { x: number; y: number; z: number }>
    }
    camera: {
      position: [number, number, number]
      near: number
      far: number
      fov: number
    }
    controls: {
      panSpeed: number
      rotateSpeed: number
      zoomSpeed: number
      enableDamping: boolean
      lookSpeed: number
      moveSpeed: number
    }
    drawing: {
      activation: DrawingActivation
      autoClear: boolean
    }
    ui: {
      nameplate: {
        enabled: boolean
        showName: boolean
        showHealth: boolean
        showClass: boolean
      }
      crosshair: {
        style: CrosshairStyle
        size: number
        opacity: number
        color: string
      }
      playerOutlines: boolean
      showStats: boolean
      showSkybox: boolean
      viewDistance: number
      killfeedSeekBuffer: number
    }
    highlander: HighlanderSettings
    assets: AssetSettings
  }
  bookmarks: number[]
  ui: {
    activePanels: UIPanelType[]
  }
  eventHistory: {
    type: string
    value?: string
    timestamp: number
  }[]
  downloads: Map<string, Download>
  setups: {
    items: SavedSetup[]
    draftName: string
    pendingSharedSetup?: SavedSetup
  }
}

export const initialState: StoreState = {
  parser: {
    status: ParserStatus.INIT,
    progress: 0,
    error: undefined,
  },

  scene: {
    players: new Map(),
    map: 'cp_snakewater',
    bounds: parseMapBoundaries(getMapBoundaries('cp_snakewater')!),
    controls: {
      mode: ControlsMode.RTS,
    },
  },

  playback: {
    playing: false,
    speed: 1,
    tick: 1,
    maxTicks: 3000,
    forceShowPanel: false,
    intervalPerTick: 0.015,
  },

  drawing: createInitialDrawingState(),

  settings: {
    scene: {
      mode: isMobile ? SceneMode.UNTEXTURED : SceneMode.TEXTURED,
      interpolateFrames: true,
      rtsCenters: {},
    },
    camera: {
      position: [0, -400, 200] as [number, number, number],
      near: 0.1,
      far: 15000,
      fov: 90,
    },
    controls: {
      // RTS camera settings
      panSpeed: 5,
      rotateSpeed: 3,
      zoomSpeed: 5,
      enableDamping: true,

      // Spectator camera settings
      lookSpeed: 3,
      moveSpeed: 5,
    },
    drawing: {
      activation: DrawingActivation.TOGGLE,
      autoClear: true,
    },
    ui: {
      nameplate: {
        enabled: true,
        showName: true,
        showHealth: true,
        showClass: true,
      },
      crosshair: {
        style: 'crosshair' as CrosshairStyle,
        size: 16,
        opacity: 0.8,
        color: '#ffffff',
      },
      playerOutlines: false,
      showStats: true,
      showSkybox: true,
      viewDistance: 15000,
      killfeedSeekBuffer: 2,
    },
    // Deep clone: the settings reducer shallow-clones and mutates nested objects in place.
    highlander: cloneDeep(DEFAULT_HIGHLANDER_SETTINGS),
    assets: cloneDeep(DEFAULT_ASSET_SETTINGS),
  },

  bookmarks: [],

  ui: {
    activePanels: [UIPanelType.ABOUT],
  },

  eventHistory: [],

  downloads: new Map(),

  setups: {
    items: [],
    draftName: '',
    pendingSharedSetup: undefined,
  },
}

export type StoreAction = {
  type: string
  payload?: any
}

// TODO: why tf is this erroring? check after TS upgrade
const useStore = create(redux<StoreState, StoreAction>(rootReducer as any, initialState))

// Export these functions at first level because they will be used very frequently
// and are essentially the Redux equivalents (makes migration/adoption easier)
const { dispatch, getState } = useStore

export { useStore, dispatch, getState, useInstance }
