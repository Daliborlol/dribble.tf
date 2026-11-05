#!/usr/bin/env node
// Runs perf scenarios x checkouts x repeats through shot.mjs, alternating the checkouts run by run (A B A B) so that
// drift and the power state cancel, and writes matrix.json and report.md with medians, spreads and A/B deltas.
// `--help` lists the options; README.md "Perf matrix" has examples.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { HARNESS_DIR, isCheckout } from '../lib/setup.mjs'
import { powerNow, waitForQuiet } from '../lib/system-sampler.mjs'

const SHOT = path.join(HARNESS_DIR, 'shot.mjs')
const DEFAULT_CONFIG = path.join(HARNESS_DIR, 'tools', 'perf-scenarios.json')
const EXIT_USAGE = 2
const EXIT_BATTERY = 3
const EXIT_GATE = 75

const HELP = `
perf-matrix: scenario x checkout x repeat through shot.mjs, medians and A/B deltas

  node scripts/hl/harness/tools/perf-matrix.mjs --root [name=]<dir>[,browser=..][,gpu=..][,query=a=b][,set=path=json][,init=file] ... --out <dir> [options]

Which runs
  --root <spec>        a checkout, repeatable; the first one is A in the deltas and every other one is compared with it.
                       Besides the folder a spec can set browser=, gpu=, query=, set= and init= (an --init-script) for
                       that side only, so the same checkout under two browsers or two settings is an A/B too
  --scenarios <list>   ids, tag:<tag> or all (default tag:core); see --list
  --quick <scenario>   one scenario, 3 repeats, uncapped and vsync, 10 s windows: the A/B a later change needs
  --repeats <n>        repeats per cell and root (default 2)
  --vsync <on|off|on,off>   default on
  --sizes <WxH,...>    replace each scenario's viewport; several sizes make a sweep
  --seconds <n>        replace each scenario's window length
  --resume             keep the runs of this --out folder that have a perf.json
Per-run flags, for every run (a root spec or a scenario's "flags" can add more)
  --browser <shell|chrome|path>, --gpu <egl|vulkan|swiftshader|default>, --query <a=b>, --set <path>=<json>
  --trace, --gpu-timer, --cpu-profile, --no-minify, --source-map, --keep-traces (perf-trace.json is deleted after its summary otherwise)
  --pack <dir|none>    asset pack (default: the config's assetPack)
  --min-available <MB>, --wait-available <s>
  --quiet-cores <n>, --quiet-wait <s>   wait before each window until other processes use at most n cores (default 2.5,
                       at most 20 s, then measure anyway and note it); --quiet-cores 0 turns it off
  --pre-quiet-wait <s>, --pre-quiet-budget <s>   before each run, with no browser up, wait for the same quiet at most this
                       long (default 120), and at most the budget over the whole matrix (default 1200)
Output and setup
  --out <dir>          required; runs/<cell>/<root>-r<n>/ per run, matrix.json, report.md
  --config <file>      scenario file (default ${DEFAULT_CONFIG})
  --lock <file>        the shared lock (default: env DRIBBLE_HARNESS_LOCK, else the config's)
  --build-cache <dir>  (default: env DRIBBLE_HARNESS_BUILDS, else the config's)
  --min-battery <pct>  stop before a run when discharging below this (default 12); exit ${EXIT_BATTERY}
  --timeout <s>        hard timeout per run once it holds the lock (default 600)
  --report-only        rewrite report.md from the --out folder's matrix.json and exit
  --dry-run            print the run order and the first command, run nothing
  --list               print the scenarios and exit

Exit 0 every run finished; 1 a run failed or a memory gate stayed closed; 2 usage; ${EXIT_BATTERY} stopped by the battery guard.
`

// ─── ARGS ──────────────────────────────────────────────────────────────────────────

const FLAGS = {
  root: 'list',
  scenarios: 'value',
  quick: 'value',
  repeats: 'number',
  vsync: 'value',
  sizes: 'value',
  seconds: 'number',
  resume: 'bool',
  browser: 'value',
  gpu: 'value',
  query: 'list',
  set: 'list',
  trace: 'bool',
  'gpu-timer': 'bool',
  'cpu-profile': 'bool',
  'no-minify': 'bool',
  'source-map': 'bool',
  'keep-traces': 'bool',
  pack: 'value',
  'min-available': 'number',
  'wait-available': 'number',
  'quiet-cores': 'number',
  'quiet-wait': 'number',
  'pre-quiet-wait': 'number',
  'pre-quiet-budget': 'number',
  out: 'value',
  config: 'value',
  lock: 'value',
  'build-cache': 'value',
  'min-battery': 'number',
  timeout: 'number',
  'report-only': 'bool',
  'dry-run': 'bool',
  list: 'bool',
  help: 'bool',
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '-h') args.help = true
    else if (!token.startsWith('--')) usage(`unexpected argument "${token}"`)
    else {
      const [key, inline] = token.slice(2).split(/=(.*)/s, 2)
      const kind = FLAGS[key]
      if (!kind) usage(`unknown option --${key}`)
      if (kind === 'bool') args[key] = true
      else {
        const value = inline ?? argv[++i]
        if (value === undefined) usage(`--${key} needs a value`)
        if (kind === 'number' && !(Number(value) >= 0)) usage(`--${key} needs a number, got "${value}"`)
        if (kind === 'list') args[key] = [...(args[key] ?? []), value]
        else args[key] = kind === 'number' ? Number(value) : value
      }
    }
  }
  return args
}

