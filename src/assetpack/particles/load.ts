// The pack's particle definitions (as/particles): `particles/systems.json`, fetched once per page while a mounted
// layer holds it, compiled for sim.ts. Reference counted: the last release drops the compiled set, and a later
// acquire fetches again. Nothing is requested without a pack that lists the item (D21).

import { useEffect, useState, useSyncExternalStore } from 'react'

import { useStore } from '@zus/store'
import { getAssetPackState, subscribeAssetPack } from '@pack/pack'
import { isAssetsOffByUrl } from '@pack/hooks'
import { loadPackItem, releaseAssetItem } from '@pack/items'

import type { CompiledParticles } from './sim'
import type { PcfFile } from './types'

export const PARTICLES_ITEM = 'particles/systems'

export interface PackParticles {
  compiled: CompiledParticles
  file: PcfFile
}

let held = 0
let promise: Promise<PackParticles | null> | null = null
let loaded: PackParticles | null = null

/** True when the ready pack lists the particle item. */
export function packParticlesListed(): boolean {
  const s = getAssetPackState()
  return s.status === 'ready' && !!s.manifest?.items?.[PARTICLES_ITEM]
}

function acquire(): Promise<PackParticles | null> {
  held++
  if (!promise) {
    promise = loadPackItem(PARTICLES_ITEM, async url => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const file = (await res.json()) as PcfFile
      if (!file || file.version !== 1 || typeof file.systems !== 'object') throw new Error('unknown systems.json version')
      const { compileParticles } = await import('./sim')
      return { file, compiled: compileParticles(file) }
    }).then(result => {
      if (held > 0) loaded = result
      return result
    })
  }
  return promise
}

function release(): void {
  held = Math.max(0, held - 1)
  if (held > 0) return
  promise = null
  loaded = null
  releaseAssetItem(PARTICLES_ITEM)
}

/** The loaded definitions while this component is mounted, or null. */
export function usePackParticleDefs(enabled: boolean): PackParticles | null {
  const [defs, setDefs] = useState<PackParticles | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    acquire().then(result => {
      if (live) setDefs(result)
    })
    return () => {
      live = false
      setDefs(null)
      release()
    }
  }, [enabled])
  return enabled ? defs : null
}

export const getLoadedPackParticles = (): PackParticles | null => loaded

/** Pack ready and listing particles, assets.enabled and assets.particles on (?assets=off counts as off). */
export function usePackParticlesWanted(): boolean {
  const state = useSyncExternalStore(subscribeAssetPack, getAssetPackState, getAssetPackState)
  const enabled = useStore(s => s.settings.assets?.enabled ?? true)
  const particles = useStore(s => s.settings.assets?.particles ?? true)
  return state.status === 'ready' && !!state.manifest?.items?.[PARTICLES_ITEM] && enabled && particles && !isAssetsOffByUrl()
}
