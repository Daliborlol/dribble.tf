// The `maps` stage of the asset pack builder (asset contract 2.5 and 9 "M3-props"): stock static props.
//
// For each selected bsp-to-glb folder it reads the map's BSP from --bsp-dir, runs the two bsp-to-glb passes
// scripts/convert-bsp.mjs runs for its props pass (entities + PAK, then the render export with --props-out,
// same flags, outputs in this stage's scratch dir), and calls convertStaticProps (scripts/lib/static-props.mjs)
// with the VPK set as its stock source, which makes the output stock-only. The result is maps/<folder>/props-stock.glb: every
// prop_static whose model is not in the BSP's PAK (plus unnamed, unparented, non-animated prop_dynamic
// entities with stock models), drawn like the PAK props of public props.glb: flat albedo (VTF reflectivity) x
// VRAD's per-vertex lighting from the PAK's sp[_hdr]_<n>.vhv, in the world lightmap's exposure. Lighting
// scale and sun direction come from the public conversion.json, which convert-bsp.mjs wrote from the same
// values. Nothing is written under public/.
//
// Manifest: maps.<folder> = { mapName, bspSha256, bspBytes, publicProps, files: { propsStock }, sizes, stats }.
// `stats` holds counts only (no timings, so equal inputs give an equal manifest); the full report with
// timings and warnings goes to reports/maps/<folder>.json, which the runtime never reads.
//
// Incremental: a folder whose input key (VPK fingerprint, generator version, BSP sha256, the public
// conversion.json values used, the hash of CONVERTER_SOURCES and the bsp-to-glb version) equals the one
// recorded in its previous entry, and whose file is still in the pack, keeps its entry.
//
// Options (--set): propsMeshopt=false (quantization only), propsBakeVertexBudget=<n>, propsKeepTmp=true.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { convertStaticProps } from '../../lib/static-props.mjs'
import { findBspToGlb, bspToGlbVersion } from '../lib/model-export.mjs'
import { sha256File } from '../lib/fsutil.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Every source file whose code decides the bytes of props-stock.glb, in a fixed order: this stage, the
// converter and the A0-pack libraries that stock mode reads VPKs, VMTs and VTFs through. A change to any
// of them changes the input key, so incremental builds never keep a file an older converter wrote.
const CONVERTER_SOURCES = [
  path.resolve(HERE, 'stage.mjs'),
  path.resolve(HERE, '..', '..', 'lib', 'static-props.mjs'),
  path.resolve(HERE, '..', 'lib', 'vmt.mjs'),
  path.resolve(HERE, '..', 'lib', 'vpk.mjs'),
  path.resolve(HERE, '..', 'lib', 'vtf.mjs'),
  path.resolve(HERE, '..', 'lib', 'model-export.mjs'),
  path.resolve(HERE, '..', 'lib', 'fsutil.mjs'),
]

function sourcesHash(files) {
  const hash = crypto.createHash('sha256')
  for (const file of files) {
    const bytes = fs.readFileSync(file)
    hash.update(`${path.basename(file)}\0${bytes.length}\0`).update(bytes)
  }
  return hash.digest('hex')
}