function usage(message) {
  console.error(`[matrix] ${message}\n[matrix] see --help`)
  process.exit(EXIT_USAGE)
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(HELP)
  process.exit(0)
}

// ─── CONFIG ────────────────────────────────────────────────────────────────────────

function loadConfig(file) {
  let config
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    usage(`--config ${file}: ${error?.message || error}`)
  }
  const byId = new Map()
  for (const raw of config.scenarios ?? []) {
    if (byId.has(raw.id)) usage(`scenario ${raw.id} is defined twice`)
    byId.set(raw.id, raw)
  }
  const resolve = raw => {
    const base = raw.extends ? byId.get(raw.extends) : null
    if (raw.extends && !base) usage(`scenario ${raw.id} extends unknown ${raw.extends}`)
    return { ...config.defaults, ...(base ? resolve(base) : {}), ...raw }
  }
  const scenarios = [...byId.values()].map(raw => {
    const scenario = resolve(raw)
    scenario.demoPath = config.demos?.[scenario.demo] ?? scenario.demo
    return scenario
  })
  return { config, scenarios }
}

const configFile = path.resolve(args.config ?? DEFAULT_CONFIG)
const { config, scenarios: allScenarios } = loadConfig(configFile)

if (args.list) {
  for (const s of allScenarios) console.log(`${s.id.padEnd(22)} [${(s.tags ?? []).join(',')}] ${s.description}`)
  process.exit(0)
}

function parseRootSpec(spec, index) {
  const parts = spec.split(',')
  const [first, ...rest] = parts
  const match = first.match(/^([A-Za-z0-9_.-]+)=(.+)$/)
  const dir = path.resolve(match ? match[2] : first)
  const root = { name: match ? match[1] : path.basename(dir) || `root${index}`, dir, browser: null, gpu: null, query: [], set: {}, init: [] }
  for (const part of rest) {
    const [key, value] = part.split(/=(.*)/s, 2)
    if (key === 'browser' || key === 'gpu') root[key] = value
    else if (key === 'query') root.query.push(value)
    else if (key === 'set') Object.assign(root.set, parseSetting(value))
    else if (key === 'init') root.init.push(path.resolve(value))
    else usage(`--root ${spec}: unknown key "${key}" (browser, gpu, query, set, init)`)
  }
  return root
}

function parseSetting(text) {
  const [settingPath, raw] = String(text).split(/=(.*)/s, 2)
  if (!settingPath || raw === undefined) usage(`--set needs path=value, got "${text}"`)
  let value = raw
  try {
    value = JSON.parse(raw)
  } catch {}
  return { [settingPath]: value }
}

function chooseScenarios() {
  const wanted = args.quick ?? args.scenarios ?? 'tag:core'
  const picked = []
  for (const token of wanted.split(',').map(t => t.trim()).filter(Boolean)) {
    const found = token === 'all' ? allScenarios : token.startsWith('tag:') ? allScenarios.filter(s => s.tags?.includes(token.slice(4))) : allScenarios.filter(s => s.id === token)
    if (!found.length) usage(`no scenario matches "${token}" (see --list)`)
    for (const s of found) if (!picked.includes(s)) picked.push(s)
  }
  return picked
}

const median = values => {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!clean.length) return null
  const middle = clean.length >> 1
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2
}

// ─── METRICS ───────────────────────────────────────────────────────────────────────

