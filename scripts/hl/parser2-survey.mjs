#!/usr/bin/env node
// When does the base parser (parser2) start its timeline? (tasks B1 and B2)
//
//   node scripts/hl/parser2-survey.mjs [--parser2] [--hl-extras <native hl_extras binary>] [--derive-from <survey.json>]
//       [--demos <dir>] [--only <a.dem,b.dem>] [--lock <file>] [--batch <n>] [--confirm] [--out <file.json>]
//       [--resume] [--tmp <dir>] [--late-seconds <s>]
//
// parser2 starts its cache after 100 warmup packets with players AND non-zero world bounds (lib.rs
// parse_demo_cache_internal). Three sources of that start, at least one of them required:
//   --hl-extras   the native `hl_extras --print-options` derives the same start (src/extras/derive.rs) and writes
//                 `derived.started` (B1's pass: noStart, delayedStart, warmupFrames, firstWorldTick).
//   --derive-from takes those derive fields from the rows of an earlier survey file instead.
//   --parser2     runs parser2 itself on every demo (scripts/hl/parser2-start.mjs, one child process per demo) and
//                 records its startTick, startDemoTick, ticks and the last cache tick with player positions.
// Every row also gets a frame scan of the file (scripts/hl/lib/demo-frames.mjs): the first packet tick (the first
// Message frame) and the warmup end (the tick of the 100th frame, where the cache builders start when the players
// exist from the first frame, which they do on every local demo). From these the survey reports, per demo and as a
// distribution:
//   startLate = parser2's start demo tick - the first packet tick  (93 to 98 ticks, 1.4 s, on a 66 Hz demo that
//               starts normally), the seconds of demo parser2 never shows,
//   delay     = parser2's start - the warmup end, the part the world-bounds condition added (0 when it starts
//               normally; the fork's fallback export starts at the warmup end, so this is what it would recover),
//   tail      = parser2's ticks - 1 - the last tick with positions: parser2 sizes its timeline by the header's tick
//               count from its own start, so a late start leaves an equally long empty tail.
// Demos that start more than --late-seconds (default 5) after their first packet are listed in `late`.
//
// --confirm runs scripts/hl/base-values.mjs on every demo the derive pass says never starts. --lock <file> runs the
// children under `flock <file>`: --batch <n> demos (default 1) one after another per lock turn, so other heavy work
// can interleave without the survey queueing once per demo. Each parser2 child waits for MemAvailable of about
// 18 MB per file MB + 750 MB (1433815: 117 MB, VmHWM 2.3 GB) and is skipped (`parser2Skipped`) below it. Run this
// script itself without flock. With --out the file is rewritten after every batch; --resume keeps the rows of an
// existing --out file that already have every requested pass and runs the rest. --tmp sets where the children
// write their files (default: the OS temp dir).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { parseArgs, REPO_ROOT } from './lib/bundle.mjs'
import { scanDemoFrames, WARMUP_PACKETS } from './lib/demo-frames.mjs'

