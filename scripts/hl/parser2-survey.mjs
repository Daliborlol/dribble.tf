#!/usr/bin/env node
// Which demos can the base parser (parser2) not start? (task B1)
//
//   node scripts/hl/parser2-survey.mjs --hl-extras <path to the native hl_extras binary> [--demos <dir>]
//       [--lock <file>] [--confirm] [--out <file.json>] [--resume] [--tmp <dir>]
//
// parser2 starts its cache after 100 warmup packets with players AND non-zero world bounds (lib.rs
// parse_demo_cache_internal). The native `hl_extras --print-options` derives the same start (src/extras/derive.rs)
// and writes `derived.started`, so a cheap first pass over every demo finds the ones that never start. It also finds
// the ones whose start the world-bounds condition delayed (warmupFrames > 100), which play but lose their first
// seconds. --confirm then runs parser2 itself (scripts/hl/base-values.mjs) on every demo that never started, when
// /proc/meminfo has room for it. --lock <file> runs each child under `flock <file>`, one demo at a time, so other
// heavy work can interleave. Run this script itself without flock. With --out the file is rewritten after every
// demo; --resume keeps the rows of an existing --out file and only runs the missing or failed demos. --tmp sets
// where hl_extras writes its options file (default: the OS temp dir).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { parseArgs, REPO_ROOT } from './lib/bundle.mjs'

const { flags } = parseArgs(process.argv.slice(2), ['confirm', 'resume'])
const bin = flags['hl-extras']
const dir = flags.demos ?? '/home/dalibor/demo_tool/demos'
if (!bin) {
  console.error('usage: node scripts/hl/parser2-survey.mjs --hl-extras <bin> [--demos dir] [--lock file] [--confirm] [--out file]')
  process.exit(2)
}
const withLock = (cmd, args) => (flags.lock ? ['flock', [flags.lock, cmd, ...args]] : [cmd, args])
const memAvailableMB = () => Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) / 1024

/** Map name from the demo header (map at byte 536, 260 bytes, NUL-padded). */
const headerMap = file => {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(260)
  fs.readSync(fd, buf, 0, 260, 536)
  fs.closeSync(fd)
  return buf.toString('latin1').replace(/\0[\s\S]*$/, '')
}

const demos = fs.readdirSync(dir).filter(f => f.endsWith('.dem')).sort()
const tmp = fs.mkdtempSync(path.join(flags.tmp ?? os.tmpdir(), 'parser2-survey-'))
const previous = new Map()
if (flags.resume && flags.out && fs.existsSync(flags.out)) {
  for (const row of JSON.parse(fs.readFileSync(flags.out, 'utf8')).rows ?? []) if (!row.error) previous.set(row.demo, row)
}
const rows = []
const t0 = performance.now()
for (const [i, name] of demos.entries()) {
  if (previous.has(name)) {
    rows.push(previous.get(name))
    continue
  }
  const file = path.join(dir, name)
  const optionsFile = path.join(tmp, 'options.json')
  fs.rmSync(optionsFile, { force: true })
  const t = performance.now()
  const [cmd, args] = withLock(bin, [file, '--print-options', optionsFile, '--counts-only'])
  const run = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const row = {
    demo: name,
    map: headerMap(file),
    fileMB: +(fs.statSync(file).size / 1048576).toFixed(1),
    exit: run.status,
    ms: Math.round(performance.now() - t),
  }
  let parsed = null
  try {
    parsed = fs.existsSync(optionsFile) ? JSON.parse(fs.readFileSync(optionsFile, 'utf8')) : null
  } catch {
    parsed = null // an empty or cut file: the child died while writing (see exit and signal)
  }
  if (run.signal) row.signal = run.signal
  if (parsed) {
    const d = parsed.derived ?? {}
    Object.assign(row, {
      started: d.started,
      startDemoTick: d.startDemoTick,
      startTick: d.startTick,
      ticks: d.ticks,
      headerTicks: d.headerTicks,
      warmupFrames: d.warmupFrames,
      firstWorldTick: d.firstWorldTick,
      nextMappedPlayer: d.nextMappedPlayer,
      worldMin: d.worldMin,
      worldMax: d.worldMax,
      intervalPerTick: d.intervalPerTick,
    })
    row.noStart = d.started === false
    // The world-bounds condition held the start back: more than the 100 warmup packets with players
    row.delayedStart = d.started === true && d.warmupFrames > 100
    if (row.delayedStart) row.delayedSeconds = +((d.warmupFrames - 100) * d.intervalPerTick).toFixed(1)
  } else {
    row.error = `no options (exit ${run.status}, signal ${run.signal}): ${(run.stderr || '').trim().split('\n').slice(-3).join(' | ')}`
  }
  if (/start rule never fired/.test(run.stderr || '')) row.stderrNeverFired = true
  if (/truncated/.test(run.stderr || '') || /truncated/.test(run.stdout || '')) row.truncated = true
  rows.push(row)
  const tag = row.noStart ? 'NO START' : row.delayedStart ? `delayed ${row.delayedSeconds} s` : row.error ? 'ERROR' : 'ok'
  console.error(`[survey] ${i + 1}/${demos.length} ${name} ${row.map} ${tag} (${row.ms} ms)`)
  if (flags.out) fs.writeFileSync(flags.out, JSON.stringify({ partial: true, rows }, null, 1))
}
fs.rmSync(tmp, { recursive: true, force: true })

