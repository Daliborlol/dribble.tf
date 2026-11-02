// Asset pack probes (asset contract 3.8): assets.status, assets.items and assets.waitIdle.
// src/main.tsx imports this module once; with no pack URL the probes report 'absent' and request nothing.

import { registerHlProbe } from '@highlander/debug'

import { failedAssetItems, listAssetItems, loadingAssetItems, subscribeAssetItems } from './items'
import {
  getAssetPackState,
  isAssetPackResolutionStarted,
  subscribeAssetPack,
} from './pack'
import {
  activePackTextureFormat,
  getPackTextureItem,
  getPackWorldInfo,
  heldPackTextures,
  packTextureGpuBytes,
} from './textures'

function status() {
  const { status, reason, url, manifest } = getAssetPackState()
  return {
    status,
    reason,
    url,
    version: manifest?.version ?? null,
    fingerprint: manifest?.builtFrom?.fingerprint ?? null,
    generatorVersion: manifest?.generator?.version ?? null,
    maps: Object.keys(manifest?.maps ?? {}).sort(),
    itemCount: listAssetItems().length,
    loading: loadingAssetItems(),
    failed: failedAssetItems(),
    started: isAssetPackResolutionStarted(),
  }
}

type IdleResult = { idle: boolean; status: string; pending: string[] }

/**
 * Resolves once the pack is settled and no item loads, or at the timeout with idle false; never rejects. It only
 * waits and never starts the pack resolution itself: the app starts it after the stored settings have loaded
 * (AssetSettingsSection on mount), so a stored assets.enabled=false is always honoured. With no pack URL the
 * state is already settled.
 */
function waitIdle(timeoutMs = 30000): Promise<IdleResult> {
  return new Promise<IdleResult>(resolve => {
    let done = false
    const result = (idle: boolean): IdleResult => ({
      idle,
      status: getAssetPackState().status,
      pending: loadingAssetItems(),
    })
    const finish = (idle: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      offPack()
      offItems()
      resolve(result(idle))
    }
    const check = () => {
      const { status } = getAssetPackState()
      if (status === 'absent' || status === 'error') return finish(true)
      if (status === 'ready' && loadingAssetItems().length === 0) finish(true)
    }
    const timer = setTimeout(() => finish(false), Math.max(0, Number(timeoutMs) || 0))
    const offPack = subscribeAssetPack(check)
    const offItems = subscribeAssetItems(check)
    check()
  })
}

registerHlProbe('assets.status', status)
registerHlProbe('assets.items', (filter?: string) =>
  listAssetItems(typeof filter === 'string' ? filter : undefined)
)
registerHlProbe('assets.waitIdle', waitIdle)

const MB = 1048576

/**
 * Texture GPU memory of the pack's maps (contract 12.6), computed from the manifest: DDS as stored, WebP as
 * width x height x 4 x 4/3, per map entry and for the textures held right now; plus the drawn pack world.
 */
function textures(folder?: string) {
  const manifest = getAssetPackState().manifest
  const maps: Record<string, { textures: number; listed: number; gpuMB: number; webpGpuMB: number }> = {}
  for (const [name, entry] of Object.entries(manifest?.maps ?? {})) {
    if (folder && name !== folder) continue
    const keys = ((entry as { textures?: string[] }).textures ?? []) as string[]
    let dds = 0
    let webp = 0
    let listed = 0
    for (const key of keys) {
      const item = getPackTextureItem(key)
      if (!item) continue
      listed++
      dds += packTextureGpuBytes(item, 'dds')
      webp += packTextureGpuBytes(item, 'webp')
    }
    maps[name] = { textures: keys.length, listed, gpuMB: +(dds / MB).toFixed(2), webpGpuMB: +(webp / MB).toFixed(2) }
  }
  const held = heldPackTextures()
  let heldBytes = 0
  for (const row of held) {
    const item = getPackTextureItem(row.key)
    if (item && row.loaded) heldBytes += packTextureGpuBytes(item, activePackTextureFormat() ?? 'dds')
  }
  return { world: getPackWorldInfo(), format: activePackTextureFormat(), maps, held: held.length, heldLoaded: held.filter(r => r.loaded).length, heldGpuMB: +(heldBytes / MB).toFixed(2) }
}

registerHlProbe('assets.textures', (folder?: string) => textures(typeof folder === 'string' ? folder : undefined))
