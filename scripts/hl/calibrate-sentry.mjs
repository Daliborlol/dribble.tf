#!/usr/bin/env node
// Sentry aim calibration (contract section 5 F2).
//
//   flock $S/heavy.lock node scripts/hl/calibrate-sentry.mjs <demo.dem> [<demo.dem> ...] [--out report.json] [--write]
//
// For every tick at which a sentry is attacking a player (state.objState 2, enemy.kind 1, not building, carried,
// upgrading, redeploying or wrangled), it takes the direction from the sentry pivot (origin + pivot height: L1 32,
// L2 40, L3 46, mini 24) to the enemy's base position + 41 (WorldSpaceCenter, the point
// CObjectSentrygun::GetEnemyAimPosition aims at), converts it to a yaw relative to the build yaw and a Source
// pitch (positive down, clamped to the turret's +/-50), and fits the networked pose parameters
// (`buildings.pose.yaw` = round(m_flPoseParameter[1] x 255), `.pitch` = element 0) to it:
//
//   relYaw = YAW_SIGN * (pose.yaw / 255 * YAW_RANGE - YAW_RANGE / 2) + YAW_OFFSET
//   pitch  = PITCH_SIGN * (pose.pitch / 255 * PITCH_RANGE - PITCH_RANGE / 2) + PITCH_OFFSET
//
// Yaw wraps, so the fit is circular: for each sign and range on a grid, the offset is the circular mean of the
// residuals, and the pair with the least sum of squared wrapped residuals wins (R^2 against the circular variance
// of the targets). Pitch is an ordinary least-squares line. The fit uses the firing samples (see below); pass
// --fit-on state to fit on every attacking sample instead.
//
// It then prints how often the drawn barrel lies within 15 degrees of the enemy centre (contract F2 acceptance). The
// barrel is scored exactly as the layer draws it: sentryAim.poseAimAt, the pose entry in effect interpolated toward
// the next one, with the fitted constants (and with the constants in src/highlander/buildings/sentryAim.ts). The
// figure is printed for the contract's sample set (every state sample with objState 2 and enemy.kind 1), for the
// set without building, carried, upgrading, redeploying and wrangled entries (a wrangled turret follows the
// engineer's laser, not its enemy), without the acquisition tick, and for the firing samples. The raw pose entry
// (no interpolation) is kept as `rawPose` for reference. With --write it rewrites the calibration block of
// sentryAim.ts.
//
// Base positions come from the committed base parser (src/libs/parser2) in a child process (this file with
// --child), exactly as scripts/hl/base-values.mjs reads them (same boundary override shift), because parser2's wasm
// heap never shrinks. The extras run in this process from src/libs/hlextras and are hydrated with the real
// src/highlander/extras/hydrate.ts, so both sit in the same scene space.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { importBundled, parseArgs, REPO_ROOT } from './lib/bundle.mjs'

const SELF = fileURLToPath(import.meta.url)
const { positional, flags } = parseArgs(process.argv.slice(2), ['child', 'write', 'quiet'])

const POSITION_FIXED_SCALE = 32 // PositionEncoding.ts default when the result has no positionScale

// ─── child: base parser positions ──────────────────────────────────────────────

