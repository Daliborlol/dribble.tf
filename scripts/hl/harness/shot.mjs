#!/usr/bin/env node
// dribble.tf headless validation harness.
//
// Builds a dribble.tf checkout (repo or worktree), serves it plus a local .dem on
// 127.0.0.1, opens it in headless Chromium (hardware WebGL through ANGLE, SwiftShader as the
// fallback), waits for the demo to parse, then seeks / switches camera modes through
// window.__dribble (src/utils/debugBridge.ts) and saves screenshots, console logs and optional
// perf numbers. Always shuts down the server and browser. Takes the heavy-command lock itself
// (re-execs under flock).
//
// Run `node scripts/hl/harness/shot.mjs --help` for options; README.md next to this file has the details.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_LOCK_NAME,
  HARNESS_CHECKOUT,
  HARNESS_DIR,
  SetupError,
  ancestorHoldsLock,
  describeBrowser,
  findOnPath,
  isCheckout,
  loadPlaywright,
  lockFileFrom,
  mainCheckoutOf,
  parentOf,
  playwrightIfInstalled,
  resolveBrowser,
  resolvePlaywright,
  shown,
} from './lib/setup.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const COMMON_FLAGS = [
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--mute-audio',
]
// The Radeon 680M render node (/dev/dri/renderD128) works headless through ANGLE: 'egl'
// (radeonsi GLES) or 'vulkan' (RADV). SwiftShader is the CPU fallback (1 fps, all cores).
const GPU_FLAGS = {
  egl: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu'],
  vulkan: ['--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--enable-gpu'],
  swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.dem': 'application/octet-stream',
}
// The asset pack (specs/assets/contract.md 3.3): served at PACK_ROUTE, built in with VITE_ASSET_PACK_URL.
const PACK_ROUTE = '/tf2-assets/'
const PACK_MISSING = 'missing'
const PACK_MIME = {
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.dds': 'application/octet-stream',
  '.webp': 'image/webp',
}
const NO_VSYNC_FLAGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit']
const ASSETS_IDLE_MS = 30000
const INTERP_DELAY_TICKS = 2 // DemoViewer renders playback tick - 2
const CLASS_ORDER = { scout: 1, soldier: 2, pyro: 3, demoman: 4, heavy: 5, engineer: 6, medic: 7, sniper: 8, spy: 9 }
const MODES = ['rts', 'pov', 'spectator']
const STEP_FIELDS = new Set(['name', 'tick', 'mode', 'player', 'settings', 'camera', 'speed', 'play', 'reset', 'hideHud', 'eval', 'screenshot'])
const EXIT_USAGE = 2
const EXIT_GATE = 75 // EX_TEMPFAIL: the memory gate did not open

const HELP = `
dribble.tf headless harness

  node ${shown(SCRIPT)} --demo <file.dem> [options]

Builds a dribble.tf checkout, serves it and a local demo on 127.0.0.1, drives the page in headless
Chromium through window.__dribble and writes screenshots, manifest.json and console.log.
Setup, the plan format, the manifest and the debug bridge: ${shown(path.join(HARNESS_DIR, 'README.md'))}

Input
  --root <dir>            checkout or worktree to build (default: the checkout holding this script,
                          ${HARNESS_CHECKOUT})
  --demo <file.dem>       local SourceTV demo (required)
  --plan <file.json>      JSON array of steps (overrides --ticks/--modes/--pov), see below
  --ticks <list>          playback ticks or percentages, e.g. 3000,12000 or 10%,50% (default 10%,50%,90%)
  --modes <list>          rts,pov,spectator (default rts,pov)
  --pov <list>            POV targets: auto | entityId | name | class[@red|@blue] (default auto)
Output
  --out <dir>             output dir (default <root>/../<root name>-harness-out/<demo>-<timestamp>)
  --size <WxH>            viewport (default 1600x900)
  --hide-hud              hide the React HUD layers in every shot (scene only)
  --settle-ms <n>         extra wait before each shot (default 700)
  --settle-frames <n>     animation frames to wait before each shot (default 8)
Perf
  --perf                  open with ?perf=true and collect [Perf] console lines
  --perf-play <spec>      tick:seconds[:mode[:player[:speed]]] e.g. 50%:10:rts or 21000:8:pov:medic@red:0
                          (speed 0 = paused) -> perf.json (fps, frame ms, ticks/s, long tasks, memory)
  --cpu-profile           with --perf-play: record a CDP CPU profile + top self-time table
Build
  --rebuild               force a rebuild;  --no-build  reuse the last build even if stale
  --no-minify             unminified build (separate cache) so --cpu-profile shows real function names
  --build-cache <dir>     build cache (env DRIBBLE_HARNESS_BUILDS; default <root>/node_modules/.cache/dribble-harness)
Browser and page
  --browser <shell|chrome|path>
                          shell = Playwright chrome-headless-shell (lighter), chrome = Playwright chromium, each
                          of the revision the harness's playwright-core expects, else the newest with a warning;
                          or a browser executable. Default: env CHROME_PATH, else the expected shell, then the
                          expected chromium, then the newest shell, then the newest chromium
                          (searched in $PLAYWRIGHT_BROWSERS_PATH and ~/.cache/ms-playwright)
  --gpu <egl|vulkan|swiftshader>  WebGL backend (default egl = AMD iGPU; falls back to swiftshader)
  --keep-default-map      do not stub the boot map GLB (by default only the demo's map GLB loads)
  --allow-network         do not block non-local requests (fonts, analytics)
  --query <a=1&b=2>       extra URL query parameters (repeatable)
  --init-script <file>    add a script that runs in the page before the app (repeatable)
  --no-vsync              uncapped frames: --disable-gpu-vsync --disable-frame-rate-limit (recorded in perf.json)
Asset pack
  --asset-pack <dir|missing>
                          serve <dir> at ${PACK_ROUTE} and build with VITE_ASSET_PACK_URL=${PACK_ROUTE} (own build
                          cache entry); "missing" builds the same way and answers 404 for every ${PACK_ROUTE} path.
                          Without it the build is the production default and ${PACK_ROUTE} answers 404
Run
  --timeout <sec>         hard timeout for the whole run (default 900)
  --load-timeout <sec>    time for the demo to parse and the scene to switch to its map (default 300)
  --lock <file>           lock that serialises heavy runs (env DRIBBLE_HARNESS_LOCK;
                          default ${path.join(os.tmpdir(), DEFAULT_LOCK_NAME)})
  --no-lock               caller already holds the lock (an ancestor \`flock <lock>\` is detected by itself)
  --min-available <MB>    memory gate, checked once the lock is held: MemAvailable must be at least MB
  --wait-available <sec>  keep checking the gate this long before giving up (default 0); a closed gate
                          exits with code ${EXIT_GATE} and runs nothing
  --check                 print the resolved setup (root, build cache, lock, playwright-core, browser) and exit
  --help, -h              this text

Plan steps (all fields optional; tick defaults to "50%"):
  {"name":"blu-sniper","tick":"50%","mode":"pov","player":"sniper@blue",
   "settings":{"ui.nameplate.enabled":false},"camera":{"mode":"rts","position":[x,y,z],"target":[x,y,z]},
   "speed":1,"play":3,"reset":true,"hideHud":false,"eval":"window.__dribble.getState()","screenshot":true}
  "tick" is a playback tick (cache tick + 2) or a percentage of the demo. "play" plays N seconds of wall
  time after seeking; "eval" is a page expression evaluated after seeking/camera setup and before settling
  (so UI it opens is captured); a returned promise is awaited and its JSON result goes to manifest.json.
  Raw stores: window.__dribble.stores.useStore / useInstance.
`

// ─── ARGS ──────────────────────────────────────────────────────────────────────

