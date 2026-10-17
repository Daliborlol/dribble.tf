// Shared helpers for the Highlander Node scripts (contract section 2.7).
//
// importBundled() bundles a JS or TS entry of this checkout with esbuild (from node_modules, honouring the
// tsconfig.json path aliases such as @highlander/*) in a child process and imports the result, so the scripts run
// the real src/highlander code without a build step.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Bundles `entry` (a path relative to the repo root) with esbuild in a child process (bundle-child.mjs, which maps
 * `three` to three-shim.mjs) and imports the code. The code goes through a temporary file that is removed right
 * after the import: importing it from a data: URL instead costs about 6 MB of RSS in Node 22.
 */
export async function importBundled(entry) {
  const child = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/hl/lib/bundle-child.mjs'), entry], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (child.status !== 0 || !child.stdout) throw new Error(`esbuild bundle of ${entry} failed: ${child.stderr}`)
  const file = path.join(os.tmpdir(), `dribble-hl-${process.pid}-${path.basename(entry).replace(/\W+/g, '_')}.mjs`)
  fs.writeFileSync(file, child.stdout)
  try {
    return await import(pathToFileURL(file).href)
  } finally {
    fs.rmSync(file, { force: true })
  }
}

/** Peak resident set size of this process in kB (`VmHWM` in /proc/self/status), 0 when unavailable. */
export function vmHwmKB() {
  try {
    const m = /VmHWM:\s+(\d+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

/** Minimal flag parser: positional arguments plus `--name value` and `--flag` (boolean) options. */
export function parseArgs(argv, booleanFlags = []) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (booleanFlags.includes(name)) flags[name] = true
      else flags[name] = argv[++i]
    } else positional.push(a)
  }
  return { positional, flags }
}

/** sample k of 16: round(ticks * (k + 0.5) / 16), the same target the Rust side uses (section 2.5.1). */
export const alignmentTarget = (ticks, k) => Math.round((ticks * (k + 0.5)) / 16)
export const ALIGNMENT_WINDOW = 64