if (flags.child) {
  const demoPath = positional[0]
  const parserDir = path.join(REPO_ROOT, 'src/libs/parser2')
  const parser = await import(pathToFileURL(path.join(parserDir, 'parser2.js')).href)
  parser.initSync({ module: fs.readFileSync(parserDir + '/parser2_bg.wasm') })
  const { getMapBoundaries } = await importBundled('src/components/Analyse/MapBoundaries.ts')
  const result = parser.parse_demo_cache(new Uint8Array(fs.readFileSync(demoPath)))
  if (typeof result === 'string' || !result) {
    console.error(`base parse failed: ${result}`)
    process.exit(1)
  }
  const { header, ticks, intervalPerTick, world, players, playerCache } = result
  const positionScale = Number.isFinite(result.positionScale) && result.positionScale > 0 ? result.positionScale : POSITION_FIXED_SCALE
  // ParseWorker.ts: shift positions from the demo's boundaryMin to the override's, in fixed-point units
  let deltaFixed = [0, 0, 0]
  const sceneOrigin = { ...world.boundaryMin }
  const override = getMapBoundaries(header.map)
  if (override) {
    const delta = ['x', 'y', 'z'].map(a => Math.trunc(world.boundaryMin[a] - override.boundaryMin[a]))
    deltaFixed = delta.map(d => Math.trunc(d * positionScale))
    Object.assign(sceneOrigin, override.boundaryMin)
  }
  let nextMappedPlayer = 0
  const ids = new Map()
  for (const pl of players) {
    ids.set(pl.id, pl.entityId)
    if (pl.id + 1 > nextMappedPlayer) nextMappedPlayer = pl.id + 1
  }
  const playerEntityIds = Array.from({ length: nextMappedPlayer }, (_, p) => ids.get(p) ?? 0)
  // positions[p][tick][axis], scene units, NaN where the base has no position (0, 0, 0)
  const positions = new Float32Array(nextMappedPlayer * ticks * 3).fill(NaN)
  for (let p = 0; p < nextMappedPlayer; p++) {
    const arr = playerCache.position[p]
    if (!arr) continue
    for (let t = 0; t < ticks; t++) {
      const o = t * 3
      let x = arr[o], y = arr[o + 1], z = arr[o + 2]
      if (x === undefined || (x | y | z) === 0) continue
      x = (x + deltaFixed[0]) >>> 0
      y = (y + deltaFixed[1]) >>> 0
      z = (z + deltaFixed[2]) >>> 0
      const at = (p * ticks + t) * 3
      positions[at] = (x | 0) / positionScale
      positions[at + 1] = (y | 0) / positionScale
      positions[at + 2] = (z | 0) / positionScale
    }
  }
  const out = {
    map: header.map,
    startTick: result.startTick ?? 0,
    tickBase: result.tickBase ?? 0,
    ticks,
    intervalPerTick,
    playerEntityIds,
    playerNames: Array.from({ length: nextMappedPlayer }, (_, p) => players.find(pl => pl.id === p)?.name ?? ''),
    sceneOrigin,
    positions: Buffer.from(positions.buffer).toString('base64'),
  }
  process.stdout.write(JSON.stringify(out), () => process.exit(0))
} else {
  await main()
}

// ─── parent ───────────────────────────────────────────────────────────────────

