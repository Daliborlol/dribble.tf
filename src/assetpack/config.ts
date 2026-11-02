// Where the local TF2 asset pack is served (asset contract 3.2). D19: a production build makes no pack
// request unless VITE_ASSET_PACK_URL was set when it was built.

const configured: string | undefined = import.meta.env.VITE_ASSET_PACK_URL

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`)

/**
 * Base URL of the pack, ending in '/', or null when no pack is configured.
 * 1. VITE_ASSET_PACK_URL set and not 'off': that value. 2. 'off': null.
 * 3. Unset in `npm run dev`: '/tf2-assets/'. 4. Unset in a production build: null (no request, ever).
 */
export const ASSET_PACK_URL: string | null = configured
  ? configured === 'off'
    ? null
    : withSlash(configured)
  : import.meta.env.DEV
    ? '/tf2-assets/'
    : null

/** True when the page URL carries ?assets=off, which forces assets.enabled off for the page. */
export const assetsOffByUrl = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).get('assets') === 'off'
  } catch {
    return false
  }
}
