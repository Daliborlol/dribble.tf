#!/usr/bin/env node
// The viewer's base-parse routes end to end (task B2): the real AsyncParser.ts on the main thread and the real
// ParseWorker.ts in every worker it starts.
//
//   flock $S/heavy.lock node scripts/hl/check-parse-routes.mjs <demo.dem> [--root <checkout>] [--tmp <dir>]
//       [--fake-delay <seconds>] [--force-empty] [--fail-fallback string|throw|empty]
//       [--expect parser2|fallback|parser2-after-failed-fallback|rejected] [--expect-sha256 <hex>] [--out <file>]
//
// A Worker stand-in runs a fresh copy of the bundled worker module per `new Worker` and passes every message through
// structuredClone with its transfer list, as the browser does (a transferred buffer is detached on the sending side,
// and class instances arrive as plain objects for AsyncParser to rehydrate). All workers share this process, so a
// wasm heap is not freed when AsyncParser terminates its worker, and the process peaks higher than the browser does.
//
// Test hooks. They replace the wasm-bindgen glue the worker imports (at bundle time), never the code under test:
//   --fake-delay s     parser2's result starts s seconds later (startDemoTick + s / intervalPerTick), which drives
//                      the delayed-start route on any demo
//   --force-empty      parser2's result has 1 tick and no players (what parser2 returns on 1429417): B1's route
//   --fail-fallback m  the fallback export fails: 'string' returns an error string (what it does for bad options),
//                      'throw' throws, 'empty' returns its result with 1 tick and no players
//
// Prints a JSON summary: the route (what each worker was asked and what it posted), every progress value the store
// gets, the parser warnings, parsedDemo's fallback fields and timeline, and the sha256 of the CachedDemo the last
// worker posted (lib/parse-worker.mjs hashCachedDemo, the hash check-delayed-start.mjs prints for a demo that stays on
// parser2, so a route can be compared with another checkout). Checks: the progress shown never falls, a load ends at
// 100, the file comes back once, and --expect / --expect-sha256. Exit code 1 when a check fails.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseArgs, REPO_ROOT, vmHwmKB } from './lib/bundle.mjs'
import { hashCachedDemo } from './lib/parse-worker.mjs'

const ROUTES = ['parser2', 'fallback', 'parser2-after-failed-fallback', 'rejected']
const { positional, flags } = parseArgs(process.argv.slice(2), ['force-empty'])
const demoPath = positional[0]
const failMode = flags['fail-fallback']
const fakeDelay = flags['fake-delay'] === undefined ? 0 : Number(flags['fake-delay'])
if (
  !demoPath ||
  (failMode !== undefined && !['string', 'throw', 'empty'].includes(failMode)) ||
  !Number.isFinite(fakeDelay) ||
  (flags.expect !== undefined && !ROUTES.includes(flags.expect))
) {
  console.error(
    'usage: node scripts/hl/check-parse-routes.mjs <demo.dem> [--root checkout] [--tmp dir] [--fake-delay s] [--force-empty] ' +
      `[--fail-fallback string|throw|empty] [--expect ${ROUTES.join('|')}] [--expect-sha256 hex] [--out file]`
  )
  process.exit(2)
}
const root = path.resolve(flags.root ?? REPO_ROOT)
const tmp = fs.mkdtempSync(path.join(flags.tmp ?? os.tmpdir(), 'b2-routes-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

// ─── the glue the worker imports, with the hooks ────────────────────────────────────────────────────────────────

const glue = name => JSON.stringify(pathToFileURL(path.join(root, `src/libs/${name}/${name}.js`)).href)
const wrappers = {}
if (fakeDelay || flags['force-empty']) {
  wrappers.parser2 = path.join(tmp, 'parser2-hooked.mjs')
  fs.writeFileSync(
    wrappers.parser2,
    [
      `import init, * as real from ${glue('parser2')}`,
      'export default init',
      `export * from ${glue('parser2')}`,
      'export function parse_demo_cache_with_progress(buffer, progress) {',
      '  let r = real.parse_demo_cache_with_progress(buffer, progress)',
      "  if (typeof r === 'string' || !r) return r",
      flags['force-empty'] ? '  r = { ...r, ticks: 1, players: [] }' : '',
      fakeDelay ? `  r = { ...r, startDemoTick: r.startDemoTick + Math.round(${fakeDelay} / r.intervalPerTick) }` : '',
      '  return r',
      '}',
    ].join('\n')
  )
}
if (failMode) {
  const body = {
    string: "  return 'forced failure (check-parse-routes --fail-fallback string)'",
    throw: "  throw new Error('forced failure (check-parse-routes --fail-fallback throw)')",
    empty: [
      '  const r = real.parse_demo_cache_fallback(buffer, options, progress)',
      "  return typeof r === 'string' || !r ? r : { ...r, ticks: 1, players: [] }",
    ].join('\n'),
  }[failMode]
  wrappers.hlextras = path.join(tmp, 'hlextras-hooked.mjs')
  fs.writeFileSync(
    wrappers.hlextras,
    [
      `import init, * as real from ${glue('hlextras')}`,
      'export default init',
      `export * from ${glue('hlextras')}`,
      'export function parse_demo_cache_fallback(buffer, options, progress) {',
      body,
      '}',
    ].join('\n')
  )
}

const require = createRequire(path.join(root, 'package.json'))
const esbuild = require('esbuild')
const libs = {
  name: 'libs-hooked',
  setup(build) {
    build.onResolve({ filter: /libs\/(parser2|hlextras)\/.*\.js$/ }, args => {
      const name = /libs\/(parser2|hlextras)\//.exec(args.path)[1]
      const file = wrappers[name] ?? path.resolve(args.resolveDir, args.path)
      return { path: pathToFileURL(file).href, external: true }
    })
  },
}
const bundle = async entry => {
  const out = await esbuild.build({
    entryPoints: [path.join(root, entry)],
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    write: false,
    logLevel: 'silent',
    plugins: [libs],
    alias: { three: path.join(root, 'scripts/hl/lib/three-shim.mjs') },
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'false',
      'import.meta.env.VITE_APP_ASSET_URL': '""',
    },
  })
  return out.outputFiles[0].text
}
const workerCode = await bundle('src/components/Analyse/Data/ParseWorker.ts')
const parserCode = await bundle('src/components/Analyse/Data/AsyncParser.ts')
await esbuild.stop()

// ─── the browser around AsyncParser: fetch and Worker ───────────────────────────────────────────────────────────

const fetched = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const u = String(url instanceof Request ? url.url : url)
  if (u.startsWith('file:')) {
    return new Response(fs.readFileSync(fileURLToPath(u)), { headers: { 'Content-Type': 'application/wasm' } })
  }
  if (u.startsWith('/')) {
    fetched.push(u)
    const file = path.join(root, 'public', decodeURIComponent(u.split('?')[0]))
    return fs.existsSync(file) ? new Response(fs.readFileSync(file), { status: 200 }) : new Response('', { status: 404 })
  }
  return realFetch(url, init)
}