// bool: a switch (an optional true/false value); value: one value; list: repeatable, comma lists allowed;
// number: one non-negative number.
const FLAGS = {
  root: 'value',
  demo: 'value',
  plan: 'value',
  ticks: 'list',
  modes: 'list',
  pov: 'list',
  out: 'value',
  size: 'value',
  'hide-hud': 'bool',
  'settle-ms': 'number',
  'settle-frames': 'number',
  perf: 'bool',
  'perf-play': 'value',
  'cpu-profile': 'bool',
  rebuild: 'bool',
  'no-build': 'bool',
  'no-minify': 'bool',
  'build-cache': 'value',
  browser: 'value',
  gpu: 'value',
  'keep-default-map': 'bool',
  'allow-network': 'bool',
  query: 'list',
  'init-script': 'list',
  'no-vsync': 'bool',
  'asset-pack': 'value',
  timeout: 'number',
  'load-timeout': 'number',
  lock: 'value',
  'no-lock': 'bool',
  'min-available': 'number',
  'wait-available': 'number',
  check: 'bool',
  help: 'bool',
}
const BOOL_WORDS = { true: true, 1: true, yes: true, false: false, 0: false, no: false }

const parseArgs = argv => {
  const args = {}
  const problems = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '-h') {
      args.help = true
      continue
    }
    if (!token.startsWith('--')) {
      problems.push(`unexpected argument "${token}"`)
      continue
    }
    const [key, inlineValue] = token.slice(2).split(/=(.*)/s, 2)
    const kind = FLAGS[key]
    if (!kind) {
      problems.push(
        `unknown option --${key}` +
          (/\s/.test(key) ? ' (an option and its value arrived as one argument; in zsh write e.g. --query a=b literally)' : '')
      )
      if (inlineValue === undefined && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) i++ // its value
      continue
    }
    let value
    if (kind === 'bool') {
      const word = inlineValue ?? (String(argv[i + 1]).toLowerCase() in BOOL_WORDS ? argv[++i] : undefined)
      value = word === undefined ? true : BOOL_WORDS[String(word).toLowerCase()]
      if (value === undefined) {
        problems.push(`--${key} is a switch; "${word}" is not true or false`)
        continue
      }
    } else if (inlineValue !== undefined) value = inlineValue
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i]
    else {
      problems.push(`--${key} needs a value`)
      continue
    }
    if (kind === 'number' && !(Number.isFinite(Number(value)) && Number(value) >= 0)) {
      problems.push(`--${key} needs a non-negative number, got "${value}"`)
      continue
    }
    if (kind === 'list') args[key] = [...(args[key] ?? []), value]
    else if (args[key] !== undefined) problems.push(`--${key} given more than once`)
    else args[key] = value
  }
  return { args, problems }
}

const parsed = parseArgs(process.argv.slice(2))
const args = parsed.args
const list = value =>
  [].concat(value ?? []).flatMap(v => String(v).split(',')).map(v => v.trim()).filter(Boolean)
const num = (value, fallback) => (value === undefined || value === true ? fallback : Number(value))
const isTickSpec = value => /^\s*\d+(\.\d+)?%?\s*$/.test(String(value))

if (args.help) {
  console.log(HELP)
  process.exit(0)
}

// Option values that can be checked without the lock, so a typo fails at once instead of after a build.
const usageProblems = [...parsed.problems]
if (args.size !== undefined && !/^\d+x\d+$/.test(String(args.size))) usageProblems.push(`--size needs WxH, e.g. 1600x900 (got "${args.size}")`)
if (args.gpu !== undefined && !GPU_FLAGS[String(args.gpu)]) usageProblems.push(`unknown --gpu ${args.gpu} (egl|vulkan|swiftshader)`)
for (const tick of list(args.ticks)) if (!isTickSpec(tick)) usageProblems.push(`bad tick "${tick}" in --ticks (a playback tick or a percentage)`)
for (const mode of list(args.modes)) if (!MODES.includes(mode)) usageProblems.push(`unknown mode "${mode}" in --modes (${MODES.join('|')})`)
if (args['perf-play'] !== undefined) {
  const [tickSpec = '50%', secondsSpec = '10', mode = 'rts', , speedSpec = '1'] = String(args['perf-play']).split(':')
  if (!isTickSpec(tickSpec) || !(Number(secondsSpec) > 0) || !(mode === '' || MODES.includes(mode)) || !(Number(speedSpec) >= 0)) {
    usageProblems.push(`bad --perf-play "${args['perf-play']}" (tick:seconds[:mode[:player[:speed]]], e.g. 50%:10:rts)`)
  }
}
if (args['cpu-profile'] && !args['perf-play']) usageProblems.push('--cpu-profile needs --perf-play')
if (usageProblems.length) {
  console.error(`[harness] ${usageProblems.join('\n[harness] ')}\n[harness] see --help`)
  process.exit(EXIT_USAGE)
}

// ─── SETUP (checked before the lock) ──────────────────────────────────────────────

const lockFile = lockFileFrom(args.lock)

function readPlan(file) {
  let plan
  try {
    plan = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new SetupError(`--plan ${file}: ${error?.message || error}`)
  }
  if (!Array.isArray(plan)) throw new SetupError('--plan must be a JSON array of steps')
  plan.forEach((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new SetupError(`--plan step ${index} is not an object`)
    if (step.tick !== undefined && !isTickSpec(step.tick)) throw new SetupError(`--plan step ${index}: bad tick "${step.tick}"`)
    if (step.mode !== undefined && !MODES.includes(step.mode)) throw new SetupError(`--plan step ${index}: unknown mode "${step.mode}"`)
    const unknown = Object.keys(step).filter(key => !STEP_FIELDS.has(key))
    if (unknown.length && process.env.DRIBBLE_HARNESS_LOCKED !== '1') console.warn(`[harness] --plan step ${index}: unknown field(s) ${unknown.join(', ')} (ignored)`)
  })
  return plan
}

function resolveSetup() {
  const root = path.resolve(String(args.root ?? HARNESS_CHECKOUT))
  if (!isCheckout(root)) throw new SetupError(`${root} is not a dribble.tf checkout (no vite.config.mts and src/)`)
  const demoPath = args.demo ? path.resolve(String(args.demo)) : null
  if (!demoPath || !fs.existsSync(demoPath)) throw new SetupError(`--demo missing or not found (${args.demo ?? ''}); see --help`)
  const plan = args.plan ? readPlan(path.resolve(String(args.plan))) : null
  const initScripts = list(args['init-script']).map(file => path.resolve(file))
  for (const file of initScripts) if (!fs.existsSync(file)) throw new SetupError(`--init-script ${file} not found`)
  const assetPack = resolveAssetPackArg()
  const playwright = resolvePlaywright()
  const browser = resolveBrowser(args.browser, playwright)
  return { root, demoPath, plan, initScripts, assetPack, playwright, browser }
}

/** --asset-pack: null without it, { dir: null } for "missing", else { dir } (absolute, an existing folder). */
function resolveAssetPackArg() {
  if (args['asset-pack'] === undefined) return null
  const value = String(args['asset-pack'])
  if (value === PACK_MISSING) return { dir: null }
  const dir = path.resolve(value)
  let stat = null
  try {
    stat = fs.statSync(dir)
  } catch {}
  if (!stat?.isDirectory()) throw new SetupError(`--asset-pack ${dir} is not a folder (give a pack folder or the word "${PACK_MISSING}")`)
  return { dir: fs.realpathSync(dir) }
}

const failSetup = error => {
  const text = error instanceof SetupError ? error.message : error?.stack || String(error)
  console.error(`[harness] FAILED: ${text.split('\n').join('\n[harness]   ')}`)
  process.exit(1)
}