function runTool(binary, argv, label) {
  const result = spawnSync(binary, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${(result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' / ')}`)
  return result.stdout
}

/** Worldspawn bounds and the initially-on light styles, as scripts/convert-bsp.mjs derives them. */
function readEntities(file) {
  const graph = JSON.parse(fs.readFileSync(file, 'utf8'))
  const entities = graph.entities.map(entity => {
    const kv = {}
    for (const { key, value } of entity.keyValues) {
      const lower = key.toLowerCase()
      if (!(lower in kv)) kv[lower] = value
    }
    return { ...entity, kv }
  })
  const worldspawn = entities.find(entity => entity.classname === 'worldspawn')
  const vec3 = value => {
    const parts = String(value ?? '').trim().split(/\s+/).map(Number)
    return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? parts.slice(0, 3) : null
  }
  const worldMins = vec3(worldspawn?.kv.world_mins)
  const worldMaxs = vec3(worldspawn?.kv.world_maxs)
  if (!worldMins || !worldMaxs) throw new Error('worldspawn lacks world_mins/world_maxs')
  const enabledStyles = new Set(Array.from({ length: 32 }, (_, i) => i))
  for (const entity of entities) {
    if (!/^light/.test(entity.classname ?? '') || entity.kv.style === undefined) continue
    const style = Number(entity.kv.style)
    if (!Number.isInteger(style) || style < 32) continue
    if ((Number(entity.kv.spawnflags || 0) & 1) === 0) enabledStyles.add(style)
  }
  return { worldMins, worldMaxs, styles: [...enabledStyles].sort((a, b) => a - b) }
}

/** The counts of a props-stock.glb conversion that go into the manifest (no timings, no paths). */
function manifestStats(result) {
  const s = result.stats
  return {
    instances: s.instances,
    staticInstances: s.staticInstances,
    dynamicInstances: s.dynamicInstances,
    pakInstances: s.pakInstances,
    missing: s.missing,
    skybox: s.skybox,
    skyboxStatic: s.skyboxStatic,
    unconvertible: s.unconvertible,
    models: s.models,
    excludedModels: s.excludedModels,
    nodes: s.nodes,
    bakedInstances: s.bakedInstances,
    vertices: s.vertices,
    triangles: s.triangles,
    renderedTriangles: s.renderedTriangles,
    winding: s.winding.agree,
    lighting: { vhv: s.lighting.exact, estimated: s.lighting.estimated, mismatched: s.lighting.mismatched, shared: s.lighting.shared },
    materials: { textured: s.materials.pak, neutral: s.materials.neutral },
  }
}

export async function run(ctx) {
  const set = ctx.options.set ?? {}
  const bspToGlb = findBspToGlb(ctx.options.bspToGlb ?? undefined)
  const vtfToPngPath = path.join(path.dirname(bspToGlb), 'vtf-to-png')
  const vtfToPng = fs.existsSync(vtfToPngPath) ? vtfToPngPath : null
  const toolVersion = bspToGlbVersion(bspToGlb)
  const converterHash = sourcesHash(CONVERTER_SOURCES)
  const options = {
    meshopt: set.propsMeshopt !== false,
    ...(Number.isFinite(set.propsBakeVertexBudget) ? { bakeVertexBudget: set.propsBakeVertexBudget } : {}),
  }
  ctx.setOptions({ propsStock: options })

  const report = { maps: {}, built: [], kept: [], skipped: [] }
  for (const folder of ctx.options.maps) {
    const info = ctx.publicMapInfo(folder)
    if (info.pipeline !== 'bsp-to-glb') throw new Error(`${folder}: not a bsp-to-glb folder`)
    const bspPath = path.join(ctx.options.bspDir, `${info.mapName}.bsp`)
    if (!fs.existsSync(bspPath)) {
      ctx.log(`${folder}: ${bspPath} missing; no stock props for this map`)
      ctx.removeMap(folder)
      report.skipped.push({ folder, reason: 'bsp missing' })
      continue
    }
    const bspSha256 = sha256File(bspPath)
    const conversion = info.conversion
    const lighting = { set: conversion.lightmap?.set ?? 'hdr', exposure: conversion.lightmap?.exposure ?? 1, floor: conversion.lightmap?.floor ?? 0 }
    const sunDirection = conversion.lightEnvironment?.direction ?? null
    const file = `maps/${folder}/props-stock.glb`
    const inputKey = ctx.inputKey({ folder, bspSha256, mapName: info.mapName, publicProps: info.props, lighting, sunDirection, options, converterHash, toolVersion })

    const previous = ctx.manifest.maps[folder]
    if (!ctx.options.force && previous?.stats?.inputKey === inputKey && ctx.hasPackFile(file)) {
      ctx.log(`${folder}: unchanged, kept`)
      report.kept.push(folder)
      continue
    }

    const started = performance.now()
    const tmp = path.join(ctx.tmp, folder)
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    // Pass 1: entity graph + PAK. Pass 2: the render export with --props-out, convert-bsp.mjs's flags.
    runTool(bspToGlb, ['--bsp', bspPath, '--entities-out', path.join(tmp, 'entities.json'), '--pak-output', path.join(tmp, 'pak'), '--pak-manifest', path.join(tmp, 'pak.json')], `${folder}: entities + PAK`)
    const { worldMins, worldMaxs, styles } = readEntities(path.join(tmp, 'entities.json'))
    runTool(bspToGlb, [
      '--bsp', bspPath,
      '--out', path.join(tmp, 'raw.glb'),
      '--lightmap-set', 'auto',
      '--lightmap-styles', styles.join(','),
      '--allow-unresolved-patch-includes', 'true',
      '--lightmap-atlas', path.join(tmp, 'lightmap-rgbe.png'),
      '--lightmap-manifest', path.join(tmp, 'lightmaps.json'),
      '--visibility-out', path.join(tmp, 'visibility.json'),
      '--material-manifest', path.join(tmp, 'materials.json'),
      '--props-out', path.join(tmp, 'props.json'),
    ], `${folder}: render export`)
    const exportMs = Math.round(performance.now() - started)

    const result = await convertStaticProps({
      bspToGlb,
      vtfToPng,
      pakDir: path.join(tmp, 'pak'),
      props: JSON.parse(fs.readFileSync(path.join(tmp, 'props.json'), 'utf8')),
      workDir: path.join(tmp, 'props'),
      outPath: ctx.stagePath(file),
      worldMins,
      worldMaxs,
      lighting,
      sunDirection,
      meshopt: options.meshopt,
      ...(options.bakeVertexBudget !== undefined ? { bakeVertexBudget: options.bakeVertexBudget } : {}),
      stockSource: ctx.vpk,
      log: message => ctx.log(`${folder}:${message}`),
    })
    if (!set.propsKeepTmp) fs.rmSync(tmp, { recursive: true, force: true })
    const ms = Math.round(performance.now() - started)
    if (!result.file) {
      ctx.log(`${folder}: no stock props`)
      ctx.removeMap(folder)
      report.skipped.push({ folder, reason: 'no stock props' })
      continue
    }
    ctx.setMap(folder, {
      mapName: info.mapName,
      bspSha256,
      bspBytes: fs.statSync(bspPath).size,
      publicProps: info.props,
      files: { propsStock: file },
      stats: { inputKey, ...manifestStats(result) },
    })
    const mapReport = { folder, mapName: info.mapName, ms, exportMs, propsMs: result.stats.ms, bytes: result.stats.bytes, props: result.props, stats: result.stats }
    ctx.writeFile(`reports/maps/${folder}.json`, `${JSON.stringify(mapReport, null, 2)}\n`)
    report.maps[folder] = { ms, bytes: result.stats.bytes, instances: result.stats.instances, models: result.stats.models, excluded: result.stats.excludedModels.length, renderedTriangles: result.stats.renderedTriangles }
    report.built.push(folder)
    ctx.log(`${folder}: props-stock.glb ${(result.stats.bytes / 1048576).toFixed(2)} MB, ${result.stats.instances} instances of ${result.stats.models} models` +
      `${result.stats.excludedModels.length ? `, ${result.stats.excludedModels.length} models excluded (winding)` : ''}, ${result.stats.missing} missing, ${(ms / 1000).toFixed(1)} s`)
  }
  return report
}
