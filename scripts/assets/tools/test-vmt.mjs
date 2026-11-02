#!/usr/bin/env node
// Self-test of lib/vmt.mjs on hand-written materials (no game files). Covers the rules of contract
// 2.6, patch materials (none exist in the VPKs; they come from BSP PAKs) and resolveMaterial.
//
//   node scripts/assets/tools/test-vmt.mjs

import assert from 'node:assert/strict'
import { parseVmt, resolveMaterial, readMaterialFile, vmtBaseTexture, vmtAlpha, vmtTruthy, NEUTRAL } from '../lib/vmt.mjs'

let n = 0
const check = (fn, label) => { fn(); n++; void label }

// Case, last occurrence wins, comments, unquoted bracket values.
check(() => {
  const v = parseVmt(`// comment
"VertexLitGeneric"
{
  "$baseTexture" "a/first"
  $BaseTexture   "a/second"   // trailing comment
  $phongfresnelranges [.25 .5 1]
  "$color2" "[1 0.5 0.5]"
  $nocull 1
}`)
  assert.equal(v.shader, 'vertexlitgeneric')
  assert.equal(v.params.$basetexture, 'a/second')
  assert.equal(v.params.$phongfresnelranges, '[.25 .5 1]')
  assert.equal(v.params.$color2, '[1 0.5 0.5]')
  assert.equal(v.params.$nocull, '1')
})

// DX conditional blocks override regardless of order; <dx90 never applies.
check(() => {
  const v = parseVmt(`"VertexLitGeneric" {
  ">=DX90" { "$basetexture" "b/dx9" "$selfillummask" "b/mask" }
  "$basetexture" "b/plain"
  "<dx90" { "$basetexture" "b/dx8" }
  ">dx90_20b" { "$envmap" "env_cubemap" }
  "<dx90_20b" { "$envmap" "none" }
}`)
  assert.equal(v.params.$basetexture, 'b/dx9')
  assert.equal(v.params.$selfillummask, 'b/mask')
  assert.equal(v.params.$envmap, 'env_cubemap')
  assert.deepEqual(v.conditions.blocks.map(b => b.applied), [true, false, true, false])
})

// Key prefixes.
check(() => {
  const v = parseVmt(`SpriteCard {
  $basetexture "c/base"
  $startfadesize .65
  "360?$startfadesize" ".35"
  "!360?$maxsize" "40"
  "srgb?$basetexture" "c/srgb"
  "!srgb?$overbrightfactor" "1.2"
  "GPU>=2?$depthblend" "1"
  "GPU<2?$blendframes" "0"
  "lowfill?$x" "1"
  "!lowfill?$y" "1"
  "wtf?$z" "1"
}`)
  assert.equal(v.params.$basetexture, 'c/srgb')
  assert.equal(v.params.$startfadesize, '.65')
  assert.equal(v.params.$maxsize, '40')
  assert.equal(v.params.$overbrightfactor, undefined)
  assert.equal(v.params.$depthblend, '1')
  assert.equal(v.params.$blendframes, undefined)
  assert.equal(v.params.$x, undefined)
  assert.equal(v.params.$y, '1')
  assert.equal(v.params.$z, undefined)
  assert.deepEqual(v.conditions.unknown, ['wtf?'])
})

// Shader fallback blocks: the material's own DX9 / HDR DX9 block applies, the rest is dropped.
check(() => {
  const v = parseVmt(`"LightmappedGeneric" {
  "$basetexture" "d/base"
  "$envmaptint" "[ .8 .8 .8 ]"
  "LightmappedGeneric_HDR_DX9" { "$envmaptint" "[ .1 .1 .1 ]" }
  "LightmappedGeneric_DX8" { "$basetexture" "d/dx8" }
  "UnlitGeneric_DX6" { "$basetexture" "d/dx6" }
  "Proxies" { "Sine" { "resultVar" "$alpha" } }
}`)
  assert.equal(v.params.$basetexture, 'd/base')
  assert.equal(v.params.$envmaptint, '[ .1 .1 .1 ]')
  assert.equal(v.params.lightmappedgeneric_dx8, undefined)
  assert.equal(v.params.unlitgeneric_dx6, undefined)
  assert.deepEqual(v.params.proxies, { sine: { resultvar: '$alpha' } })
})

// Platform conditions after a pair.
check(() => {
  const v = parseVmt(`"VertexLitGeneric" {
  "$basetexture" "e/pc" [$WIN32]
  "$basetexture" "e/console" [$X360]
  "$bumpmap" "e/bump" [!$X360 && $WINDOWS]
}`)
  assert.equal(v.params.$basetexture, 'e/pc')
  assert.equal(v.params.$bumpmap, 'e/bump')
})

