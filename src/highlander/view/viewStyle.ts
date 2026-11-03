// View style (as/tflook): "Analysis" (every overlay, the default) or "TF2 look" (the spectator view of TF2: plates
// only for the followed, hovered and POV-teammate players, labels on demand, no timeline markers, auto-hiding
// controls). A style is only a set of values for existing settings; each one stays a toggle of its own.

import { get } from 'lodash'

import { getState } from '@zus/store'
import { addEventHistoryAction, updateSettingsOptionAction } from '@zus/actions'
import { VIEW_PRESETS, type ViewStyle } from '@highlander/settings'

export const VIEW_STYLE_LABELS: Record<ViewStyle, string> = { analysis: 'Analysis', tf2: 'TF2 look' }

/** The style whose values all match the settings, or 'custom'. */
export function currentViewStyle(settings: object): ViewStyle | 'custom' {
  return (
    (Object.keys(VIEW_PRESETS) as ViewStyle[]).find(key =>
      Object.entries(VIEW_PRESETS[key]).every(([path, value]) => get(settings, path) === value)
    ) ?? 'custom'
  )
}

export function applyViewStyle(key: ViewStyle): void {
  for (const [path, value] of Object.entries(VIEW_PRESETS[key])) updateSettingsOptionAction(path, value)
}

/** Key H: TF2 look from Analysis or Custom, Analysis from TF2 look. */
export function toggleViewStyle(): void {
  const next: ViewStyle = currentViewStyle(getState().settings) === 'tf2' ? 'analysis' : 'tf2'
  applyViewStyle(next)
  addEventHistoryAction('highlanderSetting', `View style: ${VIEW_STYLE_LABELS[next]}`)
}