if (args.check) {
  await runCheck()
} else {
  let setup
  try {
    setup = resolveSetup()
  } catch (error) {
    failSetup(error)
  }

  // ─── LOCK (re-exec under flock unless an ancestor already holds the lock) ─────────
  const flock = findOnPath('flock')
  const locked = args['no-lock'] || process.env.DRIBBLE_HARNESS_LOCKED === '1' || ancestorHoldsLock(lockFile)
  if (!locked && flock && !fs.existsSync(path.dirname(lockFile))) failSetup(new SetupError(`the folder of the lock file ${lockFile} does not exist`))
  if (!locked && flock) {
    console.log(`[harness] waiting for ${lockFile} ...`)
    const child = spawn(flock, [lockFile, process.execPath, SCRIPT, ...process.argv.slice(2)], {
      stdio: 'inherit',
      detached: true,
      env: { ...process.env, DRIBBLE_HARNESS_LOCKED: '1' },
    })
    const forward = signal => {
      try {
        process.kill(-child.pid, signal)
      } catch {}
    }
    process.on('SIGINT', () => forward('SIGINT'))
    process.on('SIGTERM', () => forward('SIGTERM'))
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  } else {
    if (!locked) console.warn(`[harness] WARNING: flock is not on PATH; running without the lock ${lockFile}`)
    if (args['min-available'] !== undefined) await memoryGate()
    await main(setup).catch(error => {
      console.error(`[harness] FAILED: ${error instanceof SetupError ? error.message : error?.stack || error}`)
      process.exitCode = 1
    })
    process.exit(process.exitCode ?? 0)
  }
}

// ─── CHECK / MEMORY GATE ──────────────────────────────────────────────────────────

async function runCheck() {
  const rows = []
  const problems = []
  const notes = []
  const row = (label, value) => rows.push(`  ${label.padEnd(16)} ${value}`)
  const attempt = (label, fn) => {
    try {
      row(label, fn())
    } catch (error) {
      row(label, `PROBLEM (see below)`)
      problems.push(error instanceof SetupError ? error.message : error?.stack || String(error))
    }
  }
  const root = path.resolve(String(args.root ?? HARNESS_CHECKOUT))
  row('harness', HARNESS_DIR)
  attempt('root', () => {
    if (!isCheckout(root)) throw new SetupError(`${root} is not a dribble.tf checkout (no vite.config.mts and src/)`)
    const main = mainCheckoutOf(root)
    return `${root}${main && path.resolve(main) !== root ? ` (worktree of ${main})` : ''}`
  })
  attempt('node_modules', () => {
    const target = path.join(root, 'node_modules')
    if (fs.existsSync(target)) {
      const link = fs.lstatSync(target).isSymbolicLink() ? ` -> ${fs.readlinkSync(target)}` : ''
      return `${target}${link}`
    }
    const shared = sharedNodeModules(root)
    if (shared) return `missing; the run links it to ${shared}`
    throw new SetupError(`${target} missing and no main checkout to share it from. ${installAppHint(root)}`)
  })
  let packArg = null
  attempt('asset pack', () => {
    packArg = resolveAssetPackArg()
    if (!packArg) return `none (production default build, ${PACK_ROUTE} answers 404)`
    if (!packArg.dir) return `missing: build with VITE_ASSET_PACK_URL=${PACK_ROUTE}, every ${PACK_ROUTE} path answers 404`
    const info = readPackInfo(packArg)
    return `${packArg.dir} at ${PACK_ROUTE} (manifest.json ${info.manifestSha256 ? `sha256 ${info.manifestSha256.slice(0, 12)}, fingerprint ${info.fingerprint ?? 'null'}, generator ${info.generatorVersion ?? 'null'}` : 'MISSING'}${info.problem ? `; ${info.problem}` : ''})`
  })
  attempt('build cache', () => {
    const dir = buildCacheDir(root)
    const packUrl = packArg ? PACK_ROUTE : null
    const key = buildKey(root, packUrl)
    const status = ['', '-nominify']
      .map(suffix => {
        const distDir = path.join(dir, key + suffix, 'dist')
        if (!fs.existsSync(path.join(distDir, 'index.html'))) return null
        const fpFile = path.join(dir, key + suffix, 'fingerprint.txt')
        const fresh = fs.existsSync(fpFile) && fs.readFileSync(fpFile, 'utf8') === fingerprint(root, packUrl)
        return `${key + suffix} ${fresh ? 'fresh' : 'stale'}`
      })
      .filter(Boolean)
    return `${dir} (${status.length ? status.join(', ') : `no build yet for key ${key}`})`
  })
  const flock = findOnPath('flock')
  row('lock', `${lockFile} (${flock ? `flock ${flock}` : 'flock not on PATH: runs would go unlocked'})`)
  attempt('playwright-core', () => {
    const { version, dir } = resolvePlaywright()
    return `${version} ${dir}`
  })
  attempt('browser', () => {
    const playwright = playwrightIfInstalled()
    const browser = resolveBrowser(args.browser, playwright)
    if (browser.mismatch) notes.push(browser.mismatch)
    return describeBrowser(browser, playwright)
  })
  if (args.demo) {
    attempt('demo', () => {
      const demoPath = path.resolve(String(args.demo))
      const header = readDemoHeader(demoPath)
      return `${demoPath} map=${header.map} ticks=${header.ticks} duration=${header.duration.toFixed(0)}s`
    })
  }
  if (args.plan) attempt('plan', () => `${readPlan(path.resolve(String(args.plan))).length} step(s)`)
  const demoName = args.demo ? path.basename(String(args.demo), '.dem') : '<demo>'
  row('out', args.out ? path.resolve(String(args.out)) : defaultOutDir(root, demoName, '<timestamp>'))
  row('memory', `${availableMB() ?? '?'} MB available`)
  console.log(`[harness] setup\n${rows.join('\n')}`)
  if (notes.length) console.warn(`\n[harness] WARNING:\n- ${notes.map(n => n.split('\n').join('\n  ')).join('\n- ')}`)
  if (problems.length) {
    console.error(`\n[harness] ${problems.length} problem(s):\n- ${problems.map(p => p.split('\n').join('\n  ')).join('\n- ')}`)
    process.exit(1)
  }
  process.exit(0)
}

function availableMB() {
  try {
    const kb = Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1])
    return Number.isFinite(kb) ? Math.round(kb / 1024) : null
  } catch {
    return null
  }
}

