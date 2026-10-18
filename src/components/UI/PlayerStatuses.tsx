import React from 'react'
import { clamp } from 'lodash'

import { CachedPlayer } from '@components/Analyse/Data/PlayerCache'
import { ClassIcon } from '@components/UI/ClassIcon'
import { CLASS_ORDER_MAP } from '@constants/mappings'

import { sortPlayersByClassId, parseClassHealth } from '@utils/players'
import { focusMainCanvas } from '@utils/misc'
import { cn } from '@utils/styling'
import { useIsMobile } from '@utils/hooks'

import { useInstance } from '@zus/store'
import { jumpToPlayerPOVCamera } from '@zus/actions'

import { TEAM_HUD } from '@highlander/constants'
import { useHlSetting } from '@highlander/extras/hooks'
import { useHudSnapshot, type HudBadges, type HudRow, type MedicRow } from '@highlander/hud/hudSnapshot'
import { MedicPanel } from '@highlander/hud/widgets/MedicPanel'
import { BuildingIcon, CondIcon } from '@highlander/objectives/glyphs'
import { HUD_LAYOUT } from '@highlander/objectives/layout'

//
// ─── LEGACY PLAYER STATUSES (hud.compactStatuses off, or Highlander disabled) ───
//

//
// ─── PLAYER STATUSES ────────────────────────────────────────────────────────────
//

export interface PlayerStatusesProps {
  players: CachedPlayer[]
  tick: number
  intervalPerTick: number
}

export const PlayerStatuses = (props: PlayerStatusesProps) => {
  const isMobile = useIsMobile()
  const bluePlayers: CachedPlayer[] = []
  const redPlayers: CachedPlayer[] = []

  const { players, tick, intervalPerTick } = props
  const focusedEntityId = useInstance(state => state?.focusedObject?.userData?.entityId)

  for (const player of players) {
    if (player.team === 'blue') bluePlayers.push(player)
    if (player.team === 'red') redPlayers.push(player)
  }

  if (isMobile) {
    return (
      <div className="absolute inset-x-0 bottom-0 flex h-8 items-stretch">
        {/* Blue team - left half */}
        <div className="flex flex-1 items-stretch gap-px">
          {bluePlayers.sort(sortPlayersByClassId).map((player, index) => (
            <MobileStatusItem
              key={`blue-mobile-${index}`}
              player={player}
              team="blue"
              focused={focusedEntityId === player.user.entityId}
              tick={tick}
              intervalPerTick={intervalPerTick}
            />
          ))}
        </div>

        {/* Divider */}
        <div className="w-px bg-white/20" />

        {/* Red team - right half */}
        <div className="flex flex-1 items-stretch gap-px">
          {redPlayers.sort(sortPlayersByClassId).map((player, index) => (
            <MobileStatusItem
              key={`red-mobile-${index}`}
              player={player}
              team="red"
              focused={focusedEntityId === player.user.entityId}
              tick={tick}
              intervalPerTick={intervalPerTick}
            />
          ))}
        </div>
      </div>
    )
  }

  const blueMedics = bluePlayers.filter(({ classId }) => classId === 5)
  const redMedics = redPlayers.filter(({ classId }) => classId === 5)

  return (
    <>
      <div className="absolute left-0 mx-[1.5px] flex flex-col items-start gap-[1.5px]">
        {bluePlayers.sort(sortPlayersByClassId).map((player, index) => (
          <StatusItem
            key={`blue-player-status-item-${index}`}
            type="player"
            player={player}
            team="blue"
            alignment="left"
            focused={focusedEntityId === player.user.entityId}
            tick={tick}
            intervalPerTick={intervalPerTick}
          />
        ))}

        {blueMedics.length > 0 ? <div className="h-2" /> : null}

        {blueMedics.map((player, index) => (
          <StatusItem
            key={`blue-uber-status-item-${index}`}
            type="uber"
            player={player}
            team="blue"
            alignment="left"
            tick={tick}
            intervalPerTick={intervalPerTick}
          />
        ))}
      </div>

      <div className="absolute right-0 mx-[1.5px] flex flex-col items-end gap-[1.5px]">
        {redPlayers.sort(sortPlayersByClassId).map((player, index) => (
          <StatusItem
            key={`red-player-status-item-${index}`}
            type="player"
            player={player}
            team="red"
            alignment="right"
            focused={focusedEntityId === player.user.entityId}
            tick={tick}
            intervalPerTick={intervalPerTick}
          />
        ))}

        {redMedics.length > 0 ? <div className="h-2" /> : null}

        {redMedics.map((player, index) => (
          <StatusItem
            key={`red-uber-status-item-${index}`}
            type="uber"
            player={player}
            team="red"
            alignment="right"
            tick={tick}
            intervalPerTick={intervalPerTick}
          />
        ))}
      </div>
    </>
  )
}

