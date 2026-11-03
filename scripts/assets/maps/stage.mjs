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
// Textured world (asset contract 10 "M3-world" and 12.5): the same folder also gets maps/<folder>/world.glb,
// lightmap.webp and conversion.json from one scripts/convert-bsp.mjs run with --material-mount-plan (the VPK set)
// and --texture-uvs true, plus one texture item per base texture the world uses (textures/<key>.dds and/or
// .webp, scripts/assets/lib/texture-export.mjs). The entry gains files.{world, lightmap, conversion} and
// `textures` (the keys with an item). A key another map already wrote in this build is reused.
//
// Options (--set): propsMeshopt=false (quantization only), propsBakeVertexBudget=<n>, propsKeepTmp=true,
// mapTextures=false (no textured world), mapTextureMax=<px> (default 2048; larger top mips are dropped),
// mapWebp=false (no WebP fallback for DXT textures), mapWebpMax=<px> (default 512, the WebP fallback's largest
// edge), mapChunkGrid=<n> (default 1: one primitive per material for the whole world, fewest draw calls).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { convertStaticProps } from '../../lib/static-props.mjs'
import { findBspToGlb, bspToGlbVersion } from '../lib/model-export.mjs'
import { sha256File } from '../lib/fsutil.mjs'
import { exportVtf, textureGpuBytes } from '../lib/texture-export.mjs'

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
  path.resolve(HERE, '..', 'lib', 'texture-export.mjs'),
  path.resolve(HERE, '..', '..', 'convert-bsp.mjs'),
]
const CONVERT_BSP = path.resolve(HERE, '..', '..', 'convert-bsp.mjs')

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
    ...(s.lod ? { lod: s.lod } : {}),
    ...(s.textures !== undefined ? { textures: s.textures } : {}),
  }
}

/** Every file under `dir`, keyed by its lower-case relative path. */
function indexDir(dir) {
  const out = new Map()
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(abs, e.name), r)
      else out.set(r.toLowerCase(), path.join(abs, e.name))
    }
  }
  if (fs.existsSync(dir)) walk(dir, '')
  return out
}

/**
 * The textured world of one folder: runs convert-bsp.mjs into `tmp/world`, stages world.glb, lightmap and a
 * reduced conversion.json, and exports every texture it references. Returns { files, textures, stats, report }.
 */
const EXPORT_HASH = sourcesHash([path.resolve(HERE, '..', 'lib', 'texture-export.mjs'), path.resolve(HERE, '..', 'lib', 'vtf.mjs')])

/**
 * Exports every texture of `textureList` ({ key: { lookup, source: 'pak' | 'vpk', alpha, cutoff } }) as a texture
 * item, reusing items with the same input key. Returns { textures, stats, unsupported }.
 */
