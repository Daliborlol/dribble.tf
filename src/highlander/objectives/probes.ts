// Debug-bridge probes of the objective HUD (contract section 5 F5). Ticks are cache ticks (renderTick by default).
//
//   objective.hud(tick)    mode, timer, KOTH clocks, payload bar, points, tug of war, stopwatch line, header, banner
//   hud.layout()           bounding rectangles of the objective HUD, both player columns, the killfeed, the banner,
//                          the toolbar and the playback panel, plus every overlapping pair
//   hud.scoreboard(tick)   the Tab scoreboard rows
//   hud.snapshotStats()    { computes, lastHudTick } of the shared HUD snapshot
//   hud.rows(tick)         the player-list rows and medic rows the snapshot holds at the tick
//   killfeed.lines(tick)   the killfeed lines shown at the tick with the current settings, and the feign counts
//   timeline.markers()     every timeline marker, the enabled ones and the marker strip's render count
//   stopwatch.games()      roundWin events with their stopwatch half, decided flag and the games-won rule

import { getState, useInstance } from '@zus/store'
import { registerHlProbe } from '@highlander/debug'
import { getLoadedMapMeta } from '@highlander/map/mapMeta'
import { computeHudSnapshot, hudSnapshotStats } from '@highlander/hud/hudSnapshot'
import { killfeedLinesAt, killfeedModel } from '@highlander/hud/killfeedModel'
import { activeTimelineMarkers, timelineStripStats } from '@highlander/hud/timeline'

import { bannerAt } from './banner'
import { deathIndex } from './deaths'
import { jsonSafe } from './format'
import { objectiveModeOf, objectiveViewAt } from './objectiveModel'
import { scoreboardAt } from './scoreboardModel'
import { stopwatchIndex } from './stopwatch'
import { timelineMarkers } from './timelineModel'

const ready = () => {
  const s = useInstance.getState()
  return { x: s.extrasStatus === 'ready' ? s.extras : undefined, demo: s.parsedDemo, status: s.extrasStatus }
}
const tickOf = (tick?: number) => Math.max(0, Math.floor(tick ?? Math.max(1, getState().playback.tick - 2)))
const metaOf = (map: string | undefined) => (map ? getLoadedMapMeta(map) ?? null : null)

registerHlProbe('objective.hud', (tickArg?: number) => {
  const { x, demo, status } = ready()
  if (!x || !demo) return { error: 'extras not ready', status }
  const tick = tickOf(tickArg)
  const meta = metaOf(demo.header?.map)
  const view = objectiveViewAt(x, meta, tick)
  return jsonSafe({ ...view, mapMeta: meta ? meta.gameMode : null, banner: bannerAt(x, objectiveModeOf(x, meta), tick) })
})

registerHlProbe('hud.snapshotStats', () => hudSnapshotStats())

registerHlProbe('hud.rows', (tickArg?: number) => {
  const { x, demo } = ready()
  if (!demo) return { error: 'no demo' }
  const tick = tickOf(tickArg)
  const snap = computeHudSnapshot(demo, x, metaOf(demo.header?.map), tick)
  return jsonSafe({ tick, ready: snap.ready, rows: snap.rows, medics: snap.medics })
})

registerHlProbe('hud.scoreboard', (tickArg?: number) => {
  const { x, demo } = ready()
  if (!demo) return { error: 'no demo' }
  const tick = tickOf(tickArg)
  const index = deathIndex(demo, x)
  return jsonSafe({ ...scoreboardAt(demo, x, tick), deaths: { base: index.rows.length, feigns: index.feigns, matched: index.matched, extrasKills: index.extrasKills } })
})