//
// ─── MOBILE STATUS ITEM ─────────────────────────────────────────────────────────
//

interface MobileStatusItemProps {
  player: CachedPlayer
  team: 'blue' | 'red'
  focused?: boolean
  tick: number
  intervalPerTick: number
}

const MobileStatusItem = (props: MobileStatusItemProps) => {
  const { player, team, focused, tick, intervalPerTick } = props
  const health = player.health
  const { percentage } = parseClassHealth(player.classId, health)

  const onClickItem = async () => {
    const entityId = player?.user?.entityId || null
    if (entityId) await jumpToPlayerPOVCamera(entityId)
    focusMainCanvas()
  }

  return (
    <div
      className={cn(
        'flex flex-1 cursor-pointer items-center justify-center gap-0.5 text-xs font-semibold',
        team === 'blue' && 'bg-pp-healthbar-blue/40',
        team === 'red' && 'bg-pp-healthbar-red/40',
        health === 0 && 'opacity-40',
        focused && 'outline outline-1 outline-white'
      )}
      onClick={onClickItem}
    >
      <div className="flex h-5 w-5 shrink-0 items-center justify-center">
        <ClassIcon classId={player.classId} />
      </div>
      <span
        className={cn(
          'font-bold',
          percentage > 100 && 'text-pp-health-overhealed',
          percentage < 40 && health > 0 && 'text-pp-health-low'
        )}
      >
        {health > 0 ? health : (
          player.respawnTick != null
            ? Math.ceil((player.respawnTick - tick) * intervalPerTick)
            : ''
        )}
      </span>
    </div>
  )
}

//
// ─── STATUS ITEM ────────────────────────────────────────────────────────────────
//

const STATUS_ITEM_WIDTH = 'w-52'
const STATUS_ITEM_HEIGHT = 'h-9'

export interface StatusItemProps {
  player: CachedPlayer
  type: 'player' | 'uber'
  team: 'blue' | 'red'
  alignment: 'left' | 'right'
  focused?: boolean
  tick: number
  intervalPerTick: number
}

export const StatusItem = (props: StatusItemProps) => {
  const { player, type, team, alignment, focused, tick, intervalPerTick } = props
  let name, health, percentage, icon

  switch (type) {
    case 'player':
      name = player.user.name
      health = player.health
      percentage = parseClassHealth(player.classId, health).percentage
      icon = <ClassIcon classId={player.classId} />
      break

    case 'uber':
      name = 'Charge' // TODO: display medi gun type (requires additional parsing)
      health = player.chargeLevel || 0
      percentage = player.chargeLevel || 0
      break
  }

  const onClickItem = async () => {
    const entityId = player?.user?.entityId || null
    if (entityId) await jumpToPlayerPOVCamera(entityId)
    focusMainCanvas()
  }

  return (
    <>
      <div
        className={cn(
          'flex cursor-pointer items-center bg-pp-panel/40 text-[0.9rem] font-semibold',
          'overflow-hidden rounded-xl transition-all',
          STATUS_ITEM_WIDTH,
          STATUS_ITEM_HEIGHT,
          alignment === 'left' && 'flex-row',
          alignment === 'right' && 'flex-row-reverse',
          focused && 'z-10 outline outline-[3px] outline-white',
          focused && alignment === 'left' && 'translate-x-3',
          focused && alignment === 'right' && '-translate-x-3',
          health === 0 && 'opacity-60'
        )}
        onClick={onClickItem}
      >
        {/* Class Icon */}
        {icon && (
          <div
            className={cn(
              'flex aspect-square shrink-0 items-center justify-center bg-pp-panel/20',
              STATUS_ITEM_HEIGHT
            )}
          >
            {icon}
          </div>
        )}

        <div
          className={cn(
            'relative flex h-full w-full items-center overflow-hidden',
            health > 0 && team === 'red' && 'bg-pp-healthbar-red/50',
            health > 0 && team === 'blue' && 'bg-pp-healthbar-blue/50',
            alignment === 'left' && 'flex-row',
            alignment === 'right' && 'flex-row-reverse'
          )}
        >
          {/* Fill */}
          <div
            className={cn(
              'absolute h-full',
              team === 'red' && 'bg-pp-healthbar-red',
              team === 'blue' && 'bg-pp-healthbar-blue'
            )}
            style={{ width: `${percentage}%` }}
          />

          {/* Overheal */}
          <div
            className="absolute h-full bg-white/40"
            style={{ width: `${clamp(percentage - 100, 0, 100)}%` }}
          ></div>

          {/* Name */}
          <div className="relative overflow-hidden text-ellipsis whitespace-nowrap px-2">
            {name}
          </div>

          {/* Spacer */}
          <div className="flex-1"></div>

          {/* Health */}
          <div
            className={cn(
              'relative w-8 flex-shrink-0 text-center text-[1.1rem] font-bold text-white',
              percentage > 100 && 'text-pp-health-overhealed',
              type === 'player' && percentage < 40 && 'text-pp-health-low'
            )}
          >
            {health > 0 && health}
            {health === 0 && type === 'player' && (
              player.respawnTick != null ? (
                <span className="text-xs text-white opacity-70">
                  {Math.ceil((player.respawnTick - tick) * intervalPerTick)}
                </span>
              ) : (
                <span className="text-xs text-white opacity-70">Dead</span>
              )
            )}
          </div>

          {/* Spacer */}
          <div className="w-1.5" />
        </div>
      </div>
    </>
  )
}

