// React hooks and plain accessors for the Highlander extras and settings (contract sections 1.6 and 6.1).

import { get } from 'lodash'

import { getState, useInstance, useStore } from '@zus/store'

/** The extras once they are ready (status 'ready'), otherwise undefined. */
export const useExtras = () => useInstance(s => (s.extrasStatus === 'ready' ? s.extras : undefined))

/** 'idle' | 'disabled' | 'loading' | 'ready' | 'error' */
export const useExtrasStatus = () => useInstance(s => s.extrasStatus)

/**
 * One value of `settings.highlander` by dotted path, e.g. useHlSetting<boolean>('players.cloak').
 * Select primitives only: the reducer's shallow settings clone keeps nested object references.
 */
export const useHlSetting = <T>(path: string): T =>
  useStore(s => get(s.settings.highlander, path) as T)

/** Same as useHlSetting for non-React code (useFrame callbacks, actions, probes). */
export const getHlSetting = <T>(path: string): T => get(getState().settings.highlander, path) as T
