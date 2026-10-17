// Extras loader (contract section 3.4) and the P1 bridge probes (section 3.10).
//
// parseDemoAction calls startHighlanderExtras once the base parse resolved, the base worker was terminated and the
// scene loaded (D4). The base worker handed the file buffer back (D18); it is transferred to the extras worker,
// which copies it into wasm memory. A new demo load calls cancelHighlanderExtras first, which terminates a
// running extras worker and makes any late message from it a no-op.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { registerHlProbe } from '@highlander/debug'
import { itemName, wearableDefs } from '@highlander/items'
import { getState, useInstance } from '@zus/store'

import { checkAlignment, type AlignmentResult } from './alignment'
import { HL } from './enums'
import * as getters from './getters'
import { typedArrayBytes } from './hydrate'
import { planExtrasGroups, type ExtrasPlan } from './memory'
import type { HighlanderExtras } from './types'

/** Section 3.4 step 8: no result after this long is an error. A loader timeout, not effect logic (D12). */
const RESULT_TIMEOUT_MS = 180_000

let requestId = 0
let running: { worker: Worker; timer: ReturnType<typeof setTimeout> } | null = null

// Diagnostics for the probes
let lastPlan: (ExtrasPlan & { fileBytes: number }) | null = null
let lastAlignment: AlignmentResult | null = null
let lastTiming: { workerMs?: number; parseMs?: number; wasmMemoryBytes?: number; typedArrayBytes?: number } | null = null

function stopWorker(): void {
  if (!running) return
  clearTimeout(running.timer)
  running.worker.terminate()
  running = null
}

/** D4: terminate a running extras parse. Any message it still sends is dropped. */
export function cancelHighlanderExtras(): void {
  requestId++
  stopWorker()
}

/** Section 3.4. Never throws into the caller; every terminal path terminates the worker. */
export async function startHighlanderExtras(buffer: ArrayBuffer, parsedDemo: AsyncParser): Promise<void> {
  const req = ++requestId
  const instance = () => useInstance.getState()
  const isCurrent = () => req === requestId
  const fail = (message: string) => {
    if (!isCurrent()) return
    stopWorker()
    instance().setExtrasStatus('error', 100, message)
  }

  try {
    stopWorker()
    lastAlignment = null
    lastTiming = null

    const seconds = parsedDemo.ticks * parsedDemo.intervalPerTick
    const plan = planExtrasGroups(buffer.byteLength, { seconds })
    lastPlan = { ...plan, fileBytes: buffer.byteLength }
    if (plan.skip) {
      instance().setExtrasStatus('disabled', 0, plan.reason)
      return
    }

    instance().setExtrasStatus('loading', 0)

    const options = {
      startTick: parsedDemo.startTick,
      tickBase: parsedDemo.tickBase,
      ticks: parsedDemo.ticks,
      intervalPerTick: parsedDemo.intervalPerTick,
      playerEntityIds: Array.from(parsedDemo.playerEntityIds()),
      groups: plan.groups,
      wearableDefs: wearableDefs(),
    }

    const worker = new Worker(new URL('./ExtrasWorker.ts', import.meta.url), { type: 'module' })
    const timer = setTimeout(() => fail(`no extras result after ${RESULT_TIMEOUT_MS / 1000} s`), RESULT_TIMEOUT_MS)
    running = { worker, timer }
    let lastProgress = 0

    worker.onmessage = (event: MessageEvent) => {
      if (!isCurrent()) return
      const data = event.data
      if (!data || typeof data !== 'object') return

      if (data.type === 'progress') {
        const progress = Math.round(Number(data.progress) || 0)
        if (progress !== lastProgress) {
          lastProgress = progress
          instance().setExtrasStatus('loading', progress)
        }
        return
      }

      if (data.type === 'error') {
        fail(String(data.error || 'extras parse failed'))
        return
      }

      if (data.type !== 'result') return
      stopWorker() // the result is complete; the worker's wasm heap goes with it
      if (instance().parsedDemo !== parsedDemo) return

      const extras = data.extras as HighlanderExtras
      const alignment = checkAlignment(extras, parsedDemo)
      lastAlignment = alignment
      if (!alignment.ok) {
        instance().setExtrasStatus('error', 100, `misaligned: ${alignment.reason ?? 'unknown reason'}`)
        return
      }

      const bytes = typedArrayBytes(extras)
      lastTiming = { workerMs: data.ms, parseMs: extras.meta.parseMs, wasmMemoryBytes: data.wasmMemoryBytes, typedArrayBytes: bytes }
      instance().setExtras(extras)
      instance().setExtrasStatus('ready', 100)
      console.info('[HL] extras ready', {
        parseMs: Math.round(extras.meta.parseMs),
        workerMs: Math.round(Number(data.ms) || 0),
        typedArrayBytes: bytes,
        typedArrayMB: Math.round((bytes / 1e6) * 10) / 10,
        wasmMemoryMB: Math.round((Number(data.wasmMemoryBytes) || 0) / 1e5) / 10,
        counts: extras.meta.counts,
        excluded: extras.meta.excluded,
        warnings: extras.meta.warnings,
        alignment,
      })
    }
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault?.()
      fail(event.message || 'extras worker failed')
    }
    worker.onmessageerror = () => fail('extras result could not be read')

    worker.postMessage(
      { buffer, options, sceneOrigin: { ...parsedDemo.world.boundaryMin }, map: parsedDemo.header.map },
      [buffer]
    )
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

//
// ─── PROBES (section 3.10) ──────────────────────────────────────────────────────
//

const HL_NAMES = Object.keys(HL) as (keyof typeof HL)[]

/** NaN and infinities become null so results cross page.evaluate() as JSON. */
const safe = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)))
}

