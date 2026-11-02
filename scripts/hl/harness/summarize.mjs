#!/usr/bin/env node
// Summarise harness runs: node scripts/hl/harness/summarize.mjs <run dir | manifest.json> [...]
//
// Prints the load state, page memory and warnings, then one line per plan step:
// - steps named sweep*: how many probes ran and each probe that returned an error;
// - the step named status: extras status, unavailable groups, map status, fallback, probe count;
// - every other step: render tick, screenshot file, step error, and the start of its eval result.
// The request summary and every /tf2-assets/ request come before the steps.
// Then the run's console.log: error lines, with the known harness noise (aborted GLB requests) counted apart.
// The step names are the ones plans/smoke-gen.mjs writes; other plans print through the generic branch.

import fs from 'node:fs'
import path from 'node:path'

const inputs = process.argv.slice(2)
if (!inputs.length || inputs.some(arg => arg === '-h' || arg === '--help')) {
  console.error('usage: node scripts/hl/harness/summarize.mjs <run dir | manifest.json> [...]')
  process.exit(inputs.length ? 0 : 64)
}

const dumps = (value, max) => {
  const text = JSON.stringify(value) ?? 'null'
  return max ? text.slice(0, max) : text
}
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value)

// `ERROR: null` comes from probes whose result carries `error: null` (map.props) in sweeps written before
// smoke-gen.mjs checked for it; it is not an error.
const isProbeError = value => String(value).startsWith('ERROR') && String(value) !== 'ERROR: null'
// A sweep calls every probe without arguments; these need one, so their sweep error is expected.
const NEEDS_ARGUMENT = new Set(['fx.actor', 'buildings.tracerMuzzle'])

// Known noise: Playwright reports a GLB request that the app's loader abandoned (the stubbed boot map's
// textured_compressed.glb, player and projectile models, a map GLB loaded twice) as net::ERR_ABORTED.
const isNoise = line => /\breqfail\b.*\.glb net::ERR_ABORTED/.test(line)
const isErrorLine = line => / (error|pageerror|reqfail) /.test(line.slice(0, 20))

let failed = false
for (const input of inputs) {
  const manifestFile = fs.existsSync(input) && fs.statSync(input).isDirectory() ? path.join(input, 'manifest.json') : input
  let m
  try {
    m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (error) {
    console.error(`${manifestFile}: ${error?.message || error}`)
    failed = true
    continue
  }
  if (inputs.length > 1) console.log(`\n=== ${manifestFile}`)

  console.log('loaded:', dumps(m.loaded, 600))
  console.log('memoryMB:', dumps(m.memoryMB), 'warnings:', dumps((m.warnings ?? []).slice(0, 6)))
  if (m.requestSummary) {
    const pack = m.assetPack ?? {}
    console.log('requests:', dumps(m.requestSummary), 'asset pack:', pack.dir ? `${pack.dir} fingerprint ${pack.fingerprint ?? 'null'}` : 'none')
    const packRows = (m.requests ?? []).filter(r => String(r.path).startsWith('/tf2-assets/'))
    for (const r of packRows.slice(0, 10)) console.log('   ', r.status, r.type, r.path, r.count > 1 ? `x${r.count}` : '', r.failure ?? '')
    if (packRows.length > 10) console.log(`    ... ${packRows.length - 10} more /tf2-assets/ paths`)
  }
  for (const st of m.shots ?? []) {
    const ev = st.eval
    const name = st.step?.name ?? ''
    if (name.startsWith('sweep')) {
      const results = isPlainObject(ev) ? Object.entries(ev) : []
      const errs = results.filter(([k, v]) => isProbeError(v) && !NEEDS_ARGUMENT.has(k))
      const expected = results.filter(([k, v]) => isProbeError(v) && NEEDS_ARGUMENT.has(k))
      console.log(name, 'probes', results.length, 'errors', errs.length, expected.length ? `(+${expected.length} expected: ${expected.map(([k]) => k).join(', ')} need an argument)` : '', st.error ? `STEP ERROR ${st.error}` : '')
      for (const [k, v] of errs) console.log('   ', k, v)
    } else if (name === 'status') {
      const e = isPlainObject(ev) ? ev : {}
      const pick = Object.fromEntries(['status', 'unavailable', 'warnings', 'mapStatus', 'mapNodes', 'fallback', 'probes'].map(k => [k, e[k] ?? null]))
      console.log('status:', dumps(pick, 900), st.error ? `STEP ERROR ${st.error}` : '')
      console.log('  fallbackInfo:', dumps(e.fallbackInfo ?? null, 400))
      console.log('  props:', dumps(e.props ?? null, 300))
      console.log('  frameCache:', dumps(e.frameCache ?? null), ' mapdyn:', dumps(e.mapdyn ?? null, 300))
    } else {
      const parts = [name || `step ${st.index}`, 'tick', st.state?.playback?.renderTick ?? null, 'shot', st.file ? path.basename(st.file) : null]
      if (st.error) parts.push('STEP ERROR', st.error)
      parts.push('|', ev !== undefined ? dumps(ev, 420) : '')
      console.log(...parts)
    }
  }
  if (m.perf?.summary) {
    const p = m.perf.summary
    console.log('perf:', dumps({ spec: m.perf.spec, fps: p.fps, frameMs: p.frameMs, ticksPerSecond: p.ticksPerSecond, longTasks: p.longTasks, browserMemMB: p.browserMemMB, renderCalls: p.renderCalls }))
  }

  const consoleFile = path.join(path.dirname(manifestFile), 'console.log')
  if (fs.existsSync(consoleFile)) {
    const lines = fs.readFileSync(consoleFile, 'utf8').split('\n').filter(Boolean)
    const errors = lines.filter(isErrorLine)
    const noise = errors.filter(isNoise)
    const real = errors.filter(line => !isNoise(line))
    console.log(`console: ${lines.length} lines, ${errors.length} error lines: ${real.length} app, ${noise.length} known noise (aborted GLB requests)`)
    for (const line of real.slice(0, 20)) console.log('   ', line.slice(0, 300))
    if (real.length > 20) console.log(`    ... ${real.length - 20} more in ${consoleFile}`)
  }
}
process.exit(failed ? 1 : 0)