/** What a report needs from one run's perf.json. Thread times come from schedstat, so every run has them. */
function metricsOf(perf) {
  const system = perf.system ?? {}
  const thread = (process, name) => system.threads?.find(row => row.process === process && row.thread === name)
  const frames = perf.frameStats ?? {}
  return {
    fps: frames.fps ?? perf.summary?.fps ?? null,
    avgMs: frames.avg ?? null,
    p50Ms: frames.p50 ?? null,
    p95Ms: frames.p95 ?? null,
    p99Ms: frames.p99 ?? null,
    maxMs: frames.max ?? null,
    over20Pct: frames.over20Pct ?? null,
    over34Pct: frames.over34Pct ?? null,
    droppedVsyncPct: frames.droppedVsyncPct ?? null,
    frames: frames.count ?? null,
    workP50Ms: perf.frameWork?.p50 ?? null,
    workP95Ms: perf.frameWork?.p95 ?? null,
    workOverBudgetPct: perf.frameWork?.over16Pct ?? null,
    ticksPerSecond: perf.summary?.ticksPerSecond ?? null,
    longTasks: perf.summary?.longTasks?.count ?? null,
    longTaskMs: perf.summary?.longTasks?.totalMs ?? null,
    gpuBusyPct: system.gpuBusyPct?.avg ?? null,
    gpuBusyP95: system.gpuBusyPct?.p95 ?? null,
    // the whole GPU's busy share times the frame time; other programs' GPU work counts too
    gpuBusyMsPerFrame: system.gpuBusyPct && frames.avg ? Number(((system.gpuBusyPct.avg / 100) * frames.avg).toFixed(1)) : null,
    sclkMhz: system.sclkMhz?.avg ?? null,
    sclkP95: system.sclkMhz?.p95 ?? null,
    cpuMhz: system.cpuMhz?.avg ?? null,
    cpuMaxCoreMhz: system.cpuMaxCoreMhz?.avg ?? null,
    pptWatts: system.gpuPptWatts?.avg ?? null,
    otherCores: system.cpuLoad?.otherCores ?? null,
    swapInMB: system.memory?.swapInMB ?? null,
    majorFaults: system.memory?.majorFaults ?? null,
    browserCores: system.cpuLoad?.browserCores ?? null,
    mainCpuMs: thread('renderer', 'main')?.cpuMsPerFrame ?? null,
    mainBusyPct: thread('renderer', 'main')?.busyPct ?? null,
    mainRunQueueMs: thread('renderer', 'main')?.runQueueMsPerFrame ?? null,
    rendererPoolCpuMs: thread('renderer', 'ThreadPoolForeg')?.cpuMsPerFrame ?? null,
    compositorCpuMs: thread('renderer', 'Compositor')?.cpuMsPerFrame ?? null,
    gpuMainCpuMs: thread('gpu', 'main')?.cpuMsPerFrame ?? null,
    gpuMainBusyPct: thread('gpu', 'main')?.busyPct ?? null,
    gpuProcessCpuMs: system.processes?.gpu?.cpuMsPerFrame ?? null,
    calls: perf.renderInfo?.calls?.p50 ?? perf.summary?.renderCalls ?? null,
    triangles: perf.renderInfo?.triangles?.p50 ?? perf.summary?.renderTriangles ?? null,
    alive: perf.renderInfo?.alive?.avg ?? null,
    focusedAlivePct: perf.renderInfo?.focusedAlivePct ?? null,
    gpuSceneMs: perf.gpuTimer?.sceneMs?.avg ?? null,
    gpuSceneP95Ms: perf.gpuTimer?.sceneMs?.p95 ?? null,
    traceMainBusyMs: perf.trace?.threads?.rendererMain?.busyMsPerFrame ?? null,
    traceCompositorBusyMs: perf.trace?.threads?.rendererCompositor?.busyMsPerFrame ?? null,
    traceGpuBusyMs: perf.trace?.threads?.gpuMain?.busyMsPerFrame ?? null,
    traceVizBusyMs: perf.trace?.threads?.viz?.busyMsPerFrame ?? null,
    peakMemMB: perf.summary?.browserMemMB?.peakSoFar ?? null,
  }
}

function readRun(dir) {
  const perf = JSON.parse(fs.readFileSync(path.join(dir, 'perf.json'), 'utf8'))
  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch {}
  const warnings = [...(manifest?.warnings ?? [])]
  if (perf.modeResult?.ok === false) warnings.push(`camera: ${perf.modeResult.error}`)
  const settingsCheck = manifest?.shots?.find(shot => shot.step?.name === 'ready')?.eval
  if (settingsCheck?.wrong?.length) warnings.push(`settings not applied: ${settingsCheck.wrong.join(', ')}`)
  if (settingsCheck?.status && settingsCheck.status !== 'ready') warnings.push(`extras status ${settingsCheck.status}`)
  if (perf.quiet && !perf.quiet.ok) warnings.push(`other processes used ${perf.quiet.otherCores} cores at the start`)
  if (/swiftshader/i.test(manifest?.browser?.renderer ?? '')) warnings.push('software rendering (SwiftShader)')
  const precheck = manifest?.shots?.find(shot => shot.step?.name === 'precheck')?.eval
  if (precheck?.missing?.length) warnings.push(`settings paths unknown to this build: ${precheck.missing.join(', ')}`)
  const canvas = perf.browserInfo?.canvas
  // A window that did not measure the scene: the map never loaded or the context died (a network change once aborted
  // the page's requests), or playback did not advance.
  let invalid = null
  const expectedTicks = perf.summary?.expectedTicksPerSecond ?? 0
  if (perf.startState?.scene?.mapLoaded === false) invalid = 'the map did not load'
  else if ((perf.spec?.speed ?? 0) > 0 && (perf.summary?.ticksPerSecond ?? 0) < expectedTicks * 0.5) invalid = `playback ran at ${perf.summary?.ticksPerSecond} ticks/s`
  if (invalid) warnings.push(`INVALID: ${invalid}`)
  return {
    invalid,
    metrics: metricsOf(perf),
    power: perf.system?.power ?? null,
    browser: {
      version: perf.browserInfo?.version ?? null,
      renderer: canvas?.unmaskedRenderer ?? null,
      glRenderer: perf.browserInfo?.system?.glRenderer ?? null,
      glParts: perf.browserInfo?.system?.glImplementationParts ?? null,
      samples: canvas?.samples ?? null,
    },
    warnings,
  }
}

// ─── REPORT ────────────────────────────────────────────────────────────────────────

const fmt = (value, digits = 1) => (value === null || value === undefined || Number.isNaN(value) ? '-' : Number(value).toFixed(digits))
const spread = (values, digits = 1) => {
  const clean = values.filter(Number.isFinite)
  if (!clean.length) return '-'
  const mid = fmt(median(clean), digits)
  if (clean.length === 1) return mid
  return `${mid} (${fmt(Math.min(...clean), digits)}-${fmt(Math.max(...clean), digits)})`
}
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n')

