// Reads of settings.assets (asset contract 3.7). Select primitives only: the settings reducer shallow-clones
// the settings, so settings.assets keeps its reference while its fields change.

import { useSyncExternalStore } from 'react'

import { getState, subscribeSettings } from '@zus/store'

import { assetsOffByUrl } from './config'
import { AssetSettingKey, AssetSettings, DEFAULT_ASSET_SETTINGS } from './settings'

const offByUrl = assetsOffByUrl()

/** The stored value, with `enabled` forced false while the page URL carries ?assets=off. */
const pick = <K extends AssetSettingKey>(
  assets: AssetSettings | undefined,
  key: K
): AssetSettings[K] => {
  if (key === 'enabled' && offByUrl) return false as AssetSettings[K]
  return (assets?.[key] ?? DEFAULT_ASSET_SETTINGS[key]) as AssetSettings[K]
}

// One reader per key, shared by every component (see settingReader in extras/hooks.ts)
const readers = new Map<AssetSettingKey, () => unknown>()
function assetReader(key: AssetSettingKey): () => unknown {
  let reader = readers.get(key)
  if (!reader) {
    let seen: unknown = null
    let value: unknown
    reader = () => {
      const settings = getState().settings
      if (settings !== seen) {
        seen = settings
        value = pick(settings.assets, key)
      }
      return value
    }
    readers.set(key, reader)
  }
  return reader
}

/** One value of settings.assets, e.g. useAssetSetting('stockProps'). */
export const useAssetSetting = <K extends AssetSettingKey>(key: K): AssetSettings[K] =>
  useSyncExternalStore(subscribeSettings, assetReader(key) as () => AssetSettings[K])

/** Same as useAssetSetting for non-React code. */
export const getAssetSetting = <K extends AssetSettingKey>(key: K): AssetSettings[K] =>
  pick(getState().settings.assets, key)

/** The stored assets.enabled, ignoring ?assets=off (the settings row shows it). */
export const getStoredAssetsEnabled = (): boolean =>
  getState().settings.assets?.enabled ?? DEFAULT_ASSET_SETTINGS.enabled

export const isAssetsOffByUrl = (): boolean => offByUrl
