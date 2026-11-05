// Read-only system telemetry for a perf window: the Radeon's load and clock, CPU clocks, the power state, and the
// on-CPU and run-queue time of the browser's threads. Everything comes from sysfs and /proc; nothing is written.
//
// start() takes its first snapshot; stop(frames) takes the last one and returns the "system" record of perf.json. The
// 10 Hz samples only read small sysfs files; thread times are read twice, at the start and at the end of the window.

import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { statOf } from './perf-analysis.mjs'

const read = file => {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}
const readNumber = file => {
  const text = read(file)
  if (text === null) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}
const list = dir => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** The first DRM card with the amdgpu telemetry files, or null. */
function findGpuDevice() {
  for (const name of list('/sys/class/drm').filter(entry => /^card\d+$/.test(entry)).sort()) {
    const device = `/sys/class/drm/${name}/device`
    if (fs.existsSync(`${device}/gpu_busy_percent`)) {
      const hwmon = list(`${device}/hwmon`)[0]
      return { card: name, device, hwmon: hwmon ? `${device}/hwmon/${hwmon}` : null }
    }
  }
  return null
}

const activeClock = text => {
  const line = (text ?? '').split('\n').find(row => row.includes('*'))
  const match = line?.match(/(\d+)\s*Mhz/i)
  return match ? Number(match[1]) : null
}

function findBattery() {
  const base = '/sys/class/power_supply'
  let battery = null
  let adapter = null
  for (const name of list(base)) {
    const type = read(`${base}/${name}/type`)
    if (type === 'Battery' && !battery) battery = `${base}/${name}`
    if (type === 'Mains' && !adapter) adapter = `${base}/${name}`
  }
  return { battery, adapter }
}

/** One battery reading: { acOnline, status, capacity, watts, label }. Used by perf-matrix.mjs's battery guard too. */
export function powerNow() {
  const { battery, adapter } = findBattery()
  const acOnline = adapter ? readNumber(`${adapter}/online`) === 1 : null
  const status = battery ? read(`${battery}/status`) : null
  const capacity = battery ? readNumber(`${battery}/capacity`) : null
  const microWatts = battery ? readNumber(`${battery}/power_now`) : null
  return { acOnline, status, capacity, watts: microWatts === null ? null : Number((microWatts / 1e6).toFixed(1)) }
}

/** `powerprofilesctl get`, or null. It is a Python script (0.3 s of CPU), so it never runs inside a window. */
export function readPowerProfile() {
  return new Promise(resolve => {
    execFile('powerprofilesctl', ['get'], { timeout: 3000 }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null))
  })
}

// ─── THREADS ──────────────────────────────────────────────────────────────────────

/** Every process under rootPid: [{ pid, type }], type from Chromium's --type switch ('browser' without one). */
function processTree(rootPid) {
  const children = new Map()
  for (const entry of list('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const stat = read(`/proc/${entry}/stat`)
    if (!stat) continue
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(Number(entry))
  }
  const found = []
  const stack = [rootPid]
  while (stack.length) {
    const pid = stack.pop()
    const cmdline = read(`/proc/${pid}/cmdline`)
    if (cmdline) {
      const type = cmdline.match(/--type=([a-z-]+)/)?.[1] ?? 'browser'
      found.push({ pid, type: type === 'gpu-process' ? 'gpu' : type })
    }
    stack.push(...(children.get(pid) ?? []))
  }
  return found
}

/**
 * Per-thread on-CPU and run-queue nanoseconds, from /proc/<pid>/task/<tid>/schedstat. The main thread of a Chromium
 * process keeps the process's name, and Mesa names its threads <process>:gl0, so names become `main` and `gl0`.
 */
function threadSnapshot(rootPid) {
  const threads = new Map()
  if (!rootPid) return threads
  for (const { pid, type } of processTree(rootPid)) {
    for (const entry of list(`/proc/${pid}/task`)) {
      const tid = Number(entry)
      const schedstat = read(`/proc/${pid}/task/${tid}/schedstat`)
      if (!schedstat) continue
      const [cpuNs, waitNs] = schedstat.split(/\s+/).map(Number)
      const comm = read(`/proc/${pid}/task/${tid}/comm`) ?? '?'
      const name = tid === pid ? 'main' : comm.includes(':') ? comm.slice(comm.indexOf(':') + 1) : comm
      threads.set(`${pid}:${tid}`, { pid, type, name, cpuNs, waitNs })
    }
  }
  return threads
}

/** CPU jiffies of every process outside the browser tree: pid -> { name, ticks }. */
function foreignProcesses(rootPid) {
  const ours = new Set(rootPid ? processTree(rootPid).map(row => row.pid) : [])
  const rows = new Map()
  for (const entry of list('/proc')) {
    if (!/^\d+$/.test(entry) || ours.has(Number(entry))) continue
    const stat = read(`/proc/${entry}/stat`)
    if (!stat) continue
    const open = stat.indexOf('(')
    const close = stat.lastIndexOf(')')
    const fields = stat.slice(close + 2).split(' ')
    rows.set(entry, { name: stat.slice(open + 1, close), ticks: Number(fields[11]) + Number(fields[12]) })
  }
  return rows
}

/** The busiest processes outside the browser in a window, in cores (USER_HZ is 100 on Linux). */
function topForeign(before, after, seconds) {
  const byName = new Map()
  for (const [pid, end] of after) {
    const delta = end.ticks - (before.get(pid)?.ticks ?? 0)
    if (delta > 0) byName.set(end.name, (byName.get(end.name) ?? 0) + delta)
  }
  return [...byName]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, ticks]) => ({ name, cores: Number((ticks / 100 / Math.max(0.001, seconds)).toFixed(2)) }))
}

