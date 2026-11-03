// The followed players of the TF2 look (as/tflook): the focused player and the POV subject, as base player indices.
// Cached per tick and focus as plain numbers only (contract 12.3: no demo, extras or store snapshot here).

import { useInstance } from '@zus/store'
import { playerIndexOf } from '@highlander/extras/getters'
import type { HighlanderExtras } from '@highlander/extras/types'
import { getPovSubject } from '@highlander/pov/subject'

const ids = new WeakMap<HighlanderExtras, number>()
let nextId = 1
const cache = { tick: -1, focused: -2, id: 0, a: -1, b: -1 }

/** True when player p is the focused player or the POV subject at the tick. */
export function isFollowedPlayer(x: HighlanderExtras, p: number, tick: number): boolean {
  if (p < 0) return false
  const focused = (useInstance.getState().focusedObject?.userData?.entityId as number | undefined) ?? -1
  let id = ids.get(x)
  if (id === undefined) ids.set(x, (id = nextId++))
  if (cache.tick !== tick || cache.focused !== focused || cache.id !== id) {
    cache.tick = tick
    cache.focused = focused
    cache.id = id
    cache.a = focused >= 0 ? playerIndexOf(x, focused) : -1
    const subject = focused >= 0 ? getPovSubject(tick) : null
    cache.b = subject ? subject.p : -1
  }
  return p === cache.a || p === cache.b
}