async function memoryGate() {
  const need = Number(args['min-available'])
  const deadline = Date.now() + num(args['wait-available'], 0) * 1000
  for (;;) {
    const available = availableMB()
    if (available === null) {
      console.warn('[harness] WARNING: /proc/meminfo unreadable; memory gate skipped')
      return
    }
    if (available >= need) {
      console.log(`[harness] memory gate open: ${available} MB available (need ${need})`)
      return
    }
    if (Date.now() >= deadline) {
      console.error(`[harness] memory gate closed: ${available} MB available, need ${need}; run skipped`)
      process.exit(EXIT_GATE)
    }
    console.log(`[harness] waiting for memory: ${available} MB available, need ${need}`)
    await sleep(Math.min(10000, Math.max(1000, deadline - Date.now())))
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────────

async function main({ root, demoPath, plan, initScripts, assetPack, playwright, browser: browserChoice }) {
  const startedAt = Date.now()
  const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)
  const log = (...parts) => console.log(`[harness ${elapsed()}s]`, ...parts)

  const [width, height] = String(args.size ?? '1600x900').split('x').map(Number)
  const demoName = path.basename(demoPath, '.dem')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = path.resolve(String(args.out ?? defaultOutDir(root, demoName, stamp)))
  fs.mkdirSync(outDir, { recursive: true })

  const demoHeader = readDemoHeader(demoPath)
  log(`root=${root}`)
  log(`demo=${demoPath} map=${demoHeader.map} ticks=${demoHeader.ticks} duration=${demoHeader.duration.toFixed(0)}s`)
  log(`out=${outDir}`)

  const cleanups = []
  const cleanup = async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()
      try {
        await fn()
      } catch (error) {
        console.error('[harness] cleanup error', error?.message || error)
      }
    }
  }
  let cleaning = false
  const onSignal = signal => {
    if (cleaning) return
    cleaning = true
    console.error(`[harness] ${signal}: shutting down`)
    cleanup().finally(() => process.exit(130))
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const hardTimeout = setTimeout(() => {
    console.error(`[harness] hard timeout after ${num(args.timeout, 900)}s: shutting down`)
    cleaning = true
    cleanup().finally(() => process.exit(124))
  }, num(args.timeout, 900) * 1000)
  hardTimeout.unref()

  const consoleLines = []
  const record = (kind, text) => consoleLines.push(`${elapsed()}s ${kind.padEnd(9)} ${text}`)
  const warnings = []
  const manifest = {
    root,
    demo: demoPath,
    header: demoHeader,
    viewport: { width, height },
    startedAt: new Date(startedAt).toISOString(),
    assetPack: readPackInfo(assetPack),
    shots: [],
    warnings,
  }
  if (manifest.assetPack.problem) {
    warnings.push(`asset pack: ${manifest.assetPack.problem}`)
    log(`WARNING asset pack: ${manifest.assetPack.problem}`)
  }
  delete manifest.assetPack.problem
  if (assetPack) log(`asset pack: ${assetPack.dir ?? PACK_MISSING} at ${PACK_ROUTE}${manifest.assetPack.fingerprint ? ` fingerprint ${manifest.assetPack.fingerprint}` : ''}`)
  // Every same-origin request, one entry per method and path (query kept) in order of first occurrence.
  const requestLog = new Map()
  const requestEntry = new Map()
  const requestTotals = { total: 0, failed: 0, byPrefix: {} }
  manifest.requests = []
  manifest.requestSummary = requestTotals
  // A request failed when it got no response, a status of 400 or more, or a network error after its response.
  const rawFailed = raw => !!raw.failure || raw.status === null || raw.status >= 400

  try {
    // 1. dependencies + build
    ensureNodeModules(root, log)
    const packUrl = assetPack ? PACK_ROUTE : null
    const distDir = await ensureBuild(root, outDir, log, packUrl)

    // 2. server
    const server = await startServer({
      distDir,
      publicDir: path.join(root, 'public'),
      demoPath,
      demoMap: demoHeader.map,
      stubOtherMaps: !args['keep-default-map'],
      packDir: assetPack?.dir ?? null,
      log,
    })
    cleanups.push(
      () =>
        new Promise(resolve => {
          server.closeAllConnections?.()
          server.close(() => resolve())
        })
    )
    log(`serving on ${server.origin}`)

    // 3. browser
    const chromium = await loadPlaywright(playwright)
    const executablePath = browserChoice.executablePath
    log(`browser: ${describeBrowser(browserChoice, playwright)}, playwright-core ${playwright.version}`)
    if (browserChoice.mismatch) {
      warnings.push(`browser: ${browserChoice.mismatch}`)
      log(`WARNING: ${browserChoice.mismatch}`)
    }
    const noVsync = !!args['no-vsync']
    const { browser, gpu, renderer } = await launchBrowser(chromium, executablePath, String(args.gpu ?? 'egl'), noVsync, log)
    manifest.browser = { executablePath, gpu, renderer, noVsync }
    const browserPid = findChildPid(executablePath)
    cleanups.push(async () => {
      const closed = await withTimeout(browser.close().then(() => true), 15000, 'browser.close')
      if (!closed && browserPid) {
        try {
          process.kill(-browserPid, 'SIGKILL')
        } catch {}
      }
    })
    const memory = startMemorySampler(browserPid)
    cleanups.push(() => memory.stop())

    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
    for (const file of initScripts) {
      await context.addInitScript({ path: file })
      log(`init script ${file}`)
    }
    const page = await context.newPage()

    // drei's useGLTF loads the Draco decoder from www.gstatic.com (player models are Draco
    // compressed). Serve three's bundled copy instead so runs work offline and deterministically.
    const dracoDir = path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf')
    await context.route('https://www.gstatic.com/draco/**', route => {
      const file = path.join(dracoDir, path.basename(new URL(route.request().url()).pathname))
      if (!fs.existsSync(file)) return route.abort('filenotfound')
      return route.fulfill({
        status: 200,
        contentType: file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        body: fs.readFileSync(file),
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    })
    if (!args['allow-network']) {
      await context.route(
        url => url.hostname !== '127.0.0.1' && url.hostname !== 'www.gstatic.com',
        route => {
          const url = new URL(route.request().url())
          if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
          return route.abort('blockedbyclient')
        }
      )
    }

    // Request log: the context sees the page's and its workers' requests.
    const sameOrigin = request => {
      try {
        const url = new URL(request.url())
        return url.origin === server.origin ? url : null
      } catch {
        return null
      }
    }
    context.on('request', request => {
      const url = sameOrigin(request)
      if (!url) return
      const method = request.method()
      const key = `${method} ${url.pathname}${url.search}`
      let entry = requestLog.get(key)
      if (!entry) {
        entry = { path: url.pathname + url.search, method, status: null, type: request.resourceType(), count: 0, failure: null }
        requestLog.set(key, entry)
        manifest.requests.push(entry)
      }
      entry.count++
      requestEntry.set(request, { entry, status: null, failure: null })
      requestTotals.total++
      const prefix = url.pathname.match(/^\/[^/]+\//)?.[0] ?? '/'
      requestTotals.byPrefix[prefix] = (requestTotals.byPrefix[prefix] ?? 0) + 1
    })
    context.on('response', response => {
      const raw = requestEntry.get(response.request())
      if (!raw) return
      raw.status = response.status()
      if (raw.entry.status === null) raw.entry.status = raw.status
    })
    const settleLog = (request, failure) => {
      const raw = requestEntry.get(request)
      if (!raw) return
      requestEntry.delete(request)
      if (failure) {
        raw.failure = failure
        raw.entry.failure ??= failure
      }
      if (rawFailed(raw)) requestTotals.failed++
    }
    context.on('requestfinished', request => settleLog(request, null))
    context.on('requestfailed', request => settleLog(request, request.failure()?.errorText ?? 'failed'))

    const inflight = new Set()
    let lastNetworkActivity = Date.now()
    page.on('request', request => {
      inflight.add(request)
      lastNetworkActivity = Date.now()
    })
    const settleRequest = request => {
      inflight.delete(request)
      lastNetworkActivity = Date.now()
    }
    page.on('requestfinished', settleRequest)
    // fetch() callers often never read an error body (e.g. a 404 conversion.json), so
    // Playwright never reports those requests as finished. Treat error responses as settled.
    page.on('response', response => {
      if (response.status() >= 400) settleRequest(response.request())
    })
    page.on('requestfailed', request => {
      settleRequest(request)
      const url = new URL(request.url())
      if (url.hostname === '127.0.0.1') record('reqfail', `${request.url()} ${request.failure()?.errorText}`)
    })
    page.on('console', message => {
      let where = ''
      try {
        const loc = message.location()
        if (loc?.url) where = ` (${path.basename(new URL(loc.url).pathname)}:${loc.lineNumber})`
      } catch {}
      record(message.type(), `${message.text()}${message.type() === 'error' ? where : ''}`)
    })
    page.on('pageerror', error => record('pageerror', error?.stack || String(error)))
    page.on('dialog', async dialog => {
      record('dialog', `${dialog.type()}: ${dialog.message()}`)
      warnings.push(`dialog: ${dialog.message()}`)
      await dialog.dismiss().catch(() => {})
    })

    const waitForNetworkIdle = async (idleMs = 600, maxMs = 30000) => {
      const deadline = Date.now() + maxMs
      while (Date.now() < deadline) {
        if (inflight.size === 0 && Date.now() - lastNetworkActivity >= idleMs) return true
        await sleep(100)
      }
      const pending = [...inflight].map(request => request.url()).slice(0, 5)
      warnings.push(`network not idle after ${maxMs}ms: ${pending.join(', ')}`)
      log(`WARNING network not idle after ${maxMs}ms, pending: ${pending.join(', ')}`)
      return false
    }
    const bridge = (fn, arg) => page.evaluate(fn, arg)
    const getState = () => bridge(() => window.__dribble.getState())

    // 4. load
    const query = new URLSearchParams({ debug: '1', demoUrl: server.demoRoute })
    if (args.perf || args['perf-play']) query.set('perf', 'true')
    for (const extra of args.query ?? []) for (const [k, v] of new URLSearchParams(String(extra))) query.set(k, v)
    const pageUrl = `${server.origin}/?${query}`
    log(`open ${pageUrl}`)
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => !!window.__dribble, null, { timeout: 60000 }).catch(() => {
      throw new Error('window.__dribble never appeared: is src/utils/debugBridge.ts imported in src/main.tsx?')
    })

    const loadDeadline = Date.now() + num(args['load-timeout'], 300) * 1000
    let lastProgress = -1
    let state
    while (true) {
      state = await getState()
      if (state.parser.error) throw new Error(`demo parse failed: ${state.parser.error}`)
      if (state.parser.progress !== lastProgress && state.parser.status === 'loading') {
        lastProgress = state.parser.progress
        if (lastProgress % 20 === 0) log(`parsing ${lastProgress}%`)
      }
      if (state.parser.status === 'done' && state.demo && state.scene.map === state.demo.map) break
      if (Date.now() > loadDeadline) throw new Error(`demo did not load in time: ${JSON.stringify(state.parser)}`)
      await sleep(300)
    }
    // freeze playback right away (loadSceneFromDemoAction starts playing)
    await bridge(() => window.__dribble.setPlaying(false))
    log(`demo parsed: ${JSON.stringify(state.demo)}`)

    await waitForNetworkIdle(800, 120000)
    const mapDeadline = Date.now() + 60000
    const mapStatusState = async () =>
      bridge(() => window.__dribble?.stores?.useInstance?.getState?.()?.mapStatus?.state ?? null).catch(() => null)
    const mapUnavailable = async () =>
      warnings.some(w => w.includes('Unable to load map')) || ['missing', 'error'].includes(await mapStatusState())
    while (!(state = await getState()).scene.mapLoaded && Date.now() < mapDeadline && !(await mapUnavailable())) await sleep(300)
    if (!state.scene.mapLoaded) {
      warnings.push(`map model for ${state.demo.map} did not load (no GLB for this map?)`)
      log(`WARNING: map model for ${state.demo.map} not loaded; continuing without it`)
    }
    manifest.loaded = { atSec: Number(elapsed()), state, memoryMB: memory.sample() }
    log(`ready: maxTicks=${state.playback.maxTicks} map=${state.scene.map} mapLoaded=${state.scene.mapLoaded} mem=${JSON.stringify(memory.sample())}`)

    const maxTicks = state.playback.maxTicks
    const resolveTick = value => {
      const text = String(value ?? '50%').trim()
      const tick = text.endsWith('%') ? Math.round((Number(text.slice(0, -1)) / 100) * maxTicks) : Math.round(Number(text))
      if (!Number.isFinite(tick)) throw new Error(`bad tick "${value}"`)
      return Math.min(Math.max(tick, 1), maxTicks)
    }

    const pickAutoPlayer = async () => {
      const players = await bridge(() => window.__dribble.listPlayers())
      const candidates = players
        .filter(p => p.connected && (p.teamId === 2 || p.teamId === 3))
        .sort((a, b) => Number(b.alive) - Number(a.alive) || a.teamId - b.teamId || (CLASS_ORDER[a.className] ?? 99) - (CLASS_ORDER[b.className] ?? 99))
      return candidates[0]?.entityId
    }

    const applyMode = async step => {
      const mode = step.mode ?? 'rts'
      if (mode === 'pov') {
        let player = step.player ?? 'auto'
        if (player === 'auto') player = await pickAutoPlayer()
        if (player === undefined) return { ok: false, error: 'no player in scene for POV' }
        return bridge(([p]) => window.__dribble.setControlsMode('pov', { player: p }), [player])
      }
      return bridge(([m, reset]) => window.__dribble.setControlsMode(m, { reset }), [mode, step.reset ?? true])
    }

    // CameraTipPanels show for 2 s after a camera-mode change; wait them out so shots are clean.
    let modeChangedAt = 0
    let lastMode = null
    const settle = async () => {
      await waitForNetworkIdle(500, 20000)
      await bridge(n => window.__dribble.frames(n), num(args['settle-frames'], 8))
      const tipWait = modeChangedAt ? 2300 - (Date.now() - modeChangedAt) : 0
      await sleep(Math.max(num(args['settle-ms'], 700), tipWait))
    }

    // assets.waitIdle (src/assetpack/probes.ts) resolves once the pack has settled and no item loads. A page
    // without the probe (a06e4c7) gets null, so reference runs of older checkouts still work.
    const waitAssetsIdle = async () => {
      const result = await withTimeout(
        bridge(async ms => {
          const hl = window.__dribble?.hl
          if (!hl?.probes || !hl.probes().includes('assets.waitIdle')) return null
          try {
            return (await hl.probe('assets.waitIdle', ms)) ?? null
          } catch (error) {
            return { idle: false, error: String(error) }
          }
        }, ASSETS_IDLE_MS),
        ASSETS_IDLE_MS + 10000,
        'assets.waitIdle'
      )
      return result === false ? { idle: false, error: 'the probe did not resolve' } : result
    }

    const setHudHidden = hidden =>
      page.evaluate(h => {
        let style = document.getElementById('__harness-hide-hud')
        if (h && !style) {
          style = document.createElement('style')
          style.id = '__harness-hide-hud'
          style.textContent = '.ui-layers, .ui-layer { visibility: hidden !important; }'
          document.head.appendChild(style)
        }
        if (!h && style) style.remove()
      }, hidden)

    // 5. steps
    const steps = buildSteps()
    log(`${steps.length} step(s)`)
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]
      const tick = resolveTick(step.tick)
      const entry = { index, step, tick }
      try {
        if (step.settings) {
          for (const [option, value] of Object.entries(step.settings)) {
            await bridge(([o, v]) => window.__dribble.setSetting(o, v), [option, value])
          }
        }
        if (step.speed) await bridge(s => window.__dribble.setSpeed(s), Number(step.speed))
        await bridge(([t]) => window.__dribble.goToTick(t), [tick])
        entry.modeResult = await applyMode(step)
        const modeNow = (await getState()).scene.controlsMode
        modeChangedAt = modeNow !== lastMode ? Date.now() : 0
        lastMode = modeNow
        if (entry.modeResult && entry.modeResult.ok === false) {
          warnings.push(`step ${index}: ${entry.modeResult.error}`)
          log(`WARNING step ${index}: ${entry.modeResult.error}`)
        }
        if (step.camera) entry.cameraApplied = await bridge(c => window.__dribble.setCamera(c), step.camera)
        if (step.play) {
          await bridge(() => window.__dribble.setPlaying(true))
          await sleep(Number(step.play) * 1000)
          await bridge(() => window.__dribble.setPlaying(false))
        }
        if (step.eval) entry.eval = await page.evaluate(String(step.eval)).catch(error => ({ error: String(error) }))
        entry.assetsIdle = await waitAssetsIdle()
        if (entry.assetsIdle && entry.assetsIdle.idle !== true) {
          const why = entry.assetsIdle.error ?? `pending ${JSON.stringify(entry.assetsIdle.pending ?? [])}`
          warnings.push(`step ${index}: asset pack not idle after ${ASSETS_IDLE_MS / 1000}s: ${why}`)
          log(`WARNING step ${index}: asset pack not idle: ${why}`)
        }
        await setHudHidden(!!(step.hideHud ?? args['hide-hud']))
        await settle()
        const after = await getState()
        entry.state = { playback: after.playback, scene: after.scene, perf: after.perf }
        entry.players = await bridge(() => window.__dribble.listPlayers())
        if (step.screenshot !== false) {
          const label = step.name ?? [`t${tick}`, step.mode ?? 'rts', step.mode === 'pov' ? slug(String(step.player ?? 'auto')) : null].filter(Boolean).join('-')
          const file = path.join(outDir, `${String(index).padStart(2, '0')}-${slug(label)}.png`)
          await page.screenshot({ path: file, timeout: 60000 })
          entry.file = file
          const focused = after.scene.focusedEntityId != null ? entry.players.find(p => p.entityId === after.scene.focusedEntityId) : null
          log(`shot ${path.basename(file)} renderTick=${after.playback.renderTick} mode=${after.scene.controlsMode}${focused ? ` pov=${focused.name}(${focused.className}/${focused.team})` : ''}`)
        }
      } catch (error) {
        entry.error = String(error?.message || error)
        warnings.push(`step ${index} failed: ${entry.error}`)
        log(`step ${index} FAILED: ${entry.error}`)
      }
      manifest.shots.push(entry)
    }

    // 6. perf
    if (args['perf-play']) {
      manifest.perf = await runPerfPlay({ page, bridge, resolveTick, applyMode, settle, memory, outDir, log })
      fs.writeFileSync(path.join(outDir, 'perf.json'), JSON.stringify(manifest.perf, null, 2))
      log(`perf: ${JSON.stringify(manifest.perf.summary)}`)
    }

    manifest.memoryMB = { peak: memory.peak(), final: memory.sample() }
  } finally {
    // Requests Playwright never settled: error responses whose body nobody read, and requests still open
    // when the run ends (status null, counted as failed).
    for (const raw of requestEntry.values()) if (rawFailed(raw)) requestTotals.failed++
    requestEntry.clear()
    manifest.finishedAt = new Date().toISOString()
    manifest.perfLines = consoleLines.filter(line => line.includes('[Perf]') || line.includes('parser2:'))
    fs.writeFileSync(path.join(outDir, 'console.log'), consoleLines.join('\n') + '\n')
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    clearTimeout(hardTimeout)
    await cleanup()
    const errors = consoleLines.filter(line => / (error|pageerror|reqfail) /.test(line.slice(0, 20)))
    log(`console: ${consoleLines.length} lines, ${errors.length} errors -> ${path.join(outDir, 'console.log')}`)
    log(`manifest -> ${path.join(outDir, 'manifest.json')}`)
    if (warnings.length) log(`warnings:\n  - ${warnings.join('\n  - ')}`)
  }

  function buildSteps() {
    if (plan) return plan
    const ticks = list(args.ticks).length ? list(args.ticks) : ['10%', '50%', '90%']
    const modes = list(args.modes).length ? list(args.modes) : ['rts', 'pov']
    const povs = list(args.pov).length ? list(args.pov) : ['auto']
    const steps = []
    for (const tick of ticks) {
      for (const mode of modes) {
        if (mode === 'pov') for (const player of povs) steps.push({ tick, mode, player })
        else steps.push({ tick, mode })
      }
    }
    return steps
  }
}

