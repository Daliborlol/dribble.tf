// The real src/components/Analyse/Data/ParseWorker.ts in Node (task B2; B1's worker-node tool did the same).
//
//   const { handler, posted, mod } = await loadParseWorker(checkout, { tmp })
//   await handler({ data: { buffer } })      // the browser's first message; `posted` collects what it posts
//   mod.demoWarmup(bytes), mod.delayedStartOf(result, bytes)   // the module's exports
//
// The worker module is bundled with esbuild (TS, the tsconfig path aliases); its wasm-bindgen glue in src/libs stays
// external and loads its .wasm from the checkout through a file: fetch shim. onmessage and postMessage are worker
// globals, shimmed here. One worker per process: the module assigns the global onmessage.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
