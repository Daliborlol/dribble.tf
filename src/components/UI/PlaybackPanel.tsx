import React, { useMemo, useState } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import * as Slider from '@radix-ui/react-slider'
import { motion } from 'framer-motion'

import {
  IoArrowForwardSharpIcon,
  AiFillStepForwardIcon,
  AiFillFastForwardIcon,
  IoMdPauseIcon,
  IoMdPlayIcon,
  BsBookmarkIcon,
  BsBookmarkFillIcon,
  StickerToolIcon,
} from '@components/Misc/Icons'
import { EventHistoryText } from './EventHistoryText'
import { StickerPalette } from './StickerPalette'

import { useInstance, useStore } from '@zus/store'
import {
  changePlaySpeedAction,
  goToTickAction,
  setStickersPanelOpenAction,
  toggleBookmarkAction,
  togglePlaybackAction,
} from '@zus/actions'
import { focusMainCanvas } from '@utils/misc'
import { cn } from '@utils/styling'
import { getDurationFromTicks } from '@utils/parser'
import { useIsMobile } from '@utils/hooks'

import { TEAM_HUD } from '@highlander/constants'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { enabledTimelineMarkers, type TimelineMarker } from '@highlander/objectives/timelineModel'

// Since parser only returns round ends (not round starts) we need to
// account for the humiliation period before it resets
const ROUND_HUMILIATION_BUFFER_TICKS = 300

export const PLAYBACK_SPEED_OPTIONS = [
  { label: '3×', value: 3 },
  { label: '2×', value: 2 },
  { label: '1×', value: 1 },
  { label: '0.5×', value: 0.5 },
  { label: '0.1×', value: 0.1 },
]

interface PlaybackActionProps {
  content: React.ReactNode
  icon: React.ReactNode
  onClick?: () => void
  /**
   * Radix doesn't display tooltips on mobile, so we need a way to force show it
   * https://github.com/radix-ui/primitives/issues/1573
   */
  mobileTooltipBypass?: boolean
}