const flagNames = (flags: number) => HL_NAMES.filter(name => (flags & HL[name]) !== 0)

const extrasOrNull = () => {
  const { extras, extrasStatus } = useInstance.getState()
  return extrasStatus === 'ready' && extras ? extras : null
}

/** DemoViewer's renderTick: playback tick minus INTERP_DELAY_TICKS (2), at least 1. */
const renderTickNow = () => Math.max(1, (getState().playback.tick ?? 1) - 2)

/** Per-player extras values at a cache tick: what the getters return for every player of the base parse. */
function playersAt(tickArg?: number) {
  const x = extrasOrNull()
  const demo = useInstance.getState().parsedDemo
  if (!x || !demo) return { error: 'extras not ready', status: useInstance.getState().extrasStatus }
  const tick = Math.max(0, Math.floor(tickArg ?? renderTickNow()))
  const rows = []
  for (let p = 0; p < demo.nextMappedPlayer; p++) {
    const ref = demo.entityPlayerMap.get(p)
    if (!ref) continue
    const base = demo.playerCache.getPlayer(tick, p, ref.user as any)
    const flags = getters.flagsAt(x, p, tick)
    const weapon = getters.activeWeaponAt(x, p, tick, base.classId)
    const disguise = getters.disguiseAt(x, p, tick)
    rows.push({
      p,
      entityId: ref.user.entityId,
      name: ref.user.name,
      team: base.teamId,
      classId: base.classId,
      health: base.health,
      flags: flagNames(flags),
      cloakMeter: getters.cloakMeterAt(x, p, tick),
      invis: safe(getters.invisAt(x, p, tick)),
      disguise: disguise && { ...disguise, weaponName: itemName(disguise.weaponDef) },
      weapon,
      wstate: getters.weaponStateAt(x, p, tick),
      medigun: getters.medigunAt(x, p, tick),
      sniperCharge: getters.sniperChargeAt(x, p, tick),
      fov: safe(getters.fovAt(x, p, tick)),
      eyeZ: getters.eyeZAt(x, p, tick),
      respawnSeconds: safe(getters.respawnSecondsAt(x, p, tick)),
      ammo: getters.ammoAt(x, p, tick),
      misc: getters.miscAt(x, p, tick),
      loadout: getters.loadoutAt(x, p, tick).map(def => ({ def, name: itemName(def) })),
      scoring: getters.scoringAt(x, p, tick),
      itemCharge: getters.itemChargeAt(x, p, tick),
      vm0: getters.viewmodelAt(x, p, tick, 0),
    })
  }
  return jsonSafe({ tick, players: rows })
}

registerHlProbe('players.at', playersAt)

/** The memory plan of the last load, or a plan for (fileBytes, seconds, budgetMB). */
registerHlProbe('extras.plan', (fileBytes?: number, seconds?: number, budgetMB?: number) =>
  fileBytes === undefined ? lastPlan : planExtrasGroups(fileBytes, { seconds, budgetMB })
)

/** The alignment check result and timings of the last load. */
registerHlProbe('extras.load', () => jsonSafe({ status: useInstance.getState().extrasStatus, alignment: lastAlignment, timing: lastTiming, plan: lastPlan }))

/** Calls any getter by name with the ready extras first: hl.probe('extras.call', 'invisAt', p, tickF). */
registerHlProbe('extras.call', (name: string, ...args: unknown[]) => {
  const x = extrasOrNull()
  if (!x) return { error: 'extras not ready' }
  const fn = (getters as unknown as Record<string, unknown>)[name]
  if (typeof fn !== 'function') return { error: `no getter named "${name}"`, getters: Object.keys(getters).sort() }
  const result = (fn as (...a: unknown[]) => unknown)(x, ...args)
  return jsonSafe(result instanceof Uint32Array ? Array.from(result) : result === undefined ? null : result)
})

