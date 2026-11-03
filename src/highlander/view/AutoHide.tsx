// Auto-hiding controls (as/tflook, `view.autoHideControls`): while playback runs and the mouse has been idle for
// IDLE_MS, the elements marked `hl-autohide` (the playback bar and the side toolbar) fade out; any mouse move, click,
// wheel or key brings them back. The pointer resting on one of them keeps them shown. UI timing only: nothing drawn
// in the scene depends on it (D12).

import { useEffect, type RefObject } from 'react'

import { useStore } from '@zus/store'
import { useHlSetting } from '@highlander/extras/hooks'

export const IDLE_MS = 2500
const ATTR = 'data-hl-idle'

export const ControlsAutoHide = ({ target }: { target: RefObject<HTMLElement> }) => {
  const enabled = useHlSetting<boolean>('enabled') === true && useHlSetting<boolean>('view.autoHideControls') === true
  const playing = useStore(state => state.playback.playing)
  const active = enabled && playing

  useEffect(() => {
    const el = target.current
    if (!el) return
    if (!active) {
      el.removeAttribute(ATTR)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let overControls = false
    const hide = () => {
      if (!overControls) el.setAttribute(ATTR, '')
    }
    const wake = (event: Event) => {
      if (event.type === 'pointermove' || event.type === 'pointerdown') {
        const t = event.target as Element | null
        overControls = !!t?.closest?.('.hl-autohide')
      }
      el.removeAttribute(ATTR)
      clearTimeout(timer)
      timer = setTimeout(hide, IDLE_MS)
    }
    const events = ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const
    for (const name of events) window.addEventListener(name, wake, { passive: true, capture: true })
    timer = setTimeout(hide, IDLE_MS)
    return () => {
      clearTimeout(timer)
      for (const name of events) window.removeEventListener(name, wake, { capture: true })
      el.removeAttribute(ATTR)
    }
  }, [active, target])

  return null
}