async function exportTextures(ctx, { folder, textureList, pakDir, options, written, reuseWritten = false, otherOptions = null }) {
  const exportHash = EXPORT_HASH
  const pak = indexDir(pakDir)
  const textures = []
  const unsupported = {}
  let writtenCount = 0, reused = 0, gpuBytes = 0
  for (const [key, t] of Object.entries(textureList)) {
    const vtf = t.source === 'pak' ? (pak.has(t.lookup) ? fs.readFileSync(pak.get(t.lookup)) : null) : ctx.vpk.read(t.lookup)
    if (!vtf) { unsupported[key] = 'not found'; continue }
    // Reuse an item this build (another map) or the previous one wrote from the same VTF bytes and options; its
    // `alpha` is the first map's VMT rule, and every world material carries its own (contract 12.3).
    const vtfSha = crypto.createHash('sha256').update(vtf).digest('hex')
    const keyFor = o => ctx.inputKey({ texture: key, vtf: vtfSha, options: { textureMax: o.textureMax, webp: o.webp, webpMax: o.webpMax }, exportHash })
    const itemKey = keyFor(options)
    const existing = ctx.manifest.items[key]
    const files = existing ? [existing.file, existing.webp].filter(Boolean) : []
    // An item an earlier build made from the same VTF under the other caps (world 2048 / props 512) stays, so a
    // build of some maps never re-exports a texture other maps' entries share (incremental `--maps <one>`).
    const otherKey = otherOptions && existing?.kind === 'texture' && !written.has(key) ? keyFor(otherOptions) : null
    if (otherKey && existing.inputKey === otherKey && files.every(f => ctx.hasPackFile(f))) {
      textures.push(key)
      gpuBytes += textureGpuBytes(existing)
      reused++
      continue
    }
    // `reuseWritten` (props): a key the world of some map wrote in this build keeps the world's item.
    if (existing?.kind === 'texture' && ((reuseWritten && written.has(key)) || (existing.inputKey === itemKey && (written.has(key) || files.every(f => ctx.hasPackFile(f)))))) {
      textures.push(key)
      gpuBytes += textureGpuBytes(existing)
      reused++
      continue
    }
    const out = await exportVtf(vtf, { maxSize: options.textureMax, webpMaxSize: options.webpMax, webp: options.webp })
    if (out.unsupported) { unsupported[key] = out.unsupported; continue }
    const ddsFile = out.dds ? `textures/${key}.dds` : null
    const webpFile = out.webp ? `textures/${key}.webp` : null
    if (ddsFile) fs.writeFileSync(ctx.stagePath(ddsFile), out.dds)
    if (webpFile) fs.writeFileSync(ctx.stagePath(webpFile), out.webp)
    const main = out.dds ?? out.webp
    const item = {
      kind: 'texture',
      file: ddsFile ?? webpFile,
      inputKey: itemKey,
      webp: webpFile,
      bytes: main.length,
      sha256: crypto.createHash('sha256').update(main).digest('hex'),
      source: t.source === 'pak' ? `pak:${folder}` : 'vpk',
      srgb: out.info.srgb,
      oneBitAlpha: out.info.oneBitAlpha,
      alpha: t.alpha,
      alphaCutoff: t.cutoff,
      width: out.info.width,
      height: out.info.height,
      mips: out.info.mips,
      format: out.info.format,
      ...(out.info.frames > 1 ? { frames: out.info.frames } : {}),
      ...(webpFile && ddsFile ? { webpWidth: out.info.webpWidth, webpHeight: out.info.webpHeight } : {}),
    }
    ctx.addItem(key, item)
    // The WebP sidecar of a DDS item is listed as its own item `<key>@webp` too, because the builder lists,
    // verifies and prunes pack files by item.file only.
    if (ddsFile && webpFile) ctx.addItem(`${key}@webp`, { kind: 'texture', file: webpFile, bytes: out.webp.length, sha256: crypto.createHash('sha256').update(out.webp).digest('hex'), sidecarOf: key })
    textures.push(key)
    gpuBytes += textureGpuBytes(item)
    written.add(key)
    writtenCount++
  }
  return {
    textures,
    unsupported,
    stats: { textures: textures.length, texturesWritten: writtenCount, texturesReused: reused, texturesUnsupported: Object.keys(unsupported).length, textureGpuBytes: gpuBytes },
  }
}

