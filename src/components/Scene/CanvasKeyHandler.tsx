import { useRef, useCallback } from 'react'
import keycode from 'keycode'
import { get } from 'lodash'
import { isMobile } from 'react-device-detect'

import { useThree } from '@react-three/fiber'

import { getState, useInstance, useStore } from '@zus/store'
import {
  togglePlaybackAction,
  playbackJumpAction,
  changeControlsModeAction,
  changePlaySpeedAction,
  changeSceneModeAction,
  toggleSettingsOptionAction,
  toggleBookmarkAction,
  updateSettingsOptionAction,
  addEventHistoryAction,
} from '@zus/actions'

import { useEventListener } from '@utils/hooks'
import { jumpToTimelineMarker } from '@highlander/hud/timeline'
import { toggleViewStyle } from '@highlander/view/viewStyle'
import type { HighlanderSettings } from '@highlander/settings'

type DisguiseView = HighlanderSettings['players']['disguiseView']

const DISGUISE_VIEWS: DisguiseView[] = ['auto', 'true', 'enemy', 'pov']
const DISGUISE_VIEW_LABELS: Record<DisguiseView, string> = {
  auto: 'Auto',
  true: 'Spectator view',
  enemy: 'Enemy view',
  pov: "POV player's view",
}

const highlanderOn = () => getState().settings.highlander?.enabled === true

/** Toggle a boolean Highlander setting and show the new state in the playback panel. */
const toggleHighlanderSetting = (path: string, label: string) => {
  const enabled = !get(getState().settings.highlander, path)
  toggleSettingsOptionAction(`highlander.${path}`)
  addEventHistoryAction('highlanderSetting', `${label}: ${enabled ? 'on' : 'off'}`)
}

const cycleDisguiseView = () => {
  const current = getState().settings.highlander?.players.disguiseView ?? 'auto'
  const next = DISGUISE_VIEWS[(DISGUISE_VIEWS.indexOf(current) + 1) % DISGUISE_VIEWS.length]
  updateSettingsOptionAction('highlander.players.disguiseView', next)
  addEventHistoryAction('highlanderSetting', `Disguise view: ${DISGUISE_VIEW_LABELS[next]}`)
}

/**
 * This is just a null object added to Scene to make it easier for us to handle
 * any desired key press behaviour if the user has the Canvas focused
 */
export const CanvasKeyHandler = () => {
  const keysHeld = useRef(new Map())
  const { gl } = useThree()

  const controls = useStore(state => state.scene.controls)

  const canvasKeyDown = useCallback(
    (event: KeyboardEvent) => {
      try {
        switch (keycode(event)) {
          case 'space':
            togglePlaybackAction()
            break

          case 'left':
            playbackJumpAction('seekBackward')
            break

          case 'right':
            playbackJumpAction('seekForward')
            break

          case ',':
            playbackJumpAction('previousTick')
            break

          case '.':
            playbackJumpAction('nextTick')
            break

          case 'up':
            changePlaySpeedAction('faster')
            break

          case 'down':
            changePlaySpeedAction('slower')
            break

          case 'm':
            changeSceneModeAction('next')
            break

          case 'n':
            toggleSettingsOptionAction('ui.nameplate.enabled')
            break

          case 'o':
            toggleSettingsOptionAction('ui.playerOutlines')
            break

          case 'b':
            toggleBookmarkAction()
            break

          case '1':
            if (keysHeld.current.has('1')) return null // Prevent rapid camera cycling
            keysHeld.current.set('1', true)
            changeControlsModeAction('pov', { direction: event.shiftKey ? 'prev' : 'next' })
            break

          case '2':
            if (isMobile) break // Spectator camera not supported on mobile
            if (keysHeld.current.has('2')) return null // Prevent rapid camera cycling
            keysHeld.current.set('2', true)
            changeControlsModeAction('spectator')
            break

          case '3':
            if (keysHeld.current.has('3')) return null // Prevent rapid camera cycling
            keysHeld.current.set('3', true)
            changeControlsModeAction('rts')
            break

          // ─── Highlander (contract section 6.2 item 10) ───
          // With Highlander off these keys do nothing (rule 7.4): no setting, no toast, and Tab keeps its default.

          case 'v':
            if (!highlanderOn() || event.repeat) break
            toggleHighlanderSetting('pov.viewmodel', 'Viewmodel')
            break

          case 'i':
            if (!highlanderOn() || event.repeat) break
            cycleDisguiseView()
            break

          case '4':
            if (!highlanderOn() || event.repeat) break
            toggleHighlanderSetting('pov.chase', 'Chase camera')
            break

          case 'h':
            if (!highlanderOn() || event.repeat) break
            toggleViewStyle()
            break

          case '[':
            jumpToTimelineMarker(-1)
            break

          case ']':
            jumpToTimelineMarker(1)
            break

          case 'tab':
            if (!highlanderOn()) break
            event.preventDefault() // Tab would move the focus away from the canvas
            useInstance.getState().setScoreboardOpen(true)
            break
        }
      } catch (error) {
        console.error(error)
      }
    },
    [controls] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const canvasKeyUp = useCallback((event: KeyboardEvent) => {
    switch (keycode(event)) {
      case '1':
        keysHeld.current.delete('1')
        break

      case '2':
        keysHeld.current.delete('2')
        break

      case '3':
        keysHeld.current.delete('3')
        break
    }
  }, [])

  // The scoreboard closes on Tab keyup wherever the focus went, and when the window loses focus
  const closeScoreboardOnTabUp = useCallback((event: KeyboardEvent) => {
    if (keycode(event) === 'tab') useInstance.getState().setScoreboardOpen(false)
  }, [])
  const closeScoreboard = useCallback(() => useInstance.getState().setScoreboardOpen(false), [])

  useEventListener('keydown', canvasKeyDown, gl.domElement)
  useEventListener('keyup', canvasKeyUp, gl.domElement)
  useEventListener('keyup', closeScoreboardOnTabUp, window)
  useEventListener('blur', closeScoreboard, window)

  return null
}
