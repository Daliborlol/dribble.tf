// Objective HUD (contract section 5 F5): top 8 px, centred, at most 560 x 72 px. Three rows:
//   1. TeamHeader: names and scores (games in stopwatch), the round timer or "Game N, half H" in the centre
//   2. the mode content: KOTH clocks around the point, the payload bar, control point icons or tug of war bars
//   3. one line of text: the stopwatch line, the KOTH unlock countdown or the cart rollback warning
// Every value comes from the HUD snapshot (ObjectiveView); this component calls no getter. On mobile it shrinks
// to the timer and the progress at 0.75 scale.

import React from 'react'

import { useIsMobile } from '@utils/hooks'
import { TEAM_HUD } from '@highlander/constants'
import { useHlSetting } from '@highlander/extras/hooks'
import { useHudSnapshot } from '@highlander/hud/hudSnapshot'
import { TeamHeader } from '@highlander/hud/widgets/TeamHeader'
import { prettyPointName } from '@highlander/objectives/format'
import { CartIcon, Chevron, PointIcon } from '@highlander/objectives/glyphs'
import { HUD_LAYOUT } from '@highlander/objectives/layout'
import type { ClockView, ObjectiveView, PayloadView, PointView, TowView } from '@highlander/objectives/objectiveModel'

const NEUTRAL_FILL = '#5a5a5a'
const teamColor = (team: number) => (team === 2 ? TEAM_HUD.red : team === 3 ? TEAM_HUD.blue : NEUTRAL_FILL)
const SHADOW = '[text-shadow:0_1px_2px_rgb(0_0_0_/_0.85)]'

export const ObjectiveHud = React.memo(({ renderTick }: { renderTick: number }) => {
  const snap = useHudSnapshot(renderTick)
  const on = useHlSetting<boolean>('hud.objective')
  const isMobile = useIsMobile()
  const view = snap?.objective
  if (!on || !view || (view.mode === 'none' && !view.timer)) return null
  return <ObjectiveHudView view={view} mobile={isMobile} />
})

const ObjectiveHudView = React.memo(({ view, mobile }: { view: ObjectiveView; mobile: boolean }) => {
  const timer = <TimerText view={view} />
  const stopwatch = view.header.stopwatch
  // KOTH has no round timer: its centre slot shows the unlock countdown or OVERTIME
  const unlockIn = view.koth?.point?.unlockIn ?? null
  const center = stopwatch ? (
    <span className={`text-[12px] font-bold uppercase tracking-wide text-white/90 ${SHADOW}`}>{view.header.center}</span>
  ) : view.mode === 'koth' ? (
    view.overtime ? (
      <OvertimeText on={view.overtimeOn} />
    ) : unlockIn !== null ? (
      <span className={`text-[12px] font-bold text-white/90 ${SHADOW}`}>unlocks in {Math.ceil(unlockIn)}</span>
    ) : null
  ) : (
    timer
  )
  // the third line: the stopwatch text and the rollback warning
  const notes: React.ReactNode[] = []
  if (view.payload?.recedeIn != null) {
    notes.push(
      <span key="recede" className="text-[#ff8a80]">
        Cart rolling back in {Math.ceil(view.payload.recedeIn)}
      </span>
    )
  }
  if (view.stopwatch?.line) notes.push(<span key="sw">{view.stopwatch.line}</span>)

  const modeRow =
    view.mode === 'koth' && view.koth ? (
      <KothRow koth={view.koth} />
    ) : view.mode === 'payload' && view.payload ? (
      <div className="flex w-full items-center gap-[8px] px-[4px]">
        {stopwatch && <span className="shrink-0">{timer}</span>}
        <PayloadBar payload={view.payload} />
      </div>
    ) : view.mode === 'cp' && view.points ? (
      <div className="flex items-center gap-[10px]">
        {stopwatch && timer}
        <PointsRow points={view.points} />
      </div>
    ) : view.mode === 'tow' && view.tow ? (
      <TowRow tow={view.tow} />
    ) : null

  if (mobile) {
    // below the mobile toolbar row: the timer and the progress only, at 0.75 scale
    const progress =
      view.mode === 'koth' && view.koth ? (
        <KothRow koth={view.koth} />
      ) : view.mode === 'payload' && view.payload ? (
        <div className="flex w-[300px] items-center gap-[8px]">
          <span className="shrink-0">{timer}</span>
          <PayloadBar payload={view.payload} />
        </div>
      ) : view.mode === 'cp' && view.points ? (
        <div className="flex items-center gap-[10px]">
          {timer}
          <PointsRow points={view.points} />
        </div>
      ) : view.mode === 'tow' && view.tow ? (
        <div className="flex flex-col items-center">
          {timer}
          <TowRow tow={view.tow} />
        </div>
      ) : (
        timer
      )
    return (
      <div
        data-hl-layout="objective"
        className="flex origin-top scale-75 flex-col items-center rounded-lg px-2 py-1"
        style={{ marginTop: HUD_LAYOUT.mobileObjectiveTop, background: 'rgb(18 18 18 / 0.97)' }}
      >
        {progress}
      </div>
    )
  }

  return (
    <div
      data-hl-layout="objective"
      className="flex select-none flex-col items-center gap-[1px] overflow-hidden rounded-lg px-[8px] py-[2px]"
      style={{
        marginTop: HUD_LAYOUT.objectiveTop,
        width: HUD_LAYOUT.objectiveWidth,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: HUD_LAYOUT.objectiveHeight,
        background: 'rgb(18 18 18 / 0.97)',
        boxShadow: '0 0 0 1px rgb(255 255 255 / 0.06)',
      }}
    >
      <TeamHeader header={view.header} center={center} />
      {modeRow}
      {notes.length > 0 && (
        <div className={`flex h-[12px] shrink-0 items-center gap-3 whitespace-nowrap text-[11px] font-semibold leading-none text-white/90 ${SHADOW}`}>{notes}</div>
      )}
    </div>
  )
})

