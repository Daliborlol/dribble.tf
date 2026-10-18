// Viewport rules for the Highlander HUD between the phone layout (below 768 px wide) and the desktop layout
// (contract section 5 F5 defines 1024 px and wider). The desktop default (1280 px and wider, 600 px and taller)
// keeps the F5 positions; these rules only apply where those positions collide:
//
// - Killfeed, 768 px wide up to KILLFEED_SQUEEZE_BELOW: the gap between the player columns is narrower than a
//   killfeed line. When the viewport is tall enough, the killfeed moves below the taller column, centred, at full
//   width; otherwise (phone landscape) it stays between the columns with 3 compact lines that truncate names.
// - POV weapon HUD: below POV_HUD_RAISE_BELOW px wide its 220 px box would reach over the PlaybackPanel pill and
//   the FocusedPlayer card, so it sits above them. On viewports shorter than SHORT_VIEWPORT the RED column reaches
//   down to its bottom-right spot: from SHORT_VIEWPORT_WIDE px wide (a short desktop window) it moves to the bottom
//   edge left of the RED column, under the killfeed; narrower (phone landscape) there is no free spot, so it is hidden.

import { useState } from 'react'

import { useEventListener } from '@utils/hooks'
import type { HudSnapshot } from '@highlander/hud/hudSnapshot'
import { HUD_LAYOUT } from '@highlander/objectives/layout'

/** The narrow centred killfeed is at most 100vw - 624 px wide; below 944 px that is under 320 px. */
export const KILLFEED_SQUEEZE_BELOW = 2 * (HUD_LAYOUT.bluLeft + HUD_LAYOUT.rowWidth + 8) + 320
/** Space kept clear above the bottom edge for the FocusedPlayer card, the PlaybackPanel and its timeline. */
export const BOTTOM_CONTROLS_CLEARANCE = 136
/** On viewports shorter than this the player columns reach the bottom-right corner (and the playback controls). */
export const SHORT_VIEWPORT = 500
/** Right margin of the POV weapon HUD on a short wide viewport: left of the RED column, under the killfeed. */
export const POV_HUD_SHORT_RIGHT = HUD_LAYOUT.killfeedRight
/**
 * From this width a short viewport (a desktop window with docked devtools) has a free spot for the POV weapon HUD
 * at the bottom, left of the RED column and right of the PlaybackPanel (its timeline, about 482 px wide and
 * centred, is wider than the pill): the HUD box starts at width - POV_HUD_SHORT_RIGHT - 220, the timeline ends at
 * width / 2 + 241. The bottom left is not free: the chat sits there.
 */
export const SHORT_VIEWPORT_WIDE = 2 * (POV_HUD_SHORT_RIGHT + 220 + 8 + 241)
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

/**
 * Bottom edge (px from the top) of the taller player column with its medic panels, as TeamColumn lays it out: the
 * rows, then the column gap plus mt-[4px] before the medic block (MedicPanel is a fixed medicRowHeight tall).
 */
export function columnsBottom(snap: HudSnapshot | null, medicPanels: boolean): number {
  const side = (rows: number, medics: number) =>
    (rows > 0 ? rows * HUD_LAYOUT.rowHeight + (rows - 1) * HUD_LAYOUT.rowGap : 0) +
    (rows > 0 && medics > 0 ? HUD_LAYOUT.rowGap + 4 + medics * HUD_LAYOUT.medicRowHeight + (medics - 1) * HUD_LAYOUT.rowGap : 0)
  const blue = snap ? side(snap.rows.blue.length, medicPanels ? snap.medics.blue.length : 0) : 0
  const red = snap ? side(snap.rows.red.length, medicPanels ? snap.medics.red.length : 0) : 0
  return HUD_LAYOUT.columnTop + Math.max(blue, red, 9 * HUD_LAYOUT.rowHeight + 8 * HUD_LAYOUT.rowGap)
}