const PlaybackAction = (props: PlaybackActionProps) => {
  const [open, setOpen] = useState(false)

  let bypassProps = { root: {}, trigger: {} }

  if (props.mobileTooltipBypass) {
    bypassProps = {
      root: { open, onOpenChange: setOpen },
      trigger: {
        onClick: () => setOpen(prevOpen => !prevOpen),
        onFocus: () => setTimeout(() => setOpen(true), 0),
        onBlur: () => setOpen(false),
      },
    }
  }

  return (
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root {...bypassProps.root}>
        <Tooltip.Trigger asChild {...bypassProps.trigger}>
          <div
            className={cn(
              'cursor-pointer opacity-80',
              'transform transition-all hover:scale-125 hover:opacity-100 active:scale-110 active:opacity-100'
            )}
            onClick={props.onClick}
          >
            {props.icon}
          </div>
        </Tooltip.Trigger>

        <Tooltip.Portal>
          <Tooltip.Content sideOffset={5}>
            <div className="rounded-lg bg-pp-panel/90 px-4 py-3">{props.content}</div>
            <Tooltip.Arrow className="fill-pp-panel/90" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

export const PlaybackPanel = () => {
  const parsedDemo = useInstance(state => state.parsedDemo)
  const playback = useStore(state => state.playback)
  const bookmarks = useStore(state => state.bookmarks)
  const lastEventHistory = useStore(state => state.eventHistory)?.[0]
  const stickerDragActive = useStore(state => state.drawing.stickerDrag.active)
  const stickersOpen = useStore(state => state.drawing.stickersPanelOpen)
  const { playing, speed, tick, maxTicks, forceShowPanel } = playback
  const isBookmarked = bookmarks.includes(tick)
  const isMobile = useIsMobile()

  const rounds = useMemo(() => {
    const result = [
      {
        tick: ROUND_HUMILIATION_BUFFER_TICKS,
        winningTeam: parsedDemo?.rounds[0]?.winner || 'none',
        duration: parsedDemo?.rounds[0]?.length,
      },
    ]

    // The last round is always the end of the demo, so we can ignore it
    parsedDemo?.rounds?.slice(0, -1).forEach((round, index) => {
      result.push({
        tick: round.endTick + ROUND_HUMILIATION_BUFFER_TICKS,
        winningTeam: parsedDemo?.rounds[index + 1]?.winner || 'none',
        duration: parsedDemo?.rounds[index + 1]?.length,
      })
    })

    return result
  }, [parsedDemo?.rounds])

  const onClickRound = async (round: any) => {
    await goToTickAction(round.tick)
    focusMainCanvas()
  }

  const togglePlayback = () => {
    togglePlaybackAction()
    focusMainCanvas()
  }

  const changePlaySpeed = (speed: number) => {
    changePlaySpeedAction(speed)
    focusMainCanvas()
  }

  const goToTick = (tick: number) => {
    goToTickAction(tick)
    focusMainCanvas()
  }

  const toggleStickers = () => {
    setStickersPanelOpenAction(!stickersOpen)
  }

  return (
    <div className={cn('group relative m-4 max-w-full rounded-2xl px-6 py-2')}>
      {lastEventHistory && (
        <div className={cn('transition-all', playing ? '-mb-16 delay-700 group-hover:mb-0' : '')}>
          <motion.div
            className="pointer-events-none inline-block rounded-3xl bg-black/70 p-2"
            initial={{ opacity: 1, y: 4 }}
            animate={{ opacity: 0, y: 0 }}
            transition={{ duration: 0.6 }}
            key={`${lastEventHistory.type}.${lastEventHistory.timestamp}`}
          >
            <EventHistoryText {...lastEventHistory} />
          </motion.div>
        </div>
      )}

      <div className="relative mt-4 flex justify-center">
        {!isMobile && (
          <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-4 -translate-x-1/2">
            <motion.div
              className="pointer-events-auto"
              initial={false}
              animate={
                stickersOpen ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 12, scale: 0.96 }
              }
              transition={{ duration: 0.18 }}
            >
              {stickersOpen ? <StickerPalette /> : null}
            </motion.div>
          </div>
        )}

        <div
          className={cn(
            'z-20 flex items-center justify-center rounded-full px-5 py-3 transition-all duration-500',
            isMobile ? 'gap-3' : 'gap-6',
            playing && !forceShowPanel && !stickersOpen
              ? 'scale-90 opacity-0 delay-700'
              : 'bg-black/70 delay-0',
            'group-hover:scale-100 group-hover:bg-black/70 group-hover:opacity-100 group-hover:delay-0'
          )}
        >
          {/* Jump to tick action */}

          {!isMobile && (
            <PlaybackAction
              mobileTooltipBypass
              icon={
                <div className="-mr-1 flex min-w-11 select-none flex-col items-center text-center">
                  <div className="text-xs leading-none">TICK</div>
                  <div className="font-bold leading-none">{tick}</div>
                </div>
              }
              content={
                <div className="text-center">
                  <div>Jump to tick</div>
                  <form
                    className="relative mt-2 text-black"
                    onSubmit={(e: React.ChangeEvent<HTMLFormElement>) => {
                      e.preventDefault()
                      const tickEl = e.target.elements.namedItem('tick') as HTMLInputElement
                      const newTick = Number(tickEl.value)
                      if (isNaN(newTick)) return
                      goToTick(Math.round(newTick))
                    }}
                  >
                    <input
                      type="number"
                      name="tick"
                      className="w-28 rounded bg-white py-1 pl-2 pr-7"
                      placeholder="0"
                    />
                    <button
                      type="submit"
                      className="absolute bottom-0 right-0 top-0 ml-2 flex aspect-square items-center justify-center"
                    >
                      <IoArrowForwardSharpIcon />
                    </button>
                  </form>

                  <div className="mt-2 flex justify-between text-xs opacity-80">
                    <div>Total Ticks</div>
                    <div className="font-bold">{maxTicks}</div>
                  </div>
                </div>
              }
            />
          )}

          {/* Jump to start action */}

          <PlaybackAction
            icon={<AiFillFastForwardIcon width="1.75rem" height="1.75rem" className="rotate-180" />}
            content={<div>Jump to start</div>}
            onClick={goToTick.bind(null, 1)}
          />

          {/* Seek back action */}

          <PlaybackAction
            icon={<AiFillStepForwardIcon width="1.75rem" height="1.75rem" className="rotate-180" />}
            content={
              <div className="grid grid-cols-[auto,auto] gap-x-4 gap-y-1">
                <div className="col-span-2 text-center">Seek back</div>
                <div>1 tick</div>
                <kbd>,</kbd>
                <div>50 ticks</div>
                <kbd>←</kbd>
              </div>
            }
            onClick={goToTick.bind(null, tick - 50)}
          />

          {/* Toggle play / pause action */}

          <PlaybackAction
            icon={
              playing ? (
                <IoMdPauseIcon width="1.75rem" height="1.75rem" />
              ) : (
                <IoMdPlayIcon width="1.75rem" height="1.75rem" />
              )
            }
            content={
              <div>
                Play / Pause <kbd className="ml-2">Space</kbd>
              </div>
            }
            onClick={togglePlayback}
          />

          {/* Seek forward action */}

          <PlaybackAction
            icon={<AiFillStepForwardIcon width="1.75rem" height="1.75rem" />}
            content={
              <div className="grid grid-cols-[auto,auto] gap-x-4 gap-y-1">
                <div className="col-span-2 text-center">Seek forward</div>
                <div>1 tick</div>
                <kbd>.</kbd>
                <div>50 ticks</div>
                <kbd>→</kbd>
              </div>
            }
            onClick={goToTick.bind(null, tick + 50)}
          />

          {/* Jump to end action */}

          <PlaybackAction
            icon={<AiFillFastForwardIcon width="1.75rem" height="1.75rem" />}
            content={<div>Jump to end</div>}
            onClick={goToTick.bind(null, maxTicks)}
          />

          {/* Change play speed action */}

          {!isMobile && (
            <PlaybackAction
              mobileTooltipBypass
              icon={
                <div className="select-none rounded-3xl bg-white/90 px-2 text-sm text-black">
                  {speed}×
                </div>
              }
              content={
                <>
                  <div className="text-center">Playback speed</div>

                  <div
                    className="mt-2 grid gap-1"
                    style={{
                      gridTemplateColumns: `repeat(${PLAYBACK_SPEED_OPTIONS.length}, minmax(0, 1fr))`,
                    }}
                  >
                    {[...PLAYBACK_SPEED_OPTIONS].reverse().map(({ label, value }) => (
                      <button
                        key={`play-speed-option-${label}`}
                        className={cn(
                          'flex-1 rounded border border-transparent px-2 py-1 text-center',
                          'hover:border-white',
                          value === speed && 'bg-white text-black'
                        )}
                        onClick={() => changePlaySpeed(Number(value))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-5 grid grid-cols-[auto,auto] gap-x-4 gap-y-1">
                    <div className="flex justify-start">
                      Increase <kbd className="ml-2">↑</kbd>
                    </div>

                    <div className="flex justify-end">
                      Decrease <kbd className="ml-2">↓</kbd>
                    </div>
                  </div>
                </>
              }
            />
          )}

          {/* Toggle bookmark action */}

          <PlaybackAction
            icon={
              isBookmarked ? (
                <BsBookmarkFillIcon width="1.25rem" height="1.25rem" className="text-amber-400" />
              ) : (
                <BsBookmarkIcon width="1.25rem" height="1.25rem" />
              )
            }
            content={
              <div>
                Toggle bookmark <kbd className="ml-2">B</kbd>
              </div>
            }
            onClick={() => {
              toggleBookmarkAction()
              focusMainCanvas()
            }}
          />

          {/* Sticker toggle */}

          {!isMobile && (
            <PlaybackAction
              icon={
                <div
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-full transition-all',
                    (stickersOpen || stickerDragActive) && 'bg-white text-black opacity-100'
                  )}
                >
                  <StickerToolIcon width="1.7rem" height="1.7rem" />
                </div>
              }
              content={
                <div>
                  Toggle stickers <kbd className="ml-2">G</kbd>
                </div>
              }
              onClick={toggleStickers}
            />
          )}
        </div>
      </div>

      <div className="-ml-[5%] mt-3 w-[110%]">
        {/* Timeline slider */}

        <div className="relative">
          <Slider.Root
            className="relative flex w-full cursor-pointer select-none items-center"
            min={1}
            max={maxTicks}
            value={[tick]}
            step={1}
            onValueChange={([value]) => goToTick(value)}
          >
            <Slider.Track
              className={cn('relative grow rounded-full bg-pp-panel/30', isMobile ? 'h-3' : 'h-2')}
            >
              <Slider.Range className="absolute h-full rounded-full bg-white" />
            </Slider.Track>
          </Slider.Root>

          {/* Highlander timeline markers ([ and ] step through them) */}
          {!isMobile && <HlTimelineMarkers maxTicks={maxTicks} onSeek={goToTick} />}

          {/* Bookmark markers */}
          {bookmarks.map(bookmarkTick => (
            <div
              key={`bookmark-marker-${bookmarkTick}`}
              className="absolute top-1/2 h-3 w-1 -translate-y-1/2 cursor-pointer rounded-sm bg-amber-400 hover:bg-amber-300"
              style={{ left: `${((bookmarkTick - 1) / (maxTicks - 1)) * 100}%` }}
              onClick={() => goToTick(bookmarkTick)}
            />
          ))}
        </div>

        <div className="mt-2 flex items-center justify-between">
          {/* Rounds (Jump to round) */}

          <div className="flex items-center text-sm">
            <div className="text-outline mr-2">Round</div>

            {rounds.map((round, index) => (
              <div
                key={`jump-to-round-${index}`}
                className={cn(
                  'relative mr-2 flex cursor-pointer items-center justify-center overflow-hidden rounded-full bg-pp-panel/40 text-sm hover:opacity-80 active:opacity-80',
                  isMobile ? 'h-8 w-8' : 'h-5 w-5',
                  round.tick <= tick && 'bg-white text-black'
                )}
                onClick={onClickRound.bind(null, round)}
              >
                <span>{index + 1}</span>

                <div
                  className={cn(
                    'absolute -bottom-2 -right-2 h-4 w-4 rotate-45',
                    round.winningTeam === 'red' && 'bg-pp-killfeed-text-red',
                    round.winningTeam === 'blue' && 'bg-pp-killfeed-text-blue'
                  )}
                />
              </div>
            ))}
          </div>

          {/* Duration (Current Time / Total Time) */}

          <div className="text-outline text-sm">
            {getDurationFromTicks(tick).formatted} / {getDurationFromTicks(maxTicks).formatted}
          </div>
        </div>
      </div>
    </div>
  )
}

//
// ─── HIGHLANDER TIMELINE MARKERS (contract section 5 F5) ───────────────────────
//
// Markers by category, each with its own setting: medic (uber pops, medic drops), objective (captures, round
// wins, overtime, setup end), spy (backstabs, Dead Ringer feigns, sappers, decloaks) and engineer (sentries built
// and destroyed). They sit just above the slider at playback tick = cache tick + 2; hovering shows the clock
// time and what happened, clicking seeks there. Memoized: the list only changes with the extras or the toggles.

const MARKER_SIZE = 9

const markerColor = (m: TimelineMarker) =>
  m.team === 2 ? TEAM_HUD.red : m.team === 3 ? TEAM_HUD.blue : m.shape === 'overtime' ? '#ffd23f' : '#e5e7eb'

const MarkerShape = ({ m }: { m: TimelineMarker }) => {
  const c = markerColor(m)
  const s = MARKER_SIZE
  const stroke = { stroke: '#000', strokeOpacity: 0.6, strokeWidth: 0.8 }
  switch (m.shape) {
    case 'uber':
      return <svg width={s} height={s} viewBox="0 0 10 10"><path d="M5 1 L9.5 9 H0.5 Z" fill={c} {...stroke} /></svg>
    case 'drop':
      return <svg width={s} height={s} viewBox="0 0 10 10"><path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke={c} strokeWidth="2.4" strokeLinecap="round" /></svg>
    case 'capture':
      return <svg width={s} height={s + 2} viewBox="0 0 10 12"><path d="M1.5 0.5 V11.5" stroke="#e5e7eb" strokeWidth="1.3" /><path d="M2 1 H9.5 L7.5 3.5 L9.5 6 H2 Z" fill={c} /></svg>
    case 'roundWin':
      return <svg width={4} height={18} viewBox="0 0 4 18"><rect x="0.5" y="0" width="3" height="18" rx="1" fill={c} {...stroke} /></svg>
    case 'overtime':
      return <svg width={s} height={s} viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.6" fill="none" stroke={c} strokeWidth="1.8" /></svg>
    case 'setup':
      return <svg width={4} height={s + 2} viewBox="0 0 4 12"><rect x="1" y="0" width="2" height="12" fill="#e5e7eb" /></svg>
    case 'backstab':
      return <svg width={s} height={s} viewBox="0 0 10 10"><path d="M1 9 L7.5 2.5 L9 1 L8.2 3.6 L2.2 9.6 Z" fill={c} {...stroke} /></svg>
    case 'feign':
      return <svg width={s} height={s} viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.8" fill="none" stroke={c} strokeWidth="1.4" strokeDasharray="2 1.5" /></svg>
    case 'sapped':
      return <svg width={s} height={s} viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" fill={c} {...stroke} /><path d="M3 5 H7" stroke="#111" strokeWidth="1.4" /></svg>
    case 'decloak':
      return <svg width={s} height={s} viewBox="0 0 10 10"><path d="M0.8 5 C2.5 2 7.5 2 9.2 5 C7.5 8 2.5 8 0.8 5 Z" fill="none" stroke={c} strokeWidth="1.2" /><circle cx="5" cy="5" r="1.5" fill={c} /></svg>
    case 'sentryBuilt':
      return <svg width={s} height={s} viewBox="0 0 10 10"><path d="M5 1 L9.5 9 H0.5 Z" fill="none" stroke={c} strokeWidth="1.6" /></svg>
    case 'sentryDestroyed':
      return <svg width={s} height={s} viewBox="0 0 10 10"><path d="M5 1 L9.5 9 H0.5 Z" fill="none" stroke={c} strokeWidth="1.3" /><path d="M3 4 L7 8 M7 4 L3 8" stroke={c} strokeWidth="1.3" /></svg>
  }
}

const HlTimelineMarkers = ({ maxTicks, onSeek }: { maxTicks: number; onSeek: (tick: number) => void }) => {
  const enabled = useHlSetting<boolean>('enabled')
  const on = useHlSetting<boolean>('hud.timelineMarkers')
  const medic = useHlSetting<boolean>('hud.timelineMedic')
  const objective = useHlSetting<boolean>('hud.timelineObjective')
  const spy = useHlSetting<boolean>('hud.timelineSpy')
  const engineer = useHlSetting<boolean>('hud.timelineEngineer')
  const x = useExtras()
  const demo = useInstance(state => state.parsedDemo)
  const markers = useMemo(
    () => (enabled && on && x && demo ? enabledTimelineMarkers(demo, x, { medic, objective, spy, engineer }) : []),
    [enabled, on, x, demo, medic, objective, spy, engineer]
  )
  if (markers.length === 0 || maxTicks <= 1) return null
  return <MarkerStrip markers={markers} maxTicks={maxTicks} onSeek={onSeek} />
}

const MarkerStrip = React.memo(
  ({ markers, maxTicks, onSeek }: { markers: TimelineMarker[]; maxTicks: number; onSeek: (tick: number) => void }) => (
    <div className="pointer-events-none absolute inset-x-0 bottom-[calc(50%+6px)] h-[18px]" data-hl-layout="timeline">
      {markers.map((m, i) => (
        <div
          key={`${m.tick}-${m.shape}-${i}`}
          title={m.text}
          className="pointer-events-auto absolute bottom-0 flex -translate-x-1/2 cursor-pointer items-end opacity-90 hover:scale-150 hover:opacity-100"
          style={{ left: `${((Math.min(maxTicks, m.tick) - 1) / (maxTicks - 1)) * 100}%`, transformOrigin: 'bottom center' }}
          onClick={() => onSeek(m.tick)}
        >
          <MarkerShape m={m} />
        </div>
      ))}
    </div>
  )
)