// Columns of the main table: label, metric key, digits.
const COLUMNS = [
  ['fps', 'fps', 1],
  ['avg ms', 'avgMs', 1],
  ['p50', 'p50Ms', 1],
  ['p95', 'p95Ms', 1],
  ['p99', 'p99Ms', 1],
  ['>20ms %', 'over20Pct', 1],
  ['>34ms %', 'over34Pct', 1],
  ['long tasks', 'longTasks', 0],
  ['GPU busy %', 'gpuBusyPct', 0],
  ['GPU busy ms/f', 'gpuBusyMsPerFrame', 1],
  ['sclk MHz', 'sclkMhz', 0],
  ['CPU MHz', 'cpuMhz', 0],
  ['main CPU ms/f', 'mainCpuMs', 1],
  ['GPU proc CPU ms/f', 'gpuProcessCpuMs', 1],
  ['calls', 'calls', 0],
  ['tris', 'triangles', 0],
  ['other cores', 'otherCores', 1],
]
// Shown only when a run has them.
const OPTIONAL_COLUMNS = [
  ['frame work p50', 'workP50Ms', 1],
  ['frame work p95', 'workP95Ms', 1],
  ['work >16.7ms %', 'workOverBudgetPct', 1],
  ['GPU scene ms', 'gpuSceneMs', 1],
  ['GPU scene p95', 'gpuSceneP95Ms', 1],
  ['trace main ms/f', 'traceMainBusyMs', 1],
  ['trace compositor ms/f', 'traceCompositorBusyMs', 1],
  ['trace GPU main ms/f', 'traceGpuBusyMs', 1],
  ['trace viz ms/f', 'traceVizBusyMs', 1],
]

// Metrics of the A/B table; better: 'low' or 'high', floor: a delta smaller than this is never a difference.
const AB_METRICS = [
  ['fps', 'fps', 1, 'high', 0.5],
  ['avg frame ms', 'avgMs', 2, 'low', 0.2],
  ['p95 ms', 'p95Ms', 1, 'low', 0.3],
  ['p99 ms', 'p99Ms', 1, 'low', 0.5],
  ['frame work p50 ms', 'workP50Ms', 2, 'low', 0.2],
  ['frame work p95 ms', 'workP95Ms', 2, 'low', 0.3],
  ['frame work over 16.7 ms %', 'workOverBudgetPct', 1, 'low', 1],
  ['frames >20 ms %', 'over20Pct', 1, 'low', 0.5],
  ['frames >34 ms %', 'over34Pct', 1, 'low', 0.2],
  ['long tasks', 'longTasks', 0, 'low', 1],
  ['main thread CPU ms/frame', 'mainCpuMs', 2, 'low', 0.2],
  ['GPU process CPU ms/frame', 'gpuProcessCpuMs', 2, 'low', 0.2],
  ['GPU busy %', 'gpuBusyPct', 0, 'low', 3],
  ['draw calls', 'calls', 0, 'low', 2],
  ['triangles', 'triangles', 0, 'low', 1000],
]

// A window during which other processes used more cores than this says little: on this laptop they take from the same
// power budget and the same memory bandwidth. Such a run stays in the run list but leaves the medians, when the cell has
// a quieter run.
const NOISY_OTHER_CORES = 3.5
const isNoisy = run => (run.metrics?.otherCores ?? 0) > NOISY_OTHER_CORES
const quietOf = runs => {
  const quiet = runs.filter(run => !isNoisy(run))
  return quiet.length ? quiet : runs
}