/** Swap traffic and major page faults so far, from /proc/vmstat; a full swap stalls whoever faults. */
function vmCounters() {
  const text = read('/proc/vmstat') ?? ''
  const counter = name => Number(text.match(new RegExp(`^${name} (\\d+)`, 'm'))?.[1] ?? 0)
  return { pswpin: counter('pswpin'), pswpout: counter('pswpout'), pgmajfault: counter('pgmajfault') }
}

const memAvailableMB = () => {
  const kb = Number((read('/proc/meminfo') ?? '').match(/^MemAvailable:\s+(\d+)/m)?.[1])
  return Number.isFinite(kb) ? Math.round(kb / 1024) : null
}

/** System-wide busy and total jiffies from the first line of /proc/stat. */
function cpuTotals() {
  const fields = (read('/proc/stat') ?? '').split('\n')[0].trim().split(/\s+/).slice(1).map(Number)
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields
  const busy = user + nice + system + irq + softirq + steal
  return { busy, total: busy + idle + iowait }
}

function threadReport(before, after, frames, seconds) {
  const rows = new Map()
  const processes = new Map()
  let cpuNsTotal = 0
  for (const [key, end] of after) {
    const start = before.get(key)
    const cpuNs = end.cpuNs - (start?.cpuNs ?? 0)
    const waitNs = end.waitNs - (start?.waitNs ?? 0)
    if (cpuNs <= 0 && waitNs <= 0) continue
    cpuNsTotal += cpuNs
    const rowKey = `${end.type}/${end.name}`
    const row = rows.get(rowKey) ?? { process: end.type, thread: end.name, count: 0, cpuNs: 0, waitNs: 0 }
    row.count++
    row.cpuNs += cpuNs
    row.waitNs += waitNs
    rows.set(rowKey, row)
    const proc = processes.get(end.type) ?? { cpuNs: 0, waitNs: 0 }
    proc.cpuNs += cpuNs
    proc.waitNs += waitNs
    processes.set(end.type, proc)
  }
  const perFrame = ns => Number((ns / 1e6 / Math.max(1, frames)).toFixed(2))
  const shape = row => ({
    cpuMsPerFrame: perFrame(row.cpuNs),
    runQueueMsPerFrame: perFrame(row.waitNs),
    busyPct: Number(((row.cpuNs / 1e9 / Math.max(0.001, seconds)) * 100).toFixed(1)),
  })
  return {
    browserCores: Number((cpuNsTotal / 1e9 / Math.max(0.001, seconds)).toFixed(2)),
    processes: Object.fromEntries([...processes].sort((a, b) => b[1].cpuNs - a[1].cpuNs).map(([type, row]) => [type, shape(row)])),
    threads: [...rows.values()]
      .sort((a, b) => b.cpuNs - a.cpuNs)
      .slice(0, 16)
      .map(row => ({ process: row.process, thread: row.thread, count: row.count, ...shape(row) })),
  }
}

/**
 * Waits until the processes outside the browser use at most maxOtherCores over one second, or the timeout. On battery
 * they take from the package power budget too, so a compile burst during a window says nothing about the page.
 * Returns { ok, waitedSec, otherCores }.
 */