//
// ─── 9V9 PLAYER COLUMNS (contract section 5 F5) ─────────────────────────────────
//
// BLU at left 72 px, RED at right 8 px, both from top 96 px: 26 px rows, 232 px wide, 2 px gap, opaque. The rows
// come from the shared HUD snapshot at hudTick (class, health, respawn, badges); the medic panel sits under each
// column. Rows are keyed by entity id and sorted by class order. RED rows are mirrored (health toward the centre).

const EMPTY_MEDICS: MedicRow[] = []

const byClassOrder = (a: HudRow, b: HudRow) =>
  (CLASS_ORDER_MAP[a.classId] ?? 99) - (CLASS_ORDER_MAP[b.classId] ?? 99) || a.entityId - b.entityId

const jumpToPlayer = (entityId: number) => {
  jumpToPlayerPOVCamera(entityId)
  focusMainCanvas()
}

export const HlPlayerColumns = React.memo(({ renderTick }: { renderTick: number }) => {
  const snap = useHudSnapshot(renderTick)
  const badgesOn = useHlSetting<boolean>('hud.statusBadges')
  const medicOn = useHlSetting<boolean>('hud.medicPanel')
  const focusedEntityId = useInstance(s => s.focusedObject?.userData?.entityId as number | undefined)
  if (!snap) return null
  return (
    <>
      <TeamColumn
        side="blue"
        rows={snap.rows.blue}
        medics={medicOn ? snap.medics.blue : EMPTY_MEDICS}
        badges={badgesOn}
        focusedEntityId={focusedEntityId}
      />
      <TeamColumn
        side="red"
        rows={snap.rows.red}
        medics={medicOn ? snap.medics.red : EMPTY_MEDICS}
        badges={badgesOn}
        focusedEntityId={focusedEntityId}
      />
    </>
  )
})

interface TeamColumnProps {
  side: 'blue' | 'red'
  rows: HudRow[]
  medics: MedicRow[]
  badges: boolean
  focusedEntityId?: number
}

const TeamColumn = ({ side, rows, medics, badges, focusedEntityId }: TeamColumnProps) => {
  if (rows.length === 0) return null
  const sorted = [...rows].sort(byClassOrder)
  const style: React.CSSProperties =
    side === 'blue'
      ? { left: HUD_LAYOUT.bluLeft, top: HUD_LAYOUT.columnTop, width: HUD_LAYOUT.rowWidth, gap: HUD_LAYOUT.rowGap }
      : { right: HUD_LAYOUT.redRight, top: HUD_LAYOUT.columnTop, width: HUD_LAYOUT.rowWidth, gap: HUD_LAYOUT.rowGap }
  return (
    <div data-hl-layout={side === 'blue' ? 'blu-column' : 'red-column'} className="absolute flex select-none flex-col" style={style}>
      {sorted.map(row => (
        <PlayerRow key={row.entityId} row={row} side={side} badges={badges} focused={row.entityId === focusedEntityId} />
      ))}
      {medics.length > 0 && (
        <div className="mt-[4px] flex flex-col" style={{ gap: HUD_LAYOUT.rowGap }}>
          {medics.map(m => (
            <MedicPanel key={m.entityId} medic={m} showName={medics.length > 1} />
          ))}
        </div>
      )}
    </div>
  )
}

