#!/usr/bin/env node
// Which demos can the base parser (parser2) not start? (task B1)
//
//   node scripts/hl/parser2-survey.mjs --hl-extras <path to the native hl_extras binary> [--demos <dir>]
//       [--lock <file>] [--batch <n>] [--confirm] [--out <file.json>] [--resume] [--tmp <dir>]
//
// parser2 starts its cache after 100 warmup packets with players AND non-zero world bounds (lib.rs
// parse_demo_cache_internal). The native `hl_extras --print-options` derives the same start (src/extras/derive.rs)
// and writes `derived.started`, so a cheap first pass over every demo finds the ones that never start. It also finds
// the ones whose start the world-bounds condition delayed (warmupFrames > 100), which play but lose their first
// seconds. --confirm then runs parser2 itself (scripts/hl/base-values.mjs) on every demo that never started, when
// /proc/meminfo has room for it. --lock <file> runs the children under `flock <file>`: --batch <n> demos (default 1)
// one after another per lock turn, so other heavy work can interleave without the survey queueing once per demo.
// Run this script itself without flock. With --out the file is rewritten after every batch; --resume keeps the rows
// of an existing --out file and only runs the missing or failed demos. --tmp sets where hl_extras writes its
// options files (default: the OS temp dir).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { parseArgs, REPO_ROOT } from './lib/bundle.mjs'