const workers = []
let lastCachedDemo = null
globalThis.Worker = class StandInWorker {
  constructor() {
    this.record = { id: workers.length + 1, asked: null, posted: [], progress: { calls: 0 }, terminated: false }
    workers.push(this.record)
    this.onmessage = null
    this.onerror = null
    this.ready = (async () => {
      // A fresh module instance per worker; the module assigns the global onmessage and calls the global postMessage
      const file = path.join(tmp, `worker-${this.record.id}.mjs`)
      fs.writeFileSync(file, workerCode)
      globalThis.onmessage = null
      await import(pathToFileURL(file).href)
      this.handler = globalThis.onmessage
    })()
  }

  postMessage(data, transfer = []) {
    const message = structuredClone(data, { transfer })
    this.record.asked = message.fallback
      ? { kind: 'fallback', trigger: message.fallback.trigger, boundsSource: message.fallback.boundsSource }
      : { kind: message.lateStart ? 'parser2-late-start' : 'parser2' }
    void this.ready.then(async () => {
      globalThis.postMessage = (msg, transferList = []) => {
        this.note(msg)
        const clone = structuredClone(msg, { transfer: transferList })
        if (!this.record.terminated) setTimeout(() => this.onmessage?.({ data: clone }), 0)
      }
      try {
        await this.handler({ data: message })
      } catch (error) {
        // An exception that leaves onmessage reaches the worker's onerror in the browser
        const text = String(error?.message ?? error)
        if (!this.record.terminated) setTimeout(() => this.onerror?.({ message: text }), 0)
      }
    })
  }

  note(msg) {
    if (typeof msg?.progress === 'number') {
      const p = this.record.progress
      p.calls++
      p.first ??= msg.progress
      p.last = msg.progress
    } else if (msg?.error) {
      this.record.posted.push({ error: String(msg.error) })
    } else if (msg?.fallbackRequest) {
      const r = msg.fallbackRequest
      this.record.posted.push({ fallbackRequest: r.trigger, reason: r.reason, fileBufferBytes: msg.fileBuffer?.byteLength ?? null })
    } else if (msg?.fallbackFailed) {
      this.record.posted.push({ fallbackFailed: String(msg.fallbackFailed.error), fileBufferBytes: msg.fileBuffer?.byteLength ?? null })
    } else if (msg?.playerCache) {
      const sha256 = hashCachedDemo(msg)
      lastCachedDemo = { worker: this.record.id, sha256 }
      this.record.posted.push({
        cachedDemo: { ticks: msg.ticks, startTick: msg.startTick, startDemoTick: msg.startDemoTick, parserFallback: !!msg.parserFallback, sha256 },
      })
    } else this.record.posted.push({ other: Object.keys(msg ?? {}) })
  }

  terminate() {
    this.record.terminated = true
  }
}

