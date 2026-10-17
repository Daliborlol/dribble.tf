import React from 'react'
import { clamp } from 'lodash'

import { ClassIcon } from '@components/UI/ClassIcon'
import type { NameplateExtra } from '@highlander/scene/actorFx'
import { className } from '@highlander/players/fxState'
import { badgeBorder, CHARGE_BAR_COLOR, CLOAK_BAR_COLOR, tagStyle, useWeaponIconUrl } from '@highlander/players/plate'

import { parseClassHealth } from '@utils/players'
import { cn } from '@utils/styling'

export interface NameplateProps {
  health: number
  classId: number
  name: string
  team: string
  settings: Object | any
  extra?: NameplateExtra // Highlander nameplate items (F1)
}

const NAME_CLASS = cn(
  'max-w-40 overflow-hidden text-ellipsis whitespace-nowrap px-[0.1rem] text-[0.9rem] font-bold leading-none',
  '[text-shadow:0_0_2px_#000000,0_0_2px_#000000,0_0_2px_#000000,0_0_2px_#000000]'
)

export const Nameplate = (props: NameplateProps) => {
  const { health, classId, name, team, settings, extra } = props

  if (!settings.enabled) return null

  // Without Highlander items the plate is exactly the classic one
  if (extra) return <HighlanderNameplate {...props} extra={extra} />

  const { percentage } = parseClassHealth(classId, health)

  return (
    <>
      <div className="pointer-events-none bottom-0 flex select-none flex-col items-center text-center">
        {settings.showName && <div className={NAME_CLASS}>{name}</div>}

        {settings.showHealth && <HealthBar team={team} percentage={percentage} />}

        {settings.showClass && <ClassBadge team={team} classId={classId} />}
      </div>
    </>
  )
}

// Class strings per team, merged once instead of on every render of 18 plates
const byTeam = (make: (team: string) => string) => {
  const cache = new Map<string, string>()
  return (team: string) => {
    let value = cache.get(team)
    if (value === undefined) cache.set(team, (value = make(team)))
    return value
  }
}
const healthFillClass = byTeam(team =>
  cn('absolute inset-0 right-auto', team === 'red' && 'bg-pp-healthbar-red', team === 'blue' && 'bg-pp-healthbar-blue')
)
const classBadgeClass = byTeam(team =>
  cn(
    'mt-1 rounded-full border-[3px] border-black/20',
    team === 'red' && 'bg-pp-healthbar-red',
    team === 'blue' && 'bg-pp-healthbar-blue'
  )
)

const HealthBar = ({ team, percentage }: { team: string; percentage: number }) => (
  <div className="relative mt-1 h-[6px] w-20 overflow-hidden bg-[#8f7b89]">
    <div className={healthFillClass(team)} style={{ width: `${percentage}%` }} />

    <div
      className="absolute inset-0 right-auto bg-[#eeeeee]"
      style={{ width: `${clamp(percentage - 100, 0, 100)}%` }}
    />
  </div>
)

const ClassBadge = ({ team, classId }: { team: string; classId: number }) => (
  <div className={classBadgeClass(team)}>
    <ClassIcon classId={classId} size={16} />
  </div>
)

/** A 40 x 3 px meter (cloak, shield charge) under the health bar. */
const Meter = ({ pct, color, kind }: { pct: number; color: string; kind: 'cloak' | 'charge' }) => (
  <div
    className="relative mt-[2px] h-[3px] w-10 overflow-hidden bg-black/60"
    {...(kind === 'cloak' ? { 'data-hl-cloak': Math.round(pct) } : { 'data-hl-charge': Math.round(pct) })}
  >
    <div className="absolute inset-0 right-auto" style={{ width: `${clamp(pct, 0, 100)}%`, background: color }} />
  </div>
)

/**
 * The nameplate with the Highlander items of contract section 5 F1. drei's Html re-renders every plate on every
 * tick, so the plate body below takes primitive props only and skips rendering while none of them changed.
 */