// ─── BROWSER ──────────────────────────────────────────────────────────────────────

async function launchBrowser(chromium, executablePath, requestedGpu, noVsync, log) {
  const order = requestedGpu === 'swiftshader' ? ['swiftshader'] : [requestedGpu, 'swiftshader']
  for (const gpu of order) {
    const flags = GPU_FLAGS[gpu]
    if (!flags) throw new Error(`unknown --gpu ${gpu} (egl|vulkan|swiftshader)`)
    const browser = await chromium.launch({ executablePath, headless: true, args: [...COMMON_FLAGS, ...flags, ...(noVsync ? NO_VSYNC_FLAGS : [])], timeout: 60000 })
    let renderer = 'unknown'
    try {
      const probe = await browser.newPage()
      renderer = await probe.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2')
        if (!gl) return 'no webgl2'
        const ext = gl.getExtension('WEBGL_debug_renderer_info')
        return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
      })
      await probe.close()
    } catch (error) {
      renderer = `probe failed: ${error?.message || error}`
    }
    const hardware = !/swiftshader|no webgl2|probe failed/i.test(renderer)
    if (gpu === 'swiftshader' || hardware) {
      log(`browser: gpu=${gpu} renderer=${renderer}`)
      return { browser, gpu, renderer }
    }
    log(`browser: gpu=${gpu} unavailable (${renderer}), falling back`)
    await browser.close().catch(() => {})
  }
  throw new Error('no usable WebGL backend')
}

