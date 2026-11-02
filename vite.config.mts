import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Serves the local TF2 asset pack at /tf2-assets/ in `npm run dev` and `vite preview` (asset contract 3.3).
// The pack lives outside the repo (DRIBBLE_ASSET_PACK, default ~/tf2-pack), never under public/, so it never
// reaches dist/ or a deploy. A missing file answers 404 and never falls through to the SPA index.html.
const ASSET_PACK_PREFIX = '/tf2-assets'
const ASSET_PACK_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.dds': 'application/octet-stream',
  '.webp': 'image/webp',
}

function assetPackPlugin(): Plugin {
  const root = path.resolve(process.env.DRIBBLE_ASSET_PACK || path.join(os.homedir(), 'tf2-pack'))
  const notFound = (res: ServerResponse) => {
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain')
    res.setHeader('Cache-Control', 'no-cache')
    res.end('not found')
  }
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end()
      return
    }
    let file: string
    try {
      // Mounted at the prefix, so req.url is the path inside the pack.
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://pack').pathname)
      if (pathname.includes('\0')) return notFound(res)
      file = path.resolve(root, '.' + pathname)
    } catch {
      return notFound(res)
    }
    if (!file.startsWith(root + path.sep)) return notFound(res)
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      return notFound(res)
    }
    if (!stat.isFile()) return notFound(res)
    res.statusCode = 200
    res.setHeader(
      'Content-Type',
      ASSET_PACK_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    )
    res.setHeader('Content-Length', String(stat.size))
    res.setHeader('Cache-Control', 'no-cache')
    if (req.method === 'HEAD') return void res.end()
    const stream = fs.createReadStream(file)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }
  // The raw request URL, checked before connect strips the prefix: '/tf2-assets/../x' must stay a 404.
  const guard = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const raw = req.url ?? ''
    if (
      raw === ASSET_PACK_PREFIX ||
      raw.startsWith(ASSET_PACK_PREFIX + '/') ||
      raw.startsWith(ASSET_PACK_PREFIX + '?')
    ) {
      req.url = raw.slice(ASSET_PACK_PREFIX.length) || '/'
      return handler(req, res)
    }
    next()
  }
  return {
    name: 'dribble-asset-pack',
    configureServer(server) {
      server.middlewares.use(guard)
    },
    configurePreviewServer(server) {
      server.middlewares.use(guard)
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tsconfigPaths(), nodePolyfills({ include: ['events'] }), assetPackPlugin()],
})