interface PlayerRowProps {
  row: HudRow
  side: 'blue' | 'red'
  badges: boolean
  focused: boolean
}

const PlayerRow = React.memo(({ row, side, badges, focused }: PlayerRowProps) => {
  const mirrored = side === 'red'
  const color = side === 'red' ? TEAM_HUD.red : TEAM_HUD.blue
  const share = row.maxHealth > 0 ? row.health / row.maxHealth : 0
  const fill = Math.max(0, Math.min(1, share))
  // overheal goes up to 150 % of max health; draw it as a lighter band over the fill
  const over = Math.max(0, Math.min(1, (row.health - row.maxHealth) / (row.maxHealth * 0.5)))
  const anchor = mirrored ? 'right' : 'left'

  return (
    <div
      title={row.title}
      onClick={() => jumpToPlayer(row.entityId)}
      className={cn(
        'pointer-events-auto relative flex shrink-0 cursor-pointer items-center overflow-hidden rounded-[3px] text-[13px] font-semibold leading-none text-white',
        mirrored && 'flex-row-reverse',
        focused && 'z-10 outline outline-2 outline-white'
      )}
      style={{ height: HUD_LAYOUT.rowHeight, background: row.alive ? 'rgb(18 18 18 / 0.9)' : '#2a2a2a' }}
    >
      {row.alive && <div className="absolute inset-y-0" style={{ [anchor]: 0, width: `${fill * 100}%`, background: color, opacity: 0.85 }} />}
      {row.alive && over > 0 && (
        <div className="absolute inset-y-0" style={{ [anchor]: 0, width: `${over * 100}%`, background: 'rgb(255 255 255 / 0.32)' }} />
      )}

      <div className="relative flex h-full w-[24px] shrink-0 items-center justify-center" style={{ opacity: row.alive ? 1 : 0.5 }}>
        <ClassIcon classId={row.classId} size={18} />
      </div>

      <div
        className={cn('relative min-w-0 flex-1 truncate px-1 [text-shadow:0_1px_1px_rgb(0_0_0_/_0.6)]', mirrored && 'text-right')}
        style={{ opacity: row.alive ? 1 : 0.45 }}
      >
        {row.name}
      </div>

      {badges && row.badges && row.alive && <StatusBadges badges={row.badges} mirrored={mirrored} />}

      <div
        className={cn(
          'relative flex h-full w-[34px] shrink-0 items-center justify-center font-bold [text-shadow:0_1px_1px_rgb(0_0_0_/_0.7)]',
          row.alive ? 'text-[15px]' : 'gap-[2px] text-[17px] text-white/85',
          !row.alive && mirrored && 'flex-row-reverse'
        )}
        style={row.alive && share > 1.001 ? { color: '#9dff80' } : row.alive && share < 0.4 ? { color: '#ffb0a8' } : undefined}
        title={row.alive ? undefined : row.respawn !== null ? `respawns in ${row.respawn} s` : 'dead'}
      >
        {row.alive ? (
          row.health
        ) : (
          <>
            <DeadGlyph />
            {row.respawn ?? ''}
          </>
        )}
      </div>
    </div>
  )
})

/** A small respawn arrow in front of a dead player's respawn seconds (not a skull: that glyph means marked for death). */
const DeadGlyph = () => (
  <svg width={11} height={11} viewBox="0 0 12 12" className="shrink-0 opacity-60" aria-hidden="true">
    <path d="M9.6 4.2 A4.2 4.2 0 1 0 10.1 7.2" stroke="#e5e5e5" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    <path d="M10.8 1.4 L10.4 5 L6.9 4.3 Z" fill="#e5e5e5" />
  </svg>
)

// ─── badges ─────────────────────────────────────────────────────────────────────

