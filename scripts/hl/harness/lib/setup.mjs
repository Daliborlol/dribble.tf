// Shared setup for the harness scripts: checkout paths, the heavy-command lock, playwright-core and the
// headless browser. Everything resolves relative to the checkout that contains this file, so the harness
// works from the main checkout, from a git worktree, or from a copy elsewhere.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** scripts/hl/harness */
export const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The dribble.tf checkout that contains the harness. */
export const HARNESS_CHECKOUT = path.resolve(HARNESS_DIR, '..', '..', '..')

/** A setup problem the user fixes by installing or passing something; printed without a stack trace. */
export class SetupError extends Error {}

/** A path as the user would type it from the current directory (relative when inside it). */
export const shown = file => {
  const relative = path.relative(process.cwd(), file)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file
}

export const isCheckout = dir => fs.existsSync(path.join(dir, 'vite.config.mts')) && fs.existsSync(path.join(dir, 'src'))

/** The main checkout of a git worktree (the folder that holds the shared .git), or null outside git. */
export function mainCheckoutOf(dir) {
  try {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const absolute = path.resolve(dir, common)
    if (path.basename(absolute) === '.git') return path.dirname(absolute)
  } catch {}
  return null
}

export const isExecutable = file => {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, name))) return path.join(dir, name)
  }
  return null
}

// ─── LOCK ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_LOCK_NAME = 'dribble-heavy.lock'

/** --lock, else $DRIBBLE_HARNESS_LOCK, else <os.tmpdir()>/dribble-heavy.lock. */
export const lockFileFrom = value =>
  path.resolve(String(value ?? process.env.DRIBBLE_HARNESS_LOCK ?? path.join(os.tmpdir(), DEFAULT_LOCK_NAME)))

const readProc = (pid, file) => {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8')
  } catch {
    return ''
  }
}

export const parentOf = pid => {
  const stat = readProc(pid, 'stat')
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return Number(after[1]) || 0
}

// flock(1) options that take a value: -w/--wait/--timeout <seconds>, -E/--conflict-exit-code <code>.
const FLOCK_VALUE_OPTIONS = new Set(['--wait', '--timeout', '--conflict-exit-code'])
const FLOCK_VALUE_SHORT = new Set(['w', 'E'])

/** The file a `flock [options] <file> <command...>` command line locks: its first non-option argument. */
export function flockLockArgument(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') return args[i + 1] ?? null
    if (arg.startsWith('--')) {
      if (FLOCK_VALUE_OPTIONS.has(arg)) i++ // `--timeout 10`; `--timeout=10` carries its value
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const cluster = arg.slice(1) // -n, -xn, -w10, -nw 10
      const at = [...cluster].findIndex(letter => FLOCK_VALUE_SHORT.has(letter))
      if (at === cluster.length - 1) i++
      continue
    }
    return arg
  }
  return null
}

/**
 * True when an ancestor process is `flock [options] <lockFile> ...`, i.e. the lock is already held for this
 * run. Only flock's own lock argument counts: the same path appearing later, as an argument of the command
 * flock runs, does not mean flock holds it.
 */
export function ancestorHoldsLock(lockFile) {
  let target
  try {
    target = fs.statSync(lockFile)
  } catch {
    return false // nobody can hold a lock file that does not exist yet
  }
  let pid = process.ppid
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    const argv = readProc(pid, 'cmdline').split('\0').filter(Boolean)
    const held = argv.length && path.basename(argv[0]) === 'flock' ? flockLockArgument(argv.slice(1)) : null
    if (held) {
      let cwd = '/'
      try {
        cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
      } catch {}
      try {
        const stat = fs.statSync(path.resolve(cwd, held))
        if (stat.ino === target.ino && stat.dev === target.dev) return true
      } catch {}
    }
    pid = parentOf(pid)
  }
  return false
}

// ─── PLAYWRIGHT-CORE ──────────────────────────────────────────────────────────────

export const PINNED_PLAYWRIGHT = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'package.json'), 'utf8')).dependencies['playwright-core']
  } catch {
    return null
  }
})()

const installPlaywrightHint = () =>
  `Install it once (it goes into ${shown(path.join(HARNESS_DIR, 'node_modules'))}, which git ignores; ` +
  `the app's dependencies are not touched):\n  npm install --prefix ${shown(HARNESS_DIR)} --no-package-lock`

/**
 * Finds playwright-core without importing it: first by normal resolution from this folder
 * (scripts/hl/harness/node_modules and up), then, in a git worktree, in the main checkout's harness folder.
 */
