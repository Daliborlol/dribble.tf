// Status notices for the Highlander extras (contract section 3.9). Bottom left, above the chat.
// Timers here only fade notices out; D12 covers demo visuals, not notices.
//
//   loading                 "Highlander data NN %" for at most 3 s, then a small dot in the HUD corner until ready
//   error                   "Highlander data unavailable: <reason>" for 6 s; console warns once
//   disabled with a reason  "Highlander data off: <reason>" for 6 s (the memory plan skipped the file)
//   ready, groups excluded  "Highlander data without <groups> (large demo)" for 6 s
//
// 'disabled' without a reason (the setting is off) and 'idle' show nothing.

import React, { useEffect, useRef, useState } from 'react'

import { useInstance } from '@zus/store'

const LOADING_TEXT_MS = 3000
const MESSAGE_MS = 6000
const FADE = 'opacity 400ms ease'

export const ExtrasNotice = React.memo(() => {
  const status = useInstance(s => s.extrasStatus)
  const progress = useInstance(s => Math.round(s.extrasProgress))
  const reason = useInstance(s => s.extrasError)
  const excluded = useInstance(s =>
    s.extrasStatus === 'ready' && s.extras ? s.extras.meta.excluded.join(', ') : ''
  )

  const [loadingTextVisible, setLoadingTextVisible] = useState(false)
  const [messageVisible, setMessageVisible] = useState(false)
  const warnedRef = useRef<string | null>(null)

  const message =
    status === 'error'
      ? `Highlander data unavailable: ${reason || 'unknown error'}`
      : status === 'disabled' && reason
        ? `Highlander data off: ${reason}`
        : status === 'ready' && excluded
          ? `Highlander data without ${excluded} (large demo)`
          : null

  useEffect(() => {
    if (status !== 'loading') {
      setLoadingTextVisible(false)
      return
    }
    setLoadingTextVisible(true)
    const timer = setTimeout(() => setLoadingTextVisible(false), LOADING_TEXT_MS)
    return () => clearTimeout(timer)
  }, [status])

  useEffect(() => {
    if (!message) {
      setMessageVisible(false)
      return
    }
    setMessageVisible(true)
    const timer = setTimeout(() => setMessageVisible(false), MESSAGE_MS)
    return () => clearTimeout(timer)
  }, [message])

  useEffect(() => {
    if (status === 'error' && message && warnedRef.current !== message) {
      warnedRef.current = message
      console.warn(`[HL] ${message}`)
    }
  }, [status, message])

  const loading = status === 'loading'
  const text = loading ? `Highlander data ${progress} %` : message

  return (
    <div className="ui-layer pointer-events-none items-end justify-start">
      {text && (
        <div
          className="pointer-events-none mb-[232px] ml-4 max-w-[28rem] select-none rounded bg-pp-panel/80 px-2 py-1 text-xs"
          style={{
            opacity: (loading ? loadingTextVisible : messageVisible) ? 1 : 0,
            transition: FADE,
          }}
        >
          {text}
        </div>
      )}

      {loading && !loadingTextVisible && (
        <div
          className="pointer-events-auto absolute bottom-2 left-2 h-2 w-2 animate-pulse rounded-full bg-white/60"
          title={`Highlander data ${progress} %`}
        />
      )}
    </div>
  )
})
