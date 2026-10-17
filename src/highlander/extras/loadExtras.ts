// Extras loader (contract section 3.4). S0 stub; P1 replaces it with the worker-based loader.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { useInstance } from '@zus/store'

/** S0 stub: the extras parser does not exist yet, so the status goes straight to 'disabled'. */
export async function startHighlanderExtras(
  _buffer: ArrayBuffer,
  _parsedDemo: AsyncParser
): Promise<void> {
  useInstance.getState().setExtrasStatus('disabled')
}

/** S0 stub: nothing is running, so there is nothing to cancel. */
export function cancelHighlanderExtras(): void {}