// Patch materials: include from the same source, insert (add or overwrite), then replace (existing
// keys only), nested blocks merged, on the raw tree before conditions (bsp-to-glb's order).
const files = {
  'materials/models/base/thing.vmt': `"VertexLitGeneric" { "$basetexture" "models/base/thing" "$phong" "1" ">=dx90" { "$selfillum" "1" } }`,
  'materials/maps/pl_x/models/base/thing_wvt_patch.vmt': `"patch" {
    "include" "materials/models/base/thing.vmt"
    "replace" { "$phong" "0" "$notthere" "1" }
    "insert" { "$envmap" "maps/pl_x/c0_0_0" "$phong" "2" }
  }`,
  'materials/maps/pl_x/double_patch.vmt': `patch { include "materials\\maps\\pl_x\\models\\base\\thing_wvt_patch.vmt" insert { "$alphatest" 1 } }`,
  'materials/models/base/proxied.vmt': `"VertexLitGeneric" { "$basetexture" "models/base/proxied" "$color2" "[1 1 1]" ">=dx90" { "$color2" "[2 2 2]" }
    "Proxies" { "Sine" { "resultVar" "$color2" "sinemin" "0" } "AnimatedTexture" { "animatedtexturevar" "$basetexture" } } }`,
  'materials/maps/pl_x/proxied_patch.vmt': `"patch" { "include" "materials/models/base/proxied.vmt"
    "insert" { "$color2" "[3 3 3]" "Proxies" { "Sine" { "sinemax" "1" } "Toggle" { "x" "1" } } }
    "replace" { "Proxies" { "Sine" { "sinemin" "0.5" "notthere" "1" } "Missing" { "y" "1" } } } }`,
  'materials/models/props/crate.vmt': `"VertexLitGeneric" { "$basetexture" "models/props/crate" "$alphatest" "1" "$alphatestreference" ".3" }`,
  'materials/models/other/crate.vmt': `"VertexLitGeneric" { "$basetexture" "models/other/crate" "$translucent" "1" }`,
  'materials/notex.vmt': `"UnlitGeneric" { "$color" "[1 1 1]" }`,
}
const reader = { read: p => (files[p] ? Buffer.from(files[p], 'latin1') : null) }
const pak = { read: p => (p === 'materials/models/props/crate.vmt' ? Buffer.from(`"VertexLitGeneric" { "$basetexture" "pak/crate" }`) : null) }

check(() => {
  const m = readMaterialFile(reader, 'materials/maps/pl_x/models/base/thing_wvt_patch.vmt')
  assert.equal(m.shader, 'vertexlitgeneric')
  assert.equal(m.params.$basetexture, 'models/base/thing')
  assert.equal(m.params.$phong, '0') // insert, then replace: replace wins
  assert.equal(m.params.$notthere, undefined)
  assert.equal(m.params.$selfillum, '1')
  assert.equal(m.params.$envmap, 'maps/pl_x/c0_0_0')
  assert.equal(m.patch.resolved, true)
  const d = readMaterialFile(reader, 'materials/maps/pl_x/double_patch.vmt')
  assert.equal(d.params.$alphatest, '1')
  assert.equal(d.params.$phong, '0')
  assert.equal(d.patch.include, 'materials/maps/pl_x/models/base/thing_wvt_patch.vmt')
  // Nested blocks merge; replace adds no key; a >=dx90 override of a patched key still wins,
  // because the patch changes the raw tree before conditions are evaluated.
  const p = readMaterialFile(reader, 'materials/maps/pl_x/proxied_patch.vmt')
  assert.equal(p.params.$color2, '[2 2 2]')
  assert.deepEqual(p.params.proxies, {
    sine: { resultvar: '$color2', sinemin: '0.5', sinemax: '1' },
    animatedtexture: { animatedtexturevar: '$basetexture' },
    toggle: { x: '1' },
  })
})

// resolveMaterial: search dirs first, then the bare name; the first source wins.
check(() => {
  assert.equal(resolveMaterial(reader, 'crate', ['models/other/', 'models/props']).params.$basetexture, 'models/other/crate')
  assert.equal(resolveMaterial(reader, 'Crate', ['models\\props\\']).params.$basetexture, 'models/props/crate')
  assert.equal(resolveMaterial([pak, reader], 'crate', ['models/props/']).params.$basetexture, 'pak/crate')
  assert.equal(resolveMaterial(reader, 'models/base/thing.vmt').file, 'materials/models/base/thing.vmt')
  assert.equal(resolveMaterial(reader, 'missing', ['models/props/']), null)
})

// Material semantics.
check(() => {
  const crate = resolveMaterial(reader, 'crate', ['models/props/'])
  assert.deepEqual(vmtAlpha(crate.params), { alpha: 'test', cutoff: 0.3 })
  assert.deepEqual(vmtAlpha(resolveMaterial(reader, 'crate', ['models/other/']).params), { alpha: 'blend', cutoff: null })
  assert.deepEqual(vmtAlpha({ $alphatest: '1' }), { alpha: 'test', cutoff: 0.5 })
  assert.deepEqual(vmtAlpha({ $phong: '1', $blendtintbybasealpha: '1' }), { alpha: 'opaque', cutoff: null })
  assert.deepEqual(vmtAlpha({ $alphatest: '0', $translucent: '0.0' }), { alpha: 'opaque', cutoff: null })
  assert.equal(vmtBaseTexture(crate.params), 'materials/models/props/crate.vtf')
  assert.equal(vmtBaseTexture({ $basetexture: 'Models\\Items/MedKit.vtf' }), 'materials/models/items/medkit.vtf')
  assert.equal(vmtBaseTexture(resolveMaterial(reader, 'notex').params), null)
  assert.equal(NEUTRAL, '#8a8a8a')
  assert.ok(vmtTruthy('1') && vmtTruthy('1.0') && !vmtTruthy('0') && !vmtTruthy('false') && !vmtTruthy(undefined) && !vmtTruthy(''))
})

// Malformed input never throws.
check(() => {
  for (const text of ['', '{', '}', '"VertexLitGeneric"', '"a" { "b" { "c"', '"a" { "$x" "unterminated\n "$y" "1" }', '﻿"a"{"$basetexture""x"}']) parseVmt(text)
  assert.equal(parseVmt('﻿"a"{"$basetexture""x"}').params.$basetexture, 'x')
})

console.log(`test-vmt: ${n} groups passed`)