const OvertimeText = ({ on }: { on: boolean }) => (
  <span className={`text-[16px] font-black tracking-wider ${SHADOW}`} style={{ color: on ? '#ffd23f' : 'rgb(255 210 63 / 0.35)' }}>
    OVERTIME
  </span>
)

const TimerText = ({ view }: { view: ObjectiveView }) => {
  if (view.overtime && view.mode !== 'koth') return <OvertimeText on={view.overtimeOn} />
  if (!view.timer) return null
  return (
    <span
      className={`whitespace-nowrap text-[18px] font-black tabular-nums leading-none ${SHADOW}`}
      style={{ color: view.timer.setup ? '#ffe36e' : '#ffffff' }}
      title={view.timer.setup ? 'setup' : 'round time'}
    >
      {view.timer.text}
    </span>
  )
}

// ─── KOTH ──────────────────────────────────────────────────────────────────────

const Clock = ({ clock, team }: { clock: ClockView | null; team: number }) => (
  <div className="flex w-[84px] flex-col items-center leading-none">
    <span
      className={`text-[20px] font-black tabular-nums ${SHADOW}`}
      style={{ color: clock?.running ? '#ffffff' : 'rgb(255 255 255 / 0.4)' }}
      title={clock?.running ? 'running' : 'paused'}
    >
      {clock ? clock.text : '--:--'}
    </span>
    <span className="mt-[2px] h-[3px] w-[60px] rounded-full" style={{ background: teamColor(team), opacity: clock?.running ? 1 : 0.4 }} />
  </div>
)

const KothRow = ({ koth }: { koth: NonNullable<ObjectiveView['koth']> }) => (
  <div className="flex h-[36px] items-center gap-[10px]">
    <Clock clock={koth.blu} team={3} />
    {koth.point ? <PointBadge point={koth.point} size={36} label={false} /> : <div className="h-[36px] w-[36px]" />}
    <Clock clock={koth.red} team={2} />
  </div>
)

// ─── control points ────────────────────────────────────────────────────────────

const pointLabel = (p: PointView) => {
  const letter = p.name.match(/\bcap\s+([a-z])\b/i)
  return letter ? letter[1].toUpperCase() : String(p.index + 1)
}

const PointBadge = ({ point, size, label = true }: { point: PointView; size: number; label?: boolean }) => (
  <div
    className="relative shrink-0"
    style={{ width: size, height: size }}
    title={`${point.name ? prettyPointName(point.name, point.index) : `point ${point.index + 1}`}${point.blocked ? ', blocked' : ''}`}
  >
    <PointIcon
      size={size}
      fill={teamColor(point.owner)}
      arcColor={point.capping > 1 ? teamColor(point.capping) : null}
      progress={point.progress}
      locked={point.locked}
      label={label ? pointLabel(point) : undefined}
    />
    {point.cappers > 0 && !point.locked && (
      <span className="absolute -bottom-[3px] -right-[6px] rounded-sm bg-black/75 px-[2px] text-[10px] font-bold leading-[12px] text-white">
        x{point.cappers}
      </span>
    )}
    {point.blocked && (
      <span className="absolute -right-[5px] -top-[3px] flex h-[13px] w-[13px] items-center justify-center rounded-full bg-white ring-1 ring-black/60" title="blocked">
        <svg width={7} height={7} viewBox="0 0 8 8" aria-hidden="true">
          <path d="M1 1 L7 7 M7 1 L1 7" stroke="#b8383b" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
    )}
  </div>
)

const PointsRow = ({ points }: { points: PointView[] }) => (
  <div className="flex h-[33px] items-center gap-[8px]">
    {points.map(p => (
      <PointBadge key={p.index} point={p} size={32} />
    ))}
  </div>
)

// ─── payload ───────────────────────────────────────────────────────────────────

