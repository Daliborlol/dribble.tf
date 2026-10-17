// Desktop HUD layout (contract section 5 F5, "Layout"). Pixel positions shared by the widgets and the
// `hud.layout` probe. Elements carry data-hl-layout="<name>" so the probe can measure them.

export const HUD_LAYOUT = {
  /** ObjectiveHud + TeamHeader: top 8 px, centred, at most 560 x 72 px */
  objectiveTop: 8,
  objectiveWidth: 560,
  objectiveHeight: 72,
  /** player columns: BLU at left 72 (clears the toolbar at x 16..56), RED at right 8, both from top 96 */
  columnTop: 96,
  bluLeft: 72,
  redRight: 8,
  rowWidth: 232,
  rowHeight: 26,
  rowGap: 2,
  medicRowHeight: 30,
  /** killfeed: top 96, right 248; below 1280 px wide: top 88, centred */
  killfeedTop: 96,
  killfeedRight: 248,
  killfeedNarrowTop: 88,
  killfeedNarrowBelow: 1280,
  killfeedLineHeight: 30,
  killfeedLineGap: 2,
  /** RoundBanner: top 84 (HighlanderHud's wrapper), centred, 420 px wide, fixed height */
  bannerTop: 84,
  bannerWidth: 420,
  bannerHeight: 56,
  /** while the banner shows, the killfeed starts below it */
  killfeedBelowBanner: 84 + 56 + 8,
} as const

export type HudLayoutName = 'objective' | 'blu-column' | 'red-column' | 'killfeed' | 'banner' | 'scoreboard'
