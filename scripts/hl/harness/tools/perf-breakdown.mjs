#!/usr/bin/env node
// The main-thread breakdown of perf runs: time per frame by category from a --trace run, and the top functions from a
// --cpu-profile --no-minify run, with self time per source group through the build's source map.
//
//   node scripts/hl/harness/tools/perf-breakdown.mjs <run dir> [--profile-run <dir>] [--top <n>] [--out <file>]
//
// <run dir> holds perf.json and perf-trace.json or perf.cpuprofile (a run may have both); --profile-run names another
// run for the profile, which keeps the profiler's overhead out of the trace's numbers. Reads files only.

import fs from 'node:fs'
import path from 'node:path'
import { SourceMap } from 'node:module'
import { parseTraceBuffer, profileBreakdown, traceBreakdown } from '../lib/perf-analysis.mjs'

const argv = process.argv.slice(2)
const options = { top: 30 }
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--profile-run') options.profileRun = argv[++i]
  else if (argv[i] === '--top') options.top = Number(argv[++i])
  else if (argv[i] === '--out') options.out = argv[++i]
  else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('usage: perf-breakdown.mjs <run dir> [--profile-run <dir>] [--top <n>] [--out <file>]')
    process.exit(0)
  } else if (argv[i].startsWith('--')) {
    console.error(`unknown option ${argv[i]}`)
    process.exit(2)
  } else positional.push(argv[i])
}
if (positional.length !== 1) {
  console.error('usage: perf-breakdown.mjs <run dir> [--profile-run <dir>] [--top <n>] [--out <file>]')
  process.exit(2)
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const runDir = path.resolve(positional[0])
const profileDir = path.resolve(options.profileRun ?? runDir)
const perf = readJson(path.join(runDir, 'perf.json'))
const lines = []
const say = (...parts) => lines.push(parts.join(' '))
const pad = (value, width = 7) => String(value ?? '-').padStart(width)

const frames = perf.frameStats ?? {}
say(`# Perf breakdown: ${runDir}`)
say('')
say(`window: tick ${perf.spec.tick}, ${perf.spec.seconds} s, mode ${perf.spec.mode}${perf.spec.player ? ` player ${perf.spec.player}` : ''}, ${perf.spec.noVsync ? 'uncapped' : 'vsync'}`)
say(`frames: ${frames.count}, fps ${frames.fps}, avg ${frames.avg} ms, p50 ${frames.p50}, p95 ${frames.p95}, p99 ${frames.p99}, over 20 ms ${frames.over20Pct} %, over 34 ms ${frames.over34Pct} %`)
if (perf.frameWork) say(`frame work (${perf.frameDone ? 'first rAF callback' : 'vsync'} to the end of the frame's task): avg ${perf.frameWork.avg} ms, p50 ${perf.frameWork.p50}, p95 ${perf.frameWork.p95}, p99 ${perf.frameWork.p99}, over 16.7 ms ${perf.frameWork.over16Pct} %`)
if (perf.renderInfo) say(`renderer.info: calls ${perf.renderInfo.calls?.p50}, triangles ${perf.renderInfo.triangles?.p50}, renders per frame ${perf.renderInfo.rendersPerFrame}`)
if (perf.system) {
  const s = perf.system
  say(`system: ${s.power?.label}, GPU busy ${s.gpuBusyPct?.avg} % (p95 ${s.gpuBusyPct?.p95}), sclk avg ${s.sclkMhz?.avg} MHz (p95 ${s.sclkMhz?.p95}), CPU mean ${s.cpuMhz?.avg} MHz, fastest core ${s.cpuMaxCoreMhz?.avg} MHz, package ${s.gpuPptWatts?.avg} W, other processes ${s.cpuLoad?.otherCores} cores`)
  say('')
  say('## CPU time per thread, from schedstat over the whole window')
  say('')
  say(`${pad('cpu ms/f')} ${pad('runq ms/f', 9)} ${pad('busy %')}  thread`)
  for (const row of s.threads ?? []) say(`${pad(row.cpuMsPerFrame, 8)} ${pad(row.runQueueMsPerFrame, 9)} ${pad(row.busyPct)}  ${row.process}/${row.thread}${row.count > 1 ? ` (${row.count} threads)` : ''}`)
}

const traceFile = path.join(runDir, 'perf-trace.json')
if (fs.existsSync(traceFile)) {
  const { text } = traceBreakdown(parseTraceBuffer(fs.readFileSync(traceFile)), frames.count * frames.avg, frames.count)
  say('')
  say('## Trace (nesting resolved, self time)')
  say('')
  say(text)
} else if (perf.trace) {
  say('')
  say('## Trace summary')
  say('')
  for (const [role, row] of Object.entries(perf.trace.threads ?? {})) say(`${pad(row.busyMsPerFrame)} ms/f busy  ${pad(row.cpuMsPerFrame)} cpu  ${pad(row.busyPct)} %  ${role}`)
  say('')
  for (const [category, ms] of Object.entries(perf.trace.rendererCategories ?? {})) say(`${pad(ms)} ms/f  ${category}`)
}

const profileFile = path.join(profileDir, 'perf.cpuprofile')
if (fs.existsSync(profileFile)) {
  const profilePerf = profileDir === runDir ? perf : readJson(path.join(profileDir, 'perf.json'))
  const profileFrames = profilePerf.frameStats?.count ?? frames.count
  // Source maps of the unminified build, by bundle file name.
  const maps = new Map()
  const mapFor = url => {
    let name
    try {
      name = path.basename(new URL(url).pathname)
    } catch {
      return null
    }
    if (maps.has(name)) return maps.get(name)
    let map = null
    const distDir = profilePerf.distDir
    const file = distDir ? path.join(distDir, 'assets', `${name}.map`) : null
    if (file && fs.existsSync(file)) {
      try {
        map = new SourceMap(readJson(file))
      } catch {}
    }
    maps.set(name, map)
    return map
  }
  const groupOf = source => {
    const text = source.replace(/^(\.\.\/)+/, '')
    const pkg = text.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
    if (pkg) return pkg[1]
    const app = text.match(/^(?:.*\/)?src\/((?:highlander|assetpack|components)\/[^/]+|[^/]+)/)
    return app ? `src/${app[1]}` : text
  }
  const locate = (url, line, column) => {
    const entry = mapFor(url)?.findEntry(line, column)
    return entry?.originalSource ? groupOf(entry.originalSource) : null
  }
  // A frame's position in its source, shortened to the package or to src/.
  const describe = (url, line, column) => {
    const entry = mapFor(url)?.findEntry(line, column)
    if (!entry?.originalSource) return null
    const short = entry.originalSource.replace(/^(\.\.\/)+/, '').replace(/^.*node_modules\//, '').replace(/^.*?src\//, 'src/')
    return `${short}:${entry.originalLine + 1}`
  }
  const profile = readJson(profileFile)
  const table = profileBreakdown(profile, { frames: profileFrames, locate, describe, topN: options.top })
  const row = item => `${pad(item.msPerFrame)} ${pad(item.pct, 6)} %  ${item.name}`
  say('')
  say(`## CPU profile${profileDir === runDir ? '' : ` of ${profileDir}`}: ${profileFrames} frames, fps ${profilePerf.frameStats?.fps}, ms per frame`)
  say('')
  say(`busy ${table.busyMsPerFrame}, idle ${table.idleMsPerFrame}; of busy: garbage collector ${table.gcMsPerFrame}, (program) ${table.programMsPerFrame}, native WebGL calls ${table.webglMsPerFrame}`)
  say('')
  say(`### Self time per source group (share of busy time)`)
  say('')
  for (const item of table.groups) say(row(item))
  say('')
  say(`### Top ${options.top} functions by self time`)
  say('')
  for (const item of table.topSelf) say(row(item))
  say('')
  say(`### Top ${options.top} functions by inclusive time`)
  say('')
  for (const item of table.topInclusive) say(row(item))
  say('')
  say('### Native WebGL calls by self time')
  say('')
  for (const item of table.topWebgl) say(row(item))
}

const text = lines.join('\n') + '\n'
if (options.out) {
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
  fs.writeFileSync(options.out, text)
  console.log(`breakdown -> ${path.resolve(options.out)}`)
} else process.stdout.write(text)