const HighlanderNameplate = (props: NameplateProps & { extra: NameplateExtra }) => {
  const { health, classId, name, team, settings, extra } = props

  // A spy drawn as his disguise wears the disguise's name, health, class and team
  const shownClass = extra.classOverride ?? classId
  const { percentage } = parseClassHealth(shownClass, extra.healthOverride ?? health)
  const { disguise } = extra

  return (
    <PlateBody
      name={name}
      shownName={extra.nameOverride ?? name}
      shownTeam={extra.teamOverride ?? team}
      shownClass={shownClass}
      percentage={percentage}
      showName={!!settings.showName}
      showHealth={!!settings.showHealth}
      showClass={!!settings.showClass}
      weaponIcon={extra.weaponIcon ?? ''}
      tags={extra.tags ? extra.tags.join(' ') : ''}
      cloakPct={extra.cloakPct === undefined ? -1 : Math.round(extra.cloakPct)}
      chargePct={extra.chargePct === undefined ? -1 : Math.round(extra.chargePct)}
      disguiseCls={disguise ? disguise.cls : -1}
      disguiseTeam={disguise ? disguise.team : 0}
      disguising={!!disguise?.disguising}
    />
  )
}

interface PlateBodyProps {
  name: string
  shownName: string
  shownTeam: string
  shownClass: number
  percentage: number
  showName: boolean
  showHealth: boolean
  showClass: boolean
  weaponIcon: string // '' none
  tags: string // space separated, '' none
  cloakPct: number // -1 none
  chargePct: number // -1 none
  disguiseCls: number // -1 no badge, 0 disguising as an unknown class
  disguiseTeam: number
  disguising: boolean
}

const PlateBody = React.memo((p: PlateBodyProps) => {
  const weaponIconUrl = useWeaponIconUrl(p.weaponIcon || undefined)
  const hasBadge = p.disguiseCls >= 0
  // class 0: disguising without the desired class (no local tables), or a disguise whose class is unknown
  const disguiseLabel = p.disguiseCls > 0 ? `as ${className(p.disguiseCls)}` : p.disguising ? 'disguising' : 'disguised'

  return (
    <div
      className="pointer-events-none bottom-0 flex select-none flex-col items-center text-center"
      data-hl-plate=""
      data-hl-name={p.name}
      data-hl-shown={p.shownName}
      data-hl-team={p.shownTeam}
      data-hl-class={p.shownClass}
    >
      {p.tags && (
        <div className="mb-[2px] flex max-w-48 flex-wrap justify-center gap-[2px]">
          {p.tags.split(' ').map(tag => (
            <span
              key={tag}
              data-hl-tag=""
              className="rounded-sm px-[3px] text-[9px] font-bold leading-[11px]"
              style={tagStyle(tag, p.shownTeam)}
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {(p.showName || weaponIconUrl) && (
        <div className="flex items-center justify-center gap-1">
          {weaponIconUrl && (
            <img
              data-hl-weapon={p.weaponIcon}
              src={weaponIconUrl}
              alt=""
              className="h-[14px] w-auto max-w-[56px] object-contain"
            />
          )}
          {p.showName && <div className={NAME_CLASS}>{p.shownName}</div>}
        </div>
      )}

      {p.showHealth && <HealthBar team={p.shownTeam} percentage={p.percentage} />}

      {p.cloakPct >= 0 && <Meter pct={p.cloakPct} color={CLOAK_BAR_COLOR} kind="cloak" />}

      {p.chargePct >= 0 && <Meter pct={p.chargePct} color={CHARGE_BAR_COLOR} kind="charge" />}

      {(p.showClass || hasBadge) && (
        <div className="flex items-center justify-center gap-1">
          {p.showClass && <ClassBadge team={p.shownTeam} classId={p.shownClass} />}

          {hasBadge && (
            <div
              data-hl-badge=""
              data-hl-badge-team={p.disguiseTeam === 2 ? 'red' : p.disguiseTeam === 3 ? 'blue' : ''}
              className="mt-1 flex items-center gap-[3px] whitespace-nowrap rounded-full bg-black/70 py-[1px] pl-[1px] pr-[6px] text-[10px] font-bold leading-none text-white"
              style={{ opacity: p.disguising ? 0.5 : 1 }}
            >
              {p.disguiseCls > 0 && (
                <div className="rounded-full" style={{ border: `2px solid ${badgeBorder(p.disguiseTeam)}` }}>
                  <ClassIcon classId={p.disguiseCls} size={14} />
                </div>
              )}
              <span className={p.disguiseCls === 0 ? 'pl-[5px]' : undefined}>{disguiseLabel}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
