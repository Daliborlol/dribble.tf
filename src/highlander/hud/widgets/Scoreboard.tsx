// Tab scoreboard (contract section 5 F5, setting hud.scoreboard): a centred 760 px overlay while Tab is held
// (scoreboardOpen, S0 key handler). Two team tables side by side, rows sorted by class order then name, with
// the current class icon. Values at hudTick from the snapshot's scoreboard (objectives/scoreboardModel.ts);
// columns without data in this demo hide.

import React from 'react'

import { ClassIcon } from '@components/UI/ClassIcon'
import { useInstance } from '@zus/store'
import { cn } from '@utils/styling'
import { TEAM_HUD } from '@highlander/constants'
import { useHlSetting } from '@highlander/extras/hooks'
import { useHudSnapshot } from '@highlander/hud/hudSnapshot'
import { formatK } from '@highlander/objectives/format'
import type { HeaderView } from '@highlander/objectives/objectiveModel'
import type { ScoreboardView, ScoreColumns, ScoreRow } from '@highlander/objectives/scoreboardModel'

export const SCOREBOARD_WIDTH = 760
const MAX_CLASS_ICONS = 3

export const Scoreboard = React.memo(() => {
  const open = useInstance(s => s.scoreboardOpen)
  const on = useHlSetting<boolean>('hud.scoreboard')
  if (!open || !on) return null
  return <OpenScoreboard />
})

// Follows the hudTick only while it is open
const OpenScoreboard = () => {
  const snap = useHudSnapshot()
  if (!snap) return null
  return <ScoreboardBox board={snap.scoreboard()} header={snap.objective?.header ?? null} />
}

type ColumnKey = keyof ScoreColumns | 'kills' | 'assists' | 'deaths'
const COLUMNS: { key: ColumnKey; label: string; title: string; width: number }[] = [
  { key: 'kills', label: 'K', title: 'kills', width: 19 },
  { key: 'assists', label: 'A', title: 'assists', width: 19 },
  { key: 'deaths', label: 'D', title: 'deaths', width: 19 },
  { key: 'damage', label: 'DMG', title: 'damage', width: 33 },
  { key: 'heals', label: 'HEAL', title: 'healing', width: 33 },
  { key: 'ubers', label: 'UB', title: 'ubers deployed', width: 17 },
  { key: 'caps', label: 'CAP', title: 'captures', width: 19 },
  { key: 'backstabs', label: 'BS', title: 'backstabs', width: 17 },
  { key: 'headshots', label: 'HS', title: 'headshots', width: 17 },
  { key: 'destroyed', label: 'BLD', title: 'buildings destroyed', width: 19 },
]

const cellText = (row: ScoreRow, key: ColumnKey): string => {
  const v = row[key as keyof ScoreRow]
  if (v === null || v === undefined) return '-'
  if (key === 'damage' || key === 'heals') return formatK(v as number)
  return String(v)
}

/** K, A and D stand out; zeros and missing values fade, so the numbers that matter are easy to find. */
const cellClass = (row: ScoreRow, key: ColumnKey): string => {
  const v = row[key as keyof ScoreRow]
  if (v === null || v === undefined || v === 0) return 'text-white/25'
  return key === 'kills' || key === 'assists' || key === 'deaths' ? 'font-bold text-white' : 'text-white/85'
}

/** Where the numbers come from: K and D leave feigns out only when extras kill events mark them. */
function footerText(board: ScoreboardView): string {
  const parts = [board.sources.kd === 'events' ? 'K and D without Dead Ringer feigns' : 'K and D from base deaths, Dead Ringer feigns included']
  if (board.sources.damage === 'scoring') parts.push("damage and heals from the game's scoreboard")
  else if (board.sources.damage === 'resource') parts.push('damage and heals from the player resource')
  if (board.rosterTick !== board.tick) parts.push('players who finished the match')
  return parts.join(' · ')
}

const ScoreboardBox = React.memo(({ board, header }: { board: ScoreboardView; header: HeaderView | null }) => {
  const columns = COLUMNS.filter(c => c.key === 'kills' || c.key === 'assists' || c.key === 'deaths' || board.columns[c.key as keyof ScoreColumns])
  return (
    <div
      data-hl-layout="scoreboard"
      className="pointer-events-auto flex select-none flex-col gap-2 rounded-xl bg-pp-panel/95 p-3 text-white shadow-2xl"
      style={{ width: SCOREBOARD_WIDTH, maxWidth: 'calc(100vw - 16px)' }}
    >
      <div className="flex gap-2">
        {board.teams.map(team => (
          <TeamTable key={team.team} team={team.team} rows={team.rows} columns={columns} header={header} />
        ))}
      </div>
      <div className="text-center text-[10px] text-white/50">
        {footerText(board)}
      </div>
    </div>
  )
})

const TeamTable = ({ team, rows, columns, header }: { team: number; rows: ScoreRow[]; columns: typeof COLUMNS; header: HeaderView | null }) => {
  const color = team === 2 ? TEAM_HUD.red : TEAM_HUD.blue
  const side = header ? (team === 2 ? header.red : header.blu) : null
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="mb-1 flex h-[26px] items-center justify-between rounded-md px-2" style={{ background: color }}>
        <span className="truncate text-[14px] font-black uppercase tracking-wide">{side?.name ?? (team === 2 ? 'RED' : 'BLU')}</span>
        {side && (
          <span className="text-[15px] font-black" title={header?.stopwatch ? 'stopwatch games won' : 'score'}>
            {side.value}
            {header?.stopwatch && <span className="ml-1 text-[10px] font-semibold opacity-80">games</span>}
          </span>
        )}
      </div>
      <div className="flex h-[16px] items-center px-1 text-[9px] font-bold uppercase text-white/60">
        <span className="w-[19px]" />
        <span className="min-w-0 flex-1">player</span>
        {columns.map(c => (
          <span key={c.key} className="text-center" style={{ width: c.width }} title={c.title}>
            {c.label}
          </span>
        ))}
        <span className="w-[38px] text-right" title="classes played">cls</span>
      </div>
      {rows.map(row => (
        <div
          key={row.entityId}
          className="flex h-[24px] items-center rounded-[3px] px-1 text-[12px] odd:bg-white/[0.06]"
          style={row.alive ? undefined : { opacity: 0.5 }}
          title={row.alive ? undefined : `${row.name} (dead)`}
        >
          <span className="flex w-[19px] shrink-0 items-center">
            <ClassIcon classId={row.classId} size={16} />
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold" title={row.name}>
            {row.name}
          </span>
          {columns.map(c => (
            <span key={c.key} className={cn('shrink-0 text-center tabular-nums', cellClass(row, c.key))} style={{ width: c.width }}>
              {cellText(row, c.key)}
            </span>
          ))}
          <span className="flex w-[38px] shrink-0 items-center justify-end gap-[1px]" title={`classes played: ${row.classes.length}`}>
            {row.classes.length > MAX_CLASS_ICONS && <span className="text-[9px] text-white/60">+{row.classes.length - MAX_CLASS_ICONS + 1}</span>}
            {(row.classes.length > MAX_CLASS_ICONS ? row.classes.slice(0, MAX_CLASS_ICONS - 1) : row.classes).map(cls => (
              <ClassIcon key={cls} classId={cls} size={11} />
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}
