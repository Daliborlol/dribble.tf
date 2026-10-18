#!/usr/bin/env node
// Pixel diff: node scripts/hl/harness/tools/imgdiff.mjs <dirA> <dirB> <outDir> [threshold]
// For every PNG present in both dirs: the share of pixels whose largest channel delta exceeds the threshold
// (default 24 of 255), the bounding box of the changed pixels, and a diff image (B dimmed to 35 %, changed
// pixels in magenta) as <outDir>/<name>-diff.png. Writes <outDir>/diff.json. Uses the app's sharp.
// This file is only the command line; the diff itself lives in ../lib/images.mjs, which other scripts import.

import { SetupError } from '../lib/setup.mjs'
import { DEFAULT_THRESHOLD, diffDirs } from '../lib/images.mjs'

const [dirA, dirB, outDir, thArg, ...extra] = process.argv.slice(2)
const threshold = Number(thArg ?? DEFAULT_THRESHOLD)
if (!dirA || !dirB || !outDir || extra.length || !(Number.isFinite(threshold) && threshold >= 0)) {
  console.error('usage: node scripts/hl/harness/tools/imgdiff.mjs <dirA> <dirB> <outDir> [threshold, default 24 of 255]')
  process.exit(64)
}
try {
  const rows = await diffDirs(dirA, dirB, outDir, threshold)
  for (const r of rows) console.log(r.name.padEnd(40), r.error ?? `${String(r.changedPct).padStart(7)} %  bbox ${JSON.stringify(r.bbox)}`)
  if (!rows.length) console.error(`no PNG file is present in both ${dirA} and ${dirB}`)
} catch (error) {
  console.error(error instanceof SetupError ? error.message : error?.stack || error)
  process.exit(1)
}