const confirmed = []
if (flags.confirm) {
  for (const row of rows.filter(r => r.noStart)) {
    const needMB = Math.ceil(6.2 * row.fileMB + 200) // parser2 in Node peaked at 712 MB on the 116 MB 1429417
    const available = Math.floor(memAvailableMB())
    if (available < needMB) {
      confirmed.push({ demo: row.demo, skipped: `needs about ${needMB} MB, ${available} MB available` })
      continue
    }
    const [cmd, args] = withLock(process.execPath, [path.join(REPO_ROOT, 'scripts/hl/base-values.mjs'), path.join(dir, row.demo)])
    const run = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (run.status !== 0) {
      confirmed.push({ demo: row.demo, error: (run.stderr || '').trim().split('\n').slice(-2).join(' | ') })
      continue
    }
    const b = JSON.parse(run.stdout)
    confirmed.push({
      demo: row.demo,
      parser2Ticks: b.ticks,
      parser2Players: b.nextMappedPlayer,
      parser2NoTimeline: !(b.ticks > 1 && b.nextMappedPlayer > 0),
      parseMs: b.parseMs,
      vmHwmMB: Math.round(b.vmHwmKB / 1024),
    })
    console.error(`[survey] parser2 on ${row.demo}: ticks ${b.ticks}, players ${b.nextMappedPlayer}`)
  }
}

const out = {
  about:
    'parser2 start-rule survey (task B1). noStart: the lib.rs start rule never fires (parser2 returns 1 tick and no players; the viewer uses the fallback). delayedStart: the world-bounds condition held the start back by delayedSeconds (the demo plays without its first seconds).',
  hlExtras: bin,
  demosDir: dir,
  demos: rows.length,
  seconds: Math.round((performance.now() - t0) / 1000),
  noStart: rows.filter(r => r.noStart).map(r => r.demo),
  delayedStart: rows.filter(r => r.delayedStart).map(r => ({ demo: r.demo, map: r.map, startDemoTick: r.startDemoTick, delayedSeconds: r.delayedSeconds })),
  errors: rows.filter(r => r.error).map(r => ({ demo: r.demo, error: r.error })),
  confirmed,
  rows,
}
const json = JSON.stringify(out, null, 1)
if (flags.out) fs.writeFileSync(flags.out, json)
else process.stdout.write(json + '\n')
console.error(`[survey] ${rows.length} demos in ${out.seconds} s: no start ${out.noStart.length}, delayed ${out.delayedStart.length}, errors ${out.errors.length}`)
