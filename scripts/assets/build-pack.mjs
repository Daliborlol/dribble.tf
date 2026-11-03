#!/usr/bin/env node
// Builds the local TF2 asset pack from the user's own VPKs (contract 2.1). Personal use only; see
// scripts/assets/README.md.
//
//   npm run assets:build -- --tf2 /home/dalibor/tf2-assets/tf --hl2 /home/dalibor/tf2-assets/hl2 --out <dir>
//     [--stages maps,models,viewmodels,shading,particles | none] [--maps <folder,...|all>] [--bsp-dir <dir>] [--tmp <dir on disk>]
//     [--force] [--keep-tmp] [--prune] [--bsp-to-glb <binary>] [--set key=value ...] [--stage-dir <dir>]
//
// Stages are `scripts/assets/<stage>/stage.mjs` modules, run in the fixed order maps, models,
// viewmodels; a missing one is skipped. Each exports `run(ctx)` (see README "Writing a stage").
// Outputs are staged under the temp dir and moved into place only after every stage succeeded,
// each by an atomic rename; manifest.json is written last. A failed or interrupted build leaves the
// previous manifest.json and the files it lists as they were.
//
// Exit codes: 0 built, 1 a stage or the final check failed, 2 usage error or refused option,
// 130 interrupted.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { openVpkSet, locateTf2Vpks, canonicalJson, sha256, sortKeysDeep } from './lib/vpk.mjs'
import { createManifest, readManifest, writeManifest, validateManifest, verifyManifestFiles, isPackPath, ITEM_KINDS } from './lib/manifest.mjs'
import { writeFileAtomic, moveFileAtomic, sha256File, walkFiles, outDirProblem, gitCommit } from './lib/fsutil.mjs'
import { GENERATOR_VERSION } from './version.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHECKOUT = path.resolve(HERE, '..', '..')
export const STAGE_ORDER = ['maps', 'models', 'viewmodels', 'shading', 'particles']
// Folders whose public files keep an older textured GLB (no bsp-to-glb conversion.json) but whose pack entry
// carries a bsp-to-glb world, lightmap and props from the same BSP (as/product; replaces contract 1.1 D5's
// exclusion). Without a pack, or with an entry the runtime rejects, they load their public GLB as before.
export const PACK_WORLD_ONLY_MAPS = ['koth_product_final']
const MARKER = '.dribble-asset-pack'
const LOCK = '.build.lock'
const DEFAULT_OUT = path.join(os.homedir(), 'tf2-pack')
const DEFAULT_BSP_DIR = path.join(os.homedir(), '.local/share/Steam/steamapps/common/Team Fortress 2/tf/maps')

const USAGE = `usage: build-pack.mjs --tf2 <tf dir | dir with tf/ and hl2/> [--hl2 <dir>] [--out <dir>]
  [--stages maps,models,viewmodels,shading,particles | none] [--only <stage,...>] [--maps <folder,...|all>]
  [--bsp-dir <dir>] [--tmp <dir on disk>] [--force] [--keep-tmp] [--prune] [--bsp-to-glb <binary>]
  [--set key=value ...] [--stage-dir <dir>] [--help]

  --out       pack directory (default ${DEFAULT_OUT}); refused inside a git work tree or under /tmp
  --stages    stages to run, in the fixed order ${STAGE_ORDER.join(', ')} (default all present ones)
  --only      the same as --stages
  --maps      map folders for the maps stage (default all: the bsp-to-glb folders under public/models/maps
              plus ${PACK_WORLD_ONLY_MAPS.join(', ')})
  --bsp-dir   folder with the map BSPs (default the Steam install)
  --tmp       scratch dir (default <out>/.tmp); never /tmp
  --force     rebuild every item, ignoring the previous manifest
  --keep-tmp  keep the scratch dir
  --prune     delete pack files the new manifest does not list (reports/ and dot files stay)
  --set       stage option, repeatable; the value is JSON when it parses, else a string
  --stage-dir load <stage>/stage.mjs from this folder instead of scripts/assets (tests and fixtures)`

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { set: {}, force: false, keepTmp: false }
  const takes = new Set(['tf2', 'hl2', 'out', 'stages', 'only', 'maps', 'bsp-dir', 'tmp', 'bsp-to-glb', 'set', 'stage-dir'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { o.help = true; continue }
    if (a === '--force') { o.force = true; continue }
    if (a === '--keep-tmp') { o.keepTmp = true; continue }
    if (a === '--prune') { o.prune = true; continue }
    const eq = a.indexOf('=')
    const name = a.startsWith('--') ? a.slice(2, eq > 0 ? eq : undefined) : null
    if (!name || !takes.has(name)) throw new UsageError(`unknown option ${a}`)
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i]
    if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new UsageError(`${a} needs a value`)
    if (name === 'set') {
      const k = value.indexOf('=')
      if (k <= 0) throw new UsageError(`--set needs key=value, got ${value}`)
      const raw = value.slice(k + 1)
      let parsed
      try { parsed = JSON.parse(raw) } catch { parsed = raw }
      o.set[value.slice(0, k)] = parsed
    } else {
      if (o[name] !== undefined) throw new UsageError(`--${name} given twice`)
      o[name] = value
    }
  }
  if (o.help) return o
  if (!o.tf2) throw new UsageError('--tf2 is required')
  if (o.stages !== undefined && o.only !== undefined) throw new UsageError('--stages and --only are the same option; give one')
  return o
}

