// Timeline marker navigation (contract section 5 F5, owner F5). The S0 key handler binds `[` and `]` to it.
// The markers are the ones PlaybackPanel draws (objectives/timelineModel.ts), filtered by the enabled
// categories; marker ticks are playback ticks.

import { addEventHistoryAction, goToTickAction } from '@zus/actions'
import { getState, useInstance } from '@zus/store'
import { enabledTimelineMarkers, type TimelineMarker } from '@highlander/objectives/timelineModel'

/** The markers `[` / `]` step through right now (empty while Highlander, the markers or the extras are off). */
export function activeTimelineMarkers(): TimelineMarker[] {
  const hl = getState().settings.highlander
  const { extras, extrasStatus, parsedDemo } = useInstance.getState()
  if (!hl?.enabled || !hl.hud.timelineMarkers || extrasStatus !== 'ready' || !extras || !parsedDemo) return []
  return enabledTimelineMarkers(parsedDemo, extras, {
    medic: hl.hud.timelineMedic,
    objective: hl.hud.timelineObjective,
    spy: hl.hud.timelineSpy,
    engineer: hl.hud.timelineEngineer,
  })
}

/** The marker after (1) or before (-1) a playback tick, or null. */
export function timelineMarkerFrom(markers: TimelineMarker[], tick: number, direction: 1 | -1): TimelineMarker | null {
  if (direction > 0) return markers.find(m => m.tick > tick) ?? null
  for (let i = markers.length - 1; i >= 0; i--) if (markers[i].tick < tick) return markers[i]
  return null
}

/** Seek to the next (1) or previous (-1) marker of an enabled timeline category. */
export function jumpToTimelineMarker(direction: 1 | -1): void {
  const marker = timelineMarkerFrom(activeTimelineMarkers(), getState().playback.tick, direction)
  if (!marker) return
  goToTickAction(marker.tick)
  addEventHistoryAction('timelineMarker', marker.text)
}
