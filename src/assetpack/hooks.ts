// Reads of settings.assets (asset contract 3.7). Select primitives only: the settings reducer shallow-clones
// the settings, so settings.assets keeps its reference while its fields change.

import { getState, useStore } from '@zus/store'

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

/** One value of settings.assets, e.g. useAssetSetting('stockProps'). */
export const useAssetSetting = <K extends AssetSettingKey>(key: K): AssetSettings[K] =>
  useStore(s => pick(s.settings.assets, key))

/** Same as useAssetSetting for non-React code. */
export const getAssetSetting = <K extends AssetSettingKey>(key: K): AssetSettings[K] =>
  pick(getState().settings.assets, key)

/** The stored assets.enabled, ignoring ?assets=off (the settings row shows it). */
export const getStoredAssetsEnabled = (): boolean =>
  getState().settings.assets?.enabled ?? DEFAULT_ASSET_SETTINGS.enabled

export const isAssetsOffByUrl = (): boolean => offByUrl
