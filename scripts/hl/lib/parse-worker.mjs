// The real src/components/Analyse/Data/ParseWorker.ts in Node (task B2; B1's worker-node tool did the same).
//
//   const { handler, posted, mod } = await loadParseWorker(checkout, { tmp })
//   await handler({ data: { buffer } })      // the browser's first message; `posted` collects what it posts
//   mod.demoWarmup(bytes), mod.delayedStartOf(result, bytes)   // the module's exports
//
// The worker module is bundled with esbuild (TS, the tsconfig path aliases); its wasm-bindgen glue in src/libs stays
// external and loads its .wasm from the checkout through a file: fetch shim. onmessage and postMessage are worker
// globals, shimmed here. One worker per process: the module assigns the global onmessage.
//
// hashCachedDemo(cd): the sha256 of a CachedDemo as the worker posts it, which check-delayed-start.mjs and
// check-parse-routes.mjs print, so checkouts and routes can be compared.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * sha256 over a posted CachedDemo (every typed array's bytes, keys sorted), without the timings and the file: now,
 * perf and fileBuffer at the top, and parseMs at any depth (parserFallback.parseMs, parserFallback.parser2.parseMs).
 */
export function hashCachedDemo(cd) {
  const hash = crypto.createHash('sha256')
  const walk = (v, top) => {
    if (ArrayBuffer.isView(v)) {
      hash.update(`<${v.constructor.name}:${v.length}>`)
      hash.update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
    } else if (v instanceof ArrayBuffer) hash.update(`<ArrayBuffer:${v.byteLength}>`)
    else if (v instanceof Map) {
      hash.update('{map')
      for (const [k, x] of v) {
        hash.update(JSON.stringify(k))
        walk(x, false)
      }
      hash.update('}')
    } else if (Array.isArray(v)) {
      hash.update('[')
      v.forEach(x => walk(x, false))
      hash.update(']')
    } else if (v && typeof v === 'object') {
      hash.update('{')
      for (const k of Object.keys(v).sort()) {
        if ((top && (k === 'now' || k === 'perf' || k === 'fileBuffer')) || k === 'parseMs') continue
        hash.update(`${JSON.stringify(k)}:`)
        walk(v[k], false)
      }
      hash.update('}')
    } else hash.update(JSON.stringify(v) ?? 'undefined')
  }
  walk(cd, true)
  return hash.digest('hex')
}

export async function loadParseWorker(checkout, { tmp } = {}) {
  const require = createRequire(path.join(checkout, 'package.json'))
  const esbuild = require('esbuild')
  const libsExternal = {
    name: 'libs-external',
    setup(build) {
      build.onResolve({ filter: /libs\/(parser2|hlextras)\/.*\.js$/ }, args => ({
        path: pathToFileURL(path.resolve(args.resolveDir, args.path)).href,
        external: true,
      }))
    },
  }
  const out = await esbuild.build({
    entryPoints: [path.join(checkout, 'src/components/Analyse/Data/ParseWorker.ts')],
    absWorkingDir: checkout,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    write: false,
    logLevel: 'silent',
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [libsExternal],
  })
  await esbuild.stop()
  // The wasm-bindgen glue fetches its .wasm next to itself (a file: URL here)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url instanceof Request ? url.url : url)
    if (u.startsWith('file:')) {
      return new Response(fs.readFileSync(fileURLToPath(u)), { headers: { 'Content-Type': 'application/wasm' } })
    }
    return realFetch(url, init)
  }
  const file = path.join(tmp ?? os.tmpdir(), `dribble-parse-worker-${process.pid}.mjs`)
  fs.writeFileSync(file, out.outputFiles[0].text)
  globalThis.onmessage = null // the module assigns onmessage and calls postMessage
  const posted = []
  globalThis.postMessage = message => posted.push(message)
  try {
    const mod = await import(pathToFileURL(file).href)
    return { handler: globalThis.onmessage, posted, mod }
  } finally {
    fs.rmSync(file, { force: true })
  }
}