/** Entry and instance counts per group plus the bytes the extras hold. */
registerHlProbe('extras.summary', () => {
  const x = extrasOrNull()
  if (!x) return { error: 'extras not ready', status: useInstance.getState().extrasStatus }
  const groups: Record<string, number> = {}
  for (const key of ['players', 'weapons', 'buildings', 'projectiles', 'flames', 'dots', 'objectives', 'movers', 'pickups', 'ragdolls', 'drops', 'tempents', 'hurts'] as const) {
    groups[key] = typedArrayBytes(x[key])
  }
  return jsonSafe({
    map: x.meta.map,
    ticks: x.meta.ticks,
    playerCount: x.meta.playerCount,
    snapshotInterval: x.meta.snapshotInterval,
    typedArrayBytes: typedArrayBytes(x),
    groupBytes: groups,
    instances: {
      weapons: x.weapons.count,
      buildings: x.buildings.count,
      projectiles: x.projectiles.count,
      flames: x.flames.count,
      dots: x.dots.count,
      movers: x.movers.count,
      pickups: x.pickups.count,
      ragdolls: x.ragdolls.count,
      drops: x.drops.count,
      timers: x.objectives.timers.count,
      watchers: x.objectives.watchers.count,
    },
    events: Object.fromEntries(Object.entries(x.derived.eventsByType).map(([t, list]) => [t, list.length])),
    tempents: {
      bullets: x.tempents.bullets.tick.length,
      explosions: x.tempents.explosions.tick.length,
      tracers: x.tempents.tracers.tick.length,
      particles: x.tempents.particles.tick.length,
      clientProjectiles: x.tempents.clientProjectiles.tick.length,
      hurts: x.hurts.tick.length,
      fire: x.players.fire.tick.length,
      anim: x.players.anim.tick.length,
    },
    available: x.meta.available,
    excluded: x.meta.excluded,
    warnings: x.meta.warnings,
  })
})

/**
 * Exercises the D4 cancel paths on the loaded demo (debug only). `mode` 'double' starts the extras parse twice
 * (the second start must cancel the first, whose messages are then dropped); 'cancel' starts it, cancels it after
 * `waitMs` and checks that no result arrives, then starts it again so the page ends with ready extras.
 * `url` is the demo file to fetch (the harness serves it under ?demoUrl=).
 */
registerHlProbe('extras.restart', async (url: string, mode: 'double' | 'cancel' = 'double', waitMs = 3000) => {
  const demo = useInstance.getState().parsedDemo
  if (!demo || !url) return { error: 'needs a loaded demo and its url' }
  const statuses: string[] = [useInstance.getState().extrasStatus]
  const unsubscribe = useInstance.subscribe(s => {
    if (statuses[statuses.length - 1] !== s.extrasStatus) statuses.push(s.extrasStatus)
  })
  const fetchBuffer = async () => (await fetch(url)).arrayBuffer()
  const settle = () =>
    new Promise<string>(resolve => {
      const done = () => ['ready', 'error', 'disabled'].includes(useInstance.getState().extrasStatus)
      if (done()) return resolve(useInstance.getState().extrasStatus)
      const stop = useInstance.subscribe(() => {
        if (!done()) return
        stop()
        resolve(useInstance.getState().extrasStatus)
      })
    })
  const before = useInstance.getState().extras
  const out: Record<string, unknown> = { mode }
  try {
    if (mode === 'cancel') {
      void startHighlanderExtras(await fetchBuffer(), demo)
      cancelHighlanderExtras()
      const runningAfterCancel = running !== null
      const lateStatuses: string[] = []
      const watchLate = useInstance.subscribe(s => lateStatuses.push(s.extrasStatus))
      // a wall-clock wait in a debug probe: long enough for the cancelled worker to have finished its parse
      await new Promise(resolve => setTimeout(resolve, waitMs))
      watchLate()
      out.cancel = { runningAfterCancel, statusAfterWait: useInstance.getState().extrasStatus, lateStatuses }
    }
    const first = fetchBuffer().then(buffer => startHighlanderExtras(buffer, demo))
    if (mode === 'double') {
      await first
      void startHighlanderExtras(await fetchBuffer(), demo) // cancels the first parse, which is still running
    }
    out.final = await settle()
  } finally {
    unsubscribe()
  }
  const after = useInstance.getState().extras
  return jsonSafe({ ...out, statuses, replaced: before !== after, alignment: lastAlignment, timing: lastTiming })
})
