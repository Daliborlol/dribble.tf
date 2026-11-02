// Fixture `maps` stage for tests of the builder (loaded only with `--stage-dir`). It writes a tiny
// placeholder GLB (one triangle, no game data) as maps/<folder>/props-stock.glb and the manifest map
// entry of contract 2.3 with the public conversion.json values, so tests cover map entries without
// M3-props's real stage. Never point a dev server at a pack built with it.
//
// Options (--set): fixtureMapLimit=n (default 2).

import fs from 'node:fs'
import path from 'node:path'
import { Document, NodeIO } from '@gltf-transform/core'
import { sha256File } from '../../../lib/fsutil.mjs'

async function placeholderGlb() {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer)
  const prim = doc.createPrimitive().setAttribute('POSITION', position)
  const mesh = doc.createMesh('fixture').addPrimitive(prim)
  doc.createScene().addChild(doc.createNode('fixture').setMesh(mesh))
  return Buffer.from(await new NodeIO().writeBinary(doc))
}

export async function run(ctx) {
  const limit = ctx.options.set.fixtureMapLimit ?? 2
  const folders = ctx.options.maps.slice(0, limit)
  const glb = await placeholderGlb()
  for (const folder of folders) {
    const info = ctx.publicMapInfo(folder)
    const bsp = path.join(ctx.options.bspDir, `${info.mapName}.bsp`)
    const entry = {
      mapName: info.mapName,
      publicProps: info.props,
      files: { propsStock: `maps/${folder}/props-stock.glb` },
      stats: { fixture: true },
    }
    if (fs.existsSync(bsp)) Object.assign(entry, { bspSha256: sha256File(bsp), bspBytes: fs.statSync(bsp).size })
    ctx.writeFile(entry.files.propsStock, glb)
    ctx.setMap(folder, entry)
  }
  ctx.setOptions({ fixture: true, maps: folders })
  return { maps: folders.length }
}
