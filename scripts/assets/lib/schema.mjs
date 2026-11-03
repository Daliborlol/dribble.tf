// The item schema (items_game.txt) for the models and viewmodels stages: prefabs merged through
// build-items.mjs's `parseKeyValues` and `mergeDefinition`. Def ids and model paths are public schema text.
//
//   loadSchema(file) -> null without a file, else {
//     sha256,
//     watchModels(),                 spy watch viewmodels (v_models watches a spy item names)
//     defsOfClass(itemClass, cls),   defs of every item of `itemClass` that `cls` uses
//     resolve(def, cls),             the c_model the viewmodel bone-merges (model_player with attach_to_hands)
//     resolveWorld(def, cls),        the third-person model and extra wearable (below)
//   }
//
// resolve and resolveWorld return null when `cls` does not use the item and `{ skip, model? }` when it has no
// usable model. resolveWorld follows TF2's world model choice: `model_world` when the item has one (the Hot Hand,
// a few sappers), else `model_player_per_class[cls]`, else `model_player`; a `v_models` path (the invisibility
// watches) has no third-person model. `extra` is `extra_wearable`, the model TF2 bone-merges onto the player beside
// the weapon (banner backpacks, the Quick-Fix and Vaccinator packs, the Botkiller heads).

import fs from 'node:fs'
import { sha256 } from './vpk.mjs'
import { parseKeyValues, mergeDefinition } from '../../build-items.mjs'

const lower = s => String(s).toLowerCase()
const modelPath = (s, cls) => lower(String(s).replace(/%s/g, cls)).replace(/\\/g, '/')

export function loadSchema(file) {
  if (!file || !fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  const schema = parseKeyValues(text).items_game
  if (!schema?.items || !schema?.prefabs) throw new Error(`${file}: no items or prefabs`)
  const cache = new Map()
  const defOf = d => {
    if (!cache.has(d)) cache.set(d, schema.items[String(d)] ? mergeDefinition(Object.create(null), schema.items[String(d)], schema.prefabs) : null)
    return cache.get(d)
  }
  const usedBy = (def, cls) => Object.keys(def.used_by_classes ?? {}).map(lower).includes(cls)
  const playerModel = (def, cls) => {
    const perClass = def.model_player_per_class && typeof def.model_player_per_class === 'object' ? def.model_player_per_class[cls] : undefined
    const model = typeof perClass === 'string' ? perClass : def.model_player
    return typeof model === 'string' && model ? modelPath(model, cls) : null
  }
  return {
    sha256: sha256(Buffer.from(text)),
    /** Spy watch viewmodels (drawn as viewmodel 1): every `v_models` watch model a spy item names, sorted. */
    watchModels() {
      const out = new Set()
      for (const d of Object.keys(schema.items)) {
        const def = defOf(d)
        const model = typeof def?.model_player === 'string' ? lower(def.model_player).replace(/\\/g, '/') : ''
        if (/\/v_models\/(.*\/)?v_[^/]*watch[^/]*\.mdl$/.test(model) && Object.keys(def.used_by_classes ?? {}).map(lower).includes('spy')) out.add(model)
      }
      return [...out].sort()
    },
    /** Defs of every item of `itemClass` that `cls` uses, sorted. */
    defsOfClass(itemClass, cls) {
      const out = []
      for (const d of Object.keys(schema.items)) {
        const def = defOf(d)
        if (lower(def?.item_class ?? '') !== itemClass) continue
        if (usedBy(def, cls)) out.push(Number(d))
      }
      return out.filter(Number.isFinite).sort((a, b) => a - b)
    },
    resolve(d, cls) {
      const def = defOf(d)
      if (!def) return { skip: 'not in the schema' }
      if (!usedBy(def, cls)) return null
      const model = playerModel(def, cls)
      if (!model) return { skip: 'no model' }
      if (def.attach_to_hands !== '1' && def.attach_to_hands_vm_only !== '1') return { skip: 'not attached to hands', model }
      return { model, name: def.name ?? null }
    },
    /**
     * The third-person anim slot TF2 plays for item `d` on `cls` (upper case: 'PRIMARY', 'MELEE_ALLCLASS', ...):
     * `anim_slot` unless empty or FORCE_NOT_USED, else the class's loadout slot from used_by_classes, else
     * item_slot. null when `cls` does not use the item.
     */
    animSlot(d, cls) {
      const def = defOf(d)
      if (!def || !usedBy(def, cls)) return null
      const anim = typeof def.anim_slot === 'string' ? def.anim_slot.trim() : ''
      if (anim && anim.toUpperCase() !== 'FORCE_NOT_USED') return anim.toUpperCase()
      const perClass = Object.entries(def.used_by_classes ?? {}).find(([k]) => lower(k) === cls)?.[1]
      if (typeof perClass === 'string' && perClass !== '1' && perClass) return perClass.toUpperCase()
      return typeof def.item_slot === 'string' && def.item_slot ? def.item_slot.toUpperCase() : null
    },
    resolveWorld(d, cls) {
      const def = defOf(d)
      if (!def) return { skip: 'not in the schema' }
      if (!usedBy(def, cls)) return null
      const model = typeof def.model_world === 'string' && def.model_world ? modelPath(def.model_world, cls) : playerModel(def, cls)
      const extra = typeof def.extra_wearable === 'string' && def.extra_wearable ? modelPath(def.extra_wearable, cls) : null
      if (!model) return { skip: 'no model', ...(extra ? { extra } : {}) }
      if (/(^|\/)v_models\//.test(model)) return { skip: 'viewmodel only', model }
      return { model, ...(extra ? { extra } : {}), name: def.name ?? null }
    },
  }
}
