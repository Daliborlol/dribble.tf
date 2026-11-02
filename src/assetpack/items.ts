// The item registry the probes read (asset contract 3.6). An item is a file the manifest lists: map files are
// keyed by their pack path (maps/<folder>/props-stock.glb), model and texture items by their source path.
// Rows hold strings and numbers only.

import { ASSET_PACK_URL } from './config'
import { getAssetPackState, subscribeAssetPack } from './pack'
import type { AssetItemRow, AssetPackManifest } from './types'

const rows = new Map<string, AssetItemRow>()
const inflight = new Map<string, number>()
const listeners = new Set<() => void>()
let seededFrom: AssetPackManifest | null = null

const notify = () => {
  for (const listener of Array.from(listeners)) listener()
}

export function subscribeAssetItems(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Key of a map file: its pack path, e.g. mapFileKey('pl_vigil_rc10', 'propsStock') -> 'maps/pl_vigil_rc10/props-stock.glb'. */
export function mapFileKey(folder: string, fileKey: string): string | null {
  return getAssetPackState().manifest?.maps?.[folder]?.files?.[fileKey] ?? null
}

/** Creates an idle row for every file the manifest lists, once per manifest. */
function seed() {
  const { status, manifest, url } = getAssetPackState()
  if (status !== 'ready' || !manifest || !url || manifest === seededFrom) return
  seededFrom = manifest
  for (const entry of Object.values(manifest.maps ?? {})) {
    for (const [fileKey, file] of Object.entries(entry?.files ?? {})) {
      if (typeof file !== 'string' || rows.has(file)) continue
      const bytes = entry.sizes?.[fileKey]
      rows.set(file, {
        key: file,
        kind: `map:${fileKey}`,
        state: 'idle',
        source: 'fallback',
        url: url + file,
        bytes: typeof bytes === 'number' ? bytes : null,
        error: null,
      })
    }
  }
  for (const [key, item] of Object.entries(manifest.items ?? {})) {
    if (!item || typeof item.file !== 'string' || rows.has(key)) continue
    rows.set(key, {
      key,
      kind: String(item.kind ?? 'unknown'),
      state: 'idle',
      source: 'fallback',
      url: url + item.file,
      bytes: typeof item.bytes === 'number' ? item.bytes : null,
      error: null,
    })
  }
  notify()
}

if (ASSET_PACK_URL) subscribeAssetPack(seed)

const update = (key: string, patch: Partial<AssetItemRow>) => {
  const row = rows.get(key)
  if (!row) return
  rows.set(key, { ...row, ...patch })
  notify()
}

/** The row of one item, or undefined when the manifest does not list it (or no pack is ready). */
export const getAssetItem = (key: string): AssetItemRow | undefined => rows.get(key)

/** Every row, sorted by key, filtered by key substring. */
export function listAssetItems(filter?: string): AssetItemRow[] {
  const all = Array.from(rows.values()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return filter ? all.filter(row => row.key.includes(filter)) : all
}

export const loadingAssetItems = (): string[] =>
  listAssetItems()
    .filter(row => row.state === 'loading')
    .map(row => row.key)

export const failedAssetItems = (): string[] =>
  listAssetItems()
    .filter(row => row.state === 'failed')
    .map(row => row.key)

/**
 * Loads one listed item through `load(url)`. Returns null, without a request, when the manifest does not list it,
 * when it failed before (no retry for the page) or when it was skipped. A failure logs one console.warn
 * (`[assets] <key>: <error>; using the fallback`) and marks the item failed. The caller owns what `load` returns
 * and disposes it.
 */
export async function loadPackItem<T>(
  key: string,
  load: (url: string) => Promise<T>
): Promise<T | null> {
  seed()
  const row = rows.get(key)
  if (!row || !row.url || row.state === 'failed' || row.state === 'skipped') return null
  inflight.set(key, (inflight.get(key) ?? 0) + 1)
  if (row.state !== 'loading') update(key, { state: 'loading' })
  try {
    const result = await load(row.url)
    const left = (inflight.get(key) ?? 1) - 1
    inflight.set(key, left)
    if (rows.get(key)?.state !== 'failed') {
      update(key, left > 0 ? { state: 'loading' } : { state: 'ready', source: 'pack', error: null })
    }
    return result
  } catch (error) {
    inflight.set(key, Math.max(0, (inflight.get(key) ?? 1) - 1))
    const message = error instanceof Error ? error.message : String(error)
    if (rows.get(key)?.state !== 'failed') {
      console.warn(`[assets] ${key}: ${message}; using the fallback`)
      update(key, { state: 'failed', source: 'fallback', error: message })
    }
    return null
  }
}

/** Marks an item skipped for the page (for example a stale map entry, contract 3.5); it is never requested. */
export function skipAssetItem(key: string, reason: string): void {
  seed()
  const row = rows.get(key)
  if (!row || row.state === 'failed') return
  update(key, { state: 'skipped', source: 'fallback', error: reason })
}

/** A ready item whose drawn copies were all unmounted goes back to idle; the next mount loads it again. */
export function releaseAssetItem(key: string): void {
  const row = rows.get(key)
  if (row && row.state === 'ready' && !(inflight.get(key) ?? 0))
    update(key, { state: 'idle', source: 'fallback' })
}
