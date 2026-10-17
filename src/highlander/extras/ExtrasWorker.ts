// Extras worker entry (contract section 3.4). Started by loadExtras.ts after the base parse resolved and the base
// worker was terminated (D4). It owns the demo bytes inside wasm memory (D18): the transferred file buffer is
// copied into an ExtrasInput and every JS reference to it is dropped before the parse starts.

import init, { ExtrasInput, parse_demo_extras_input } from '../../libs/hlextras/hlextras.js'
import type { ExtrasRaw } from './types'
import { collectBuffers, hydrate } from './hydrate'

// The DOM lib types the worker global as Window, whose postMessage needs a target origin (TS2769). Same fix as ParseWorker.ts:10.
declare function postMessage(message: any, transfer?: any[]): void

onmessage = async (event: MessageEvent) => {
  const data = event.data
  try {
    const wasm = await init()
    const t0 = performance.now()
    let fileBuffer: ArrayBuffer | null = data.buffer
    data.buffer = null
    let bytes: Uint8Array | null = new Uint8Array(fileBuffer as ArrayBuffer)
    const length = bytes.length
    const input = new ExtrasInput(length)
    new Uint8Array(wasm.memory.buffer, input.ptr(), length).set(bytes)
    bytes = null
    // ArrayBuffer.prototype.transfer (ES2024) detaches the file buffer and frees its memory now, so the parse peak
    // holds the file once (in wasm memory) instead of until the next GC. Older browsers keep the GC path, which
    // needs every reference gone: after this line no JS reference to the file remains.
    const transfer = (fileBuffer as ArrayBuffer & { transfer?: (length: number) => ArrayBuffer }).transfer
    if (typeof transfer === 'function') transfer.call(fileBuffer, 0)
    fileBuffer = null
    const raw = parse_demo_extras_input(input, data.options, (p: number) => postMessage({ type: 'progress', progress: p }))
    if (typeof raw === 'string' || !raw) return postMessage({ type: 'error', error: raw || 'extras parse failed' })
    ;(raw as ExtrasRaw).meta.parseMs = performance.now() - t0
    const extras = hydrate(raw as ExtrasRaw, data.sceneOrigin)
    postMessage(
      { type: 'result', extras, ms: performance.now() - t0, wasmMemoryBytes: wasm.memory.buffer.byteLength },
      collectBuffers(extras)
    )
  } catch (e) {
    postMessage({ type: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}