// ─── PERF ─────────────────────────────────────────────────────────────────────────

async function runPerfPlay({ page, bridge, resolveTick, applyMode, settle, memory, outDir, log }) {
  const [tickSpec = '50%', secondsSpec = '10', mode = 'rts', playerSpec, speedSpec = '1'] = String(args['perf-play']).split(':')
  const seconds = Number(secondsSpec)
  const speed = Number(speedSpec)
  const player = playerSpec || undefined
  const tick = resolveTick(tickSpec)
  await bridge(([t]) => window.__dribble.goToTick(t), [tick])
  await applyMode({ mode, player })
  if (speed > 0) await bridge(s => window.__dribble.setSpeed(s), speed)
  await settle()

  let cdp
  if (args['cpu-profile']) {
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
    await cdp.send('Profiler.start')
  }

  const memBefore = memory.sample()
  // Play, sample frame times and long tasks, and pause, all inside one evaluate so the
  // tick rate is measured over exactly the sampled wall time.
  const run = await page.evaluate(
    ([ms, play]) =>
      new Promise(resolve => {
        const bridge = window.__dribble
        const longTasks = []
        let observer
        try {
          observer = new PerformanceObserver(list => list.getEntries().forEach(entry => longTasks.push(entry.duration)))
          observer.observe({ type: 'longtask', buffered: false })
        } catch {}
        const heapStart = performance.memory?.usedJSHeapSize
        const tick0 = bridge.getState().playback.tick
        const t0 = performance.now()
        if (play) bridge.setPlaying(true)
        const deltas = []
        let last = t0
        const step = now => {
          deltas.push(now - last)
          last = now
          if (now - t0 < ms) return requestAnimationFrame(step)
          bridge.setPlaying(false)
          observer?.disconnect()
          resolve({
            deltas,
            elapsedMs: performance.now() - t0,
            tick0,
            tick1: bridge.getState().playback.tick,
            heapStart,
            heapEnd: performance.memory?.usedJSHeapSize,
            longTasks,
            perf: bridge.getState().perf,
          })
        }
        requestAnimationFrame(step)
      }),
    [seconds * 1000, speed > 0]
  )
  const memAfter = memory.sample()

  let profileSummary
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop')
    const file = path.join(outDir, 'perf.cpuprofile')
    fs.writeFileSync(file, JSON.stringify(profile))
    profileSummary = await summarizeProfile(profile)
    fs.writeFileSync(path.join(outDir, 'perf-top.txt'), profileSummary.table)
    log(`cpu profile -> ${file} (top self time in perf-top.txt)`)
    await cdp.detach().catch(() => {})
  }

  const sorted = [...run.deltas].sort((a, b) => a - b)
  const pct = p => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
  const avg = sorted.reduce((sum, v) => sum + v, 0) / Math.max(1, sorted.length)
  const toMb = bytes => (bytes ? Math.round(bytes / 1048576) : null)
  const round1 = v => Number(v.toFixed(1))
  return {
    spec: { tick, seconds, mode, player: player ?? null, speed, noVsync: !!args['no-vsync'] },
    summary: {
      fps: round1(1000 / avg),
      frameMs: { avg: round1(avg), p50: round1(pct(50)), p95: round1(pct(95)), max: round1(pct(100)) },
      ticksPerSecond: round1((run.tick1 - run.tick0) / (run.elapsedMs / 1000)),
      expectedTicksPerSecond: round1(speed / 0.015),
      longTasks: { count: run.longTasks.length, totalMs: Math.round(run.longTasks.reduce((sum, v) => sum + v, 0)) },
      jsHeapMB: { start: toMb(run.heapStart), end: toMb(run.heapEnd) },
      browserMemMB: { before: memBefore, after: memAfter, peakSoFar: memory.peak() },
      renderCalls: run.perf.renderCalls,
      renderTriangles: run.perf.renderTriangles,
      topSelfTime: profileSummary?.top?.slice(0, 15),
      topFiles: profileSummary?.files?.slice(0, 15),
    },
    frames: run.deltas.length,
  }
}

