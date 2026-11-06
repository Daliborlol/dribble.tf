// The page-level asset pack record (asset contract 3.4). It holds the manifest only, never a demo, an extras
// object or a store snapshot, so the memory rule of Highlander contract 12.3 allows it at module level.

import { useSyncExternalStore } from 'react'

import { subscribeSettings, useStore } from '@zus/store'

import { ASSET_PACK_URL } from './config'
import { getAssetSetting, getStoredAssetsEnabled, isAssetsOffByUrl } from './hooks'
import type { AssetPackManifest, AssetPackReason, AssetPackState, AssetPackStatus } from './types'

/** The manifest request gives up after this long; a later answer is ignored for the page. */
export const MANIFEST_TIMEOUT_MS = 2000

const NOT_CONFIGURED: AssetPackState = Object.freeze({
  status: 'absent',
  reason: 'not-configured',
  url: null,
  manifest: null,
}) as AssetPackState

let state: AssetPackState = ASSET_PACK_URL
  ? { status: 'loading', reason: null, url: ASSET_PACK_URL, manifest: null }
  : NOT_CONFIGURED
let started = !ASSET_PACK_URL
let pending: Promise<AssetPackState> = Promise.resolve(state)
/** A `disabled` result caused by the setting is redone once when assets.enabled turns true. */
let settingRetryUsed = false
let unsubscribeSetting: (() => void) | null = null

const listeners = new Set<() => void>()

function setState(next: AssetPackState) {
  state = next
  for (const listener of Array.from(listeners)) listener()
}

/** Subscribe to pack state changes (useSyncExternalStore contract). */
export function subscribeAssetPack(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Synchronous read of the pack state. */
export const getAssetPackState = (): AssetPackState => state

/** True once resolveAssetPack() has been called (or nothing needs resolving). */
export const isAssetPackResolutionStarted = (): boolean => started

export const isAssetPackSettled = (status: AssetPackStatus = state.status): boolean =>
  status !== 'loading'

/** React hook of the pack state. */
export const useAssetPack = (): AssetPackState =>
  useSyncExternalStore(subscribeAssetPack, getAssetPackState, getAssetPackState)

/** True while the pack is ready and assets.enabled is on (?assets=off included). */
const readAssetsEnabled = () => useStore.getState().settings.assets?.enabled ?? true

export const useAssetPackActive = (): boolean => {
  const pack = useAssetPack()
  const enabled = useSyncExternalStore(subscribeSettings, readAssetsEnabled)
  return pack.status === 'ready' && enabled && !isAssetsOffByUrl()
}

/**
 * URL of a file the manifest lists, or null: no pack, pack not ready, or the path is not in the manifest
 * (contract 2.3: the runtime requests nothing else).
 */
export function assetPackFile(path: string): string | null {
  if (state.status !== 'ready' || !state.url || !state.manifest) return null
  return isListed(state.manifest, path) ? state.url + path : null
}

function isListed(manifest: AssetPackManifest, path: string): boolean {
  for (const entry of Object.values(manifest.maps ?? {})) {
    for (const file of Object.values(entry?.files ?? {})) if (file === path) return true
  }
  for (const item of Object.values(manifest.items ?? {}))
    if (item?.file === path || (item as { webp?: unknown } | undefined)?.webp === path) return true
  return false
}

const finish = (
  status: AssetPackStatus,
  reason: AssetPackReason,
  manifest: AssetPackManifest | null = null
) => {
  const next: AssetPackState = { status, reason, url: ASSET_PACK_URL, manifest }
  setState(next)
  return next
}

const looksLikeHtml = (contentType: string, text: string) => {
  if (contentType.toLowerCase().includes('text/html')) return true
  const head = text.trimStart().slice(0, 15).toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html')
}

async function fetchManifest(url: string): Promise<AssetPackState> {
  const manifestUrl = `${url}manifest.json`
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => {
      timedOut = true
      controller?.abort()
      resolve('timeout')
    }, MANIFEST_TIMEOUT_MS)
  })

  const fail = (reason: AssetPackReason, detail: string) => {
    console.warn(`[assets] asset pack at ${url} unusable (${reason}): ${detail}`)
    return finish('error', reason)
  }

  try {
    const request = (async () => {
      const response = await fetch(manifestUrl, { signal: controller?.signal, cache: 'no-cache' })
      const text = response.ok ? await response.text() : ''
      return { response, text }
    })()
    const answer = await Promise.race([request, timeout])
    if (answer === 'timeout' || timedOut) {
      request.catch(() => undefined)
      return fail('timeout', `no answer within ${MANIFEST_TIMEOUT_MS} ms`)
    }
    const { response, text } = answer
    if (response.status === 404 || response.status === 410) {
      console.info(`[assets] no asset pack at ${url}`)
      return finish('absent', 'not-found')
    }
    if (!response.ok) return fail('network', `manifest.json answered ${response.status}`)
    if (looksLikeHtml(response.headers.get('content-type') ?? '', text)) {
      console.info(`[assets] no asset pack at ${url}`)
      return finish('absent', 'html')
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error) {
      return fail('invalid', `manifest.json is not JSON (${(error as Error).message})`)
    }
    if (!json || typeof json !== 'object') return fail('invalid', 'manifest.json is not an object')
    const manifest = json as AssetPackManifest
    if (manifest.format !== 'dribble-asset-pack')
      return fail('invalid', `format ${JSON.stringify(manifest.format)}`)
    if (manifest.version !== 1)
      return fail('version', `version ${JSON.stringify(manifest.version)}, expected 1`)
    return finish('ready', null, manifest)
  } catch (error) {
    if (timedOut) return fail('timeout', `no answer within ${MANIFEST_TIMEOUT_MS} ms`)
    return fail('network', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
}

function watchSettingOnce() {
  if (settingRetryUsed || unsubscribeSetting) return
  unsubscribeSetting = useStore.subscribe(() => {
    if (!getStoredAssetsEnabled()) return
    unsubscribeSetting?.()
    unsubscribeSetting = null
    settingRetryUsed = true
    setState({ status: 'loading', reason: null, url: ASSET_PACK_URL, manifest: null })
    pending = run()
  })
}

function run(): Promise<AssetPackState> {
  const url = ASSET_PACK_URL
  if (!url) return Promise.resolve(state)
  if (isAssetsOffByUrl()) return Promise.resolve(finish('absent', 'disabled'))
  if (!getAssetSetting('enabled')) {
    const next = finish('absent', 'disabled')
    watchSettingOnce()
    return Promise.resolve(next)
  }
  return fetchManifest(url)
}

/**
 * Resolves the pack once per page (contract 3.4). With no pack URL it returns an already resolved promise and
 * requests nothing. It reads assets.enabled and ?assets=off when first called.
 */
export function resolveAssetPack(): Promise<AssetPackState> {
  if (!started) {
    started = true
    pending = run()
  }
  return pending
}