/**
 * The map folders of the maps stage: the bsp-to-glb folders of this checkout (public/models/maps/<f>/conversion.json
 * pipeline bsp-to-glb) plus the PACK_WORLD_ONLY_MAPS folders that have a public conversion.json, sorted.
 */
export function packMapFolders(checkout = CHECKOUT) {
  const root = path.join(checkout, 'public', 'models', 'maps')
  const extra = PACK_WORLD_ONLY_MAPS.filter(name => fs.existsSync(path.join(root, name, 'conversion.json')))
  return [...new Set([...bspToGlbFolders(checkout), ...extra])].sort()
}

/** The bsp-to-glb map folders of this checkout: public/models/maps/<f>/conversion.json pipeline bsp-to-glb. */
export function bspToGlbFolders(checkout = CHECKOUT) {
  const root = path.join(checkout, 'public', 'models', 'maps')
  const out = []
  for (const name of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
    const file = path.join(root, name, 'conversion.json')
    if (!fs.existsSync(file)) continue
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).pipeline === 'bsp-to-glb') out.push(name)
    } catch { /* not a conversion file */ }
  }
  return out
}

/** `mapName` and the `props` object of a folder's public conversion.json (what manifest map entries copy), and `worldOnly`. */
export function publicMapInfo(folder, checkout = CHECKOUT) {
  const file = path.join(checkout, 'public', 'models', 'maps', folder, 'conversion.json')
  const c = JSON.parse(fs.readFileSync(file, 'utf8'))
  const pipeline = c.pipeline ?? null
  // worldOnly: a PACK_WORLD_ONLY_MAPS folder whose public files are an older textured GLB.
  const worldOnly = PACK_WORLD_ONLY_MAPS.includes(folder) && pipeline !== 'bsp-to-glb'
  return { mapName: c.mapName ?? null, props: c.props ?? null, pipeline, conversion: c, worldOnly }
}

function resolveStages(o) {
  const raw = o.stages ?? o.only
  if (raw === undefined || raw === 'all') return [...STAGE_ORDER]
  if (raw === 'none' || raw === '') return []
  const names = raw.split(',').map(s => s.trim()).filter(Boolean)
  for (const n of names) if (!STAGE_ORDER.includes(n)) throw new UsageError(`unknown stage ${n} (stages: ${STAGE_ORDER.join(', ')})`)
  return STAGE_ORDER.filter(s => names.includes(s))
}

function resolveMaps(o) {
  const all = packMapFolders()
  if (o.maps === undefined || o.maps === 'all') return all
  const names = o.maps.split(',').map(s => s.trim()).filter(Boolean)
  for (const n of names) {
    if (!all.includes(n)) throw new UsageError(`--maps ${n}: not a map folder of the maps stage (folders: ${all.join(', ')})`)
  }
  return [...new Set(names)].sort()
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function acquireLock(out) {
  const file = path.join(out, LOCK)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' })
      return () => { try { fs.rmSync(file) } catch { /* gone */ } }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const pid = Number(fs.readFileSync(file, 'utf8').trim())
      if (pid && pidAlive(pid)) throw new Error(`another pack build (pid ${pid}) is writing ${out}`)
      fs.rmSync(file, { force: true })
    }
  }
  throw new Error(`could not take ${file}`)
}

function log(...args) { console.log('[assets]', ...args) }

