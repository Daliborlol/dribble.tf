// The killfeed and player-list HUD blocks, moved out of DemoViewer unchanged (contract section 6.1).
// F5 owns this file afterwards (9v9 layout, MedicPanel placement).

import { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { CachedPlayer } from '@components/Analyse/Data/PlayerCache'
import { Killfeed } from '@components/UI/Killfeed'
import { PlayerStatuses } from '@components/UI/PlayerStatuses'

export interface HudLayoutProps {
  demo?: AsyncParser
  tick: number
  renderTick: number
  players: CachedPlayer[]
  intervalPerTick: number
}

export const HudLayout = (props: HudLayoutProps) => {
  const { demo, tick, players, intervalPerTick } = props

  return (
    <>
      <div className="ui-layer m-4 items-start justify-end">
        <div className="flex flex-col items-end gap-2">
          {demo && <Killfeed parser={demo} tick={tick} />}
        </div>
      </div>

      {players.length > 0 && (
        <div className="ui-layer items-center justify-stretch">
          <PlayerStatuses players={players} tick={tick} intervalPerTick={intervalPerTick} />
        </div>
      )}
    </>
  )
}