const PayloadBar = ({ payload }: { payload: PayloadView }) => {
  const color = teamColor(payload.attackTeam)
  const pct = (v: number) => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(2)}%`
  const chevrons =
    payload.speed < 0 ? (
      <Chevron size={10} color="#ff3b30" reverse />
    ) : payload.speed > 0 ? (
      <span className="flex">
        {Array.from({ length: Math.min(3, payload.speed) }, (_, i) => (
          <Chevron key={i} size={10} color="#f2f2f2" />
        ))}
      </span>
    ) : null
  // near the right end the cart's label goes to its left
  const flip = payload.progress > 0.8
  return (
    <div className="relative h-[30px] min-w-0 flex-1">
      {/* track */}
      <div className="absolute left-[6px] right-[6px] top-[19px] h-[8px] overflow-hidden rounded-full bg-black/60 ring-1 ring-white/20">
        <div className="absolute inset-y-0 left-0" style={{ width: pct(payload.progress), background: color }} />
      </div>
      <div className="absolute inset-x-[6px] top-0 h-full">
        {/* checkpoints */}
        {payload.checkpoints.map(cp => (
          <span
            key={cp.index}
            className="absolute top-[17px] h-[12px] w-[12px] -translate-x-1/2 rotate-45 rounded-[1px] ring-1 ring-black/70"
            style={{ left: pct(cp.at), background: cp.owner === payload.attackTeam ? color : cp.owner > 1 ? teamColor(cp.owner) : NEUTRAL_FILL }}
            title={`checkpoint ${Math.round(cp.at * 100)} %`}
          />
        ))}
        {/* cart */}
        <div className="absolute -top-[1px] flex items-center gap-[2px]" style={flip ? { right: `calc(${pct(1 - payload.progress)} - 9px)`, flexDirection: 'row-reverse' } : { left: `calc(${pct(payload.progress)} - 9px)` }}>
          <CartIcon size={18} color={color} />
          {payload.cappers !== 0 && (
            <span className={`text-[11px] font-black leading-none ${SHADOW}`} style={{ color: payload.cappers < 0 ? '#ff8a80' : '#ffffff' }}>
              {payload.cappers < 0 ? 'blocked' : `x${payload.cappers}`}
            </span>
          )}
          {chevrons}
        </div>
      </div>
    </div>
  )
}

// ─── tug of war ────────────────────────────────────────────────────────────────

const ScoreBar = ({ value, max, team }: { value: number; max: number; team: number }) => (
  <div className={`flex w-[118px] items-center gap-[6px] ${team === 2 ? 'flex-row-reverse' : ''}`}>
    <span className={`w-[28px] text-center text-[16px] font-black tabular-nums leading-none text-white ${SHADOW}`}>{value}</span>
    <div className="relative h-[8px] flex-1 overflow-hidden rounded-full bg-black/60 ring-1 ring-white/20">
      <div className="absolute inset-y-0" style={{ [team === 2 ? 'right' : 'left']: 0, width: `${Math.min(100, (value / max) * 100)}%`, background: teamColor(team) }} />
    </div>
  </div>
)

/**
 * The cart between the BLU end (left) and the RED end (right). The watcher progress rises while BLU pushes
 * (speed > 0, checked on tow_tetsudo: 883 of 885 one-second steps with speed 2 or 3 moved toward RED) and falls
 * at speed -1 while RED pushes, so the chevrons point the way the cart goes in the pushing team's colour.
 */
const TowRow = ({ tow }: { tow: TowView }) => {
  const width = 220
  const x = tow.progress !== null ? Math.round(tow.progress * width) : null
  const push =
    tow.speed > 0 ? (
      <span className="flex">
        {Array.from({ length: Math.min(3, tow.speed) }, (_, i) => (
          <Chevron key={i} size={10} color={TEAM_HUD.blue} />
        ))}
      </span>
    ) : tow.speed < 0 ? (
      <Chevron size={10} color={TEAM_HUD.red} reverse />
    ) : null
  return (
    <div className="flex h-[30px] items-center gap-[10px]">
      <ScoreBar value={tow.blu} max={tow.max} team={3} />
      <div className="relative h-[30px]" style={{ width }} title="cart position: BLU end left, RED end right">
        <div className="absolute left-0 right-0 top-[19px] h-[6px] rounded-full ring-1 ring-white/20" style={{ background: `linear-gradient(90deg, ${TEAM_HUD.blue}, #555 50%, ${TEAM_HUD.red})` }} />
        {x !== null && (
          <div
            className="absolute -top-[1px] flex items-center gap-[2px]"
            // on the right half the badge and chevrons go to the cart's left, so they stay over the track
            style={x > width * 0.6 ? { right: width - x - 9, flexDirection: 'row-reverse' } : { left: x - 9 }}
          >
            <CartIcon size={18} color="#d6d6d6" />
            {tow.cappers > 0 && <span className={`text-[11px] font-black leading-none text-white ${SHADOW}`}>x{tow.cappers}</span>}
            {push}
          </div>
        )}
      </div>
      <ScoreBar value={tow.red} max={tow.max} team={2} />
    </div>
  )
}