export async function waitForQuiet({ rootPid = null, maxOtherCores, timeoutSec }) {
  const started = performance.now()
  const coreCount = list('/sys/devices/system/cpu').filter(name => /^cpu\d+$/.test(name)).length || 1
  const sumCpuNs = threads => [...threads.values()].reduce((sum, row) => sum + row.cpuNs, 0)
  for (;;) {
    const totals = cpuTotals()
    const browserNs = sumCpuNs(threadSnapshot(rootPid))
    const began = performance.now()
    await new Promise(resolve => setTimeout(resolve, 1000))
    const seconds = (performance.now() - began) / 1000
    const after = cpuTotals()
    const browserCores = (sumCpuNs(threadSnapshot(rootPid)) - browserNs) / 1e9 / seconds
    const totalDelta = after.total - totals.total
    const systemCores = totalDelta > 0 ? ((after.busy - totals.busy) / totalDelta) * coreCount : 0
    const otherCores = Math.max(0, systemCores - browserCores)
    const waitedSec = (performance.now() - started) / 1000
    if (otherCores <= maxOtherCores || waitedSec >= timeoutSec) {
      return { ok: otherCores <= maxOtherCores, waitedSec: Number(waitedSec.toFixed(1)), otherCores: Number(otherCores.toFixed(2)), maxOtherCores }
    }
  }
}

// ─── SAMPLER ──────────────────────────────────────────────────────────────────────

