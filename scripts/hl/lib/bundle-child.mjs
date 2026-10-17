// Child process of bundle.mjs: bundles one entry of this checkout with esbuild and writes the ESM code to stdout.
// It runs in its own process so the esbuild service never adds to the memory the checker measures.
//   node scripts/hl/lib/bundle-child.mjs <entry relative to the repo root>

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(REPO_ROOT, 'package.json'))
const esbuild = require('esbuild')

const result = await esbuild.build({
  entryPoints: [path.resolve(REPO_ROOT, process.argv[2])],
  absWorkingDir: REPO_ROOT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
  legalComments: 'none',
  define: { 'import.meta.env.DEV': 'false' },
  alias: { three: './scripts/hl/lib/three-shim.mjs' },
})
await esbuild.stop()
process.stdout.write(result.outputFiles[0].text, () => process.exit(0))
