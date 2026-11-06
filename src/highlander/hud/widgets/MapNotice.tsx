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

// A number per loaded demo (0 without one), so the store selector returns a primitive (contract rule
// 1.6.4) that still changes when another demo loads: the notice shows again even when its text repeats.
const demoIds = new WeakMap<object, number>()
let nextDemoId = 1
const demoLoadId = (demo: object | undefined): number => {
  if (!demo) return 0
  let id = demoIds.get(demo)
  if (id === undefined) {
    id = nextDemoId++
    demoIds.set(demo, id)
  }
  return id
}

export const MapNotice = React.memo(() => {
  const map = useStore(s => s.scene.map)
  const state = useInstance(s => s.mapStatus.state)
  const folder = useInstance(s => s.mapStatus.folder)
  const demoId = useInstance(s => demoLoadId(s.parsedDemo))

  const message =
    state === 'missing'
      ? `Map geometry for ${map} is not available; players and objectives still play.`
      : state === 'error'
        ? `Map geometry for ${map} failed to load; players and objectives still play.`
        : state === 'ready' && demoId > 0 && folder && folder.toLowerCase() !== map.toLowerCase()
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
  }, [message, demoId])

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
