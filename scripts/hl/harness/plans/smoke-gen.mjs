// Smoke plans: every layer mounted together, a sweep over every HL probe, key screenshots and probe reads.
//
//   node scripts/hl/harness/plans/smoke-gen.mjs <outDir> [plan ...]
//
// Writes <outDir>/smoke-<plan>.json for each plan (all of them by default). Plans and the demos they are for:
//   1438891  /home/dalibor/demo_tool/demos/1438891.dem  koth_product_final (also runs with --perf-play 50%:10:rts)
//   1434434  1434434.dem  pl_vigil_rc10 (short, the fastest check)
//   1440442  1440442.dem  cp_steel_f12
//   1429417  1429417.dem  tow_tetsudo_b10c, base-parser fallback, no timeline (memory gate 3000 MB)
//   1428628  1428628.dem  tow_tetsudo_b10c, base-parser fallback, delayed start (memory gate 3000 MB)
//   sample   public/samples/i52_snakewater_gc.dem  the bundled 6v6 demo
// Ticks, players ('BigZZZ', 'kanon', entity 4) and the moments they show belong to those demos.
// The sweep always lists assets.status and assets.items ('absent' on a page without them, such as a06e4c7) and
// skips assets.waitIdle, which the harness itself awaits before every shot; the status step records both.
// Summarise a run with: node scripts/hl/harness/summarize.mjs <out>/manifest.json
import fs from 'node:fs'
import path from 'node:path'

const [outDir, ...only] = process.argv.slice(2)
if (!outDir || outDir.startsWith('-')) {
  console.error('usage: node scripts/hl/harness/plans/smoke-gen.mjs <outDir> [plan ...]   (plans: 1438891 1434434 1440442 1429417 1428628 sample)')
  process.exit(64)
}
const SWEEP = `(() => { const d = window.__dribble; const skip = new Set(['extras.restart','extras.load','extras.call','viewmodel.debug','pov.wallScan','pov.wallDistance','memory.release','memory.digest','assets.waitIdle']); const want = ['assets.status','assets.items']; const out = {}; const names = d.hl.probes(); for (const n of [...names, ...want.filter(w => !names.includes(w))]) { if (skip.has(n)) continue; if (!names.includes(n)) { out[n] = 'absent'; continue } let r; try { r = d.hl.probe(n) } catch (e) { r = { error: String(e) } } let s = ''; try { s = JSON.stringify(r) ?? '' } catch (e) { s = 'unserializable' } out[n] = r && typeof r === 'object' && !Array.isArray(r) && 'error' in r && r.error != null ? 'ERROR: ' + String(r.error).slice(0, 200) : 'ok ' + s.length } return out })()`
const STATUS = `(() => { const d = window.__dribble; const st = d.hl.status(); const a = st.meta ? st.meta.available : {}; const ui = d.stores.useInstance.getState(); const pd = ui.parsedDemo; return { status: st.status, unavailable: Object.entries(a || {}).filter(([, v]) => !v).map(([k]) => k), warnings: st.meta && st.meta.warnings, mapStatus: ui.mapStatus, mapNodes: ui.mapNodes ? ui.mapNodes.size : null, fallback: pd ? pd.parserFallback ?? null : null, fallbackInfo: pd ? pd.parserFallbackInfo ?? null : null, scene: d.getState().scene, probes: d.hl.probes().length, props: d.hl.probe('map.props'), frameCache: d.hl.probe('fx.frameCache'), mapdyn: d.hl.probe('mapdyn.summary'), assets: d.hl.probes().includes('assets.status') ? { status: d.hl.probe('assets.status'), items: d.hl.probe('assets.items') } : null } })()`
const POVSTATE = `(() => { const d = window.__dribble; return { pov: d.hl.probe('pov.state'), vm: d.hl.probe('viewmodel.state'), hud: d.hl.probe('pov.hud'), layout: d.hl.probe('hud.layout') } })()`
const base = [
  { name: 'ready', tick: '5%', mode: 'rts', screenshot: false, eval: 'window.__dribble.hl.waitReady(240000)' },
  { name: 'status', tick: '5%', mode: 'rts', screenshot: false, eval: STATUS },
]
const plans = {
  '1438891': [
    ...base,
    { name: 'rts-10', tick: '10%', mode: 'rts' },
    { name: 'sweep-40', tick: '40%', mode: 'rts', screenshot: false, eval: SWEEP },
    { name: 'rts-50', tick: '50%', mode: 'rts' },
    { name: 'rts-90', tick: '90%', mode: 'rts' },
    { name: 'pov-medic-uber', tick: 35002, mode: 'pov', player: 'medic@red', eval: POVSTATE },
    { name: 'pov-engineer-21500', tick: 21500, mode: 'pov', player: 'BigZZZ', eval: POVSTATE },
    { name: 'pov-sniper-50', tick: '50%', mode: 'pov', player: 'sniper@blue', eval: POVSTATE },
    { name: 'pov-spy-30', tick: '30%', mode: 'pov', player: 'spy@red', eval: POVSTATE },
    { name: 'rts-cloak-3443', tick: 3445, mode: 'rts' },
    { name: 'scoreboard-end', tick: '99%', mode: 'rts', eval: "(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab' })); return window.__dribble.hl.probe('hud.scoreboard') })()" },
    { name: 'sweep-75-pov', tick: '75%', mode: 'pov', player: 'engineer@blue', screenshot: false, eval: SWEEP },
  ],
  '1434434': [
    ...base,
    { name: 'rts-10', tick: '10%', mode: 'rts' },
    { name: 'sweep-40', tick: '40%', mode: 'rts', screenshot: false, eval: SWEEP },
    { name: 'rts-50', tick: '50%', mode: 'rts' },
    { name: 'pov-kanon-9096', tick: 9096, mode: 'pov', player: 'kanon', eval: "(() => { const d = window.__dribble; return { pov: d.hl.probe('pov.state'), plates: d.hl.probe('fx.plates') } })()" },
    { name: 'pov-heavy-60', tick: '60%', mode: 'pov', player: 'heavy@blue', eval: POVSTATE },
    { name: 'pov-demo-80', tick: '80%', mode: 'pov', player: 'demoman@red', eval: POVSTATE },
  ],
  '1440442': [
    ...base,
    { name: 'rts-10', tick: '10%', mode: 'rts' },
    { name: 'kritz-4971', tick: 4971, mode: 'rts' },
    { name: 'sweep-40', tick: '40%', mode: 'rts', screenshot: false, eval: SWEEP },
    { name: 'rts-50', tick: '50%', mode: 'rts' },
    { name: 'pov-soldier-50', tick: '50%', mode: 'pov', player: 'soldier@blue', eval: POVSTATE },
    { name: 'pov-medic-70', tick: '70%', mode: 'pov', player: 'medic@red', eval: POVSTATE },
  ],
  '1429417': [
    ...base,
    { name: 'rts-10', tick: '10%', mode: 'rts' },
    { name: 'sweep-40', tick: '40%', mode: 'rts', screenshot: false, eval: SWEEP },
    { name: 'rts-62', tick: '62%', mode: 'rts' },
    { name: 'pov-sniper-30', tick: '30%', mode: 'pov', player: 'sniper@red', eval: POVSTATE },
    { name: 'mem', tick: '62%', mode: 'rts', screenshot: false, eval: "(() => { const m = performance.memory; return m ? { usedMB: Math.round(m.usedJSHeapSize / 1048576), totalMB: Math.round(m.totalJSHeapSize / 1048576) } : null })()" },
  ],
}