async function main() {
  if (positional.length === 0) {
    console.error('usage: node scripts/hl/calibrate-sentry.mjs <demo.dem> [<demo.dem> ...] [--out report.json] [--write]')
    process.exit(2)
  }
  const log = (...a) => flags.quiet || console.error(...a)
  // The real src/highlander code, bundled with esbuild (scripts/hl/lib/bundle.mjs maps `three` to its shim)
  const { hydrate } = await importBundled('scripts/hl/lib/hydrate-entry.mjs')
  const { BLD, ENEMY, SENTRY_STATE } = await importBundled('src/highlander/extras/enums.ts')
  const { trackIndexAt } = await importBundled('src/highlander/extras/track.ts')
  const aim = await importBundled('src/highlander/buildings/sentryAim.ts')
  const lib = { trackIndexAt }

  const pkgDir = path.join(REPO_ROOT, 'src/libs/hlextras')
  const wasmMod = await import(pathToFileURL(path.join(pkgDir, 'hlextras.js')).href)
  const wasm = wasmMod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'hlextras_bg.wasm')) })
  const ITEMS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/constants/items.json'), 'utf8'))
  const wearableDefs = Object.keys(ITEMS).filter(k => ITEMS[k].c.startsWith('tf_wearable')).map(Number).sort((a, b) => a - b)

  const contractSamples = [] // every attacking state sample: { demo, instance, tick, enemy, firing, skip, poseYaw, posePitch, relYaw, pitch, dir, buildYaw, ... }
  const tickSamples = [] // every attacking tick outside the skipped states (diagnostics)
  const perDemo = []
  const extrasOf = new Map() // demo -> hydrated extras, so the drawn aim can be scored after the fit
  const SKIP = BLD.BUILDING | BLD.DORMANT | BLD.UPGRADING | BLD.CARRY_DEPLOY | BLD.WRANGLED

  for (const demoPath of positional) {
    const demo = path.basename(demoPath, '.dem')
    log(`[calibrate] ${demo}: base positions (parser2 child)`)
    const child = spawnSync(process.execPath, [SELF, '--child', demoPath], { maxBuffer: 1024 * 1024 * 1024, encoding: 'utf8' })
    if (child.status !== 0) {
      console.error(child.stderr)
      process.exit(1)
    }
    const base = JSON.parse(child.stdout)
    const posBytes = Buffer.from(base.positions, 'base64')
    const positions = new Float32Array(posBytes.buffer, posBytes.byteOffset, posBytes.byteLength / 4)
    const baseTicks = base.ticks

    log(`[calibrate] ${demo}: extras`)
    const options = {
      startTick: base.startTick,
      tickBase: base.tickBase,
      ticks: base.ticks,
      intervalPerTick: base.intervalPerTick,
      playerEntityIds: base.playerEntityIds,
      wearableDefs,
      groups: ['players', 'buildings'],
    }
    let raw
    {
      const bytes = fs.readFileSync(demoPath)
      const input = new wasmMod.ExtrasInput(bytes.length)
      new Uint8Array(wasm.memory.buffer, input.ptr(), bytes.length).set(bytes)
      raw = wasmMod.parse_demo_extras_input(input, options, () => {})
    }
    if (typeof raw === 'string' || !raw) {
      console.error(`[calibrate] extras parse failed: ${raw}`)
      process.exit(1)
    }
    const x = hydrate(raw, base.sceneOrigin)
    extrasOf.set(demo, x)
    const b = x.buildings
    const st = b.state
    let demoSamples = 0
    let demoContractSamples = 0
    let sentries = 0
    const kinds = {}
    for (let j = 0; j < b.count; j++) {
      if (b.type[j] !== 2 || b.mapPlaced[j]) continue
      sentries++
      const end = Math.min(b.deleted[j] === 0xffffffff ? x.meta.ticks : b.deleted[j], x.meta.ticks)
      for (let i = b.enemy.offsets[j]; i < b.enemy.offsets[j + 1]; i++) kinds[b.enemy.kind[i]] = (kinds[b.enemy.kind[i]] ?? 0) + 1
      /**
       * The sample at `tick` (state entry `si`), or null when the sentry is not attacking a player there. `skip`
       * marks the building, carried, upgrading, redeploying and wrangled entries.
       */
      const sampleAt = (tick, si, firing) => {
        if (si < 0 || st.objState[si] !== SENTRY_STATE.ATTACKING) return null
        const skip = (st.flags[si] & SKIP) !== 0
        const ei = lib.trackIndexAt(b.enemy, j, tick)
        if (ei < 0 || b.enemy.kind[ei] !== ENEMY.PLAYER) return null
        const p = b.enemy.index[ei]
        const pi = lib.trackIndexAt(b.pose, j, tick)
        const xi = lib.trackIndexAt(b.xform, j, tick)
        if (pi < 0 || xi < 0 || p >= base.playerEntityIds.length || tick >= baseTicks) return null
        const at = (p * baseTicks + tick) * 3
        if (Number.isNaN(positions[at])) return null
        const pivot = aim.sentryPivotHeight(st.level[si], b.mini[j] !== 0)
        const ox = b.xform.x[xi], oy = b.xform.y[xi], oz = b.xform.z[xi] + pivot
        const dx = positions[at] - ox, dy = positions[at + 1] - oy, dz = positions[at + 2] + aim.ENEMY_AIM_HEIGHT - oz
        const len = Math.hypot(dx, dy, dz)
        if (len < 1) return null
        const buildYaw = aim.yawOfQuat(b.xform.qx[xi], b.xform.qy[xi], b.xform.qz[xi], b.xform.qw[xi])
        const targetYaw = (Math.atan2(dy, dx) * 180) / Math.PI
        const targetPitch = Math.max(-50, Math.min(50, (-Math.asin(dz / len) * 180) / Math.PI))
        return {
          demo,
          instance: j,
          tick,
          enemy: p,
          firing,
          skip,
          since: tick - b.enemy.ticks[ei], // ticks since this enemy entry started (turret slew after acquisition)
          poseYaw: b.pose.yaw[pi] / 255,
          posePitch: b.pose.pitch[pi] / 255,
          poseAge: tick - b.pose.ticks[pi],
          relYaw: wrap180(targetYaw - buildYaw),
          pitch: targetPitch,
          dist: len,
          dir: [dx / len, dy / len, dz / len],
          buildYaw,
        }
      }
      // The fit uses the `state` samples (entries) of the contract. While attacking, a sentry pushes a state entry
      // mostly when it fires (its shells or rockets drop), and it fires only when its turret is within 10 degrees of
      // the goal (CObjectSentrygun::Attack), so these samples measure the pose mapping rather than the turret's slew
      // after it acquires a target.
      for (let si = st.offsets[j]; si < st.offsets[j + 1]; si++) {
        const firing = si > st.offsets[j] && (st.shells[si] < st.shells[si - 1] || st.rockets[si] < st.rockets[si - 1])
        const s = sampleAt(st.ticks[si], si, firing)
        if (s) {
          contractSamples.push(s)
          demoContractSamples++
          if (!s.skip) demoSamples++
        }
      }
      // Every attacking tick, for the diagnostics (includes the slew after each acquisition)
      for (let tick = b.created[j]; tick < end; tick++) {
        const s = sampleAt(tick, lib.trackIndexAt(st, j, tick), false)
        if (s && !s.skip) tickSamples.push(s)
      }
    }
    perDemo.push({ demo, map: base.map, sentries, samples: demoSamples, contractSamples: demoContractSamples, enemyKinds: kinds })
    log(`[calibrate] ${demo}: ${sentries} sentries, ${demoSamples} attacking samples (${demoContractSamples} with wrangled entries), enemy kinds ${JSON.stringify(kinds)}`)
  }

  // the calibration set: attacking samples outside the building, carried, upgrading, redeploying and wrangled states
  const samples = contractSamples.filter(s => !s.skip)
  if (samples.length === 0) {
    console.error('[calibrate] no attacking samples')
    process.exit(1)
  }

  const firing = samples.filter(s => s.firing)
  const fitSet = flags['fit-on'] === 'state' ? samples : firing
  if (fitSet.length < 20) {
    console.error(`[calibrate] only ${fitSet.length} samples to fit`)
    process.exit(1)
  }
  const fitOf = set => {
    // yaw: circular fit over sign and range, offset = circular mean of the residuals
    const targetMean = circularMean(set.map(s => s.relYaw))
    const ssTotYaw = set.reduce((a, s) => a + wrap180(s.relYaw - targetMean) ** 2, 0)
    let bestYaw = null
    const tryYaw = (sign, range) => {
      const residuals = set.map(s => wrap180(s.relYaw - sign * (s.poseYaw * range - range / 2)))
      const offset = circularMean(residuals)
      const ss = residuals.reduce((a, r) => a + wrap180(r - offset) ** 2, 0)
      if (!bestYaw || ss < bestYaw.ss) bestYaw = { sign, range, offset, ss }
    }
    for (const sign of [-1, 1]) for (let range = 180; range <= 720; range += 1) tryYaw(sign, range)
    for (let range = bestYaw.range - 1; range <= bestYaw.range + 1; range += 0.1) tryYaw(bestYaw.sign, range)
    // pitch: least squares pitch = a * pose + c  (a = sign * range, c = -a / 2 + offset)
    const n = set.length
    const mx = set.reduce((a, s) => a + s.posePitch, 0) / n
    const my = set.reduce((a, s) => a + s.pitch, 0) / n
    let sxy = 0, sxx = 0, syy = 0
    for (const s of set) {
      sxy += (s.posePitch - mx) * (s.pitch - my)
      sxx += (s.posePitch - mx) ** 2
      syy += (s.pitch - my) ** 2
    }
    const slope = sxy / sxx
    const intercept = my - slope * mx
    const pitchSign = slope < 0 ? -1 : 1
    const pitchRange = Math.abs(slope)
    const ssResPitch = set.reduce((a, s) => a + (s.pitch - (slope * s.posePitch + intercept)) ** 2, 0)
    return {
      constants: {
        YAW_RANGE: round(bestYaw.range, 1),
        YAW_SIGN: bestYaw.sign,
        YAW_OFFSET: round(bestYaw.offset, 2),
        PITCH_RANGE: round(pitchRange, 1),
        PITCH_SIGN: pitchSign,
        PITCH_OFFSET: round(intercept + (pitchSign * pitchRange) / 2, 2),
      },
      r2: { yaw: round(1 - bestYaw.ss / ssTotYaw, 4), pitch: round(1 - ssResPitch / syy, 4) },
      rmsDeg: { yaw: round(Math.sqrt(bestYaw.ss / n), 2), pitch: round(Math.sqrt(ssResPitch / n), 2) },
    }
  }
  const fit = fitOf(fitSet)
  const fitted = fit.constants
  const r2Yaw = fit.r2.yaw, r2Pitch = fit.r2.pitch

  // ── accuracy: barrel direction against the enemy centre. 'drawn' scores the aim the layer draws at the sample's
  // tick (sentryAim.poseAimAt: the pose entry in effect, interpolated toward the next one); 'raw' the pose entry
  // in effect alone.
  const within = (constants, set = samples, mode = 'drawn') => {
    let hit = 0
    const errors = []
    for (const s of set) {
      let relYaw, pitch
      if (mode === 'drawn') {
        const drawn = aim.poseAimAt(extrasOf.get(s.demo), s.instance, s.tick, constants)
        if (!drawn) continue
        relYaw = drawn.relYaw
        pitch = drawn.pitch
      } else {
        relYaw = constants.YAW_SIGN * (s.poseYaw * constants.YAW_RANGE - constants.YAW_RANGE / 2) + (constants.YAW_OFFSET ?? 0)
        pitch = constants.PITCH_SIGN * (s.posePitch * constants.PITCH_RANGE - constants.PITCH_RANGE / 2) + (constants.PITCH_OFFSET ?? 0)
      }
      const yaw = ((s.buildYaw + relYaw) * Math.PI) / 180
      const pr = (pitch * Math.PI) / 180
      const bx = Math.cos(pr) * Math.cos(yaw), by = Math.cos(pr) * Math.sin(yaw), bz = -Math.sin(pr)
      const dot = Math.max(-1, Math.min(1, bx * s.dir[0] + by * s.dir[1] + bz * s.dir[2]))
      const err = (Math.acos(dot) * 180) / Math.PI
      errors.push(err)
      if (err <= 15) hit++
    }
    errors.sort((a, b) => a - b)
    if (errors.length === 0) return { samples: 0 }
    return { samples: errors.length, within15: round(hit / errors.length, 4), medianDeg: round(errors[errors.length >> 1], 2), p90Deg: round(errors[Math.floor(errors.length * 0.9)], 2) }
  }
  const current = {
    YAW_RANGE: aim.YAW_RANGE, YAW_SIGN: aim.YAW_SIGN, YAW_OFFSET: aim.YAW_OFFSET,
    PITCH_RANGE: aim.PITCH_RANGE, PITCH_SIGN: aim.PITCH_SIGN, PITCH_OFFSET: aim.PITCH_OFFSET,
  }
  const contractDefaults = { YAW_RANGE: 360, YAW_SIGN: -1, YAW_OFFSET: 0, PITCH_RANGE: 100, PITCH_SIGN: -1, PITCH_OFFSET: 0 }
  // diagnostics over every attacking tick, bucketed by ticks since the enemy was acquired (turret slew)
  const slew = {}
  for (const [name, lo, hi] of [['0-9', 0, 10], ['10-32', 10, 33], ['33-65', 33, 66], ['66+', 66, Infinity]]) {
    slew[name] = within(fitted, tickSamples.filter(s => s.since >= lo && s.since < hi))
  }
  const noAcquisition = samples.filter(s => s.firing || s.since > 0)
  const report = {
    demos: perDemo,
    samples: samples.length,
    contractSamples: contractSamples.length,
    firingSamples: firing.length,
    fitOn: fitSet === firing ? 'firing' : 'state',
    fitted,
    r2: fit.r2,
    rmsDeg: fit.rmsDeg,
    fitOnEveryStateSample: fitOf(samples),
    // Contract F2 acceptance (at least 80 %): the drawn barrel within 15 degrees of the enemy centre
    acceptance: {
      metric: 'drawn barrel (sentryAim.poseAimAt, the interpolated pose the layer draws) within 15 deg of the enemy base position + 41, at each attacking state sample',
      contractSamples: within(fitted, contractSamples),
      withoutSkippedStates: within(fitted, samples),
      withoutAcquisitionTick: within(fitted, noAcquisition),
      firingSamples: within(fitted, firing),
      currentFile: { contractSamples: within(current, contractSamples), withoutSkippedStates: within(current, samples) },
      contractDefaults: { contractSamples: within(contractDefaults, contractSamples), withoutSkippedStates: within(contractDefaults, samples) },
    },
    // the same figures from the raw pose entry in effect (no interpolation), as the earlier runs printed them
    rawPose: {
      contractSamples: within(fitted, contractSamples, 'raw'),
      withoutSkippedStates: within(fitted, samples, 'raw'),
      withoutAcquisitionTick: within(fitted, noAcquisition, 'raw'),
      firingSamples: within(fitted, firing, 'raw'),
    },
    // Why attacking state samples miss: a sentry pushes a state entry when it acquires or switches targets (its
    // m_iState or m_hEnemy changes), CObjectSentrygun::FoundTarget sets the enemy, and the turret starts to turn on
    // a later think (MoveTurret) and needs up to about half a second to reach the new enemy. The pose shows that
    // slew truthfully, so those samples are off target by design; the firing samples (the turret is within 10
    // degrees of its goal, CObjectSentrygun::Attack) measure the mapping itself. Drawn aim.
    accuracyByKind: {
      firing: within(fitted, firing),
      acquisitionTick: within(fitted, samples.filter(s => !s.firing && s.since === 0)),
      slewWindow1to32: within(fitted, samples.filter(s => !s.firing && s.since > 0 && s.since < 33)),
      other: within(fitted, samples.filter(s => !s.firing && s.since >= 33)),
      wrangled: within(fitted, contractSamples.filter(s => s.skip)),
    },
    everyAttackingTick: { all: within(fitted, tickSamples), bySinceAcquired: slew },
    aimAtEnemy: r2Yaw < 0.9 || r2Pitch < 0.9,
  }
  const json = JSON.stringify(report, null, 2)
  if (flags.out) fs.writeFileSync(flags.out, json)
  if (flags.dump) fs.writeFileSync(flags.dump, samples.map(s => JSON.stringify(s)).join('\n'))
  console.log(json)

  if (flags.write) {
    const file = path.join(REPO_ROOT, 'src/highlander/buildings/sentryAim.ts')
    const src = fs.readFileSync(file, 'utf8')
    const acc = report.acceptance
    const block = [
      '// <calibration> (written by scripts/hl/calibrate-sentry.mjs --write)',
      `// demos: ${perDemo.map(d => `${d.demo} (${d.map}, ${d.sentries} sentries, ${d.samples} samples)`).join(', ')}`,
      `// fit on ${report.fitOn} samples: ${fitSet.length} of ${samples.length} attacking state samples; R^2 yaw ${report.r2.yaw}, pitch ${report.r2.pitch}; rms yaw ${report.rmsDeg.yaw} deg, pitch ${report.rmsDeg.pitch} deg`,
      `// drawn barrel within 15 deg of the enemy centre: ${pct(acc.withoutSkippedStates.within15)} of the ${acc.withoutSkippedStates.samples} attacking samples (median ${acc.withoutSkippedStates.medianDeg} deg, p90 ${acc.withoutSkippedStates.p90Deg} deg), ${pct(acc.contractSamples.within15)} of all ${acc.contractSamples.samples} with the wrangled ones, ${pct(acc.firingSamples.within15)} of the ${acc.firingSamples.samples} firing samples`,
      `// misses are turret slew: ${report.accuracyByKind.acquisitionTick.samples} samples sit on the tick a target is acquired (${pct(report.accuracyByKind.acquisitionTick.within15)} within), ${report.accuracyByKind.slewWindow1to32.samples} in the 32 ticks after it (${pct(report.accuracyByKind.slewWindow1to32.within15)}); without the acquisition tick ${pct(acc.withoutAcquisitionTick.within15)} of ${acc.withoutAcquisitionTick.samples}`,
      `export const YAW_RANGE = ${fitted.YAW_RANGE}`,
      `export const YAW_SIGN = ${fitted.YAW_SIGN}`,
      `export const YAW_OFFSET = ${fitted.YAW_OFFSET}`,
      `export const PITCH_RANGE = ${fitted.PITCH_RANGE}`,
      `export const PITCH_SIGN = ${fitted.PITCH_SIGN}`,
      `export const PITCH_OFFSET = ${fitted.PITCH_OFFSET}`,
      `export const AIM_AT_ENEMY = ${report.aimAtEnemy}`,
      '// </calibration>',
    ].join('\n')
    const next = src.replace(/\/\/ <calibration>[\s\S]*?\/\/ <\/calibration>/, block)
    if (next === src && !src.includes(block)) {
      console.error('[calibrate] calibration markers not found in sentryAim.ts')
      process.exit(1)
    }
    fs.writeFileSync(file, next)
    log(`[calibrate] wrote ${path.relative(REPO_ROOT, file)}`)
  }
}

function wrap180(a) {
  let v = ((a + 180) % 360 + 360) % 360 - 180
  if (v === -180) v = 180
  return v
}

function circularMean(degrees) {
  let sx = 0, sy = 0
  for (const d of degrees) {
    sx += Math.cos((d * Math.PI) / 180)
    sy += Math.sin((d * Math.PI) / 180)
  }
  return (Math.atan2(sy, sx) * 180) / Math.PI
}

function pct(v) {
  return Number.isFinite(v) ? `${(v * 100).toFixed(1)} %` : 'n/a'
}

function round(v, digits) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}