function writeReport(state, outDir) {
  const lines = [`# Perf matrix`, '', `Generated ${new Date().toISOString()}. ${state.runs.length} run(s) planned, ${state.runs.filter(r => r.status === 'ok').length} finished.`]
  if (state.stopped) lines.push('', `**Stopped early: ${state.stopped}**`)
  lines.push('', 'Roots: ' + state.roots.map(root => `\`${root.name}\` = ${root.dir}${root.browser ? ` browser ${root.browser}` : ''}${root.gpu ? ` gpu ${root.gpu}` : ''}`).join('; '))
  const okRuns = state.runs.filter(run => run.status === 'ok')
  const powers = new Set(okRuns.map(run => run.power?.label ?? 'unknown'))
  lines.push('', `Power states seen: ${[...powers].join(', ') || 'none'}${powers.size > 1 ? ' (**mixed**: the power column tells which runs ran where)' : ''}.`)
  const browsers = new Set(okRuns.map(run => `${run.browser?.version ?? '?'} ${run.browser?.glRenderer ?? run.browser?.renderer ?? '?'} ${run.browser?.glParts ?? ''} MSAA ${run.browser?.samples ?? '?'}`))
  lines.push('', `Browsers seen: ${[...browsers].join('; ') || 'none'}.`)
  lines.push('', `Each value is the median, with the range over the repeats in parentheses. Runs during which other processes used more than ${NOISY_OTHER_CORES} cores leave the medians when the cell has a quieter run; n shows runs used/finished. Frame numbers come from rAF deltas in the page. With vsync, fps and the shares of frames over 20 ms and 34 ms are the honest numbers; uncapped frames come in short/long pairs, so read the average there. main and GPU process CPU come from schedstat over the whole window (no trace needed).`)

  const columns = [...COLUMNS, ...OPTIONAL_COLUMNS.filter(([, key]) => okRuns.some(run => Number.isFinite(run.metrics[key])))]
  const head = ['cell', 'root', 'n', ...columns.map(column => column[0]), 'power']
  const rows = []
  for (const cell of state.cells) {
    for (const root of state.roots) {
      const finished = okRuns.filter(run => run.cell === cell.id && run.root === root.name)
      if (!finished.length) continue
      const runs = quietOf(finished)
      const powerLabels = [...new Set(runs.map(run => run.power?.label ?? '?'))]
      rows.push([cell.id, root.name, runs.length === finished.length ? String(runs.length) : `${runs.length}/${finished.length}`, ...columns.map(([, key, digits]) => spread(runs.map(run => run.metrics[key]), digits)), powerLabels.join(' + ')])
    }
  }
  lines.push('', '## Medians', '', mdTable(head, rows))

  if (state.roots.length > 1) {
    lines.push('', '## A/B', '', `A is \`${state.roots[0].name}\`. Delta is the median over pairs of consecutive runs, B minus A, in the same power state. "noise" means the delta is smaller than the spread over repeats of either side, smaller than the metric's floor, or its pairs disagree in sign.`)
    for (const cell of state.cells) {
      const a = state.roots[0]
      for (const b of state.roots.slice(1)) {
        const runsA = quietOf(okRuns.filter(run => run.cell === cell.id && run.root === a.name))
        const runsB = quietOf(okRuns.filter(run => run.cell === cell.id && run.root === b.name))
        if (!runsA.length || !runsB.length) continue
        const rowsAb = []
        for (const [label, key, digits, better, floor] of AB_METRICS) {
          const pairs = []
          for (const runA of runsA) {
            const runB = runsB.find(run => run.repeat === runA.repeat)
            if (!runB || (runA.power?.label ?? '') !== (runB.power?.label ?? '')) continue
            const valueA = runA.metrics[key]
            const valueB = runB.metrics[key]
            if (Number.isFinite(valueA) && Number.isFinite(valueB)) pairs.push(valueB - valueA)
          }
          const valuesA = runsA.map(run => run.metrics[key]).filter(Number.isFinite)
          const valuesB = runsB.map(run => run.metrics[key]).filter(Number.isFinite)
          if (!valuesA.length || !valuesB.length) continue
          const delta = median(pairs)
          const noise = Math.max(valuesA.length > 1 ? Math.max(...valuesA) - Math.min(...valuesA) : 0, valuesB.length > 1 ? Math.max(...valuesB) - Math.min(...valuesB) : 0)
          let verdict = 'no pairs'
          if (delta !== null) {
            const signs = new Set(pairs.map(Math.sign))
            if (pairs.length < 2) verdict = 'one pair, no noise estimate'
            else if (Math.abs(delta) <= floor || Math.abs(delta) <= noise || signs.size > 1) verdict = 'noise'
            else verdict = (delta < 0) === (better === 'low') ? 'better' : 'worse'
          }
          const base = median(valuesA)
          rowsAb.push([
            label,
            spread(valuesA, digits),
            spread(valuesB, digits),
            delta === null ? '-' : `${delta >= 0 ? '+' : ''}${fmt(delta, digits)}${base ? ` (${delta >= 0 ? '+' : ''}${fmt((delta / base) * 100, 1)} %)` : ''}`,
            pairs.length ? `${fmt(Math.min(...pairs), digits)} .. ${fmt(Math.max(...pairs), digits)}` : '-',
            verdict,
          ])
        }
        lines.push('', `### ${cell.id}: ${a.name} -> ${b.name}`, '', mdTable(['metric', a.name, b.name, 'delta', 'pairs', 'verdict'], rowsAb))
      }
    }
  }

  const warned = state.runs.filter(run => run.warnings?.length || run.status !== 'ok')
  if (warned.length) {
    lines.push('', '## Run problems', '')
    for (const run of warned) lines.push(`- ${run.cell} ${run.root} r${run.repeat}: ${run.status}${run.exitCode ? ` (exit ${run.exitCode})` : ''}${run.warnings?.length ? `: ${run.warnings.join('; ')}` : ''}`)
  }

  lines.push('', '## Run order', '', state.runs.map(run => `${run.index + 1}. ${run.cell} ${run.root} r${run.repeat} ${run.status}${run.power ? ` ${run.power.label}` : ''}${run.metrics ? ` fps ${fmt(run.metrics.fps)} avg ${fmt(run.metrics.avgMs)} other ${fmt(run.metrics.otherCores)}${isNoisy(run) ? ' NOISY' : ''}` : ''}`).join('\n'), '')
  fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'))
  fs.writeFileSync(path.join(outDir, 'matrix.json'), JSON.stringify(state, null, 2))
}

// ─── PLAN ──────────────────────────────────────────────────────────────────────────