const { flags } = parseArgs(process.argv.slice(2), ['confirm', 'resume', 'parser2'])
const bin = flags['hl-extras']
const dir = flags.demos ?? '/home/dalibor/demo_tool/demos'
if (!bin && !flags['derive-from'] && !flags.parser2) {
  console.error(
    'usage: node scripts/hl/parser2-survey.mjs [--parser2] [--hl-extras <bin>] [--derive-from <survey.json>] [--demos dir] [--only a,b] [--lock file] [--batch n] [--confirm] [--out file] [--resume] [--tmp dir] [--late-seconds s]'
  )
  process.exit(2)
}
const batchSize = Math.max(1, Math.floor(Number(flags.batch ?? 1)) || 1)
const lateSeconds = Number(flags['late-seconds'] ?? 5)
const withLock = (cmd, args) => (flags.lock ? ['flock', [flags.lock, cmd, ...args]] : [cmd, args])
const memAvailableMB = () => Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) / 1024
const shellQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`
const parser2NeedMB = fileMB => Math.ceil(18 * fileMB + 750)
const read = file => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
const readJson = file => {
  try {
    return JSON.parse(read(file))
  } catch {
    return null // missing, empty or cut: the child died before or while writing it
  }
}

/** Derive fields of one demo from the files its hl_extras run wrote: <base>.json (options), .out, .err, .code. */
const deriveFields = base => {
  const [exit, ms] = read(`${base}.code`).trim().split(/\s+/).map(Number)
  const out = { exit: Number.isFinite(exit) ? exit : null, ms: Number.isFinite(ms) ? ms : null }
  if (out.exit !== null && out.exit > 128) out.signal = out.exit - 128 // bash reports a signal as 128 + n
  const parsed = readJson(`${base}.json`)
  const stderr = read(`${base}.err`)
  const stdout = read(`${base}.out`)
  if (parsed) {
    const d = parsed.derived ?? {}
    Object.assign(out, {
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
  } else {
    out.error = `no options (exit ${out.exit}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`
  }
  if (/start rule never fired/.test(stderr)) out.stderrNeverFired = true
  // --counts-only prints one JSON line with a `truncated` field; a cut file also logs "truncated at demo tick N"
  let counts = null
  try {
    counts = JSON.parse(stdout.trim().split('\n').pop() || 'null')
  } catch {
    counts = null
  }
  if (counts?.truncated === true || /truncated at demo tick/.test(stderr)) out.truncated = true
  return out
}

const DERIVE_KEYS = [
  'exit', 'ms', 'signal', 'started', 'startDemoTick', 'startTick', 'ticks', 'headerTicks', 'warmupFrames',
  'firstWorldTick', 'nextMappedPlayer', 'worldMin', 'worldMax', 'intervalPerTick', 'error', 'stderrNeverFired', 'truncated',
]

/** The B1 flags (noStart, delayedStart) and the B2 timing fields of one row, from whatever passes it has. */
const finishRow = row => {
  const d = row.derive && !row.derive.error ? row.derive : null
  if (d) {
    row.noStart = d.started === false
    // The world-bounds condition held the start back: more than the 100 warmup packets with players
    row.delayedStart = d.started === true && d.warmupFrames > WARMUP_PACKETS
    if (row.delayedStart) row.delayedSeconds = +((d.warmupFrames - WARMUP_PACKETS) * d.intervalPerTick).toFixed(1)
  }
  const p = row.parser2
  const ipt = p?.intervalPerTick ?? d?.intervalPerTick
  const started = p ? p.ticks > 1 && p.players > 0 : d ? d.started : undefined
  const start = p ? p.startDemoTick : d?.startDemoTick
  const f = row.frames
  row.started = started
  if (started && Number.isFinite(start) && Number.isFinite(ipt)) {
    if (f.firstPacketTick !== null) {
      row.startLateTicks = start - f.firstPacketTick
      row.startLateSeconds = +(row.startLateTicks * ipt).toFixed(2)
    }
    if (f.warmupEndTick !== null) {
      row.delayTicks = start - f.warmupEndTick
      row.delaySeconds = +(row.delayTicks * ipt).toFixed(2)
    }
  }
  if (p && started && p.lastTickWithPositions !== null) {
    row.tailTicks = p.ticks - 1 - p.lastTickWithPositions
    row.tailSeconds = +(row.tailTicks * p.intervalPerTick).toFixed(2)
  }
  if (p && d) {
    row.deriveAgrees =
      d.started === started && (!started || (d.startDemoTick === p.startDemoTick && d.startTick === p.startTick))
  }
  return row
}

const demos = fs
  .readdirSync(dir)
  .filter(f => f.endsWith('.dem'))
  .filter(f => !flags.only || flags.only.split(',').includes(f))
  .sort()
const tmp = fs.mkdtempSync(path.join(flags.tmp ?? os.tmpdir(), 'parser2-survey-'))
const rowsByName = new Map()
const complete = row =>
  !(bin && (!row.derive || row.derive.error)) && !(flags.parser2 && !row.parser2) && !row.parser2Error
if (flags.resume && flags.out && fs.existsSync(flags.out)) {
  for (const row of JSON.parse(fs.readFileSync(flags.out, 'utf8')).rows ?? []) if (complete(row)) rowsByName.set(row.demo, row)
}
const deriveFrom = new Map()
if (flags['derive-from']) {
  for (const old of JSON.parse(fs.readFileSync(flags['derive-from'], 'utf8')).rows ?? []) {
    // B1's survey rows hold the derive fields at the top level, B2's under `derive`
    const src = old.derive ?? old
    const fields = {}
    for (const k of DERIVE_KEYS) if (src[k] !== undefined) fields[k] = src[k]
    deriveFrom.set(old.demo, fields)
  }
}

const orderedRows = () => demos.map(name => rowsByName.get(name)).filter(Boolean)
const todo = demos.filter(name => !rowsByName.has(name))
const t0 = performance.now()
let lockTurns = 0
const parser2Start = path.join(REPO_ROOT, 'scripts/hl/parser2-start.mjs')
for (let b = 0; b < todo.length; b += batchSize) {
  const batch = todo.slice(b, b + batchSize)
  const lines = ['#!/usr/bin/env bash']
  batch.forEach((name, i) => {
    const base = path.join(tmp, String(i))
    for (const ext of ['json', 'out', 'err', 'code', 'p2.json', 'p2.err', 'p2.code', 'p2.skip']) fs.rmSync(`${base}.${ext}`, { force: true })
    const demo = path.join(dir, name)
    if (bin) {
      lines.push(
        `s=$(date +%s%N); ${shellQuote(bin)} ${shellQuote(demo)} --print-options ${shellQuote(`${base}.json`)} --counts-only > ${shellQuote(`${base}.out`)} 2> ${shellQuote(`${base}.err`)}; c=$?; echo "$c $(( ($(date +%s%N) - s) / 1000000 ))" > ${shellQuote(`${base}.code`)}`
      )
    }
    if (flags.parser2) {
      const need = parser2NeedMB(fs.statSync(demo).size / 1048576)
      lines.push(
        `a=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); if [ "$a" -lt ${need} ]; then echo "$a ${need}" > ${shellQuote(`${base}.p2.skip`)}; else s=$(date +%s%N); ${shellQuote(process.execPath)} ${shellQuote(parser2Start)} ${shellQuote(demo)} --out ${shellQuote(`${base}.p2.json`)} 2> ${shellQuote(`${base}.p2.err`)}; c=$?; echo "$c $(( ($(date +%s%N) - s) / 1000000 ))" > ${shellQuote(`${base}.p2.code`)}; fi`
      )
    }
  })
  if (lines.length > 1) {
    const script = path.join(tmp, 'batch.sh')
    fs.writeFileSync(script, `${lines.join('\n')}\n`)
    const [cmd, args] = withLock('bash', [script])
    spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    lockTurns++
  }
  batch.forEach((name, i) => {
    const base = path.join(tmp, String(i))
    const frames = scanDemoFrames(path.join(dir, name), { full: true })
    const row = {
      demo: name,
      map: frames.header.map,
      fileMB: +(frames.fileBytes / 1048576).toFixed(1),
      frames: {
        firstPacketTick: frames.firstPacketTick,
        warmupEndTick: frames.warmupEndTick,
        lastPacketTick: frames.lastPacketTick,
        headerTicks: frames.header.ticks,
        frames: frames.frames,
        messageFrames: frames.messageFrames,
        truncated: frames.truncated,
        ...(frames.error ? { error: frames.error } : {}),
      },
    }
    if (bin) row.derive = deriveFields(base)
    else if (deriveFrom.has(name)) row.derive = deriveFrom.get(name)
    if (flags.parser2) {
      const skip = read(`${base}.p2.skip`).trim()
      if (skip) {
        const [available, need] = skip.split(/\s+/).map(Number)
        row.parser2Skipped = `needs about ${need} MB, ${available} MB available`
      } else {
        const p2 = readJson(`${base}.p2.json`)
        const [exit, ms] = read(`${base}.p2.code`).trim().split(/\s+/).map(Number)
        if (p2) {
          const { demo: _demo, map: _map, fileBytes: _bytes, vmHwmKB, ...rest } = p2
          row.parser2 = { ...rest, vmHwmMB: Math.round(vmHwmKB / 1024), wallMs: Number.isFinite(ms) ? ms : null }
        } else {
          row.parser2Error = `exit ${exit}: ${read(`${base}.p2.err`).trim().split('\n').slice(-2).join(' | ')}`
        }
      }
    }
    finishRow(row)
    rowsByName.set(name, row)
    const tag = row.noStart
      ? 'NO START'
      : row.started === false
        ? 'no timeline'
        : row.startLateSeconds > lateSeconds
          ? `late ${row.startLateSeconds} s`
          : row.parser2Error || row.derive?.error
            ? 'ERROR'
            : row.parser2Skipped
              ? 'parser2 skipped (memory)'
              : 'ok'
    const ms = row.parser2?.wallMs ?? row.derive?.ms
    console.error(`[survey] ${demos.indexOf(name) + 1}/${demos.length} ${name} ${row.map} ${tag}${ms ? ` (${ms} ms)` : ''}`)
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

/** min, quartiles, p90, p99 and max of a list of numbers. */
const distribution = values => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const q = f => v[Math.min(v.length - 1, Math.floor(f * v.length))]
  return { n: v.length, min: v[0], p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), p99: q(0.99), max: v[v.length - 1] }
}
const histogram = values => {
  const counts = new Map()
  for (const value of values) if (value !== undefined && value !== null) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].sort((a, b) => a[0] - b[0])
}
const startedRows = rows.filter(r => r.started)
const summary = {
  startLateSeconds: distribution(startedRows.map(r => r.startLateSeconds)),
  startLateTicks: histogram(startedRows.map(r => r.startLateTicks)),
  delaySeconds: distribution(startedRows.map(r => r.delaySeconds)),
  delayTicks: histogram(startedRows.map(r => r.delayTicks)),
  tailSeconds: distribution(startedRows.map(r => r.tailSeconds)),
  tailTicks: histogram(startedRows.map(r => r.tailTicks)),
  firstPacketTick: histogram(rows.map(r => r.frames.firstPacketTick)),
  warmupEndTick: histogram(rows.map(r => r.frames.warmupEndTick)),
}
const out = {
  about:
    'parser2 start survey (tasks B1 and B2). startLate: parser2 start demo tick minus the first packet tick (the first Message frame). delay: parser2 start minus the warmup end (the 100th frame, where the fallback export starts). tail: parser2 ticks - 1 minus the last cache tick with player positions. noStart: the start rule never fires (parser2 returns 1 tick and no players; the viewer uses the fallback). delayedStart (derive): the world-bounds condition held the start back by delayedSeconds. late: startLateSeconds above lateSeconds.',
  hlExtras: bin ?? null,
  deriveFrom: flags['derive-from'] ?? null,
  parser2: !!flags.parser2,
  demosDir: dir,
  demos: rows.length,
  lateSeconds,
  seconds: Math.round((performance.now() - t0) / 1000),
  childSeconds: Math.round(rows.reduce((sum, r) => sum + (r.derive?.ms ?? 0) + (r.parser2?.wallMs ?? 0), 0) / 1000),
  lockTurns,
  noStart: rows.filter(r => r.noStart || r.started === false).map(r => r.demo),
  delayedStart: rows
    .filter(r => r.delayedStart || r.delayTicks > 0)
    .map(r => ({
      demo: r.demo,
      map: r.map,
      startDemoTick: r.parser2?.startDemoTick ?? r.derive?.startDemoTick,
      delaySeconds: r.delaySeconds,
      delayedSeconds: r.delayedSeconds,
    })),
  late: rows
    .filter(r => r.startLateSeconds > lateSeconds)
    .map(r => ({
      demo: r.demo,
      map: r.map,
      fileMB: r.fileMB,
      firstPacketTick: r.frames.firstPacketTick,
      warmupEndTick: r.frames.warmupEndTick,
      startDemoTick: r.parser2?.startDemoTick ?? r.derive?.startDemoTick,
      startLateSeconds: r.startLateSeconds,
      delaySeconds: r.delaySeconds,
      tailSeconds: r.tailSeconds,
    })),
  deriveDisagrees: rows.filter(r => r.deriveAgrees === false).map(r => r.demo),
  parser2Skipped: rows.filter(r => r.parser2Skipped).map(r => ({ demo: r.demo, why: r.parser2Skipped })),
  errors: rows
    .filter(r => r.derive?.error || r.parser2Error || r.frames.error)
    .map(r => ({ demo: r.demo, error: r.derive?.error ?? r.parser2Error ?? r.frames.error })),
  truncated: rows.filter(r => r.frames.truncated || r.derive?.truncated).map(r => r.demo),
  summary,
  confirmed,
  rows,
}
const json = JSON.stringify(out, null, 1)
if (flags.out) fs.writeFileSync(flags.out, json)
else process.stdout.write(`${json}\n`)
console.error(
  `[survey] ${rows.length} demos in ${out.seconds} s (${out.childSeconds} s of child runs, ${lockTurns} lock turns): no start ${out.noStart.length}, late > ${lateSeconds} s ${out.late.length}, errors ${out.errors.length}, parser2 skipped ${out.parser2Skipped.length}`
)
