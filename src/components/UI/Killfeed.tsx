import React, { useMemo, useState } from 'react'
import { inRange } from 'lodash'

import { AsyncParser, CachedDeath } from '@components/Analyse/Data/AsyncParser'
import { KILL_ICON_ALIASES } from '@constants/killIconAliases'

import { jumpToPlayerPOVCamera } from '@zus/actions'
import { useInstance } from '@zus/store'
import { focusMainCanvas } from '@utils/misc'
import { cn } from '@utils/styling'
import { useIsMobile } from '@utils/hooks'

import { TEAM_HUD } from '@highlander/constants'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { KILLFEED_LINGER_TICKS, killfeedModel, SKULL_ICON, type FeedActor, type KillfeedLine } from '@highlander/hud/killfeedModel'
import { lowerBoundOf } from '@highlander/objectives/deaths'
import { KillIcon } from '@highlander/objectives/glyphs'
import { HUD_LAYOUT } from '@highlander/objectives/layout'
import { bannerOpacity } from '@highlander/objectives/banner'
import { useHudSelect } from '@highlander/hud/hudSnapshot'
import { BOTTOM_CONTROLS_CLEARANCE, columnsBottom, KILLFEED_SQUEEZE_BELOW, useViewport } from '@highlander/hud/responsive'

//
// ─── LEGACY KILLFEED (Highlander disabled) ──────────────────────────────────────
//

const RELEVANT_DEATH_LINGER_TICKS = 200 // Keep death in feed for this many ticks

export interface KillfeedProps {
  parser: AsyncParser
  tick: number
}

export interface KillfeedItemProps {
  death: CachedDeath
  highlighted?: boolean
}

export const Killfeed = (props: KillfeedProps) => {
  const focusedObject = useInstance(state => state.focusedObject)
  const isMobile = useIsMobile()
  const { parser, tick } = props
  const { deaths } = parser

  let relevantDeaths: CachedDeath[] = []

  for (const deathTickKey in deaths) {
    const deathTick = Number(deathTickKey)
    if (inRange(tick, deathTick, deathTick + RELEVANT_DEATH_LINGER_TICKS)) {
      relevantDeaths = relevantDeaths.concat(deaths[deathTickKey])
    }
  }

  // Limit to 3 kills on mobile to save space
  if (isMobile) {
    relevantDeaths = relevantDeaths.slice(-3)
  }

  return (
    <div className={cn('flex flex-col items-end text-right', isMobile && 'text-xs')}>
      {relevantDeaths.map(death => {
        let highlighted = false

        if (focusedObject) {
          highlighted = [death.killer?.user.entityId, death.assister?.user.entityId].includes(
            focusedObject.userData.entityId
          )
        }

        return (
          <KillfeedItem
            key={`killfeed-item-${death.tick}-${death.victim.user.entityId}`}
            death={death}
            highlighted={highlighted}
          />
        )
      })}
    </div>
  )
}

export const KillfeedItem = (props: KillfeedItemProps) => {
  const { killer, assister, victim, weapon } = props.death

  let iconName = KILL_ICON_ALIASES[weapon] || weapon
  let [weaponIcon, setWeaponIcon] = useState(
    new URL(`/src/assets/kill_icons/${iconName}.png`, import.meta.url).href
  )

  const teamTextColorMap: { [key: string]: string } = {
    red: 'text-pp-killfeed-text-red',
    blue: 'text-pp-killfeed-text-blue',
  }
  let killerTeamColor = killer ? teamTextColorMap[killer.user.team] : ''
  let victimTeamColor = teamTextColorMap[victim?.user.team]

  const onWeaponIconImgError = () => {
    console.log(`Missing kill icon: ${iconName}`)
    setWeaponIcon(new URL(`/src/assets/kill_icons/skull.png`, import.meta.url).href)
  }

  const onClickPlayerName = (entityId: number) => {
    jumpToPlayerPOVCamera(entityId)
    focusMainCanvas()
  }

  return (
    <div
      className={cn(
        'mb-2 flex rounded-xl bg-pp-panel/70 px-5 py-2 font-bold',
        props.highlighted && 'bg-white/90'
      )}
    >
      {killer && killer !== victim && (
        <div
          className={cn('cursor-pointer hover:underline active:underline', killerTeamColor)}
          onClick={onClickPlayerName.bind(this, killer.user.entityId)}
        >
          {killer.user.name}
        </div>
      )}

      {assister && <div className={cn('mx-2', killerTeamColor)}>+</div>}

      {assister && (
        <div
          className={cn('cursor-pointer hover:underline active:underline', killerTeamColor)}
          onClick={onClickPlayerName.bind(this, assister.user.entityId)}
        >
          {assister.user.name}
        </div>
      )}

      <div className="inline-flex items-center px-4">
        <img
          src={weaponIcon}
          className={cn('h-[1.2rem] ', props.highlighted ? '' : 'brightness-[600%]')}
          alt={`${weapon} Icon`}
          onError={onWeaponIconImgError}
        />
      </div>

      <div
        className={cn('cursor-pointer hover:underline active:underline', victimTeamColor)}
        onClick={onClickPlayerName.bind(this, victim.user.entityId)}
      >
        {victim.user.name}
      </div>
    </div>
  )
}

