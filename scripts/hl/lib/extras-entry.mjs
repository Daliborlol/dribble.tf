// Bundle entry for the Node checker: the real src/highlander extras code (hydrate, alignment rule, getters,
// findTicks, memory plan) without React or the store. scripts/hl/lib/bundle.mjs bundles it with esbuild.

export { hydrate, collectBuffers, typedArrayBytes } from '../../../src/highlander/extras/hydrate.ts'
export { checkAlignmentWith, ALIGNMENT_MAX_DISTANCE } from '../../../src/highlander/extras/alignment.ts'
export * as getters from '../../../src/highlander/extras/getters.ts'
export { findTicks, FIND_KINDS } from '../../../src/highlander/extras/findTicks.ts'
export { BLD, COND, HL, RULES, condSet, deriveFlags } from '../../../src/highlander/extras/enums.ts'
export { EXTRAS_PEAK, planExtrasGroups, predictExtrasPeakMB } from '../../../src/highlander/extras/memory.ts'
export { wearableDefs } from '../../../src/highlander/items.ts'
