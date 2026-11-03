// The pack's manifest.json v1 (asset contract 2.3).

export interface AssetPackVpk {
  file: string
  bytes: number
  treeCrc32: string
  archives: number
  archiveBytes: number
}

export interface AssetPackMapEntry {
  mapName: string
  bspSha256?: string
  bspBytes?: number
  /** Verbatim copy of the public conversion.json `props` object. */
  publicProps?: Record<string, unknown>
  files: Record<string, string>
  sizes?: Record<string, number>
  stats?: Record<string, unknown>
}

export interface AssetPackManifestItem {
  kind: 'model' | 'texture' | 'particles' | 'shading'
  file: string
  bytes?: number
  sha256?: string
  [extra: string]: unknown
}

export interface AssetPackManifest {
  format: 'dribble-asset-pack'
  version: 1
  generator?: { version?: string; commit?: string | null }
  builtFrom?: { vpks?: AssetPackVpk[]; fingerprint?: string }
  options?: Record<string, unknown>
  maps?: Record<string, AssetPackMapEntry>
  items?: Record<string, AssetPackManifestItem>
}

export type AssetPackStatus = 'absent' | 'loading' | 'ready' | 'error'

export type AssetPackReason =
  | null
  | 'not-configured'
  | 'disabled'
  | 'not-found'
  | 'html'
  | 'timeout'
  | 'network'
  | 'invalid'
  | 'version'

export interface AssetPackState {
  status: AssetPackStatus
  reason: AssetPackReason
  url: string | null
  manifest: AssetPackManifest | null
}

export type AssetItemState = 'idle' | 'loading' | 'ready' | 'failed' | 'skipped'

/** One probe row per pack file (asset contract 3.6). */
export interface AssetItemRow {
  key: string
  kind: string
  state: AssetItemState
  source: 'pack' | 'fallback'
  url: string | null
  bytes: number | null
  error: string | null
}