export function startSystemSampler({ rootPid = null, intervalMs = 100, profileBefore = null } = {}) {
  const gpu = findGpuDevice()
  const { battery, adapter } = findBattery()
  const cpuFreqFiles = list('/sys/devices/system/cpu')
    .filter(name => /^cpu\d+$/.test(name))
    .map(name => `/sys/devices/system/cpu/${name}/cpufreq/scaling_cur_freq`)
    .filter(file => fs.existsSync(file))
  const cpuPolicy = '/sys/devices/system/cpu/cpu0/cpufreq'

  const rows = { gpuBusyPct: [], sclkMhz: [], sclkActualMhz: [], cpuMhz: [], cpuMaxCoreMhz: [], gpuPptWatts: [], gpuTempC: [], batteryWatts: [], vramUsedMB: [], gttUsedMB: [] }
  const seen = { acOnline: new Set(), batteryStatus: new Set(), platformProfile: new Set(), energyPreference: new Set(), scalingMaxMhz: new Set() }
  const capacities = []
  const costs = []

  const sample = () => {
    const began = performance.now()
    if (gpu) {
      rows.gpuBusyPct.push(readNumber(`${gpu.device}/gpu_busy_percent`))
      rows.sclkMhz.push(activeClock(read(`${gpu.device}/pp_dpm_sclk`)))
      const used = readNumber(`${gpu.device}/mem_info_vram_used`)
      if (used !== null) rows.vramUsedMB.push(used / 1048576)
      const gtt = readNumber(`${gpu.device}/mem_info_gtt_used`)
      if (gtt !== null) rows.gttUsedMB.push(gtt / 1048576)
      if (gpu.hwmon) {
        const clock = readNumber(`${gpu.hwmon}/freq1_input`)
        if (clock !== null) rows.sclkActualMhz.push(clock / 1e6)
        const ppt = readNumber(`${gpu.hwmon}/power1_input`) ?? readNumber(`${gpu.hwmon}/power1_average`)
        if (ppt !== null) rows.gpuPptWatts.push(ppt / 1e6)
        const temp = readNumber(`${gpu.hwmon}/temp1_input`)
        if (temp !== null) rows.gpuTempC.push(temp / 1000)
      }
    }
    if (cpuFreqFiles.length) {
      const clocks = cpuFreqFiles.map(readNumber).filter(value => value !== null)
      if (clocks.length) {
        rows.cpuMhz.push(clocks.reduce((sum, value) => sum + value, 0) / clocks.length / 1000)
        rows.cpuMaxCoreMhz.push(Math.max(...clocks) / 1000)
      }
    }
    if (adapter) seen.acOnline.add(read(`${adapter}/online`))
    if (battery) {
      seen.batteryStatus.add(read(`${battery}/status`))
      capacities.push(readNumber(`${battery}/capacity`))
      const watts = readNumber(`${battery}/power_now`)
      if (watts !== null) rows.batteryWatts.push(watts / 1e6)
    }
    seen.platformProfile.add(read('/sys/firmware/acpi/platform_profile'))
    seen.energyPreference.add(read(`${cpuPolicy}/energy_performance_preference`))
    const maxFreq = readNumber(`${cpuPolicy}/scaling_max_freq`)
    if (maxFreq !== null) seen.scalingMaxMhz.add(Math.round(maxFreq / 1000))
    costs.push(performance.now() - began)
  }

  const threadsBefore = threadSnapshot(rootPid)
  const foreignBefore = foreignProcesses(rootPid)
  const totalsBefore = cpuTotals()
  const vmBefore = vmCounters()
  const memBefore = memAvailableMB()
  const startedAt = performance.now()
  sample()
  const timer = setInterval(sample, intervalMs)

  return {
    /**
     * Ends the sampling at once. The call returns a function that takes `powerprofilesctl get`, which is read only now
     * that the window is over, and returns the record.
     */
    stop({ frames }) {
      clearInterval(timer)
      const seconds = (performance.now() - startedAt) / 1000
      const threadsAfter = threadSnapshot(rootPid)
      const totalsAfter = cpuTotals()
      const foreignAfter = foreignProcesses(rootPid)
      const vmAfter = vmCounters()
      const availableEnd = memAvailableMB()
      const busyDelta = totalsAfter.busy - totalsBefore.busy
      const totalDelta = totalsAfter.total - totalsBefore.total
      const coreCount = cpuFreqFiles.length || 1
      const report = threadReport(threadsBefore, threadsAfter, frames, seconds)
      const systemCores = totalDelta > 0 ? (busyDelta / totalDelta) * coreCount : null
      const values = set => [...set].filter(value => value !== null)
      const acOnline = values(seen.acOnline)
      const onAc = acOnline.length === 1 ? acOnline[0] === '1' : null
      const scalingMaxMhz = values(seen.scalingMaxMhz)
      return profileAfter => {
        const profile = profileBefore ?? profileAfter
        const changed =
          acOnline.length > 1 || values(seen.batteryStatus).length > 1 || values(seen.platformProfile).length > 1 || values(seen.energyPreference).length > 1 || scalingMaxMhz.length > 1 || (!!profileBefore && !!profileAfter && profileBefore !== profileAfter)
        const source = onAc === null ? 'unknown' : onAc ? 'ac' : 'battery'
        const maxLabel = scalingMaxMhz.length === 1 ? `${(scalingMaxMhz[0] / 1000).toFixed(1)}GHz` : '?GHz'
        return {
          card: gpu?.card ?? null,
          intervalMs,
          seconds: Number(seconds.toFixed(2)),
          samples: costs.length,
          sampleCostMs: statOf(costs, 2),
          gpuBusyPct: statOf(rows.gpuBusyPct),
          sclkMhz: statOf(rows.sclkMhz, 0),
          sclkActualMhz: statOf(rows.sclkActualMhz, 0),
          cpuMhz: statOf(rows.cpuMhz, 0),
          cpuMaxCoreMhz: statOf(rows.cpuMaxCoreMhz, 0),
          gpuPptWatts: statOf(rows.gpuPptWatts),
          gpuTempC: statOf(rows.gpuTempC),
          batteryWatts: statOf(rows.batteryWatts),
          vramUsedMB: statOf(rows.vramUsedMB, 0),
          gttUsedMB: statOf(rows.gttUsedMB, 0),
          power: {
            label: `${source}/${profile ?? 'unknown'}/${maxLabel}${changed ? '/CHANGED' : ''}`,
            source,
            acOnline: onAc,
            batteryStatus: values(seen.batteryStatus),
            capacityStart: capacities[0] ?? null,
            capacityEnd: capacities[capacities.length - 1] ?? null,
            profileStart: profileBefore,
            profileEnd: profileAfter,
            platformProfile: values(seen.platformProfile),
            energyPreference: values(seen.energyPreference),
            scalingMaxMhz,
            changed,
          },
          cpuLoad: {
            coreCount,
            systemBusyCores: systemCores === null ? null : Number(systemCores.toFixed(2)),
            browserCores: report.browserCores,
            otherCores: systemCores === null ? null : Number(Math.max(0, systemCores - report.browserCores).toFixed(2)),
            topOther: topForeign(foreignBefore, foreignAfter, seconds),
          },
          memory: {
            availableMBStart: memBefore,
            availableMBEnd: availableEnd,
            swapInMB: Number((((vmAfter.pswpin - vmBefore.pswpin) * 4096) / 1048576).toFixed(1)),
            swapOutMB: Number((((vmAfter.pswpout - vmBefore.pswpout) * 4096) / 1048576).toFixed(1)),
            majorFaults: vmAfter.pgmajfault - vmBefore.pgmajfault,
          },
          processes: report.processes,
          threads: report.threads,
        }
      }
    },
  }
}