registerHlProbe('killfeed.lines', (tickArg?: number) => {
  const { x, demo } = ready()
  if (!demo) return { error: 'no demo' }
  const hl = getState().settings.highlander
  const tick = tickOf(tickArg)
  const model = killfeedModel(demo, x, { feign: !!hl?.hud.killfeedFeignDeaths, objectives: !!hl?.hud.killfeedObjectives })
  const lines = killfeedLinesAt(model, tick, hl?.hud.killfeedMaxLines ?? 6)
  const count = (test: (l: (typeof model.lines)[number]) => boolean) => model.lines.reduce((n, l) => n + (test(l) ? 1 : 0), 0)
  return jsonSafe({
    tick,
    total: model.lines.length,
    feigns: model.feigns,
    hiddenFeigns: model.hiddenFeigns,
    // over the whole demo, with the current settings: lines a viewer can see
    feignLines: count(l => l.feign),
    critLines: count(l => l.crit === 2),
    miniCritLines: count(l => l.crit === 1),
    headshotLines: count(l => l.headshot),
    backstabLines: count(l => l.backstab),
    domLines: count(l => l.dom),
    revLines: count(l => l.rev),
    buildingLines: count(l => l.kind === 'building'),
    captureLines: count(l => l.kind === 'capture'),
    lines: lines.map(l => ({
      tick: l.tick,
      kind: l.kind,
      killer: l.killer?.name ?? null,
      killerTeam: l.killer?.team ?? null,
      victim: l.victim?.name ?? null,
      victimTeam: l.victim?.team ?? null,
      label: l.victimLabel,
      text: l.text,
      icon: l.iconName,
      crit: l.crit,
      hsBadge: l.hsBadge,
      dom: l.dom,
      rev: l.rev,
      feign: l.feign,
    })),
  })
})

registerHlProbe('timeline.markers', () => {
  const { x, demo } = ready()
  if (!x || !demo) return { error: 'extras not ready' }
  const all = timelineMarkers(demo, x)
  const counts: Record<string, number> = {}
  for (const m of all) counts[`${m.category}.${m.shape}`] = (counts[`${m.category}.${m.shape}`] ?? 0) + 1
  return jsonSafe({
    total: all.length,
    counts,
    enabled: activeTimelineMarkers().map(m => ({ tick: m.tick, shape: m.shape, text: m.text })),
    stripRenders: timelineStripStats.renders,
  })
})

registerHlProbe('stopwatch.games', () => {
  const { x } = ready()
  if (!x) return { error: 'extras not ready' }
  const index = stopwatchIndex(x)
  return jsonSafe({ isStopwatch: index.isStopwatch, rule: index.rule, roundStarts: index.roundStarts, wins: index.wins })
})

// ─── layout ────────────────────────────────────────────────────────────────────

interface Rect { x: number; y: number; w: number; h: number }

const rectOf = (el: Element): Rect | null => {
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  const style = getComputedStyle(el)
  if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return null
  return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }
}

const union = (rects: Rect[]): Rect | null => {
  if (rects.length === 0) return null
  const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y))
  const x1 = Math.max(...rects.map(r => r.x + r.w)), y1 = Math.max(...rects.map(r => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const overlapArea = (a: Rect, b: Rect) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0.5 && h > 0.5 ? Math.round(w * h) : 0
}

registerHlProbe('hud.layout', () => {
  const rects: Record<string, Rect | null> = {}
  for (const el of Array.from(document.querySelectorAll('[data-hl-layout]'))) {
    const name = el.getAttribute('data-hl-layout') ?? '?'
    if (name === 'timeline') continue
    const r = rectOf(el)
    if (r) rects[name] = r
  }
  // killfeed lines: the container box may be wider than the lines themselves
  const killfeed = document.querySelector('[data-hl-layout="killfeed"]')
  if (killfeed) rects.killfeed = union(Array.from(killfeed.children).map(rectOf).filter((r): r is Rect => !!r)) ?? rects.killfeed ?? null
  // toolbar: the panel buttons along the left edge (PanelToolbar)
  const buttons = Array.from(document.querySelectorAll('.ui-layers button'))
    .map(rectOf)
    .filter((r): r is Rect => !!r && r.x < 64 && r.w <= 48 && r.h <= 48 && r.y < 320)
  rects.toolbar = union(buttons)
  // playback controls: the round pill group of PlaybackPanel
  const playback = Array.from(document.querySelectorAll('.ui-layers .rounded-full.px-5.py-3'))[0]
  rects.playback = playback ? rectOf(playback) : null

  const names = Object.keys(rects).filter(k => rects[k] && k !== 'scoreboard')
  const overlaps: { a: string; b: string; area: number }[] = []
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const area = overlapArea(rects[names[i]]!, rects[names[j]]!)
      if (area > 0) overlaps.push({ a: names[i], b: names[j], area })
    }
  }
  return { viewport: { w: window.innerWidth, h: window.innerHeight }, rects, overlaps }
})
