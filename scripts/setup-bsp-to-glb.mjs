#!/usr/bin/env node
/**
 * setup-bsp-to-glb.mjs — fetch, patch and build Hona/bsp-to-glb for scripts/convert-bsp.mjs.
 *
 * Layout: a sibling checkout ../bsp-to-glb (override with --dir or BSP_TO_GLB_DIR), pinned to
 * PINNED_COMMIT, with scripts/bsp-to-glb/*.patch applied on a local `dribble` branch. Upstream has
 * no tagged release archives yet, so we build from source (Rust ≥ 1.85, edition 2024; ~25 s).
 *
 * Usage: node scripts/setup-bsp-to-glb.mjs [--dir ../bsp-to-glb] [--jobs 4] [--skip-build true]
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_URL = 'https://github.com/Hona/bsp-to-glb'
const PINNED_COMMIT = '7b7f7fc803b65e53791d3fc6eab04c0a2e355c6c' // main @ 2026-07 (tag poc-final-2026-07-16)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const dir = path.resolve(opt('dir', process.env.BSP_TO_GLB_DIR || path.join(repoRoot, '..', 'bsp-to-glb')))
const jobs = opt('jobs', process.env.CARGO_BUILD_JOBS || '')
const skipBuild = opt('skip-build', 'false') === 'true'
const patchDir = path.join(__dirname, 'bsp-to-glb')
const patches = fs.existsSync(patchDir) ? fs.readdirSync(patchDir).filter(f => f.endsWith('.patch')).sort().map(f => path.join(patchDir, f)) : []

const sh = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { stdio: options.capture ? 'pipe' : 'inherit', encoding: 'utf8', cwd: options.cwd, env: { ...process.env, ...(options.env || {}) } })
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed${options.capture ? `: ${result.stderr}` : ''}`)
  }
  return result
}
const git = (args, options = {}) => sh('git', ['-C', dir, ...args], options)

console.log(`bsp-to-glb checkout: ${dir}`)
if (!fs.existsSync(path.join(dir, '.git'))) {
  sh('git', ['clone', REPO_URL, dir])
}
const head = git(['rev-parse', 'HEAD'], { capture: true }).stdout.trim()
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).stdout.trim()
const patchedAlready = branch === 'dribble' && git(['merge-base', '--is-ancestor', PINNED_COMMIT, 'HEAD'], { allowFail: true, capture: true }).status === 0
if (!patchedAlready) {
  if (git(['status', '--porcelain'], { capture: true }).stdout.trim()) {
    throw new Error(`${dir} has local changes; commit or stash them first`)
  }
  git(['cat-file', '-e', `${PINNED_COMMIT}^{commit}`], { allowFail: true, capture: true }).status === 0 || git(['fetch', 'origin'])
  git(['checkout', '-B', 'dribble', PINNED_COMMIT])
  for (const patch of patches) {
    console.log(`Applying ${path.basename(patch)}`)
    git(['-c', 'commit.gpgsign=false', '-c', 'user.name=dribble.tf', '-c', 'user.email=dribble@localhost', 'am', '--3way', patch])
  }
} else {
  console.log(`Already on patched branch 'dribble' (${head.slice(0, 10)})`)
}

if (!skipBuild) {
  sh('cargo', ['build', '--release', '--locked'], { cwd: dir, env: jobs ? { CARGO_BUILD_JOBS: jobs } : {} })
}
const exe = name => path.join(dir, 'target', 'release', process.platform === 'win32' ? `${name}.exe` : name)
const version = sh(exe('bsp-to-glb'), ['--version-json'], { capture: true }).stdout.trim()
const usage = sh(exe('bsp-to-glb'), [], { capture: true, allowFail: true }).stderr
if (!usage.includes('--lightmap-styles') || !usage.includes('--allow-unresolved-patch-includes')) {
  throw new Error('bsp-to-glb was built without the dribble patches (scripts/bsp-to-glb/*.patch)')
}
console.log(`OK ${JSON.parse(version).name} ${JSON.parse(version).version}`)
console.log(`  ${exe('bsp-to-glb')}`)
console.log(`  ${exe('vtf-to-png')}`)

// Node-side dependencies of convert-bsp.mjs.
const missing = ['@gltf-transform/core', '@gltf-transform/extensions', '@gltf-transform/functions', 'meshoptimizer', 'sharp'].filter(name => {
  try {
    return !fs.existsSync(path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json'))
  } catch {
    return true
  }
})
if (missing.length) console.log(`Missing Node deps for convert-bsp.mjs: npm i -D ${missing.join(' ')}`)
