// Root of every Highlander HUD widget (contract section 6.4). Mounted right before <PanelToolbar />.
// The notices always render (they explain why Highlander data is missing); the widgets only while enabled.

import React from 'react'

import { useHlSetting } from '@highlander/extras/hooks'
import { ExtrasNotice } from '@highlander/hud/widgets/ExtrasNotice'
import { MapNotice } from '@highlander/hud/widgets/MapNotice'
import { ObjectiveHud } from '@highlander/hud/widgets/ObjectiveHud'
import { PovWeaponHud } from '@highlander/hud/widgets/PovWeaponHud'
import { RoundBanner } from '@highlander/hud/widgets/RoundBanner'
import { Scoreboard } from '@highlander/hud/widgets/Scoreboard'
import { ScopeOverlay } from '@highlander/hud/widgets/ScopeOverlay'

export const HighlanderHud = React.memo(({ renderTick }: { renderTick: number }) => {
  const enabled = useHlSetting<boolean>('enabled')
  return (
    <>
      <ExtrasNotice renderTick={renderTick} />
      <MapNotice renderTick={renderTick} />
      {enabled && (
        <>
          <div className="ui-layer pointer-events-none items-start justify-center"><ObjectiveHud renderTick={renderTick} /></div>
          <div className="ui-layer pointer-events-none items-start justify-center"><div className="mt-[84px]"><RoundBanner renderTick={renderTick} /></div></div>
          <div className="ui-layer pointer-events-none"><ScopeOverlay renderTick={renderTick} /></div>
          <div className="ui-layer pointer-events-none items-end justify-end"><div className="mb-28 mr-4"><PovWeaponHud renderTick={renderTick} /></div></div>
          <div className="ui-layer pointer-events-none items-center justify-center"><Scoreboard renderTick={renderTick} /></div>
        </>
      )}
    </>
  )
})