const lines = []
const saved = { warn: console.warn, log: console.log, info: console.info, error: console.error }
const keep = level => (...args) => {
  const text = args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  if (/parser|fallback/i.test(text)) lines.push(`${level}: ${text}`)
}
console.warn = keep('warn')
console.log = keep('log')
console.error = keep('error')
console.info = () => {}

// ─── the load ────────────────────────────────────────────────────────────────────────────────────────────────────

const parserFile = path.join(tmp, 'asyncparser.mjs')
fs.writeFileSync(parserFile, parserCode)
const { AsyncParser } = await import(pathToFileURL(parserFile).href)

const bytes = fs.readFileSync(demoPath)
const progress = []
const t0 = performance.now()
const parsed = new AsyncParser(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), p => progress.push(p))
let error = null
try {
  await parsed.cache()
} catch (e) {
  error = String(e?.message ?? e)
}
const ms = Math.round(performance.now() - t0)
const handBack = parsed.takeFileBuffer()
const takeAgain = parsed.takeFileBuffer()
Object.assign(console, saved)

const kinds = workers.map(w => w.asked?.kind ?? 'none').join('>')
const route = error
  ? 'rejected'
  : ({ parser2: 'parser2', 'parser2>fallback': 'fallback', 'parser2>fallback>parser2-late-start': 'parser2-after-failed-fallback' }[kinds] ??
    `other: ${kinds}`)
let aliveMid = null
if (!error && parsed.ticks > 1) {
  const mid = Math.floor(parsed.ticks / 2)
  aliveMid = parsed.getPlayersAtTick(mid).filter(p => p.health > 0 && (p.teamId === 2 || p.teamId === 3)).length
}
const falls = progress.filter((p, i) => i > 0 && p < progress[i - 1]).length

const failures = []
if (falls) failures.push(`the progress shown falls ${falls} times`)
if (!error) {
  if (progress.at(-1) !== 100) failures.push(`the last progress shown is ${progress.at(-1)}, not 100`)
  if (handBack?.byteLength !== bytes.length) failures.push(`the file came back with ${handBack?.byteLength ?? 'no'} bytes, not ${bytes.length}`)
  if (takeAgain !== undefined) failures.push('takeFileBuffer returned the file twice')
}
if (flags.expect && route !== flags.expect) failures.push(`route ${route}, expected ${flags.expect}`)
if (flags['expect-sha256'] && lastCachedDemo?.sha256 !== flags['expect-sha256']) {
  failures.push(`the last CachedDemo hashes to ${lastCachedDemo?.sha256 ?? 'nothing'}, expected ${flags['expect-sha256']}`)
}

const summary = {
  demo: path.basename(demoPath),
  root,
  hooks: { fakeDelaySeconds: fakeDelay || null, forceEmpty: !!flags['force-empty'], failFallback: failMode ?? null },
  route,
  ok: failures.length === 0,
  failures,
  error,
  workers,
  lastCachedDemo,
  parsed: error
    ? null
    : {
        parserFallback: parsed.parserFallback,
        info: parsed.parserFallbackInfo ?? null,
        failure: parsed.parserFallbackFailure ?? null,
        ticks: parsed.ticks,
        startTick: parsed.startTick,
        startDemoTick: parsed.startDemoTick,
        tickBase: parsed.tickBase,
        positionScale: parsed.positionScale,
        players: parsed.entityPlayerMap.size,
        world: parsed.world,
        aliveMid,
      },
  progress: {
    calls: progress.length,
    first: progress[0] ?? null,
    last: progress.at(-1) ?? null,
    falls,
    values: progress.filter((p, i) => i === 0 || p !== progress[i - 1]),
  },
  fileBack: { bytes: handBack?.byteLength ?? null, fileBytes: bytes.length, secondTakeUndefined: takeAgain === undefined },
  lines,
  fetched,
  ms,
  vmHwmMB: Math.round(vmHwmKB() / 1024),
}
const json = JSON.stringify(summary, null, 1)
if (flags.out) fs.writeFileSync(flags.out, json)
console.log(json)
process.exit(failures.length ? 1 : 0)
