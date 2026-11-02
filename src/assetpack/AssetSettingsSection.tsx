// The "TF2 assets" block of the settings panel (asset contract 3.7). It renders nothing when no pack URL is
// configured (the production default). Phase 2 to 4 tasks each own the line of their own row here.

import { useEffect } from 'react'

import { ToggleOption } from '@components/UI/Shared/SettingsOptions'
import { updateSettingsOptionAction } from '@zus/actions'
import { useStore } from '@zus/store'

import { ASSET_PACK_URL } from './config'
import { isAssetsOffByUrl } from './hooks'
import { listAssetItems } from './items'
import { resolveAssetPack, useAssetPack } from './pack'
import type { AssetPackState } from './types'

const statusLine = (pack: AssetPackState): string => {
  const url = pack.url ?? ''
  switch (pack.status) {
    case 'ready': {
      const maps = Object.keys(pack.manifest?.maps ?? {}).length
      const items = listAssetItems().length
      return `TF2 asset pack: ready, ${maps} map${maps === 1 ? '' : 's'}, ${items} item${items === 1 ? '' : 's'}`
    }
    case 'loading':
      return 'TF2 asset pack: loading'
    case 'error':
      return `TF2 asset pack: error (${pack.reason ?? 'unknown'}) at ${url}`
    default:
      if (pack.reason === 'disabled')
        return isAssetsOffByUrl() ? 'TF2 asset pack: off (?assets=off)' : 'TF2 asset pack: off'
      return `TF2 asset pack: not found at ${url}`
  }
}

const AssetSettingsRows = () => {
  const pack = useAssetPack()
  // Primitives only: settings.assets keeps its reference while its fields change (settings reducer).
  const enabled = useStore(s => s.settings.assets?.enabled ?? true)
  const stockProps = useStore(s => s.settings.assets?.stockProps ?? true)
  const offByUrl = isAssetsOffByUrl()

  useEffect(() => {
    void resolveAssetPack()
  }, [])

  const hasMaps = Object.keys(pack.manifest?.maps ?? {}).length > 0

  return (
    <>
      <div className="mb-4 mt-16 text-xs font-black uppercase opacity-60">TF2 assets</div>
      <div className="mb-4 text-sm opacity-70" data-assets-status={pack.status}>
        {statusLine(pack)}
      </div>

      <ToggleOption
        label={offByUrl ? 'Use the TF2 asset pack (off by ?assets=off)' : 'Use the TF2 asset pack'}
        checked={enabled && !offByUrl}
        disabled={offByUrl}
        onChange={checked => updateSettingsOptionAction('assets.enabled', checked)}
      />

      {hasMaps && (
        <ToggleOption
          label="Stock static props"
          checked={stockProps}
          onChange={checked => updateSettingsOptionAction('assets.stockProps', checked)}
        />
      )}
    </>
  )
}

export const AssetSettingsSection = () => (ASSET_PACK_URL ? <AssetSettingsRows /> : null)