async function buildTexturedWorld(ctx, { folder, bspPath, bspToGlb, tmp, pakDir, options, written, propOptions = null }) {
  const mounts = { schemaVersion: 1, mounts: ctx.vpk.vpks.map((v, i) => ({ id: `vpk${i}`, kind: 'vpk', path: v.file })) }
  const mountsPath = path.join(tmp, 'mounts.json')
  fs.writeFileSync(mountsPath, JSON.stringify(mounts))
  const outDir = path.join(tmp, 'world')
  const convTmp = path.join(tmp, 'world-tmp')
  fs.mkdirSync(convTmp, { recursive: true })
  const result = spawnSync(process.execPath, [
    CONVERT_BSP, '--bsp', bspPath, '--out-dir', outDir, '--skybox-dir', path.join(tmp, 'sky'), '--temp-dir', convTmp,
    '--props', 'false', '--bsp-to-glb', bspToGlb, '--chunk-grid', String(options.chunkGrid),
    '--material-mount-plan', mountsPath, '--texture-uvs', 'true', '--texture-pak-prefix', `pak/${folder}/`,
    '--overlays', String(options.overlays !== false),
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${folder}: textured world failed (${result.status}): ${(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' / ')}`)
  const conversion = JSON.parse(fs.readFileSync(path.join(outDir, 'conversion.json'), 'utf8'))
  const textureList = JSON.parse(fs.readFileSync(path.join(outDir, 'textures.json'), 'utf8'))
  const files = {
    world: `maps/${folder}/world.glb`,
    lightmap: `maps/${folder}/${conversion.files.lightmap}`,
    conversion: `maps/${folder}/conversion.json`,
  }
  fs.copyFileSync(path.join(outDir, 'world.glb'), ctx.stagePath(files.world))
  fs.copyFileSync(path.join(outDir, conversion.files.lightmap), ctx.stagePath(files.lightmap))
  // Only what World reads, without timestamps or timings, so equal inputs give equal bytes.
  const packConversion = {
    mapName: conversion.mapName,
    pipeline: conversion.pipeline,
    files: { model: 'world.glb', lightmap: conversion.files.lightmap },
    lightmap: conversion.lightmap,
    chunking: conversion.chunking,
    textures: conversion.textures,
    ...(conversion.overlays ? { overlays: conversion.overlays } : {}),
  }
  ctx.writeFile(files.conversion, `${JSON.stringify(packConversion, null, 1)}\n`)

  const exported = await exportTextures(ctx, { folder, textureList, pakDir, options, written, otherOptions: propOptions })
  return {
    files,
    textures: exported.textures,
    stats: { ...exported.stats, chunkGrid: options.chunkGrid, ...(conversion.overlays ? { overlays: conversion.overlays.drawn } : {}) },
    report: { unsupported: exported.unsupported, glbBytes: conversion.stats?.glbBytes ?? null },
    // The full converter output's lighting, for folders whose public conversion.json has none (PACK_WORLD_ONLY_MAPS).
    lighting: { set: conversion.lightmap?.set ?? 'hdr', exposure: conversion.lightmap?.exposure ?? 1, floor: conversion.lightmap?.floor ?? 0 },
    sunDirection: conversion.lightEnvironment?.direction ?? null,
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
    // M3-props2: textured props (UV0, skins, VMT alpha) with their own texture items, the far VTX LOD, and the
    // PAK props again as props-pak.glb with VPK materials. The texture caps follow contract 6.2 (stock props).
    textured: set.propsTextures !== false,
    lod: set.propsLod !== false,
    pak: set.propsPak !== false,
    textureMax: Number.isFinite(set.propsTextureMax) ? set.propsTextureMax : 512,
    webp: set.mapWebp !== false,
    webpMax: Number.isFinite(set.propsWebpMax) ? set.propsWebpMax : 256,
    sky: set.propsSky !== false,
  }
  const worldOptions = set.mapTextures === false ? null : {
    textureMax: Number.isFinite(set.mapTextureMax) ? set.mapTextureMax : 2048,
    webp: set.mapWebp !== false,
    webpMax: Number.isFinite(set.mapWebpMax) ? set.mapWebpMax : 512,
    chunkGrid: Number.isFinite(set.mapChunkGrid) ? set.mapChunkGrid : 1,
    // as/mapfx: info_overlay geometry in world.glb (convert-bsp.mjs --overlays), drawn with the pack textures.
    overlays: set.mapOverlays !== false,
  }
  ctx.setOptions({ propsStock: options, ...(worldOptions ? { world: worldOptions } : {}) })

  const report = { maps: {}, built: [], kept: [], skipped: [] }
  const written = new Set() // texture keys this run wrote
  for (const folder of ctx.options.maps) {
    const info = ctx.publicMapInfo(folder)
    // PACK_WORLD_ONLY_MAPS (koth_product_final): the public folder keeps an older textured GLB; the pack entry
    // brings the bsp-to-glb world, so the world comes first and lights the props.
    const worldOnly = info.worldOnly === true
    if (info.pipeline !== 'bsp-to-glb' && !worldOnly) throw new Error(`${folder}: not a bsp-to-glb folder`)
    if (worldOnly && !worldOptions) {
      ctx.log(`${folder}: needs the textured world (mapTextures); not built`)
      ctx.removeMap(folder)
      report.skipped.push({ folder, reason: 'mapTextures off' })
      continue
    }
    const bspPath = path.join(ctx.options.bspDir, `${info.mapName}.bsp`)
    if (!fs.existsSync(bspPath)) {
      ctx.log(`${folder}: ${bspPath} missing; no stock props for this map`)
      ctx.removeMap(folder)
      report.skipped.push({ folder, reason: 'bsp missing' })
      continue
    }
    const bspSha256 = sha256File(bspPath)
    const conversion = info.conversion
    let lighting = { set: conversion.lightmap?.set ?? 'hdr', exposure: conversion.lightmap?.exposure ?? 1, floor: conversion.lightmap?.floor ?? 0 }
    let sunDirection = conversion.lightEnvironment?.direction ?? null
    const file = `maps/${folder}/props-stock.glb`
    const inputKey = ctx.inputKey({ folder, bspSha256, mapName: info.mapName, publicProps: info.props, lighting, sunDirection, options, worldOptions, converterHash, toolVersion })

    const previous = ctx.manifest.maps[folder]
    if (!ctx.options.force && previous?.stats?.inputKey === inputKey && ctx.hasPackFile(file) && Object.values(previous.files ?? {}).every(f => ctx.hasPackFile(f))) {
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

    const propsJson = JSON.parse(fs.readFileSync(path.join(tmp, 'props.json'), 'utf8'))
    const worldStarted = performance.now()
    let world = null
    if (worldOnly) {
      world = await buildTexturedWorld(ctx, { folder, bspPath, bspToGlb, tmp, pakDir: path.join(tmp, 'pak'), options: worldOptions, written, propOptions: options })
      lighting = world.lighting
      sunDirection = world.sunDirection
    }
    const propsCommon = {
      bspToGlb,
      vtfToPng,
      pakDir: path.join(tmp, 'pak'),
      props: propsJson,
      worldMins,
      worldMaxs,
      lighting,
      sunDirection,
      meshopt: options.meshopt,
      ...(options.bakeVertexBudget !== undefined ? { bakeVertexBudget: options.bakeVertexBudget } : {}),
      stockSource: ctx.vpk,
      textured: options.textured,
      lod: options.lod,
      texturePakPrefix: `pak/${folder}/`,
    }
    const result = await convertStaticProps({
      ...propsCommon,
      workDir: path.join(tmp, 'props'),
      outPath: ctx.stagePath(file),
      log: message => ctx.log(`${folder}:${message}`),
    })
    if (!worldOnly && worldOptions) {
      world = await buildTexturedWorld(ctx, { folder, bspPath, bspToGlb, tmp, pakDir: path.join(tmp, 'pak'), options: worldOptions, written, propOptions: options })
    }
    const worldMs = Math.round(performance.now() - worldStarted)
    // PAK props with VPK materials (props-pak.glb), only for maps whose public props.glb has PAK props.
    const pakFile = `maps/${folder}/props-pak.glb`
    // A world-only folder has no public props counts; its PAK pass writes no file when the PAK has no models.
    const pakResult = options.pak && (worldOnly || Number(info.props?.pak) + Number(info.props?.dynamic ?? 0) > 0)
      ? await convertStaticProps({ ...propsCommon, select: 'pak', workDir: path.join(tmp, 'props-pak'), outPath: ctx.stagePath(pakFile), log: message => ctx.log(`${folder}: pak${message}`) })
      : null
    // as/mapfx: the static props inside the 3D skybox (PAK and stock models), unscaled at their skybox positions,
    // for pack worlds only (World draws them with the world's skybox_3d node). No far LODs: they are far anyway.
    const skyFile = `maps/${folder}/props-sky.glb`
    const skyResult = world && options.sky
      ? await convertStaticProps({ ...propsCommon, select: 'skybox', lod: false, workDir: path.join(tmp, 'props-sky'), outPath: ctx.stagePath(skyFile), log: message => ctx.log(`${folder}: sky${message}`) })
      : null
    // Prop textures after the world's, so a key both use keeps the world item (its larger cap).
    const propTextureList = { ...(result.textures ?? {}), ...(pakResult?.textures ?? {}), ...(skyResult?.textures ?? {}) }
    const propTextures = options.textured && Object.keys(propTextureList).length
      ? await exportTextures(ctx, { folder, textureList: propTextureList, pakDir: path.join(tmp, 'pak'), options, written, reuseWritten: true, otherOptions: worldOptions })
      : null
    if (propTextures) ctx.log(`${folder}: prop textures ${propTextures.stats.textures} (${propTextures.stats.texturesWritten} written, ${propTextures.stats.texturesReused} reused, ${propTextures.stats.texturesUnsupported} unsupported), ${(propTextures.stats.textureGpuBytes / 1048576).toFixed(1)} MB GPU`)
    if (world) ctx.log(`${folder}: textured world, ${world.stats.textures} textures (${world.stats.texturesWritten} written, ${world.stats.texturesReused} reused, ${world.stats.texturesUnsupported} unsupported), ${(world.stats.textureGpuBytes / 1048576).toFixed(1)} MB GPU, ${(worldMs / 1000).toFixed(1)} s`)
    if (!set.propsKeepTmp) fs.rmSync(tmp, { recursive: true, force: true })
    const ms = Math.round(performance.now() - started)
    if (!result.file && !world) {
      ctx.log(`${folder}: no stock props`)
      ctx.removeMap(folder)
      report.skipped.push({ folder, reason: 'no stock props' })
      continue
    }
    ctx.setMap(folder, {
      mapName: info.mapName,
      bspSha256,
      bspBytes: fs.statSync(bspPath).size,
      // A world-only folder's public conversion.json has no props; the entry then has no publicProps (null at runtime).
      ...(worldOnly && info.props == null ? {} : { publicProps: info.props }),
      files: { ...(result.file ? { propsStock: file } : {}), ...(pakResult?.file ? { propsPak: pakFile } : {}), ...(skyResult?.file ? { propsSky: skyFile } : {}), ...(world?.files ?? {}) },
      ...(world ? { textures: world.textures } : {}),
      ...(propTextures ? { propTextures: propTextures.textures } : {}),
      stats: {
        inputKey,
        ...(result.file ? manifestStats(result) : {}),
        ...(pakResult?.file ? { propsPak: manifestStats(pakResult) } : {}),
        ...(skyResult?.file ? { propsSky: manifestStats(skyResult) } : {}),
        ...(propTextures ? { propTextures: propTextures.stats } : {}),
        ...(world ? { world: world.stats } : {}),
      },
    })
    if (world) report.maps[folder] = { worldMs, world: world.stats }
    const mapReport = { folder, mapName: info.mapName, ms, exportMs, propsMs: result.stats.ms, worldMs, bytes: result.stats.bytes, props: result.props, stats: result.stats, world: world ? { ...world.stats, ...world.report } : null }
    ctx.writeFile(`reports/maps/${folder}.json`, `${JSON.stringify(mapReport, null, 2)}\n`)
    report.maps[folder] = { ...report.maps[folder], ms, bytes: result.stats.bytes, instances: result.stats.instances, models: result.stats.models, excluded: result.stats.excludedModels.length, renderedTriangles: result.stats.renderedTriangles }
    report.built.push(folder)
    ctx.log(`${folder}: props-stock.glb ${(result.stats.bytes / 1048576).toFixed(2)} MB, ${result.stats.instances} instances of ${result.stats.models} models` +
      `${result.stats.excludedModels.length ? `, ${result.stats.excludedModels.length} models excluded (winding)` : ''}, ${result.stats.missing} missing, ${(ms / 1000).toFixed(1)} s`)
  }
  // Map entries this run kept (not selected, or unchanged) still need their texture items, which a --force run of
  // this stage does not carry over; take them from the previous manifest while their files are in the pack.
  for (const entry of Object.values(ctx.manifest.maps)) {
    for (const key of [...(entry.textures ?? []), ...(entry.propTextures ?? [])]) {
      for (const k of [key, `${key}@webp`]) {
        const old = ctx.previous?.items?.[k]
        if (ctx.manifest.items[k] || !old || old.kind !== 'texture' || !ctx.hasPackFile(old.file)) continue
        const { stage: _stage, ...item } = old
        ctx.addItem(k, item)
      }
    }
  }
  return report
}