async function summarizeProfile(profile) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const self = new Map()
  const files = new Map()
  const intervals = profile.timeDeltas ?? []
  const fileOf = url => {
    if (!url) return '(native)'
    try {
      return path.basename(new URL(url).pathname)
    } catch {
      return url
    }
  }
  profile.samples?.forEach((id, i) => {
    const node = byId.get(id)
    if (!node) return
    const frame = node.callFrame
    const file = fileOf(frame.url)
    const key = `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
    const us = intervals[i] ?? 0
    self.set(key, (self.get(key) ?? 0) + us)
    files.set(file, (files.get(file) ?? 0) + us)
  })
  const total = [...self.values()].reduce((sum, v) => sum + v, 0) || 1
  const rank = map =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([name, us]) => ({ name, ms: Math.round(us / 1000), pct: Number(((us / total) * 100).toFixed(1)) }))
  const top = rank(self)
  const byFile = rank(files)
  const fmt = rows => rows.map(row => `${String(row.pct).padStart(5)}%  ${String(row.ms).padStart(7)}ms  ${row.name}`).join('\n')
  const table = `# self time by function (use --no-minify for readable names)\n${fmt(top)}\n\n# self time by script\n${fmt(byFile)}\n`
  return { top, files: byFile, table }
}

// ─── MEMORY (PSS of the browser process tree, MB) ──────────────────────────────────

function startMemorySampler(rootPid) {
  let peak = 0
  const sample = () => {
    if (!rootPid) return null
    const children = new Map()
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      const stat = (() => {
        try {
          return fs.readFileSync(`/proc/${entry}/stat`, 'utf8')
        } catch {
          return ''
        }
      })()
      if (!stat) continue
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (!children.has(ppid)) children.set(ppid, [])
      children.get(ppid).push(Number(entry))
    }
    let totalKb = 0
    const stack = [rootPid]
    while (stack.length) {
      const pid = stack.pop()
      let text = ''
      try {
        text = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
      } catch {}
      const pss = text.match(/^Pss:\s+(\d+)/m)
      if (pss) totalKb += Number(pss[1])
      else {
        try {
          const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
          totalKb += Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0)
        } catch {}
      }
      stack.push(...(children.get(pid) ?? []))
    }
    const mb = Math.round(totalKb / 1024)
    peak = Math.max(peak, mb)
    return mb
  }
  const timer = setInterval(sample, 1000)
  timer.unref()
  return { sample, peak: () => peak, stop: () => clearInterval(timer) }
}

// ─── BUILD ────────────────────────────────────────────────────────────────────────

function defaultOutDir(root, demoName, stamp) {
  return path.join(path.dirname(root), `${path.basename(root)}-harness-out`, `${demoName}-${stamp}`)
}

function installAppHint(root) {
  return `Install the app's dependencies once (under the lock): cd ${root} && npx --yes yarn@1.22.22 install --frozen-lockfile --ignore-scripts`
}

/** The main checkout's node_modules, for a worktree that has none yet. */
function sharedNodeModules(root) {
  const main = mainCheckoutOf(root)
  if (!main || path.resolve(main) === path.resolve(root)) return null
  const shared = path.join(main, 'node_modules')
  return fs.existsSync(shared) ? shared : null
}

function ensureNodeModules(root, log) {
  const target = path.join(root, 'node_modules')
  if (fs.existsSync(target)) return
  let dangling = false
  try {
    dangling = fs.lstatSync(target).isSymbolicLink()
  } catch {}
  if (dangling) throw new SetupError(`${target} is a symlink to a missing folder (${fs.readlinkSync(target)}). Remove or fix it.`)
  const shared = sharedNodeModules(root)
  if (!shared) throw new SetupError(`${target} missing. ${installAppHint(mainCheckoutOf(root) ?? root)}`)
  fs.symlinkSync(shared, target, 'dir')
  log(`linked ${target} -> ${shared}`)
}

function buildCacheDir(root) {
  return path.resolve(String(args['build-cache'] ?? process.env.DRIBBLE_HARNESS_BUILDS ?? path.join(root, 'node_modules', '.cache', 'dribble-harness')))
}

// One cache entry per checkout path and VITE_ASSET_PACK_URL; the production default (no pack URL) keeps
// the key it had before the asset phase.
function buildKey(root, packUrl = null) {
  let real = root
  try {
    real = fs.realpathSync(root)
  } catch {}
  const key = crypto.createHash('sha1').update(real).digest('hex').slice(0, 12)
  return packUrl ? `${key}-pack-${crypto.createHash('sha1').update(packUrl).digest('hex').slice(0, 6)}` : key
}

function fingerprint(root, packUrl = null) {
  const entries = []
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) walk(full)
      else entries.push(`${path.relative(root, full)}:${stat.size}:${Math.round(stat.mtimeMs)}`)
    }
  }
  walk(path.join(root, 'src'))
  for (const name of ['index.html', 'vite.config.mts', 'package.json', 'tsconfig.json', 'tailwind.config.ts', 'postcss.config.js']) {
    const full = path.join(root, name)
    if (fs.existsSync(full)) {
      const stat = fs.statSync(full)
      entries.push(`${name}:${stat.size}:${Math.round(stat.mtimeMs)}`)
    }
  }
  entries.sort()
  if (packUrl) entries.push(`VITE_ASSET_PACK_URL=${packUrl}`)
  return crypto.createHash('sha1').update(entries.join('\n')).digest('hex')
}

async function ensureBuild(root, outDir, log, packUrl) {
  const buildRoot = path.join(buildCacheDir(root), buildKey(root, packUrl) + (args['no-minify'] ? '-nominify' : ''))
  const distDir = path.join(buildRoot, 'dist')
  const fpFile = path.join(buildRoot, 'fingerprint.txt')
  const current = fingerprint(root, packUrl)
  const hasBuild = fs.existsSync(path.join(distDir, 'index.html'))
  const fresh = hasBuild && fs.existsSync(fpFile) && fs.readFileSync(fpFile, 'utf8') === current

  if (hasBuild && (fresh || args['no-build']) && !args.rebuild) {
    log(`build: reusing ${distDir}${fresh ? '' : ' (STALE, --no-build)'}`)
    return distDir
  }

  fs.mkdirSync(buildRoot, { recursive: true })
  log(`build: vite build of ${root} -> ${distDir}${packUrl ? ` with VITE_ASSET_PACK_URL=${packUrl}` : ''}`)
  const logFile = path.join(outDir, 'build.log')
  const output = []
  const code = await new Promise(resolve => {
    const childArgs = [
      path.join(HARNESS_DIR, 'build-child.mjs'),
      root,
      distDir,
      ...(args['no-minify'] ? ['--no-minify'] : []),
      ...(packUrl ? ['--asset-pack-url', packUrl] : []),
    ]
    const env = { ...process.env, VITE_APP_ASSET_URL: '' }
    delete env.VITE_ASSET_PACK_URL // build-child sets it from --asset-pack-url only
    const child = spawn(process.execPath, childArgs, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 300000)
    child.stdout.on('data', chunk => output.push(String(chunk)))
    child.stderr.on('data', chunk => output.push(String(chunk)))
    child.on('exit', exitCode => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })
  fs.writeFileSync(logFile, output.join(''))
  if (code !== 0) throw new Error(`vite build failed (exit ${code}), see ${logFile}\n${output.join('').slice(-3000)}`)
  fs.writeFileSync(fpFile, current)
  log(output.join('').trim().split('\n').filter(line => line.includes('[harness]')).join(' ') || 'build: ok')
  return distDir
}

// ─── SERVER ───────────────────────────────────────────────────────────────────────

function emptyGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }))
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(20)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(20 + padded.length, 8)
  header.writeUInt32LE(padded.length, 12)
  header.write('JSON', 16, 'ascii')
  return Buffer.concat([header, padded])
}