/** The plan of one run: check the settings paths, apply them and wait for the extras, then warm up; shot.mjs measures after it. */
function planFor(scenario, seconds, settings) {
  const where = { tick: scenario.tick, mode: scenario.mode, ...(scenario.player ? { player: scenario.player } : {}) }
  const expected = JSON.stringify(settings)
  const getter = "const get = (object, dotted) => dotted.split('.').reduce((at, key) => at?.[key], object)"
  const precheck = `(() => { ${getter}; const settings = window.__dribble.stores.useStore.getState().settings; return { missing: Object.keys(${expected}).filter(key => get(settings, key) === undefined) } })()`
  const ready = `(async () => { ${getter}; const b = window.__dribble; const status = await b.hl.waitReady(90000); await new Promise(done => setTimeout(done, 2600)); const settings = b.stores.useStore.getState().settings; const expected = ${expected}; return { status, wrong: Object.keys(expected).filter(key => JSON.stringify(get(settings, key)) !== JSON.stringify(expected[key])), projectiles: b.hl.probes().includes('memory.projectiles') ? b.hl.probe('memory.projectiles')?.record?.state ?? null : null } })()`
  const steps = [
    { name: 'precheck', tick: scenario.tick, screenshot: false, eval: precheck },
    { name: 'ready', ...where, settings, screenshot: false, eval: ready },
  ]
  // 4x covers the whole window in a quarter of the time, so everything that first appears in it has loaded.
  if (scenario.warm) steps.push({ name: 'warm', ...where, speed: 4, play: Math.max(2, seconds / 4) })
  else steps.push({ name: 'start', ...where })
  return steps
}

function viewPresetDrift(root) {
  const problems = []
  for (const [preset, styleKey] of Object.entries(config.viewPresetChecks ?? {})) {
    let source
    try {
      source = fs.readFileSync(path.join(root.dir, 'src/highlander/settings.ts'), 'utf8')
    } catch {
      continue
    }
    const block = source.slice(source.indexOf('VIEW_PRESETS')).match(new RegExp(`\\b${styleKey}:\\s*\\{([\\s\\S]*?)\\n\\s*\\}`))?.[1]
    if (!block) continue
    const actual = {}
    for (const match of block.matchAll(/'([\w.]+)':\s*('[^']*'|[\w.]+)/g)) actual[match[1]] = match[2].startsWith("'") ? match[2].slice(1, -1) : JSON.parse(match[2])
    const wanted = config.settingsPresets?.[preset] ?? {}
    const keys = new Set([...Object.keys(actual), ...Object.keys(wanted)])
    const differing = [...keys].filter(key => actual[key] !== wanted[key])
    if (differing.length) problems.push(`config preset ${preset} differs from ${root.name}'s VIEW_PRESETS.${styleKey}: ${differing.join(', ')}`)
  }
  return problems
}

// ─── RUN ───────────────────────────────────────────────────────────────────────────

function runChild(commandArgs, env, logFile, echo = false) {
  return new Promise(resolve => {
    const log = fs.createWriteStream(logFile)
    const child = spawn(process.execPath, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], env })
    activeChild = child
    const sink = chunk => {
      log.write(chunk)
      if (echo) process.stdout.write(chunk)
    }
    child.stdout.on('data', sink)
    child.stderr.on('data', sink)
    child.on('exit', (code, signal) => {
      activeChild = null
      log.end()
      resolve(code ?? (signal ? 1 : 0))
    })
  })
}

let activeChild = null
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true
    activeChild?.kill(signal)
  })
}