export function resolvePlaywright() {
  const bases = [HARNESS_DIR]
  const main = mainCheckoutOf(HARNESS_CHECKOUT)
  if (main && path.resolve(main) !== HARNESS_CHECKOUT) bases.push(path.join(main, 'scripts', 'hl', 'harness'))
  for (const base of bases) {
    let packageFile
    try {
      packageFile = createRequire(path.join(base, 'package.json')).resolve('playwright-core/package.json')
    } catch {
      continue
    }
    const dir = path.dirname(packageFile)
    const { version } = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
    const entry = ['index.mjs', 'index.js'].map(name => path.join(dir, name)).find(file => fs.existsSync(file))
    if (entry) return { dir, version, entry }
  }
  throw new SetupError(
    `playwright-core is not installed for the harness (looked in ${bases
      .map(base => shown(path.join(base, 'node_modules')))
      .join(' and ')}).\n${installPlaywrightHint()}`
  )
}

export async function loadPlaywright(resolved = resolvePlaywright()) {
  const mod = await import(pathToFileURL(resolved.entry).href)
  const chromium = mod.chromium ?? mod.default?.chromium
  if (!chromium) throw new SetupError(`${resolved.entry} does not export chromium (playwright-core ${resolved.version}).\n${installPlaywrightHint()}`)
  return chromium
}

// ─── BROWSER ──────────────────────────────────────────────────────────────────────

// Folder layouts of `playwright install` on Linux (newest first). `install` is also the browser's name in
// playwright-core's browsers.json.
export const BROWSER_KINDS = {
  shell: {
    folder: 'chromium_headless_shell-',
    executables: ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell'],
    install: 'chromium-headless-shell',
  },
  chrome: {
    folder: 'chromium-',
    executables: ['chrome-linux64/chrome', 'chrome-linux/chrome'],
    install: 'chromium',
  },
}

/** $PLAYWRIGHT_BROWSERS_PATH (when set) and ~/.cache/ms-playwright. */
export function browserCacheDirs() {
  const dirs = []
  const fromEnv = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (fromEnv && fromEnv !== '0') dirs.push(path.resolve(fromEnv))
  dirs.push(path.join(os.homedir(), '.cache', 'ms-playwright'))
  return [...new Set(dirs)]
}

/** Every installed browser of a kind ('shell' or 'chrome') as { kind, revision, executablePath }, newest first. */
export function installedBrowsers(kind) {
  const spec = BROWSER_KINDS[kind]
  const found = []
  for (const base of browserCacheDirs()) {
    let names = []
    try {
      names = fs.readdirSync(base)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith(spec.folder)) continue
      const revision = Number(name.slice(spec.folder.length))
      if (!Number.isInteger(revision)) continue
      const executablePath = spec.executables.map(exe => path.join(base, name, exe)).find(isExecutable)
      if (executablePath) found.push({ kind, revision, executablePath })
    }
  }
  return found.sort((a, b) => b.revision - a.revision)
}

/** The installed browser of a kind at `revision` when that one is installed, else the newest, else null. */
export function findInstalledBrowser(kind, revision) {
  const all = installedBrowsers(kind)
  return all.find(hit => hit.revision === revision) ?? all[0] ?? null
}

/** resolvePlaywright(), or null when playwright-core is not installed. */
export function playwrightIfInstalled() {
  try {
    return resolvePlaywright()
  } catch {
    return null
  }
}

/**
 * The browser revisions a playwright-core install was released with, from its browsers.json:
 * { shell, chrome } (either may be missing; {} when the file cannot be read). Its revisionOverrides only
 * name older macOS builds, and the harness runs on Linux, so they are ignored.
 */
export function expectedBrowserRevisions(playwright) {
  const expected = {}
  if (!playwright?.dir) return expected
  try {
    const { browsers } = JSON.parse(fs.readFileSync(path.join(playwright.dir, 'browsers.json'), 'utf8'))
    for (const [kind, spec] of Object.entries(BROWSER_KINDS)) {
      const revision = Number(browsers.find(browser => browser.name === spec.install)?.revision)
      if (Number.isInteger(revision)) expected[kind] = revision
    }
  } catch {}
  return expected
}

const installBrowserHint = (kinds, playwright = playwrightIfInstalled()) => {
  const dir = playwright?.dir ?? path.join(HARNESS_DIR, 'node_modules', 'playwright-core')
  const version = playwright?.version ?? PINNED_PLAYWRIGHT
  return (
    `Install the browser that matches the harness's playwright-core${version ? ` ${version}` : ''} with:\n` +
    `  node ${shown(path.join(dir, 'cli.js'))} install ${BROWSER_KINDS[kinds[0]].install}\n` +
    `or name a browser executable: --browser <path> or CHROME_PATH=<path>.`
  )
}

/**
 * The browser to launch: --browser shell|chrome|<path>, else $CHROME_PATH, else, under the Playwright
 * browser cache, the chrome-headless-shell of the revision that playwright-core expects, then the chromium
 * of that revision, then the newest chrome-headless-shell, then the newest chromium. `shell` and `chrome`
 * take the expected revision of their kind when it is installed, else the newest.
 *
 * Returns { kind, revision, executablePath, source, expectedRevision }, plus `mismatch` (a warning to print)
 * when the chosen revision is not the expected one: a Playwright installed later for another project must
 * not silently change the browser behind two runs that get compared.
 */
