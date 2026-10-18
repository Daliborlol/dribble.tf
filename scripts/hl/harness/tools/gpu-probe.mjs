#!/usr/bin/env node
// Probe which headless Chromium flag sets give a hardware WebGL context on this machine:
//   node scripts/hl/harness/tools/gpu-probe.mjs [--browser shell|chrome|<path>]   (launches Chromium: run it under the lock)
// For each browser (default: the newest installed headless shell and chromium) and flag set it prints the
// frame rate of 60 rAF frames and the WebGL renderer string. 'swiftshader' in the renderer means CPU rendering.
import { SetupError, findInstalledBrowser, loadPlaywright, resolveBrowser } from '../lib/setup.mjs'

const argv = process.argv.slice(2)
const requested = argv[0] === '--browser' ? argv[1] : undefined
let chromium
const BIN = {}
try {
  chromium = await loadPlaywright()
  if (requested) BIN[requested] = resolveBrowser(requested).executablePath
  else for (const kind of ['shell', 'chrome']) {
    const hit = findInstalledBrowser(kind)
    if (hit) BIN[kind] = hit.executablePath
  }
  if (!Object.keys(BIN).length) BIN.path = resolveBrowser(undefined).executablePath // CHROME_PATH, or the install hint
} catch (error) {
  console.error(error instanceof SetupError ? error.message : error)
  process.exit(1)
}
const SETS = {
  swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  vulkan: ['--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl'],
  egl: ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl'],
  gl: ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl'],
}
const page_html = `<canvas id=c width=1280 height=720></canvas><script>
const gl = document.getElementById('c').getContext('webgl2');
const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
window.info = gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'no webgl2';
</script>`
for (const [binName, bin] of Object.entries(BIN)) {
  for (const [setName, args] of Object.entries(SETS)) {
    let browser
    try {
      browser = await chromium.launch({ executablePath: bin, headless: true, args, timeout: 30000 })
      const page = await browser.newPage()
      await page.setContent(page_html)
      const info = await page.evaluate(() => window.info)
      const fps = await page.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { if (++n >= 60) r(Math.round(60000 / (performance.now() - t0))); else requestAnimationFrame(f) }; requestAnimationFrame(f) }))
      console.log(binName.padEnd(7), setName.padEnd(12), String(fps).padStart(4) + 'fps', info)
    } catch (error) {
      console.log(binName.padEnd(7), setName.padEnd(12), 'ERROR', String(error.message).split('\n')[0])
    } finally {
      await browser?.close().catch(() => {})
    }
  }
}