//
// ─── HIGHLANDER KILLFEED (contract section 5 F5) ────────────────────────────────
//
// Lines come from base deaths annotated with extras kill events (crit, headshot and backstab icons, DOM / REV
// badges, Dead Ringer feigns hidden unless hud.killfeedFeignDeaths), plus building and capture lines with
// hud.killfeedObjectives. Newest hud.killfeedMaxLines lines (3 on mobile), 30 px each, linger 200 ticks.
// Desktop: top 96 px, right 248 px (between the player columns); below 1280 px wide: top 88 px, centred. While
// the round banner shows, the killfeed starts below it. From 768 to 943 px wide the gap between the columns is
// under 320 px: the killfeed goes below the taller column at full width when the viewport has room for it, else it
// stays between the columns with 3 compact lines (hud/responsive.ts). Below 1280 px a line never grows wider than
// the killfeed; its names truncate instead. Name colours are the team at the kill tick.

const TEAM_TEXT: Record<number, string> = { 2: 'text-pp-killfeed-text-red', 3: 'text-pp-killfeed-text-blue' }

const onClickName = (entityId: number) => {
  jumpToPlayerPOVCamera(entityId)
  focusMainCanvas()
}

export const HlKillfeed = React.memo(() => {
  const demo = useInstance(s => s.parsedDemo)
  const x = useExtras()
  const maxLines = useHlSetting<number>('hud.killfeedMaxLines') ?? 6
  const feign = useHlSetting<boolean>('hud.killfeedFeignDeaths')
  const objectives = useHlSetting<boolean>('hud.killfeedObjectives')
  const bannerOn = useHlSetting<boolean>('hud.roundBanner')
  const focusedEntityId = useInstance(s => s.focusedObject?.userData?.entityId as number | undefined)
  const isMobile = useIsMobile()
  const narrow = useIsMobile(HUD_LAYOUT.killfeedNarrowBelow)
  const medicPanels = useHlSetting<boolean>('hud.medicPanel')
  const compactStatuses = useHlSetting<boolean>('hud.compactStatuses')
  // as/tflook: without player columns the killfeed takes the top right corner, as in TF2
  const noColumns = useHlSetting<boolean>('view.playerColumns') === false
  const vp = useViewport()

  const model = useMemo(
    () => (demo ? killfeedModel(demo, x, { feign: !!feign, objectives: !!objectives }) : null),
    [demo, x, feign, objectives]
  )
  // 768 to 943 px wide: below the columns when there is room for every line, else 3 compact lines between them
  // only next to the compact columns (hud.compactStatuses off shows the old player list, whose geometry differs)
  const squeezed = !isMobile && !noColumns && !!compactStatuses && vp.w < KILLFEED_SQUEEZE_BELOW
  const desktopLines = Math.max(1, maxLines)
  // What the feed takes from the tick, as one primitive: it renders when a line enters or leaves the visible window
  // (same rule as killfeedLinesAt), when the banner shows or goes and when the columns' height changes
  const tickKey = useHudSelect((snap, renderTick) => {
    const end = model ? lowerBoundOf(model.ticks, renderTick + 1) : 0
    const start = model ? lowerBoundOf(model.ticks, renderTick - KILLFEED_LINGER_TICKS + 1) : 0
    const banner = snap?.banner
    const shown = !!bannerOn && !!banner && bannerOpacity(banner.eventTick, renderTick) > 0
    return `${start}|${end}|${shown ? 1 : 0}|${squeezed ? columnsBottom(snap, !!medicPanels) + 8 : 0}`
  })
  const [start, end, bannerFlag, belowTop] = useMemo(() => tickKey.split('|').map(Number), [tickKey])
  const below = squeezed && vp.h - BOTTOM_CONTROLS_CLEARANCE - belowTop >= desktopLines * (HUD_LAYOUT.killfeedLineHeight + HUD_LAYOUT.killfeedLineGap)
  const compactFeed = squeezed && !below
  const lineCount = isMobile || compactFeed ? 3 : desktopLines
  const lines = useMemo(
    () => (model ? model.lines.slice(Math.max(start, end - lineCount), end) : []),
    [model, start, end, lineCount]
  )

  if (!model || lines.length === 0) return null

  const bannerShown = bannerFlag === 1
  const top = bannerShown ? HUD_LAYOUT.killfeedBelowBanner : narrow ? HUD_LAYOUT.killfeedNarrowTop : HUD_LAYOUT.killfeedTop

  // mobile: below the toolbar row and the reduced objective HUD (and below the banner while it shows)
  const style: React.CSSProperties = isMobile
    ? { right: 8, top: bannerShown ? HUD_LAYOUT.mobileKillfeedBelowBanner : HUD_LAYOUT.mobileKillfeedTop, maxWidth: 'calc(100vw - 16px)' }
    : below
      ? { top: belowTop, left: '50%', transform: 'translateX(-50%)', width: 'max-content', maxWidth: 'calc(100vw - 16px)' }
    : noColumns
      ? { top, right: 16, maxWidth: 'calc(100vw - 32px)' }
    : narrow
      ? { top, left: '50%', transform: 'translateX(-50%)', maxWidth: `calc(100vw - ${2 * (HUD_LAYOUT.bluLeft + HUD_LAYOUT.rowWidth + 8)}px)` }
      : { top, right: HUD_LAYOUT.killfeedRight, maxWidth: `calc(100vw - ${HUD_LAYOUT.killfeedRight + HUD_LAYOUT.bluLeft + HUD_LAYOUT.rowWidth + 8}px)` }

  return (
    <div
      data-hl-layout="killfeed"
      className={cn('absolute flex select-none flex-col', narrow && !isMobile && !noColumns ? 'items-center' : 'items-end', (isMobile || compactFeed) && 'text-xs')}
      style={{ ...style, gap: HUD_LAYOUT.killfeedLineGap }}
    >
      {lines.map(line => (
        <FeedLine key={line.key} line={line} fit={narrow || isMobile} compact={compactFeed} highlighted={focusedEntityId !== undefined && isInvolved(line, focusedEntityId)} />
      ))}
    </div>
  )
})