async function main() {
  if (!args.out) usage('--out is required')
  const outDir = path.resolve(args.out)
  fs.mkdirSync(outDir, { recursive: true })

  if (args['report-only']) {
    const state = JSON.parse(fs.readFileSync(path.join(outDir, 'matrix.json'), 'utf8'))
    for (const run of state.runs) {
      if (fs.existsSync(path.join(run.dir, 'perf.json'))) {
        Object.assign(run, readRun(run.dir))
        run.status = run.invalid ? 'invalid' : 'ok'
      }
    }
    writeReport(state, outDir)
    console.log(`[matrix] report -> ${path.join(outDir, 'report.md')}`)
    return 0
  }

  const roots = (args.root ?? []).map(parseRootSpec)
  if (!roots.length) usage('at least one --root is required')
  const names = new Set(roots.map(root => root.name))
  if (names.size !== roots.length) usage('two --root specs have the same name; give them name=<dir>')
  for (const root of roots) if (!isCheckout(root.dir)) usage(`${root.dir} is not a dribble.tf checkout`)

  const scenarios = chooseScenarios()
  const quick = !!args.quick
  const repeats = args.repeats ?? (quick ? 3 : 2)
  const vsyncModes = (args.vsync ?? (quick ? 'off,on' : 'on')).split(',').map(word => word.trim())
  if (vsyncModes.some(mode => mode !== 'on' && mode !== 'off')) usage('--vsync takes on, off or on,off')
  const sizes = args.sizes?.split(',').map(size => size.trim())
  for (const size of sizes ?? []) if (!/^\d+x\d+$/.test(size)) usage(`bad size "${size}"`)
  const secondsOverride = args.seconds ?? (quick ? 10 : undefined)
  const lock = path.resolve(args.lock ?? process.env.DRIBBLE_HARNESS_LOCK ?? config.defaults?.lock ?? '')
  if (!args.lock && !process.env.DRIBBLE_HARNESS_LOCK && !config.defaults?.lock) usage('pass the shared lock with --lock')
  const buildCache = path.resolve(args['build-cache'] ?? process.env.DRIBBLE_HARNESS_BUILDS ?? config.defaults?.buildCache ?? path.join(outDir, 'builds'))
  const tmpDir = path.join(outDir, 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  const env = { ...process.env, TMPDIR: tmpDir } // the browser's throwaway profile goes to disk, not the /tmp quota
  const extraSettings = Object.assign({}, ...(args.set ?? []).map(parseSetting))

  const cells = []
  for (const scenario of scenarios) {
    for (const size of sizes ?? [scenario.size]) {
      for (const vsync of vsyncModes) {
        const parts = [scenario.id]
        if (sizes) parts.push(size)
        parts.push(vsync === 'on' ? 'vsync' : 'uncapped')
        cells.push({ id: parts.join('/'), scenario, size, noVsync: vsync === 'off' })
      }
    }
  }

  const state = {
    startedAt: new Date().toISOString(),
    configFile,
    roots: roots.map(({ name, dir, browser, gpu, query, set, init }) => ({ name, dir, browser, gpu, query, set, init })),
    cells: cells.map(cell => ({ id: cell.id, scenario: cell.scenario.id, description: cell.scenario.description, size: cell.size, noVsync: cell.noVsync, seconds: secondsOverride ?? cell.scenario.seconds })),
    runs: [],
    stopped: null,
  }

  // A B A B: per repeat every cell, per cell the roots in order. Repeats are the outer loop, so a cell's repeats spread
  // over the whole matrix and a drift of the machine shows up in its range.
  const planned = []
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const cell of cells) {
      for (const root of roots) {
        const dir = path.join(outDir, 'runs', ...cell.id.split('/').map(part => part.replace(/[^\w.-]+/g, '_')), `${root.name}-r${repeat}`)
        planned.push({ index: planned.length, cell, root, repeat, dir })
      }
    }
  }
  state.runs = planned.map(({ index, cell, root, repeat, dir }) => ({ index, cell: cell.id, root: root.name, repeat, dir, status: 'pending' }))

  const notes = []
  for (const root of roots) notes.push(...viewPresetDrift(root))
  for (const note of notes) console.warn(`[matrix] WARNING: ${note}`)

  const commandFor = ({ cell, root, dir }) => {
    const scenario = cell.scenario
    const seconds = secondsOverride ?? scenario.seconds
    const settings = {}
    for (const preset of scenario.presets ?? []) {
      if (!config.settingsPresets?.[preset]) usage(`scenario ${scenario.id}: unknown preset ${preset}`)
      Object.assign(settings, config.settingsPresets[preset])
    }
    Object.assign(settings, scenario.settings ?? {}, extraSettings, root.set)
    const planFile = path.join(dir, 'plan.json')
    const perfPlay = [scenario.tick, seconds, scenario.mode, scenario.player ?? '', scenario.speed].join(':')
    const pack = args.pack ?? scenario.assetPack
    const command = [SHOT, '--root', root.dir, '--demo', scenario.demoPath, '--plan', planFile, '--perf-play', perfPlay, '--size', cell.size, '--out', dir, '--lock', lock, '--build-cache', buildCache, '--timeout', String(args.timeout ?? 600)]
    if (!scenario.noPack && pack && pack !== 'none') command.push('--asset-pack', pack)
    if (cell.noVsync) command.push('--no-vsync')
    command.push('--settle-ms', '200', '--settle-frames', '4') // the plan's steps need no pixels-perfect settle
    if (args.trace) command.push('--trace')
    if (args['gpu-timer']) command.push('--gpu-timer')
    if (args['cpu-profile']) command.push('--cpu-profile')
    if (args['no-minify']) command.push('--no-minify')
    if (args['source-map']) command.push('--source-map')
    const browser = root.browser ?? args.browser ?? scenario.browser
    if (browser) command.push('--browser', browser)
    const gpu = root.gpu ?? args.gpu ?? scenario.gpu
    if (gpu) command.push('--gpu', gpu)
    for (const query of [...(scenario.query ?? []), ...(args.query ?? []), ...root.query]) command.push('--query', query)
    for (const file of scenario.init ?? []) command.push('--init-script', path.resolve(path.dirname(configFile), file))
    for (const file of root.init) command.push('--init-script', file)
    for (const flag of scenario.flags ?? []) command.push(flag)
    const minAvailable = args['min-available'] ?? scenario.minAvailable
    const quietCores = args['quiet-cores'] ?? 2.5
    if (quietCores > 0) command.push('--quiet-cores', String(quietCores), '--quiet-wait', String(args['quiet-wait'] ?? 20))
    if (minAvailable) command.push('--min-available', String(minAvailable), '--wait-available', String(args['wait-available'] ?? scenario.waitAvailable ?? 0))
    return { command, planFile, plan: planFor(scenario, seconds, settings) }
  }

  if (args['dry-run']) {
    for (const run of planned) console.log(`${String(run.index + 1).padStart(3)}. ${run.cell.id} ${run.root.name} r${run.repeat}`)
    console.log(`\nfirst command:\nnode ${commandFor(planned[0]).command.join(' ')}`)
    return 0
  }

  // Build first, so no run measures a machine still warm from a build, and a broken checkout stops here.
  const builds = new Map()
  for (const run of planned) {
    const { command } = commandFor(run)
    const packFlag = command.includes('--asset-pack')
    const key = `${run.root.dir}|${packFlag}`
    if (builds.has(key)) continue
    builds.set(key, true)
    const buildDir = path.join(outDir, 'builds-log', run.root.name + (packFlag ? '-pack' : '-nopack'))
    fs.mkdirSync(buildDir, { recursive: true })
    const buildCommand = [SHOT, '--build-only', '--root', run.root.dir, '--demo', run.cell.scenario.demoPath, '--out', buildDir, '--lock', lock, '--build-cache', buildCache]
    if (packFlag) buildCommand.push('--asset-pack', command[command.indexOf('--asset-pack') + 1])
    if (args['no-minify']) buildCommand.push('--no-minify')
    if (args['source-map']) buildCommand.push('--source-map')
    console.log(`[matrix] build check: ${run.root.name}${packFlag ? ' with pack URL' : ''}`)
    const code = await runChild(buildCommand, env, path.join(buildDir, 'shot.log'))
    if (code !== 0) {
      console.error(`[matrix] the build of ${run.root.dir} failed (exit ${code}), see ${path.join(buildDir, 'shot.log')}`)
      return 1
    }
  }

  let failed = 0
  let preQuietBudget = args['pre-quiet-budget'] ?? 1200
  const minBattery = args['min-battery'] ?? 12
  for (const run of planned) {
    const record = state.runs[run.index]
    if (interrupted) break
    const power = powerNow()
    if (power.status === 'Discharging' && power.capacity !== null && power.capacity < minBattery) {
      state.stopped = `battery guard: discharging at ${power.capacity} %, under ${minBattery} %`
      console.error(`[matrix] ${state.stopped}; stopping, what finished is in the report`)
      break
    }
    if (args.resume && fs.existsSync(path.join(run.dir, 'perf.json'))) {
      const kept = readRun(run.dir)
      if (!kept.invalid) {
        Object.assign(record, kept, { status: 'ok', resumed: true })
        console.log(`[matrix] ${run.index + 1}/${planned.length} ${run.cell.id} ${run.root.name} r${run.repeat}: kept`)
        continue
      }
      fs.rmSync(path.join(run.dir, 'perf.json'))
    }
    // A compile burst of another program costs more than its cores on battery: it takes from the shared power budget.
    const quietCores = args['quiet-cores'] ?? 2.5
    if (quietCores > 0 && preQuietBudget > 0) {
      const gate = await waitForQuiet({ maxOtherCores: quietCores, timeoutSec: Math.min(args['pre-quiet-wait'] ?? 120, preQuietBudget) })
      preQuietBudget -= gate.waitedSec
      record.preQuiet = gate
      if (gate.waitedSec > 5) console.log(`[matrix] waited ${gate.waitedSec} s for other processes (${gate.otherCores} cores now)`)
    }
    fs.mkdirSync(run.dir, { recursive: true })
    const { command, planFile, plan } = commandFor(run)
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2))
    fs.writeFileSync(path.join(run.dir, 'command.txt'), `TMPDIR=${tmpDir} node ${command.join(' ')}\n`)
    const started = Date.now()
    let code = await runChild(command, env, path.join(run.dir, 'shot.log'))
    if (code === 0 && fs.existsSync(path.join(run.dir, 'perf.json')) && readRun(run.dir).invalid) {
      console.error(`[matrix] ${run.cell.id} ${run.root.name} r${run.repeat}: ${readRun(run.dir).invalid}; running it once more`)
      code = await runChild(command, env, path.join(run.dir, 'shot.log'))
    }
    record.exitCode = code
    record.wallSec = Math.round((Date.now() - started) / 1000)
    if (code === 0 && fs.existsSync(path.join(run.dir, 'perf.json'))) {
      Object.assign(record, readRun(run.dir))
      record.status = record.invalid ? 'invalid' : 'ok'
      if (record.invalid) failed++
      if (!args['keep-traces']) fs.rmSync(path.join(run.dir, 'perf-trace.json'), { force: true })
      const m = record.metrics
      console.log(
        `[matrix] ${run.index + 1}/${planned.length} ${run.cell.id} ${run.root.name} r${run.repeat}: fps ${fmt(m.fps)} avg ${fmt(m.avgMs)} p95 ${fmt(m.p95Ms)} >20ms ${fmt(m.over20Pct)}% main ${fmt(m.mainCpuMs)} gpuBusy ${fmt(m.gpuBusyPct, 0)}% sclk ${fmt(m.sclkMhz, 0)} [${record.power?.label ?? '?'}] ${record.wallSec}s${record.warnings.length ? ` WARN ${record.warnings.join('; ')}` : ''}`
      )
    } else {
      record.status = code === EXIT_GATE ? 'skipped (memory gate)' : 'failed'
      failed++
      console.error(`[matrix] ${run.index + 1}/${planned.length} ${run.cell.id} ${run.root.name} r${run.repeat}: ${record.status} (exit ${code}), see ${path.join(run.dir, 'shot.log')}`)
    }
    writeReport(state, outDir)
  }
  if (interrupted) state.stopped = 'interrupted'
  state.finishedAt = new Date().toISOString()
  writeReport(state, outDir)
  // An A/B answers on the terminal too; a long matrix only names its file.
  if (roots.length > 1 && cells.length <= 4) {
    const report = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8')
    const at = report.indexOf('## A/B')
    if (at >= 0) console.log(`\n${report.slice(at, report.indexOf('## Run order')).trim()}\n`)
  }
  console.log(`[matrix] report -> ${path.join(outDir, 'report.md')}`)
  if (state.stopped?.startsWith('battery')) return EXIT_BATTERY
  return failed || interrupted ? 1 : 0
}

process.exit(await main())
