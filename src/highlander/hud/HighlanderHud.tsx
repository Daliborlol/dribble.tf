// Root of every Highlander HUD widget (contract section 6.4). Mounted right before <PanelToolbar />.
// The notices always render (they explain why Highlander data is missing); the widgets only while enabled.
// PovWeaponHud: bottom right (mb-28 mr-4); below 1024 px wide raised above the FocusedPlayer card and the
// PlaybackPanel; below 500 px tall at the bottom edge left of the RED column from 1434 px wide, else not shown
// (hud/responsive.ts).

import React from 'react'

import { useHlSetting } from '@highlander/extras/hooks'
import { BOTTOM_CONTROLS_CLEARANCE, POV_HUD_RAISE_BELOW, POV_HUD_SHORT_RIGHT, SHORT_VIEWPORT, SHORT_VIEWPORT_WIDE, useViewport } from '@highlander/hud/responsive'
import { ExtrasNotice } from '@highlander/hud/widgets/ExtrasNotice'
import { MapNotice } from '@highlander/hud/widgets/MapNotice'
import { ObjectiveHud } from '@highlander/hud/widgets/ObjectiveHud'
import { PovWeaponHud } from '@highlander/hud/widgets/PovWeaponHud'
import { RoundBanner } from '@highlander/hud/widgets/RoundBanner'
import { Scoreboard } from '@highlander/hud/widgets/Scoreboard'
import { ScopeOverlay } from '@highlander/hud/widgets/ScopeOverlay'

export const HighlanderHud = React.memo(({ renderTick }: { renderTick: number }) => {
  const enabled = useHlSetting<boolean>('enabled')
  const vp = useViewport()
  const povHud = vp.h < SHORT_VIEWPORT ? (vp.w >= SHORT_VIEWPORT_WIDE ? 'short' : null) : vp.w < POV_HUD_RAISE_BELOW ? 'raised' : 'default'
  return (
    <>
      <ExtrasNotice renderTick={renderTick} />
      <MapNotice renderTick={renderTick} />
      {enabled && (
        <>
          <div className="ui-layer pointer-events-none items-start justify-center"><ObjectiveHud renderTick={renderTick} /></div>
          <div className="ui-layer pointer-events-none items-start justify-center"><div className="mt-[84px]"><RoundBanner renderTick={renderTick} /></div></div>
          <div className="ui-layer pointer-events-none"><ScopeOverlay renderTick={renderTick} /></div>
          {povHud && (
            <div className="ui-layer pointer-events-none items-end justify-end">
              <div
                className={povHud === 'default' ? 'mb-28 mr-4' : povHud === 'raised' ? 'mr-2' : 'mb-4'}
                style={povHud === 'raised' ? { marginBottom: BOTTOM_CONTROLS_CLEARANCE } : povHud === 'short' ? { marginRight: POV_HUD_SHORT_RIGHT } : undefined}
              >
                <PovWeaponHud renderTick={renderTick} />
              </div>
            </div>
          )}
          <div className="ui-layer pointer-events-none items-center justify-center"><Scoreboard renderTick={renderTick} /></div>
        </>
      )}
    </>
  )
})
