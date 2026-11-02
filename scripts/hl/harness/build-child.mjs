// Builds a dribble.tf checkout (repo or worktree) with that checkout's own vite.config.mts,
// without copying public/ (the harness server serves <root>/public directly).
//
// Usage: node scripts/hl/harness/build-child.mjs <root> <outDir> [--no-minify] [--asset-pack-url <url>]
// Run by shot.mjs as a child process so the Rollup heap is released when it exits. It uses the vite in
// <root>/node_modules, so a worktree builds with the same toolchain as its main checkout.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, outDir, ...flags] = process.argv.slice(2)
const minify = !flags.includes('--no-minify')
const packAt = flags.indexOf('--asset-pack-url')
const packUrl = packAt >= 0 ? flags[packAt + 1] : null
if (!root || !outDir || (packAt >= 0 && !packUrl)) {
  console.error('usage: node build-child.mjs <root> <outDir> [--no-minify] [--asset-pack-url <url>]')
  process.exit(64)
}

// getAsset() prefixes VITE_APP_ASSET_URL in production builds; force local assets.
process.env.VITE_APP_ASSET_URL = ''
// The asset pack URL (specs/assets/contract.md 3.2) is set only for --asset-pack runs; otherwise the build is
// the production default, which makes no pack request.
if (packUrl) process.env.VITE_ASSET_PACK_URL = packUrl
else delete process.env.VITE_ASSET_PACK_URL

const viteEntry = path.join(root, 'node_modules', 'vite', 'dist', 'node', 'index.js')
if (!fs.existsSync(viteEntry)) {
  console.error(`vite not found at ${viteEntry} (is node_modules installed or symlinked?)`)
  process.exit(65)
}

const { build } = await import(pathToFileURL(viteEntry).href)
const started = Date.now()

await build({
  root,
  configFile: path.join(root, 'vite.config.mts'),
  mode: 'production',
  publicDir: false,
  logLevel: 'warn',
  clearScreen: false,
  build: {
    outDir,
    emptyOutDir: true,
    reportCompressedSize: false,
    sourcemap: false,
    minify,
  },
})

console.log(`[harness] build ok${packUrl ? ` (VITE_ASSET_PACK_URL=${packUrl})` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${outDir}`)
