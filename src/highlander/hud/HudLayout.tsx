// The killfeed and player-list HUD blocks (contract sections 6.1 and 5 F5).
//
// Highlander on: the 9v9 layout. Player columns at the screen sides (BLU left of centre at x 72, RED at the right
// edge) from top 96 px with the medic panels underneath, the killfeed between them (top 96 px, right 248 px), all
// fed by the shared HUD snapshot. hud.compactStatuses off keeps the old player list; mobile keeps the bottom
// strip and a 3-line killfeed.
// Highlander off (settings.highlander.enabled false): the pre-Highlander killfeed and player list, unchanged.

import { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { HlKillfeed, Killfeed } from '@components/UI/Killfeed'
import { HlPlayerColumns, PlayerStatuses } from '@components/UI/PlayerStatuses'
import { useIsMobile } from '@utils/hooks'
import { playersAt, renderTickOf, usePlaybackTick } from '@utils/tickData'
import { useHlSetting } from '@highlander/extras/hooks'

import '@highlander/objectives/probes'

export interface HudLayoutProps {
  demo?: AsyncParser
  intervalPerTick: number
}

// The per-tick wrappers of the old player list and killfeed (Highlander off, or hud.compactStatuses off): they keep
// rendering on every tick; the 9v9 HUD does not.
const TickKillfeed = ({ parser }: { parser: AsyncParser }) => <Killfeed parser={parser} tick={usePlaybackTick()} />

const TickPlayerStatuses = ({ demo, intervalPerTick }: { demo?: AsyncParser; intervalPerTick: number }) => {
  const tick = usePlaybackTick()
  const players = demo ? playersAt(demo, renderTickOf(tick)).list : []
  if (players.length === 0) return null
  return (
    <div className="ui-layer items-center justify-stretch">
      <PlayerStatuses players={players} tick={tick} intervalPerTick={intervalPerTick} />
    </div>
  )
}

export const HudLayout = (props: HudLayoutProps) => {
  const { demo, intervalPerTick } = props
  const enabled = useHlSetting<boolean>('enabled')
  const compact = useHlSetting<boolean>('hud.compactStatuses')
  // as/tflook view.playerColumns off hides the player columns (or the old list) with Highlander on
  const playerColumns = useHlSetting<boolean>('view.playerColumns') !== false
  const isMobile = useIsMobile()

  if (!enabled) {
    return (
      <>
        <div className="ui-layer m-4 items-start justify-end">
          <div className="flex flex-col items-end gap-2">
            {demo && <TickKillfeed parser={demo} />}
          </div>
        </div>

        <TickPlayerStatuses demo={demo} intervalPerTick={intervalPerTick} />
      </>
    )
  }

  const columns = compact && !isMobile

  return (
    <>
      {demo && (
        <div className="ui-layer pointer-events-none">
          <HlKillfeed />
        </div>
      )}

      {!playerColumns ? null : columns ? (
        <div className="ui-layer pointer-events-none">
          <HlPlayerColumns />
        </div>
      ) : (
        <TickPlayerStatuses demo={demo} intervalPerTick={intervalPerTick} />
      )}
    </>
  )
}