export async function main(argv) {
  let o
  try {
    o = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) { console.error(`${error.message}\n${USAGE}`); return 2 }
    throw error
  }
  if (o.help) { console.log(USAGE); return 0 }

  let stages, maps
  try {
    stages = resolveStages(o)
    maps = resolveMaps(o)
  } catch (error) {
    if (error instanceof UsageError) { console.error(error.message); return 2 }
    throw error
  }

  const out = path.resolve(o.out ?? DEFAULT_OUT)
  const outProblem = outDirProblem(out)
  if (outProblem) { console.error(`refusing --out: ${outProblem}`); return 2 }
  const tmpRoot = path.resolve(o.tmp ?? path.join(out, '.tmp'))
  const tmpProblem = outDirProblem(tmpRoot)
  if (tmpProblem && /under \/tmp/.test(tmpProblem)) { console.error(`refusing --tmp: ${tmpProblem}`); return 2 }
  if (fs.existsSync(out)) {
    if (!fs.statSync(out).isDirectory()) { console.error(`refusing --out: ${out} is not a directory`); return 2 }
    const entries = fs.readdirSync(out)
    if (entries.length && !entries.includes('manifest.json') && !entries.includes(MARKER)) {
      console.error(`refusing --out: ${out} is not empty and holds no asset pack (no manifest.json or ${MARKER})`)
      return 2
    }
  }

  let located
  try {
    located = locateTf2Vpks(o.tf2, o.hl2)
  } catch (error) { console.error(error.message); return 2 }

  fs.mkdirSync(out, { recursive: true })
  if (!fs.existsSync(path.join(out, MARKER))) writeFileAtomic(path.join(out, MARKER), 'dribble-asset-pack\n')
  let release
  try { release = acquireLock(out) } catch (error) { console.error(error.message); return 1 }

  const buildTmp = path.join(tmpRoot, 'build')
  const stagedRoot = path.join(buildTmp, 'staged')
  let current = 'setup'
  let finishing = false
  const onSignal = signal => {
    console.error(`[assets] ${signal} during ${current}; ${finishing ? 'files were being moved into place, so the previous manifest may list replaced files; rerun the build' : 'manifest.json and the files it lists are unchanged'}`)
    if (!o.keepTmp && !finishing) {
      fs.rmSync(buildTmp, { recursive: true, force: true })
      try { if (fs.readdirSync(tmpRoot).length === 0) fs.rmdirSync(tmpRoot) } catch { /* not ours or gone */ }
    }
    release()
    process.exit(130)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const t0 = performance.now()
  let vpk
  try {
    fs.rmSync(buildTmp, { recursive: true, force: true })
    fs.mkdirSync(stagedRoot, { recursive: true })
    vpk = openVpkSet(located.files, { labels: located.labels })
    const builtFrom = vpk.fingerprint()
    log(`VPKs ${builtFrom.vpks.map(v => v.file).join(', ')}; fingerprint ${builtFrom.fingerprint.slice(0, 16)}`)

    const prev = readManifest(out)
    const prevOk = prev.manifest && !prev.errors.length ? prev.manifest : null
    if (prev.absent) log('no previous manifest')
    else if (prev.errors.length) log(`previous manifest ignored: ${prev.errors[0]}`)
    const sameVpks = Boolean(prevOk && prevOk.builtFrom.fingerprint === builtFrom.fingerprint)
    const sameGenerator = Boolean(prevOk && prevOk.generator.version === GENERATOR_VERSION)
    // Stages that run keep their previous entries only for an incremental build. Entries owned by a
    // stage that does not run (and map entries of folders this run does not select) are carried
    // while the VPKs are the same, so `--force --stages maps` keeps the model items.
    const incremental = sameVpks && sameGenerator && !o.force
    const ownerRuns = owner => owner !== null && stages.includes(owner)
    const keepEntry = (owner, { folder } = {}) => {
      if (!sameVpks) return false
      if (!ownerRuns(owner)) return true
      if (owner === 'maps' && folder !== undefined && !maps.includes(folder)) return true
      return incremental
    }
    if (prevOk && !sameVpks) log('previous manifest was built from other VPKs; rebuilding everything')
    else if (prevOk && !sameGenerator) log(`previous manifest has generator ${prevOk.generator.version}; rebuilding the stages that run`)
    else if (prevOk && o.force) log(`--force: rebuilding ${stages.length ? stages.join(', ') : 'nothing (no stages)'}`)
    const manifest = createManifest({ generatorVersion: GENERATOR_VERSION, commit: gitCommit(CHECKOUT), builtFrom, options: {} })
    if (prevOk) {
      const notRun = new Set()
      for (const [k, v] of Object.entries(prevOk.options ?? {})) {
        if (keepEntry(k)) manifest.options[k] = structuredClone(v)
        else if (!ownerRuns(k)) notRun.add(k)
      }
      for (const [folder, entry] of Object.entries(prevOk.maps ?? {})) {
        if (keepEntry('maps', { folder })) manifest.maps[folder] = structuredClone(entry)
        else if (!ownerRuns('maps')) notRun.add('maps')
      }
      for (const [key, item] of Object.entries(prevOk.items ?? {})) {
        const owner = item.stage ?? null
        if (keepEntry(owner)) manifest.items[key] = structuredClone(item)
        else if (!ownerRuns(owner)) notRun.add(owner ?? 'unknown')
      }
      if (notRun.size) log(`warning: dropped the previous entries of ${[...notRun].sort().join(', ')} (built from other VPKs); rebuild with --stages ${[...notRun].filter(n => STAGE_ORDER.includes(n)).sort().join(',') || 'all'}`)
      const keptStale = sameVpks && !sameGenerator ? STAGE_ORDER.filter(st => !stages.includes(st) && (st in manifest.options || st === 'maps' && Object.keys(manifest.maps).length || Object.values(manifest.items).some(i => i.stage === st))) : []
      if (keptStale.length) log(`warning: kept the entries of ${keptStale.join(', ')} built by generator ${prevOk.generator.version}; rebuild with --stages ${keptStale.join(',')}`)
    }

    const staged = new Map() // pack path -> staged absolute path
    const report = { generatorVersion: GENERATOR_VERSION, stages: {}, ms: 0 }
    const stagePath = rel => {
      if (!isPackPath(rel) || rel === 'manifest.json' || rel.startsWith('.')) throw new Error(`not a pack path: ${rel}`)
      const abs = path.join(stagedRoot, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      staged.set(rel, abs)
      return abs
    }

    for (const stage of STAGE_ORDER) {
      if (!stages.includes(stage)) continue
      const file = path.join(o['stage-dir'] ? path.resolve(o['stage-dir']) : HERE, stage, 'stage.mjs')
      if (!fs.existsSync(file)) { log(`stage ${stage}: ${file} not present, skipped`); report.stages[stage] = { skipped: 'not present' }; continue }
      current = `stage ${stage}`
      log(`stage ${stage} running`)
      const stageTmp = path.join(buildTmp, stage)
      fs.mkdirSync(stageTmp, { recursive: true })
      const ts = performance.now()
      const mod = await import(pathToFileURL(file).href)
      if (typeof mod.run !== 'function') throw new Error(`${stage}/stage.mjs exports no run(ctx)`)
      const stageLog = (...args) => log(`[${stage}]`, ...args)
      const ctx = {
        stage,
        vpk,
        out,
        tmp: stageTmp,
        checkout: CHECKOUT,
        generatorVersion: GENERATOR_VERSION,
        fingerprint: builtFrom.fingerprint,
        options: { stages, maps, bspDir: path.resolve(o['bsp-dir'] ?? DEFAULT_BSP_DIR), force: !incremental, set: structuredClone(o.set), bspToGlb: o['bsp-to-glb'] ?? null },
        manifest,
        previous: prevOk,
        log: stageLog,
        /** Input key of an item: VPK fingerprint, generator version and whatever else changes its output. */
        inputKey: parts => sha256(canonicalJson({ fingerprint: builtFrom.fingerprint, generator: GENERATOR_VERSION, stage, parts: sortKeysDeep(parts) })),
        /** Absolute path to write pack file `rel` to; it moves into place after every stage succeeded. */
        stagePath,
        writeFile: (rel, data) => { writeFileAtomic(stagePath(rel), data); return rel },
        setOptions: obj => { manifest.options[stage] = sortKeysDeep(obj) },
        setMap: (folder, entry) => { manifest.maps[folder] = structuredClone(entry) },
        removeMap: folder => { delete manifest.maps[folder] },
        addItem: (key, item) => {
          if (!ITEM_KINDS.includes(item.kind)) throw new Error(`item ${key}: kind ${item.kind}`)
          // `stage` records the owner, so a run of other stages carries the item (see keepEntry).
          manifest.items[key] = { ...structuredClone(item), stage }
        },
        removeItem: key => { delete manifest.items[key] },
        publicMapInfo: folder => publicMapInfo(folder),
        /** True when the pack already holds `rel` (from a previous build), staged files aside. */
        hasPackFile: rel => fs.existsSync(path.join(out, rel)),
      }
      const result = await mod.run(ctx)
      report.stages[stage] = { ms: Math.round(performance.now() - ts), ...(result && typeof result === 'object' ? result : {}) }
      log(`stage ${stage} done in ${((performance.now() - ts) / 1000).toFixed(1)} s`)
    }

    // Everything that can fail runs before the first rename: sizes and hashes come from the staged
    // file when one is staged (it replaces the pack file), else from the pack file; then the manifest
    // is validated and every listed file is checked against that overlay. Only then are files moved
    // and the manifest written, so a failure up to here leaves the pack as it was.
    current = 'finishing'
    // A path reserved with stagePath() but never written (a skipped item) is dropped; a listed file
    // that is missing fails the check below.
    for (const rel of [...staged.keys()]) if (!fs.existsSync(staged.get(rel))) staged.delete(rel)
    const finalPath = rel => staged.get(rel) ?? path.join(out, rel)
    const hashes = new Map()
    const hashOf = rel => { if (!hashes.has(rel)) hashes.set(rel, sha256File(finalPath(rel))); return hashes.get(rel) }
    for (const item of Object.values(manifest.items)) {
      if (!isPackPath(item.file)) continue // validateManifest reports it
      const abs = finalPath(item.file)
      if (staged.has(item.file)) {
        item.bytes = fs.statSync(abs).size
        item.sha256 = hashOf(item.file)
      } else if (fs.existsSync(abs)) {
        item.bytes ??= fs.statSync(abs).size
        item.sha256 ??= hashOf(item.file)
      }
    }
    for (const entry of Object.values(manifest.maps)) {
      entry.sizes ??= {}
      for (const [k, f] of Object.entries(entry.files ?? {})) {
        if (!isPackPath(f)) continue
        const abs = finalPath(f)
        if (staged.has(f)) entry.sizes[k] = fs.statSync(abs).size
        else if (fs.existsSync(abs)) entry.sizes[k] ??= fs.statSync(abs).size
      }
    }
    const invalid = validateManifest(manifest)
    if (invalid.length) throw new Error(`the new manifest is invalid:\n  ${invalid.join('\n  ')}`)
    const problems = verifyManifestFiles(out, manifest, { resolve: finalPath })
    if (problems.length) throw new Error(`the new manifest does not match the pack:\n  ${problems.join('\n  ')}`)

    report.ms = Math.round(performance.now() - t0)
    current = 'moving files into place'
    finishing = true
    for (const rel of [...staged.keys()].sort()) moveFileAtomic(staged.get(rel), path.join(out, rel))
    writeFileAtomic(path.join(out, 'reports', 'build', 'last-build.json'), `${JSON.stringify(report, null, 2)}\n`)
    writeManifest(out, manifest)
    finishing = false
    const unlisted = walkFiles(out, (rel, isDir) => rel.startsWith('.') || rel === 'reports' || (isDir && rel.split('/').some(s => s.startsWith('.'))))
      .filter(rel => rel !== 'manifest.json' && !Object.values(manifest.items).some(i => i.file === rel) && !Object.values(manifest.maps).some(m => Object.values(m.files ?? {}).includes(rel)))
    if (unlisted.length && o.prune) {
      for (const rel of unlisted) {
        fs.rmSync(path.join(out, rel))
        for (let dir = path.dirname(path.join(out, rel)); dir !== out && fs.readdirSync(dir).length === 0; dir = path.dirname(dir)) fs.rmdirSync(dir)
      }
      log(`--prune: deleted ${unlisted.length} files the manifest does not list`)
    } else if (unlisted.length) {
      log(`${unlisted.length} files in the pack are not listed in the manifest (the runtime never requests them; --prune deletes them), e.g. ${unlisted.slice(0, 3).join(', ')}`)
    }
    log(`wrote ${path.join(out, 'manifest.json')}: ${Object.keys(manifest.maps).length} maps, ${Object.keys(manifest.items).length} items, ${((performance.now() - t0) / 1000).toFixed(1)} s`)
    return 0
  } catch (error) {
    console.error(`[assets] build failed during ${current}: ${error.stack ?? error.message}`)
    console.error(`[assets] ${finishing ? 'files were being moved into place, so the previous manifest may list replaced files; rerun the build' : 'manifest.json and the files it lists are unchanged'}`)
    return 1
  } finally {
    vpk?.close()
    if (!o.keepTmp) {
      fs.rmSync(buildTmp, { recursive: true, force: true })
      try { if (fs.readdirSync(tmpRoot).length === 0) fs.rmdirSync(tmpRoot) } catch { /* not ours or gone */ }
    }
    release()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
