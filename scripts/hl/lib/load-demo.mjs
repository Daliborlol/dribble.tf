// Load a demo in Node the way the viewer does (task X2's tooling, ported for contract 14.2).
//
//   const { parsed, x, route, baseMs, extrasMs, modules } = await loadDemo(root, demoPath, { tmp, entries })
//
// The base parse runs the real AsyncParser.ts on the "main thread" and the real ParseWorker.ts in a Worker stand-in
// (a fresh module copy per `new Worker`, messages through structuredClone with their transfer lists), as
// scripts/hl/check-parse-routes.mjs does, so parser2, the no-timeline and the delayed-start fallback routes all run as
// in the browser. `route` lists what each worker was asked ('parser2', 'parser2-late', 'fallback:<trigger>').
// Then the Highlander extras: the real hlextras wasm with loadExtras.ts's options (every group, the items table's
// wearable defs) and hydrate.ts with the base scene origin. `entries` maps names to further TS/JS entries of the
// checkout (paths relative to `root`), bundled with esbuild and returned in `modules`. Only the three shim comes from
// this script's directory when `root` lacks one, so `root` may be an older checkout (comparing builds).
//
// All workers share this process, so a wasm heap is not freed when AsyncParser ends its worker: the process peaks
// higher than the browser. Bundled modules are separate instances from the ones inside the AsyncParser bundle.
// `tmp` holds the bundled modules only while they are imported (default: the OS temp dir).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** This process's resident and peak resident memory in MB (/proc/self/status), zeros when unavailable. */
export function vmMB() {
  try {
    const st = fs.readFileSync('/proc/self/status', 'utf8')
    const mb = re => Math.round(Number(re.exec(st)?.[1] ?? 0) / 1024)
    return { rss: mb(/VmRSS:\s+(\d+)/), hwm: mb(/VmHWM:\s+(\d+)/) }
  } catch {
    return { rss: 0, hwm: 0 }
  }
}

/** esbuild for a checkout: TS, its tsconfig path aliases, `three` mapped to the shim, wasm-bindgen glue external. */
export async function makeBundler(root) {
  const require = createRequire(path.join(root, 'package.json'))
  const esbuild = require('esbuild')
  const libs = {
    name: 'libs-external',
    setup(build) {
      build.onResolve({ filter: /libs\/(parser2|hlextras)\/.*\.js$/ }, args => ({
        path: pathToFileURL(path.resolve(args.resolveDir, args.path)).href,
        external: true,
      }))
    },
  }
  // The shim of the checkout under test, else this script's own, so --root also works on checkouts without one
  const rootShim = path.join(root, 'scripts/hl/lib/three-shim.mjs')
  const threeShim = fs.existsSync(rootShim) ? rootShim : fileURLToPath(new URL('./three-shim.mjs', import.meta.url))
  const bundle = async (entry, extra = {}) => {
    const out = await esbuild.build({
      ...(typeof entry === 'string'
        ? { entryPoints: [path.isAbsolute(entry) ? entry : path.join(root, entry)] }
        : { stdin: { contents: entry.contents, resolveDir: root, loader: 'ts', sourcefile: entry.name } }),
      absWorkingDir: root,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      plugins: [libs],
      alias: { three: threeShim },
      define: {
        'import.meta.env.DEV': 'false',
        'import.meta.env.PROD': 'false',
        'import.meta.env.VITE_APP_ASSET_URL': '""',
      },
      ...extra,
    })
    return out.outputFiles[0].text
  }
  return { bundle, stop: () => esbuild.stop() }
}

