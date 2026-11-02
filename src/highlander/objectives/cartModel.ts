// W-items: which pack model draws the payload cart (asset contract 12.5). The cart prop's own model string when the
// pack lists it, else the stock cart of the mode: tug of war's `props_tow/tow_cart` (in tow_tetsudo's BSP PAK, so the
// pack holds it with source `pak:<folder>`), payload's `props_trainyard/bomb_cart`, or `bomb_cart_red` when RED
// attacks at round start. Custom carts outside the pack (pl_divulgence's `models/custom/dirty_bomb_cart.mdl`) take the
// stock bomb cart.

import { useAssetPack } from '@pack/pack'

import type { HighlanderExtras } from '@highlander/extras/types'
import { packModelKey } from '@highlander/mapdyn/packModels'

import type { ObjectiveMode } from './objectiveModel'

export const TOW_CART_MODEL = 'models/props_tow/tow_cart.mdl'
export const BOMB_CART_MODEL = 'models/props_trainyard/bomb_cart.mdl'
export const BOMB_CART_RED_MODEL = 'models/props_trainyard/bomb_cart_red.mdl'

/** Model strings of the cart props, in instance order (manifest key form). */
export function cartPropModels(x: HighlanderExtras): string[] {
  const out: string[] = []
  const list = x.objectives.cart.movers
  for (let i = 0; i < list.length; i++) {
    const j = list[i]
    if (j < 0 || j >= x.movers.count) continue
    const key = packModelKey(x.strings.models[x.movers.model[j]])
    if (key.endsWith('.mdl') && !out.includes(key)) out.push(key)
  }
  return out
}

/** The model candidates for the cart, best first. */
export function cartModelCandidates(x: HighlanderExtras, mode: ObjectiveMode, redAttacks: boolean): string[] {
  const stock = mode === 'tow' ? [TOW_CART_MODEL] : redAttacks ? [BOMB_CART_RED_MODEL, BOMB_CART_MODEL] : [BOMB_CART_MODEL]
  return [...cartPropModels(x), ...stock]
}

/** The first candidate the ready pack lists, or null (placeholder cart). Reactive to the pack state. */
export function useCartModelKey(x: HighlanderExtras | undefined, mode: ObjectiveMode, redAttacks: boolean): string | null {
  const pack = useAssetPack()
  if (!x || pack.status !== 'ready') return null
  const items = pack.manifest?.items as Record<string, { kind?: string }> | undefined
  if (!items) return null
  return cartModelCandidates(x, mode, redAttacks).find(key => items[key]?.kind === 'model') ?? null
}
