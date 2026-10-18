// Viewport rules for the Highlander HUD between the phone layout (below 768 px wide) and the desktop layout
// (contract section 5 F5 defines 1024 px and wider). The desktop default (1280 px and wider, 600 px and taller)
// keeps the F5 positions; these rules only apply where those positions collide:
//
// - Killfeed, 768 px wide up to KILLFEED_SQUEEZE_BELOW: the gap between the player columns is narrower than a
//   killfeed line. When the viewport is tall enough, the killfeed moves below the taller column, centred, at full
//   width; otherwise (phone landscape) it stays between the columns with 3 compact lines that truncate names.
// - POV weapon HUD: below POV_HUD_RAISE_BELOW px wide its 220 px box would reach over the PlaybackPanel pill and
//   the FocusedPlayer card, so it sits above them; on viewports shorter than SHORT_VIEWPORT it has no free spot
//   (player columns down to the playback controls), so it is hidden.

import { useState } from 'react'

import { useEventListener } from '@utils/hooks'
import type { HudSnapshot } from '@highlander/hud/hudSnapshot'
import { HUD_LAYOUT } from '@highlander/objectives/layout'

/** The narrow centred killfeed is at most 100vw - 624 px wide; below 944 px that is under 320 px. */
export const KILLFEED_SQUEEZE_BELOW = 2 * (HUD_LAYOUT.bluLeft + HUD_LAYOUT.rowWidth + 8) + 320
/** Space kept clear above the bottom edge for the FocusedPlayer card, the PlaybackPanel and its timeline. */
export const BOTTOM_CONTROLS_CLEARANCE = 136
/** Viewports shorter than this have no free spot for the POV weapon HUD. */
export const SHORT_VIEWPORT = 500
/** Below this width the POV weapon HUD's box (right 16 px, 220 px wide) reaches over the PlaybackPanel pill. */
export const POV_HUD_RAISE_BELOW = 1024

export interface Viewport {
  w: number
  h: number
}

const read = (): Viewport => ({ w: window.innerWidth, h: window.innerHeight })

/** innerWidth and innerHeight, updated on resize. */
export function useViewport(): Viewport {
  const [vp, setVp] = useState(read)
  useEventListener('resize', () => setVp(prev => {
    const next = read()
    return next.w === prev.w && next.h === prev.h ? prev : next
  }), window)
  return vp
}

/** Bottom edge (px from the top) of the taller player column with its medic panels. */
export function columnsBottom(snap: HudSnapshot | null, medicPanels: boolean): number {
  const side = (rows: number, medics: number) =>
    (rows > 0 ? rows * HUD_LAYOUT.rowHeight + (rows - 1) * HUD_LAYOUT.rowGap : 0) +
    (rows > 0 && medics > 0 ? 4 + medics * HUD_LAYOUT.medicRowHeight + (medics - 1) * HUD_LAYOUT.rowGap : 0)
  const blue = snap ? side(snap.rows.blue.length, medicPanels ? snap.medics.blue.length : 0) : 0
  const red = snap ? side(snap.rows.red.length, medicPanels ? snap.medics.red.length : 0) : 0
  return HUD_LAYOUT.columnTop + Math.max(blue, red, 9 * HUD_LAYOUT.rowHeight + 8 * HUD_LAYOUT.rowGap)
}