const isInvolved = (line: KillfeedLine, entityId: number) =>
  line.killer?.entityId === entityId || line.assister?.entityId === entityId

const Name = ({ actor, className }: { actor: FeedActor; className?: string }) => (
  <span
    className={cn('min-w-0 max-w-[170px] cursor-pointer truncate hover:underline', TEAM_TEXT[actor.team], className)}
    onClick={() => onClickName(actor.entityId)}
    title={actor.name}
  >
    {actor.name}
  </span>
)

const Badge = ({ text, title }: { text: string; title: string }) => (
  <span title={title} className="ml-1 rounded-sm bg-white/15 px-[3px] py-[1px] text-[9px] font-black tracking-wide text-white/90">
    {text}
  </span>
)

const FeedLine = React.memo(({ line, highlighted, fit, compact }: { line: KillfeedLine; highlighted: boolean; fit?: boolean; compact?: boolean }) => {
  const base = cn(
    'pointer-events-auto flex shrink-0 items-center whitespace-nowrap rounded-lg',
    // the font size before leading-none: tailwind-merge drops a leading-* class that precedes a text-[size]
    compact ? 'px-2 text-[11px]' : 'px-3 text-[13px]',
    'font-bold leading-none',
    // below 1280 px wide the killfeed can be narrower than a line: the line keeps to it and its names truncate
    fit && 'max-w-full',
    highlighted ? 'bg-white/90' : 'bg-pp-panel/75',
    line.feign && 'opacity-60'
  )
  const style = { height: HUD_LAYOUT.killfeedLineHeight }

  if (line.kind === 'capture') {
    const color = line.team === 2 ? TEAM_HUD.red : line.team === 3 ? TEAM_HUD.blue : '#aaa'
    return (
      <div className={base} style={style}>
        <svg width={12} height={14} viewBox="0 0 12 14" className="mr-2 shrink-0" aria-hidden="true">
          <path d="M1.5 1 V13.5" stroke="#ddd" strokeWidth="1.5" />
          <path d="M2.2 1.5 H11 L8.6 4.5 L11 7.5 H2.2 Z" fill={color} />
        </svg>
        <span className={cn('truncate', TEAM_TEXT[line.team])}>{line.text}</span>
      </div>
    )
  }

  return (
    <div className={base} style={style}>
      {line.killer && <Name actor={line.killer} />}
      {line.assister && (
        <>
          <span className={cn('mx-1', TEAM_TEXT[line.killer?.team ?? 0])}>+</span>
          <Name actor={line.assister} />
        </>
      )}
      <span className={cn('inline-flex shrink-0 items-center', compact ? 'px-1.5' : 'px-3')}>
        <KillIcon src={line.icon || SKULL_ICON} alt={line.iconName} crit={line.crit} bright={!highlighted} className="h-[1.1rem]" />
        {line.hsBadge && <Badge text="HS" title="Headshot" />}
        {line.dom && <Badge text="DOM" title="Domination" />}
        {line.rev && <Badge text="REV" title="Revenge" />}
        {line.feign && <Badge text="FAKE" title="Dead Ringer feign death" />}
      </span>
      {line.kind === 'building' ? (
        <span className={cn('min-w-0 max-w-[200px] truncate', TEAM_TEXT[line.team])}>{line.victimLabel}</span>
      ) : (
        line.victim && <Name actor={line.victim} />
      )}
    </div>
  )
})