function startServer({ distDir, publicDir, demoPath, demoMap, stubOtherMaps, packDir, log }) {
  const demoRoute = `/__harness/demo/${encodeURIComponent(path.basename(demoPath))}`
  const mapBase = demoMap.split('_').slice(0, 2).join('_').toLowerCase()
  const EMPTY_GLB = emptyGlb()

  const send = (res, status, headers, body) => {
    res.writeHead(status, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...headers })
    res.end(body)
  }
  const sendFile = (req, res, file) => {
    const stat = fs.statSync(file)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file).pipe(res)
  }
  const resolveIn = (base, pathname) => {
    const file = path.resolve(base, '.' + pathname)
    if (!file.startsWith(path.resolve(base) + path.sep)) return null
    try {
      return fs.statSync(file).isFile() ? file : null
    } catch {
      return null
    }
  }

  // Contract 3.3: GET and HEAD only, paths stay inside the pack root (symlinks resolved), a missing file or
  // pack answers 404 text/plain and never falls through to index.html. Without a pack folder ("missing", or
  // no --asset-pack) every pack path answers 404.
  const servePack = (req, res, rawPathname) => {
    const notFound = () => res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' }).end(req.method === 'HEAD' ? undefined : 'not found')
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.writeHead(405, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache', Allow: 'GET, HEAD' }).end('method not allowed')
    }
    if (!packDir) return notFound()
    let rel
    try {
      rel = decodeURIComponent(rawPathname.slice(PACK_ROUTE.length))
    } catch {
      return notFound()
    }
    if (!rel || rel.includes('\0')) return notFound()
    const file = path.resolve(packDir, rel)
    if (!file.startsWith(packDir + path.sep)) return notFound()
    let real
    try {
      real = fs.realpathSync(file)
      if (!real.startsWith(packDir + path.sep) || !fs.statSync(real).isFile()) return notFound()
    } catch {
      return notFound()
    }
    const size = fs.statSync(real).size
    res.writeHead(200, {
      'Content-Type': PACK_MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': 'no-cache',
    })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(real).pipe(res)
  }

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname.startsWith(PACK_ROUTE) || url.pathname === PACK_ROUTE.slice(0, -1)) return servePack(req, res, url.pathname)
      // A raw path under the pack route whose dot segments (also %2e%2e) left it after URL normalisation stays a 404,
      // so such a request never falls through to the build or the SPA index.
      const rawPath = String(req.url).split(/[?#]/, 1)[0]
      if (rawPath.startsWith(PACK_ROUTE) || rawPath === PACK_ROUTE.slice(0, -1)) return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found')
      const pathname = decodeURIComponent(url.pathname)
      if (url.pathname === demoRoute) return sendFile(req, res, demoPath)
      if (pathname.startsWith('/umami/')) return send(res, 204, {}, '')
      const mapGlb = pathname.match(/^\/models\/maps\/([^/]+)\/[^/]+\.glb$/)
      if (stubOtherMaps && mapGlb && !mapGlb[1].toLowerCase().startsWith(mapBase)) {
        log(`stubbed boot map ${pathname} (demo map is ${demoMap})`)
        return send(res, 200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': EMPTY_GLB.length }, EMPTY_GLB)
      }
      const file =
        (pathname === '/' ? resolveIn(distDir, '/index.html') : null) ??
        resolveIn(distDir, pathname) ??
        resolveIn(publicDir, pathname) ??
        (path.extname(pathname) ? null : resolveIn(distDir, '/index.html'))
      if (!file) return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found')
      return sendFile(req, res, file)
    } catch (error) {
      log(`server error for ${req.url}: ${error?.stack || error}`)
      send(res, 500, { 'Content-Type': 'text/plain' }, String(error))
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.origin = `http://127.0.0.1:${port}`
      server.demoRoute = demoRoute
      resolve(server)
    })
  })
}

// ─── ASSET PACK ───────────────────────────────────────────────────────────────────

/**
 * The manifest's assetPack record: always the same keys, all null without --asset-pack. `problem` is a
 * message for warnings and is removed before the manifest is written.
 */
function readPackInfo(pack) {
  const info = { dir: null, served: null, manifestSha256: null, fingerprint: null, generatorVersion: null, problem: null }
  if (!pack) return info
  info.dir = pack.dir ?? PACK_MISSING
  info.served = !!pack.dir
  if (!pack.dir) return info
  const file = path.join(pack.dir, 'manifest.json')
  let bytes
  try {
    bytes = fs.readFileSync(file)
  } catch {
    info.problem = `${file} not found; the page will see 404`
    return info
  }
  info.manifestSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  try {
    const json = JSON.parse(bytes.toString('utf8'))
    info.fingerprint = typeof json?.builtFrom?.fingerprint === 'string' ? json.builtFrom.fingerprint : null
    info.generatorVersion = typeof json?.generator?.version === 'string' ? json.generator.version : null
    if (json?.format !== 'dribble-asset-pack' || json?.version !== 1) info.problem = `${file} is not a dribble-asset-pack v1 manifest`
  } catch (error) {
    info.problem = `${file} is not valid JSON (${error?.message || error})`
  }
  return info
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────────

function readDemoHeader(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(1072)
  fs.readSync(fd, buf, 0, 1072, 0)
  fs.closeSync(fd)
  const str = (offset, length) => buf.toString('latin1', offset, offset + length).split('\0')[0]
  if (str(0, 8) !== 'HL2DEMO') throw new Error(`${file} is not a HL2DEMO file`)
  return {
    server: str(16, 260),
    map: str(536, 260),
    game: str(796, 260),
    duration: buf.readFloatLE(1056),
    ticks: buf.readInt32LE(1060),
  }
}

// Playwright spawns the browser as a direct child of this process. Chrome rewrites its argv into one
// space-joined string; a wrapper script that execs the real binary shows the real path instead, so the
// pipe flag Playwright passes is the fallback match.
function findChildPid(executablePath) {
  let byPipe = null
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (parentOf(entry) !== process.pid) continue
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8')
      const argv0 = cmdline.split('\0')[0]
      if (argv0 === executablePath || argv0.startsWith(executablePath + ' ')) return Number(entry)
      if (byPipe === null && cmdline.includes('--remote-debugging-pipe')) byPipe = Number(entry)
    } catch {}
  }
  return byPipe
}

function slug(text) {
  return String(text).replace(/[^a-zA-Z0-9@._-]+/g, '_').slice(0, 60)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Resolves with the promise's value, or false (with a message) when it takes longer than ms.
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise(resolve => {
      timer = setTimeout(() => {
        console.error(`[harness] ${label} timed out`)
        resolve(false)
      }, ms)
    }),
  ])
}