export function resolveBrowser(requested, playwright = playwrightIfInstalled()) {
  const expected = expectedBrowserRevisions(playwright)
  const annotate = (hit, source) => {
    const want = expected[hit.kind]
    const result = { ...hit, source, expectedRevision: want ?? null }
    if (want !== undefined && hit.revision !== want) {
      result.mismatch =
        `playwright-core ${playwright.version} expects ${BROWSER_KINDS[hit.kind].install} revision ${want}, which is not ` +
        `installed; using revision ${hit.revision} (${hit.executablePath}). Runs with different browser revisions can ` +
        `differ in pixels and frame rate. Install the expected one with: node ${shown(path.join(playwright.dir, 'cli.js'))} ` +
        `install ${BROWSER_KINDS[hit.kind].install}`
    }
    return result
  }
  if (requested === 'shell' || requested === 'chrome') {
    const hit = findInstalledBrowser(requested, expected[requested])
    if (!hit) {
      throw new SetupError(
        `--browser ${requested}: no ${BROWSER_KINDS[requested].folder}*/ folder with an executable in ${browserCacheDirs().join(' or ')}.\n` +
          installBrowserHint([requested], playwright)
      )
    }
    return annotate(hit, `--browser ${requested}`)
  }
  if (requested !== undefined) {
    const file = path.resolve(String(requested))
    if (!isExecutable(file)) {
      throw new SetupError(`--browser ${requested}: no executable file at ${file}.\n${installBrowserHint(['shell'], playwright)}`)
    }
    return { kind: 'path', revision: null, executablePath: file, source: '--browser', expectedRevision: null }
  }
  if (process.env.CHROME_PATH) {
    const file = path.resolve(process.env.CHROME_PATH)
    if (!isExecutable(file)) {
      throw new SetupError(
        `CHROME_PATH=${process.env.CHROME_PATH}: no executable file there (unset it to auto-detect a browser).\n${installBrowserHint(['shell'], playwright)}`
      )
    }
    return { kind: 'path', revision: null, executablePath: file, source: 'CHROME_PATH', expectedRevision: null }
  }
  const kinds = ['shell', 'chrome']
  const exact = kinds
    .filter(kind => expected[kind] !== undefined)
    .map(kind => installedBrowsers(kind).find(hit => hit.revision === expected[kind]))
    .find(Boolean)
  const hit = exact ?? kinds.map(kind => installedBrowsers(kind)[0]).find(Boolean)
  if (!hit) {
    throw new SetupError(
      `no headless Chromium found (looked for chromium_headless_shell-*/ and chromium-*/ in ${browserCacheDirs().join(' and ')}).\n` +
        installBrowserHint(kinds, playwright)
    )
  }
  return annotate(hit, 'auto-detected')
}

/** One line for logs: `<path> (<source>, revision N, as playwright-core V expects)`, or names the mismatch. */
export function describeBrowser(browser, playwright) {
  let revision = ''
  if (browser.revision != null) {
    revision = `, revision ${browser.revision}`
    if (browser.expectedRevision != null && playwright?.version) {
      revision +=
        browser.revision === browser.expectedRevision
          ? `, as playwright-core ${playwright.version} expects`
          : `, NOT the ${browser.expectedRevision} that playwright-core ${playwright.version} expects`
    }
  }
  return `${browser.executablePath} (${browser.source}${revision})`
}

// ─── CHECKOUT MODULES ─────────────────────────────────────────────────────────────

/**
 * Text labels drawn with sharp start its bundled fontconfig, which is older than the system's and prints a
 * "Fontconfig warning" line for each newer construct in the system font config (90 lines on Arch). Tools that
 * draw labels call this first: it runs the script again as a child with those lines dropped from stderr and
 * resolves true in the parent, which must then do nothing else (the child's exit code ends the process).
 */
export async function rerunWithoutFontconfigWarnings() {
  if (process.env.DRIBBLE_HARNESS_QUIET_FC === '1') return false
  const { spawn } = await import('node:child_process')
  const { createInterface } = await import('node:readline')
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: ['inherit', 'inherit', 'pipe'],
    env: { ...process.env, DRIBBLE_HARNESS_QUIET_FC: '1' },
  })
  createInterface({ input: child.stderr }).on('line', line => {
    if (!line.startsWith('Fontconfig warning')) process.stderr.write(`${line}\n`)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  return true
}

/** require() a package from a checkout's node_modules (sharp comes in through @gltf-transform/cli). */
export function requireFromCheckout(name, checkout = HARNESS_CHECKOUT) {
  try {
    return createRequire(path.join(checkout, 'package.json'))(name)
  } catch (error) {
    throw new SetupError(
      `${name} could not be loaded from ${shown(path.join(checkout, 'node_modules'))} (${String(error?.message ?? error).split('\n')[0]}).\n` +
        `It is one of the app's dependencies: install them in the main checkout, or link its node_modules into this worktree.`
    )
  }
}