const { flags } = parseArgs(process.argv.slice(2), ['confirm', 'resume'])
const bin = flags['hl-extras']
const dir = flags.demos ?? '/home/dalibor/demo_tool/demos'
if (!bin) {
  console.error(
    'usage: node scripts/hl/parser2-survey.mjs --hl-extras <bin> [--demos dir] [--lock file] [--batch n] [--confirm] [--out file] [--resume] [--tmp dir]'
  )
  process.exit(2)
}
const batchSize = Math.max(1, Math.floor(Number(flags.batch ?? 1)) || 1)
const withLock = (cmd, args) => (flags.lock ? ['flock', [flags.lock, cmd, ...args]] : [cmd, args])
const memAvailableMB = () => Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) / 1024
const shellQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`

/** Map name from the demo header (map at byte 536, 260 bytes, NUL-padded). */
const headerMap = file => {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(260)
  fs.readSync(fd, buf, 0, 260, 536)
  fs.closeSync(fd)
  return buf.toString('latin1').replace(/\0[\s\S]*$/, '')
}

/** One survey row from the files a batch wrote for this demo: <base>.json (options), .out, .err, .code. */
const rowFor = (name, base) => {
  const file = path.join(dir, name)
  const read = ext => {
    try {
      return fs.readFileSync(`${base}.${ext}`, 'utf8')
    } catch {
      return ''
    }
  }
  const [exit, ms] = read('code').trim().split(/\s+/).map(Number)
  const row = {
    demo: name,
    map: headerMap(file),
    fileMB: +(fs.statSync(file).size / 1048576).toFixed(1),
    exit: Number.isFinite(exit) ? exit : null,
    ms: Number.isFinite(ms) ? ms : null,
  }
  if (row.exit !== null && row.exit > 128) row.signal = row.exit - 128 // bash reports a signal as 128 + n
  let parsed = null
  try {
    parsed = JSON.parse(read('json'))
  } catch {
    parsed = null // missing, empty or cut: the child died before or while writing it (see exit)
  }
  const stderr = read('err')
  const stdout = read('out')
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
    row.error = `no options (exit ${row.exit}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`
  }
  if (/start rule never fired/.test(stderr)) row.stderrNeverFired = true
  // --counts-only prints one JSON line with a `truncated` field; a cut file also logs "truncated at demo tick N"
  let counts = null
  try {
    counts = JSON.parse(stdout.trim().split('\n').pop() || 'null')
  } catch {
    counts = null
  }
  if (counts?.truncated === true || /truncated at demo tick/.test(stderr)) row.truncated = true
  return row
}

const demos = fs.readdirSync(dir).filter(f => f.endsWith('.dem')).sort()
const tmp = fs.mkdtempSync(path.join(flags.tmp ?? os.tmpdir(), 'parser2-survey-'))
const rowsByName = new Map()
if (flags.resume && flags.out && fs.existsSync(flags.out)) {
  for (const row of JSON.parse(fs.readFileSync(flags.out, 'utf8')).rows ?? []) if (!row.error) rowsByName.set(row.demo, row)
}
const orderedRows = () => demos.map(name => rowsByName.get(name)).filter(Boolean)
const todo = demos.filter(name => !rowsByName.has(name))
const t0 = performance.now()
let lockTurns = 0
for (let b = 0; b < todo.length; b += batchSize) {
  const batch = todo.slice(b, b + batchSize)
  const lines = ['#!/usr/bin/env bash']
  batch.forEach((name, i) => {
    const base = path.join(tmp, String(i))
    for (const ext of ['json', 'out', 'err', 'code']) fs.rmSync(`${base}.${ext}`, { force: true })
    lines.push(
      `s=$(date +%s%N); ${shellQuote(bin)} ${shellQuote(path.join(dir, name))} --print-options ${shellQuote(`${base}.json`)} --counts-only > ${shellQuote(`${base}.out`)} 2> ${shellQuote(`${base}.err`)}; c=$?; echo "$c $(( ($(date +%s%N) - s) / 1000000 ))" > ${shellQuote(`${base}.code`)}`
    )
  })
  const script = path.join(tmp, 'batch.sh')
  fs.writeFileSync(script, `${lines.join('\n')}\n`)
  const [cmd, args] = withLock('bash', [script])
  spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  lockTurns++
  batch.forEach((name, i) => {
    const row = rowFor(name, path.join(tmp, String(i)))
    rowsByName.set(name, row)
    const tag = row.noStart ? 'NO START' : row.delayedStart ? `delayed ${row.delayedSeconds} s` : row.error ? 'ERROR' : 'ok'
    console.error(`[survey] ${demos.indexOf(name) + 1}/${demos.length} ${name} ${row.map} ${tag} (${row.ms} ms)`)
  })
  if (flags.out) fs.writeFileSync(flags.out, JSON.stringify({ partial: true, rows: orderedRows() }, null, 1))
}
fs.rmSync(tmp, { recursive: true, force: true })
const rows = orderedRows()

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
    'parser2 start-rule survey (task B1). noStart: the lib.rs start rule never fires (parser2 returns 1 tick and no players; the viewer uses the fallback). delayedStart: the world-bounds condition held the start back by delayedSeconds (the demo plays without its first seconds). ms: the hl_extras run of that demo (derive pass plus a counts-only extras parse), without lock waits.',
  hlExtras: bin,
  demosDir: dir,
  demos: rows.length,
  seconds: Math.round((performance.now() - t0) / 1000),
  hlExtrasSeconds: Math.round(rows.reduce((sum, r) => sum + (r.ms ?? 0), 0) / 1000),
  lockTurns,
  noStart: rows.filter(r => r.noStart).map(r => r.demo),
  delayedStart: rows
    .filter(r => r.delayedStart)
    .map(r => ({ demo: r.demo, map: r.map, startDemoTick: r.startDemoTick, delayedSeconds: r.delayedSeconds })),
  errors: rows.filter(r => r.error).map(r => ({ demo: r.demo, error: r.error })),
  truncated: rows.filter(r => r.truncated).map(r => r.demo),
  confirmed,
  rows,
}
const json = JSON.stringify(out, null, 1)
if (flags.out) fs.writeFileSync(flags.out, json)
else process.stdout.write(`${json}\n`)
console.error(
  `[survey] ${rows.length} demos in ${out.seconds} s (${out.hlExtrasSeconds} s of hl_extras, ${lockTurns} lock turns): no start ${out.noStart.length}, delayed ${out.delayedStart.length}, errors ${out.errors.length}`
)
