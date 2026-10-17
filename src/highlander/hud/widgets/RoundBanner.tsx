// Round banner (contract section 5 F5, setting hud.roundBanner): for 330 ticks after each roundWin, fading over
// the last 33, "<team name> wins the round" with the reason in words. After a stopwatch first half it says what
// the next attackers must beat; after a decided stopwatch game, who won it and the games score. HighlanderHud
// places it at top 84 px, centred; it is 420 px wide (narrower when the player columns need the room) and of
// fixed height, so the killfeed can start right below it.

import React from 'react'

import { useIsMobile } from '@utils/hooks'
import { TEAM_HUD } from '@highlander/constants'
import { useHlSetting } from '@highlander/extras/hooks'
import { useHudSnapshot } from '@highlander/hud/hudSnapshot'
import { bannerOpacity, type BannerView } from '@highlander/objectives/banner'
import { HUD_LAYOUT } from '@highlander/objectives/layout'

export const RoundBanner = React.memo(({ renderTick }: { renderTick: number }) => {
  const snap = useHudSnapshot(renderTick)
  const on = useHlSetting<boolean>('hud.roundBanner')
  const isMobile = useIsMobile()
  const banner = snap?.banner
  if (!on || !banner) return null
  const opacity = bannerOpacity(banner.eventTick, renderTick)
  if (opacity <= 0) return null
  return <BannerBox banner={banner} opacity={opacity} mobile={isMobile} />
})

const BannerBox = React.memo(({ banner, opacity, mobile }: { banner: BannerView; opacity: number; mobile: boolean }) => {
  const color = banner.team === 2 ? TEAM_HUD.red : banner.team === 3 ? TEAM_HUD.blue : '#6b6b6b'
  // between the two player columns: 72 + 232 + 8 on each side
  const sideRoom = 2 * (HUD_LAYOUT.bluLeft + HUD_LAYOUT.rowWidth + 8)
  return (
    <div
      data-hl-layout="banner"
      className="flex select-none flex-col items-center justify-center overflow-hidden rounded-lg text-center leading-tight text-white shadow-lg"
      style={{
        width: HUD_LAYOUT.bannerWidth,
        maxWidth: mobile ? 'calc(100vw - 24px)' : `calc(100vw - ${sideRoom}px)`,
        height: HUD_LAYOUT.bannerHeight,
        opacity,
        // on mobile the reduced objective HUD sits lower (below the toolbar row)
        transform: mobile ? 'translateY(32px)' : undefined,
        background: `linear-gradient(180deg, ${color}, ${color}e8)`,
        boxShadow: '0 0 0 1px rgb(0 0 0 / 0.5), 0 6px 16px rgb(0 0 0 / 0.35)',
      }}
    >
      <div className="max-w-full truncate px-3 text-[18px] font-black uppercase tracking-wide [text-shadow:0_1px_2px_rgb(0_0_0_/_0.6)]">
        {banner.title}
      </div>
      {banner.reason && <div className="max-w-full truncate px-3 text-[12px] font-semibold text-white/90">{banner.reason}</div>}
      {banner.sub && <div className="max-w-full truncate px-3 text-[12px] font-bold text-[#ffe36e] [text-shadow:0_1px_1px_rgb(0_0_0_/_0.6)]">{banner.sub}</div>}
    </div>
  )
})