const ROUTE = `(() => { const pd = window.__dribble.stores.useInstance.getState().parsedDemo; let first = null, last = null; const data = pd.playerCache.positionCache.data; for (const arr of data) { const n = Math.min(pd.ticks, Math.floor(arr.length / 3)); for (let t = 0; t < n; t++) { if (arr[t * 3] || arr[t * 3 + 1] || arr[t * 3 + 2]) { if (first === null || t < first) first = t; break } } for (let t = n - 1; t >= 0; t--) { if (arr[t * 3] || arr[t * 3 + 1] || arr[t * 3 + 2]) { if (last === null || t > last) last = t; break } } } return { fallback: pd.parserFallback ?? null, trigger: pd.parserFallbackInfo ? pd.parserFallbackInfo.trigger : null, failure: pd.parserFallbackFailure || null, ticks: pd.ticks, startTick: pd.startTick, firstPlayerTick: first, lastPlayerTick: last } })()`
plans['1438891'].push(
  { name: 'pov-teammate-deathcam', tick: 2352, mode: 'pov', player: 4, eval: "(async () => { const d = window.__dribble; await d.frames(10); const hud = d.hl.probe('pov.hud'); return { state: d.hl.probe('pov.state'), header: hud && hud.model ? hud.model.header : null } })()" },
  { name: 'pov-before-fight', tick: 52000, mode: 'pov', player: 'medic@red', screenshot: false },
  { name: 'fight-declutter', tick: 52029, mode: 'rts', eval: "window.__dribble.hl.probe('nameplates.declutter')" },
)
plans['1434434'].push(
  { name: 'sandvich-midair', tick: 11247, mode: 'rts', eval: "(() => { const d = window.__dribble; return { moving: d.hl.probe('mapdyn.moving', 11245), summary: d.hl.probe('mapdyn.summary') } })()" },
)
plans['1440442'].push(
  { name: 'padlocks-hud', tick: '30%', mode: 'rts', eval: "window.__dribble.hl.probe('objective.hud')" },
)
plans['1428628'] = [
  ...base,
  { name: 'route', tick: '5%', mode: 'rts', screenshot: false, eval: ROUTE },
  { name: 'rts-02', tick: '2%', mode: 'rts' },
  { name: 'sweep-40', tick: '40%', mode: 'rts', screenshot: false, eval: SWEEP },
  { name: 'rts-50', tick: '50%', mode: 'rts' },
  { name: 'pov-medic-02', tick: '2%', mode: 'pov', player: 'medic@red', eval: POVSTATE },
  { name: 'rts-end', tick: '99%', mode: 'rts' },
]
plans['sample'] = [
  ...base,
  { name: 'rts-30', tick: '30%', mode: 'rts' },
  { name: 'sweep-40', tick: '40%', mode: 'rts', screenshot: false, eval: SWEEP },
  { name: 'pov-soldier-50', tick: '50%', mode: 'pov', player: 'soldier@blue', eval: POVSTATE },
]
const unknown = only.filter(name => !plans[name])
if (unknown.length) {
  console.error(`unknown plan(s): ${unknown.join(', ')} (have ${Object.keys(plans).join(' ')})`)
  process.exit(64)
}
fs.mkdirSync(outDir, { recursive: true })
for (const [demo, steps] of Object.entries(plans)) {
  if (only.length && !only.includes(demo)) continue
  const file = path.join(outDir, `smoke-${demo}.json`)
  fs.writeFileSync(file, JSON.stringify(steps, null, 1))
  console.log(`${file}: ${steps.length} steps`)
}
