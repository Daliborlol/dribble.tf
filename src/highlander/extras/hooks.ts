// React hooks and plain accessors for the Highlander extras and settings (contract sections 1.6 and 6.1).

import { useSyncExternalStore } from 'react'
import { get } from 'lodash'

import { getState, subscribeSettings, useInstance, type InstanceState } from '@zus/store'

// Stable selectors: an inline one makes the store hook rebuild its memo and schedule a passive effect on every render
const selectReadyExtras = (s: InstanceState) => (s.extrasStatus === 'ready' ? s.extras : undefined)
const selectExtrasStatus = (s: InstanceState) => s.extrasStatus

/** The extras once they are ready (status 'ready'), otherwise undefined. */
export const useExtras = () => useInstance(selectReadyExtras)

/** 'idle' | 'disabled' | 'loading' | 'ready' | 'error' */
export const useExtrasStatus = () => useInstance(selectExtrasStatus)

// One reader per setting path, shared by every component: the store runs its listeners on every playback tick, and a
// reader answers from its last value unless the settings object changed (the reducer clones it on every settings
// update). So a tick costs a call and a comparison per hook, no path walk.
const readers = new Map<string, () => unknown>()
function settingReader(path: string): () => unknown {
  let reader = readers.get(path)
  if (!reader) {
    let seen: unknown = null
    let value: unknown
    reader = () => {
      const settings = getState().settings
      if (settings !== seen) {
        seen = settings
        value = get(settings.highlander, path)
      }
      return value
    }
    readers.set(path, reader)
  }
  return reader
}

/**
 * One value of `settings.highlander` by dotted path, e.g. useHlSetting<boolean>('players.cloak').
 * Select primitives only: the reducer's shallow settings clone keeps nested object references.
 */
export const useHlSetting = <T>(path: string): T => useSyncExternalStore(subscribeSettings, settingReader(path) as () => T)

/** Same as useHlSetting for non-React code (useFrame callbacks, actions, probes). */
export const getHlSetting = <T>(path: string): T => get(getState().settings.highlander, path) as T