/** Imports bundled code through a temporary file in `tmp`, removed right after the import. */
export async function importCode(code, tmp, name) {
  const file = path.join(tmp, `${name}-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(file, code)
  try {
    return await import(pathToFileURL(file).href)
  } finally {
    fs.rmSync(file, { force: true })
  }
}

// What loadExtras.ts and ExtrasWorker.ts use around the extras parse, resolved inside `root` (stdin entry, so an
// older checkout under test needs no file of this script's)
const EXTRAS_ENTRY = {
  name: 'load-demo-extras-entry.ts',
  contents: "export { hydrate } from './src/highlander/extras/hydrate.ts'\nexport { wearableDefs } from './src/highlander/items.ts'\n",
}

export async function loadDemo(root, demoPath, { tmp = os.tmpdir(), extras = true, entries = {} } = {}) {
  const { bundle, stop } = await makeBundler(root)
  const workerCode = await bundle('src/components/Analyse/Data/ParseWorker.ts')
  const parserCode = await bundle('src/components/Analyse/Data/AsyncParser.ts')
  const extrasCode = extras ? await bundle(EXTRAS_ENTRY) : null
  const extraCode = {}
  for (const [name, entry] of Object.entries(entries)) extraCode[name] = await bundle(entry)
  await stop()

  // fetch: wasm from file: URLs, public files for the conversion.json lookups of the fallback bounds
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url instanceof Request ? url.url : url)
    if (u.startsWith('file:')) {
      return new Response(fs.readFileSync(fileURLToPath(u)), { headers: { 'Content-Type': 'application/wasm' } })
    }
    if (u.startsWith('/')) {
      const file = path.join(root, 'public', decodeURIComponent(u.split('?')[0]))
      return fs.existsSync(file) ? new Response(fs.readFileSync(file), { status: 200 }) : new Response('', { status: 404 })
    }
    return realFetch(url, init)
  }

  const route = []
  let workerSeq = 0
  globalThis.Worker = class StandInWorker {
    constructor() {
      this.id = ++workerSeq
      this.terminated = false
      this.ready = (async () => {
        // A fresh module instance per worker; the module assigns the global onmessage and calls the global postMessage
        const file = path.join(tmp, `parse-worker-${process.pid}-${this.id}.mjs`)
        fs.writeFileSync(file, workerCode)
        globalThis.onmessage = null
        try {
          await import(pathToFileURL(file).href)
        } finally {
          fs.rmSync(file, { force: true })
        }
        this.handler = globalThis.onmessage
      })()
    }
    postMessage(data, transfer = []) {
      const message = structuredClone(data, { transfer })
      route.push(message.fallback ? `fallback:${message.fallback.trigger}` : message.lateStart ? 'parser2-late' : 'parser2')
      void this.ready.then(async () => {
        globalThis.postMessage = (msg, transferList = []) => {
          const clone = structuredClone(msg, { transfer: transferList })
          if (!this.terminated) setTimeout(() => this.onmessage?.({ data: clone }), 0)
        }
        try {
          await this.handler({ data: message })
        } catch (error) {
          // An exception that leaves onmessage reaches the worker's onerror in the browser
          const text = String(error?.message ?? error)
          if (!this.terminated) setTimeout(() => this.onerror?.({ message: text }), 0)
        }
      })
    }
    terminate() {
      this.terminated = true
    }
  }

  const quiet = { log: console.log, info: console.info, warn: console.warn }
  console.log = () => {}
  console.info = () => {}
  console.warn = (...a) => process.stderr.write(`[warn] ${a.map(String).join(' ')}\n`)
  let parsed
  let baseMs
  try {
    const { AsyncParser } = await importCode(parserCode, tmp, 'asyncparser')
    const bytes = fs.readFileSync(demoPath)
    const t0 = performance.now()
    parsed = new AsyncParser(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), () => {})
    await parsed.cache()
    baseMs = performance.now() - t0
  } finally {
    Object.assign(console, quiet)
  }
  const fileBuffer = parsed.takeFileBuffer()

  let x = null
  let extrasMs = 0
  if (extras) {
    const { hydrate, wearableDefs } = await importCode(extrasCode, tmp, 'extras')
    const pkgDir = path.join(root, 'src/libs/hlextras')
    const wasmMod = await import(pathToFileURL(path.join(pkgDir, 'hlextras.js')).href)
    const wasm = wasmMod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'hlextras_bg.wasm')) })
    // loadExtras.ts's options, every group (the memory plan is not applied)
    const options = {
      startTick: parsed.startTick,
      tickBase: parsed.tickBase,
      ticks: parsed.ticks,
      intervalPerTick: parsed.intervalPerTick,
      playerEntityIds: Array.from(parsed.playerEntityIds()),
      wearableDefs: wearableDefs(),
    }
    const t1 = performance.now()
    let file = new Uint8Array(fileBuffer ?? fs.readFileSync(demoPath))
    const input = new wasmMod.ExtrasInput(file.length)
    new Uint8Array(wasm.memory.buffer, input.ptr(), file.length).set(file)
    file = null
    const raw = wasmMod.parse_demo_extras_input(input, options, () => {})
    if (typeof raw === 'string' || !raw) throw new Error(`extras parse failed: ${raw}`)
    x = hydrate(raw, { ...parsed.world.boundaryMin })
    extrasMs = performance.now() - t1
  }

  const modules = {}
  for (const [name, code] of Object.entries(extraCode)) modules[name] = await importCode(code, tmp, name)
  return { parsed, x, route, baseMs, extrasMs, modules }
}
