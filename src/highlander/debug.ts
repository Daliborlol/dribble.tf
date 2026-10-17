// Highlander probe registry for the debug bridge (contract section 3.10).
// Every feature registers at least one probe named `<feature>.<what>` at module load of its layer;
// the bridge exposes them as window.__dribble.hl.probe(name, ...args) and .probes().

export type HlProbe = (...args: any[]) => unknown // must return JSON-safe data

const probes = new Map<string, HlProbe>()

export function registerHlProbe(name: string, fn: HlProbe): void {
  probes.set(name, fn)
}

/** Runs a probe. Unknown names and thrown errors come back as `{ error }` so harness plans never crash. */
export function runHlProbe(name: string, ...args: unknown[]): unknown {
  const fn = probes.get(name)
  if (!fn) return { error: `no HL probe named "${name}"`, probes: listHlProbes() }
  try {
    return fn(...args)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function listHlProbes(): string[] {
  return Array.from(probes.keys()).sort()
}
