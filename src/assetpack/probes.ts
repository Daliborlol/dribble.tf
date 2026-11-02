// Asset pack probes (asset contract 3.8): assets.status, assets.items and assets.waitIdle.
// src/main.tsx imports this module once; with no pack URL the probes report 'absent' and request nothing.

import { registerHlProbe } from '@highlander/debug'

import { failedAssetItems, listAssetItems, loadingAssetItems, subscribeAssetItems } from './items'
import {
  getAssetPackState,
  isAssetPackResolutionStarted,
  resolveAssetPack,
  subscribeAssetPack,
} from './pack'

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
 * Resolves once the pack is settled and no item loads, or at the timeout with idle false; never rejects. It
 * starts the pack resolution when nothing has (so a harness waiting on it never stalls); with no pack URL that
 * requests nothing.
 */
function waitIdle(timeoutMs = 30000): Promise<IdleResult> {
  void resolveAssetPack()
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
