// Nameplate tags by view style (as/tflook, `view.plateTags`): 'always' keeps F1's tags, 'off' drops them, 'brief'
// keeps a tag only for BRIEF_TAG_SECONDS after its state began, so the plate flags a change and then goes quiet.
// The onset is read from the condition flags at the tick (recentFlagEdge), a pure function of the data and the tick
// (D12): seeking to a tick twice gives the same plate. Tags without a flag edge (REV, GAS, the rage tags) show only
// in 'always'; DECLOAK and MEDIC! are brief already and stay.

import { HL } from '@highlander/extras/enums'
import { playerIndexOf } from '@highlander/extras/getters'
import type { HighlanderExtras } from '@highlander/extras/types'
import type { NameplateExtra } from '@highlander/scene/actorFx'
import { recentFlagEdge } from '@highlander/players/fxState'

export const BRIEF_TAG_SECONDS = 2

const FLAG_OF_TAG: Record<string, number> = {
  UBER: HL.UBER, QF: HL.QUICKFIX_UBER, VACC: HL.VACC_UBER, CRIT: HL.CRIT, BONK: HL.BONK, MARKED: HL.MARKED,
  STUN: HL.STUNNED, TAUNT: HL.TAUNTING,
}
const ALREADY_BRIEF = new Set(['DECLOAK', 'MEDIC!'])

/** The plate extra with the tags the mode keeps; the same object when nothing changes. */
export function filterPlateTags(
  extra: NameplateExtra | undefined,
  mode: string,
  x: HighlanderExtras | undefined,
  entityId: number,
  tick: number
): NameplateExtra | undefined {
  if (!extra?.tags || mode === 'always' || mode === undefined) return extra
  let tags: string[] = []
  if (mode === 'brief' && x) {
    const p = playerIndexOf(x, entityId)
    const window = Math.max(1, Math.round(BRIEF_TAG_SECONDS / (x.meta.intervalPerTick || 0.015)))
    tags = extra.tags.filter(tag => {
      if (ALREADY_BRIEF.has(tag)) return true
      const bit = FLAG_OF_TAG[tag]
      return bit !== undefined && p >= 0 && recentFlagEdge(x, p, tick, bit, true, window) !== null
    })
  }
  if (tags.length === extra.tags.length) return extra
  const out = { ...extra }
  if (tags.length) out.tags = tags
  else delete out.tags
  return out
}
