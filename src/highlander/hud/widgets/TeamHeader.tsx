// Team header (contract section 5 F5), rendered inside ObjectiveHud: team names from the tournament convars
// (RED / BLU when unset; the names follow the players across a stopwatch swap, so the RED side can be called
// "BLU"), and per side the round score, or in stopwatch the games won by the team now on that side. The centre
// slot holds the round timer, or "Game N, half H" in stopwatch.

import React from 'react'

import { TEAM_HUD } from '@highlander/constants'
import type { HeaderSide, HeaderView } from '@highlander/objectives/objectiveModel'

const Side = ({ side, align }: { side: HeaderSide; align: 'left' | 'right' }) => {
  const color = side.team === 2 ? TEAM_HUD.red : TEAM_HUD.blue
  const name = (
    <span
      className="min-w-0 max-w-[150px] truncate rounded-[3px] px-[8px] py-[3px] text-[12px] font-extrabold uppercase leading-none tracking-wide text-white [text-shadow:0_1px_1px_rgb(0_0_0_/_0.5)]"
      style={{ background: color }}
      title={side.name}
    >
      {side.name}
    </span>
  )
  const value = (
    <span className="w-[26px] shrink-0 text-center text-[17px] font-black leading-none text-white [text-shadow:0_1px_2px_rgb(0_0_0_/_0.8)]">
      {side.value}
    </span>
  )
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-[6px] ${align === 'left' ? 'justify-start' : 'flex-row-reverse justify-start'}`}>
      {name}
      {value}
    </div>
  )
}

export const TeamHeader = React.memo(({ header, center }: { header: HeaderView; center: React.ReactNode }) => (
  <div className="flex h-[20px] w-full shrink-0 items-center gap-2">
    <Side side={header.blu} align="left" />
    <div className="flex shrink-0 items-center justify-center whitespace-nowrap">{center}</div>
    <Side side={header.red} align="right" />
  </div>
))
