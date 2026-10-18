#!/usr/bin/env node
// Which local demos does the viewer route to the fallback after parser2? (task B2)
//
//   node scripts/hl/check-delayed-trigger.mjs --survey <parser2-survey.json> [--demos <dir>] [--root <checkout>]
//       [--out <file.json>] [--tmp <dir>]
//
// Runs the real trigger of ParseWorker.ts (its exported demoWarmup and delayedStartOf, bundled with esbuild) on every
// demo file of a `scripts/hl/parser2-survey.mjs --parser2` run, with the parser2 start that run measured, and checks
// demoWarmup against the survey's Node frame scan (scripts/hl/lib/demo-frames.mjs). No demo is parsed: only the
// frame headers of the first megabytes are read, so it needs no lock. Demos without a parser2 timeline go to the
// fallback by B1's rule (ticks <= 1 or no players) whatever the delay. Exit code 1 when a scan disagrees.

import fs from 'node:fs'
import path from 'node:path'

import { parseArgs, REPO_ROOT } from './lib/bundle.mjs'
import { loadParseWorker } from './lib/parse-worker.mjs'

const { flags } = parseArgs(process.argv.slice(2))
if (!flags.survey) {
  console.error('usage: node scripts/hl/check-delayed-trigger.mjs --survey <parser2-survey.json> [--demos dir] [--root checkout] [--out file] [--tmp dir]')
  process.exit(2)
}
const root = path.resolve(flags.root ?? REPO_ROOT)
const survey = JSON.parse(fs.readFileSync(flags.survey, 'utf8'))
const dir = flags.demos ?? survey.demosDir
const { mod } = await loadParseWorker(root, { tmp: flags.tmp })
const { demoWarmup, delayedStartOf, DELAYED_START_FALLBACK_SECONDS } = mod

/** The first `bytes` of a file (the whole file when it is shorter). */
const head = (file, bytes) => {
  const fd = fs.openSync(file, 'r')
  try {
    const size = Math.min(bytes, fs.fstatSync(fd).size)
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, 0)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } finally {
    fs.closeSync(fd)
  }
}

const rows = []
const scanMismatches = []
for (const r of survey.rows) {
  const file = path.join(dir, r.demo)
  let bytes = head(file, 8 << 20)
  let warm = demoWarmup(bytes)
  if (warm.warmupEndTick === null && bytes.byteLength === 8 << 20) {
    bytes = new Uint8Array(fs.readFileSync(file)) // the 100th frame lies further in
    warm = demoWarmup(bytes)
  }
  if (warm.firstPacketTick !== r.frames.firstPacketTick || warm.warmupEndTick !== r.frames.warmupEndTick) {
    scanMismatches.push({ demo: r.demo, ts: warm, node: { firstPacketTick: r.frames.firstPacketTick, warmupEndTick: r.frames.warmupEndTick } })
  }
  const p = r.parser2
  const timeline = !!p && p.ticks > 1 && p.players > 0
  const delayed = timeline ? delayedStartOf({ startDemoTick: p.startDemoTick, intervalPerTick: p.intervalPerTick }, bytes) : null
  rows.push({
    demo: r.demo,
    map: r.map,
    route: !p ? 'unknown (no parser2 run)' : !timeline ? 'fallback: no timeline' : delayed ? 'fallback: delayed start' : 'parser2',
    startDemoTick: p?.startDemoTick ?? null,
    warmupEndTick: warm.warmupEndTick,
    delaySeconds: delayed ? +delayed.delaySeconds.toFixed(2) : timeline && warm.warmupEndTick !== null ? +((p.startDemoTick - warm.warmupEndTick) * p.intervalPerTick).toFixed(2) : null,
  })
}

const byRoute = {}
for (const row of rows) (byRoute[row.route] ??= []).push(row.demo)
const out = {
  root,
  survey: flags.survey,
  thresholdSeconds: DELAYED_START_FALLBACK_SECONDS,
  demos: rows.length,
  routes: Object.fromEntries(Object.entries(byRoute).map(([k, v]) => [k, v.length])),
  delayedStart: rows.filter(r => r.route === 'fallback: delayed start'),
  noTimeline: rows.filter(r => r.route === 'fallback: no timeline').map(r => r.demo),
  largestDelayOnParser2: rows.filter(r => r.route === 'parser2').reduce((m, r) => Math.max(m, r.delaySeconds ?? 0), 0),
  scanMismatches,
  rows,
}
const json = JSON.stringify(out, null, 1)
if (flags.out) fs.writeFileSync(flags.out, json)
console.log(JSON.stringify({ ...out, rows: undefined }, null, 1))
process.exitCode = scanMismatches.length ? 1 : 0
