// Map geometry notices (contract section 4.5 item 6). Top left, beside the toolbar buttons, where it
// clears the player panels, the killfeed and the objective HUD. A timer only fades the notice out; D12
// covers demo visuals, not notices.
//
//   mapStatus missing   "Map geometry for <map> is not available; players and objectives still play."
//   mapStatus error     "Map geometry for <map> failed to load; players and objectives still play."
//   ready, other folder "Using <folder> geometry for <map>" (a demo on another version of a converted map)
//
// Each notice shows for 8 s and has a close button.

import React, { useEffect, useState } from 'react'

import { useInstance, useStore } from '@zus/store'

const MESSAGE_MS = 8000
const FADE = 'opacity 400ms ease'

export const MapNotice = React.memo((_props: { renderTick: number }) => {
  const map = useStore(s => s.scene.map)
  const state = useInstance(s => s.mapStatus.state)
  const folder = useInstance(s => s.mapStatus.folder)
  const demo = useInstance(s => s.parsedDemo)

  const message =
    state === 'missing'
      ? `Map geometry for ${map} is not available; players and objectives still play.`
      : state === 'error'
        ? `Map geometry for ${map} failed to load; players and objectives still play.`
        : state === 'ready' && demo && folder && folder.toLowerCase() !== map.toLowerCase()
          ? `Using ${folder} geometry for ${map}`
          : null

  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!message) {
      setVisible(false)
      return
    }
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), MESSAGE_MS)
    return () => clearTimeout(timer)
  }, [message, demo])

  if (!message) return null

  return (
    <div className="ui-layer pointer-events-none items-start justify-start">
      <div
        className="ml-16 mt-4 flex max-w-[28rem] select-none items-start gap-2 rounded bg-pp-panel/80 px-2 py-1 text-xs"
        style={{
          opacity: visible ? 1 : 0,
          transition: FADE,
          pointerEvents: visible ? 'auto' : 'none',
        }}
        role="status"
      >
        <span>{message}</span>
        <button
          type="button"
          className="leading-none opacity-60 hover:opacity-100"
          aria-label="Dismiss"
          onClick={() => setVisible(false)}
        >
          ×
        </button>
      </div>
    </div>
  )
})
