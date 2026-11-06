// Per-tick data read outside React: playback.tick changes on every frame, so nothing may render
// on the tick itself. Components select a primitive derived from the tick (useStore re-renders only when it changes) and
// useFrame callbacks read the rows here. One compute per tick per demo, shared by every actor and selector.
//
// Memory rule (contract 12.3): the rows live in a WeakMap keyed by the demo.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import type { CachedPlayer } from '@components/Analyse/Data/PlayerCache'
import { useStoreWithEqualityFn } from 'zustand/traditional'

import { useStore, type StoreState } from '@zus/store'

/** DemoViewer INTERP_DELAY_TICKS: renderTick = max(1, playback.tick - 2). */
export const renderTickOf = (playbackTick: number) => Math.max(1, playbackTick - 2)
export const selectRenderTick = (state: StoreState) => renderTickOf(state.playback.tick)
export const selectPlaybackTick = (state: StoreState) => state.playback.tick
/** The render tick, re-rendering on every tick: only for leaves that really change per tick and for the legacy paths. */
export const useRenderTick = () => useStore(selectRenderTick)
export const usePlaybackTick = () => useStore(selectPlaybackTick)

/** A value derived from the store, compared by `isEqual`: the selector runs on every store update, the caller renders when the value changes. */
export const useStoreValue = <T,>(selector: (state: StoreState) => T, isEqual?: (a: T, b: T) => boolean): T =>
  useStoreWithEqualityFn(useStore, selector, isEqual)

export interface TickPlayers {
  tick: number
  /** The connected RED and BLU players, in the order of getPlayersAtTick */
  list: CachedPlayer[]
  byEntity: Map<number, CachedPlayer>
  /** Entity ids of `list`, comma separated: changes when a player joins, leaves or switches to spectator */
  roster: string
}

const memo = new WeakMap<AsyncParser, [TickPlayers | null, TickPlayers | null]>()

function build(demo: AsyncParser, tick: number): TickPlayers {
  const list = demo.getPlayersAtTick(tick).filter(({ connected, teamId }) => connected && (teamId === 2 || teamId === 3))
  const byEntity = new Map<number, CachedPlayer>()
  let roster = ''
  for (const player of list) {
    byEntity.set(player.user.entityId, player)
    roster += roster ? `,${player.user.entityId}` : `${player.user.entityId}`
  }
  return { tick, list, byEntity, roster }
}

/** The connected players at a cache tick. Keeps the two ticks used last, so `tick` and `tick + 1` both hit once per tick. */
export function playersAt(demo: AsyncParser, tick: number): TickPlayers {
  let slots = memo.get(demo)
  if (!slots) memo.set(demo, (slots = [null, null]))
  const first = slots[0]
  if (first?.tick === tick) return first
  const second = slots[1]
  slots[1] = first
  if (second?.tick === tick) return (slots[0] = second)
  return (slots[0] = build(demo, tick))
}