const Bar = ({ value, color, title }: { value: number; color: string; title: string }) => (
  <div title={title} className="relative h-[4px] w-[24px] shrink-0 overflow-hidden rounded-sm bg-black/60">
    <div className="absolute inset-y-0 left-0" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
  </div>
)

const Ring = ({ value, color, title }: { value: number; color: string; title: string }) => {
  const r = 5.5
  const c = 2 * Math.PI * r
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" className="shrink-0">
      <title>{title}</title>
      <circle cx="7" cy="7" r={r} fill="rgb(0 0 0 / 0.55)" stroke="rgb(255 255 255 / 0.25)" strokeWidth="2" />
      <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="2" strokeDasharray={`${(c * Math.max(0, Math.min(1, value))).toFixed(2)} ${c.toFixed(2)}`} transform="rotate(-90 7 7)" />
    </svg>
  )
}

const MEDIGUN_LETTER_TITLE: Record<string, string> = { U: 'Medi Gun', K: 'Kritzkrieg', Q: 'Quick-Fix', V: 'Vaccinator' }
const MAX_COND_GLYPHS = 3

const StatusBadges = ({ badges: b, mirrored }: { badges: HudBadges; mirrored: boolean }) => {
  const items: React.ReactNode[] = []
  if (b.medic) {
    items.push(
      <span
        key="medic"
        title={`${MEDIGUN_LETTER_TITLE[b.medic.letter] ?? 'Medigun'} ${b.medic.pct} %${b.medic.ready ? ', ready' : ''}`}
        className={cn('shrink-0 rounded-sm px-[3px] text-[11px] font-bold tabular-nums', b.medic.ready ? 'bg-black/55 text-[#ffe36e]' : 'bg-black/45 text-white')}
        style={b.medic.ready ? { textShadow: '0 0 4px #ffd23f, 0 0 8px #ffd23f' } : undefined}
      >
        {b.medic.pct}% {b.medic.letter}
      </span>
    )
  }
  if (b.cloak !== null) items.push(<Bar key="cloak" value={b.cloak / 100} color={b.cloaked ? '#c4b5fd' : '#e5e7eb'} title={`Cloak ${b.cloak} %${b.cloaked ? ', cloaked' : ''}`} />)
  if (b.disguise) {
    items.push(
      <span
        key="disguise"
        title="Disguised"
        className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-sm"
        style={{ background: b.disguise.team === 2 ? TEAM_HUD.red : b.disguise.team === 3 ? TEAM_HUD.blue : '#555', boxShadow: '0 0 0 1px rgb(0 0 0 / 0.6)' }}
      >
        <ClassIcon classId={b.disguise.cls} size={12} />
      </span>
    )
  }
  if (b.sniper !== null) items.push(<Bar key="sniper" value={b.sniper} color="#7dd3fc" title={`Sniper charge ${Math.round(b.sniper * 150)}`} />)
  for (const [i, building] of b.buildings.entries()) items.push(<BuildingIcon key={`b${i}`} b={building} size={14} />)
  if (b.stickies > 0) {
    items.push(
      <span key="stickies" title={`${b.stickies} stickies out`} className="flex shrink-0 items-center gap-[1px] text-[11px] font-bold">
        <svg width={9} height={9} viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="#e5e7eb" stroke="#000" strokeOpacity="0.5" /></svg>
        {b.stickies}
      </span>
    )
  }
  if (b.rage !== null) {
    items.push(
      <span key="rage" title={`Rage ${b.rage} %`} className="shrink-0 rounded-sm bg-black/45 px-[3px] text-[11px] font-bold tabular-nums" style={{ color: b.rage >= 100 ? '#ffe36e' : '#ffb26b' }}>
        {b.rage}%
      </span>
    )
  }
  if (b.shield !== null) items.push(<Bar key="shield" value={b.shield / 100} color="#fbbf24" title={`Shield charge ${b.shield} %`} />)
  if (b.throwable !== null) items.push(<Ring key="throw" value={b.throwable / 100} color="#a7f3d0" title={`Recharging ${b.throwable} %`} />)
  for (const cond of b.conds.slice(0, MAX_COND_GLYPHS)) items.push(<CondIcon key={cond} cond={cond} size={14} />)
  if (items.length === 0) return null
  return <div className={cn('relative flex shrink-0 items-center gap-[3px] px-[2px]', mirrored && 'flex-row-reverse')}>{items}</div>
}
