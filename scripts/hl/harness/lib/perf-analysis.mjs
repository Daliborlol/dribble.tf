// Pure analysis of a perf window: frame statistics, Chromium trace breakdown and CPU profile tables. shot.mjs,
// tools/perf-matrix.mjs and tools/perf-breakdown.mjs share these, so a number means the same in every report.

/** The harness's percentile: the element at floor(p% of n) of an ascending array. */
export const percentileOf = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0

const round = (value, digits = 1) => Number(Number(value).toFixed(digits))

/** { n, avg, min, p50, p95, max } of a list of numbers; nulls and NaN are skipped; null when nothing is left. */
export function statOf(values, digits = 1) {
  const clean = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (!clean.length) return null
  const sum = clean.reduce((total, value) => total + value, 0)
  return {
    n: clean.length,
    avg: round(sum / clean.length, digits),
    min: round(clean[0], digits),
    p50: round(percentileOf(clean, 50), digits),
    p95: round(percentileOf(clean, 95), digits),
    max: round(clean[clean.length - 1], digits),
  }
}

const VSYNC_MS = 1000 / 60

/**
 * Per-frame statistics of a list of frame times in ms. over20Pct counts frames that missed at least one 60 Hz vsync,
 * over34Pct frames that missed at least two. droppedVsyncPct is the share of the window's vsyncs that showed no new
 * frame, so one 100 ms frame weighs as five dropped vsyncs; it only means that with vsync on.
 */
export function frameStats(deltas) {
  const sorted = [...deltas].sort((a, b) => a - b)
  const count = sorted.length
  if (!count) return null
  const total = sorted.reduce((sum, value) => sum + value, 0)
  const share = limit => round((sorted.filter(value => value > limit).length / count) * 100, 2)
  const vsyncs = deltas.reduce((sum, value) => sum + Math.max(1, Math.round(value / VSYNC_MS)), 0)
  return {
    count,
    fps: round(1000 / (total / count)),
    avg: round(total / count, 2),
    p50: round(percentileOf(sorted, 50), 2),
    p95: round(percentileOf(sorted, 95), 2),
    p99: round(percentileOf(sorted, 99), 2),
    max: round(sorted[count - 1], 2),
    over20Pct: share(20),
    over34Pct: share(34),
    droppedVsyncPct: round(((vsyncs - count) / Math.max(1, vsyncs)) * 100, 2),
  }
}

/** The main thread's time per frame from vsync to the end of the frame's task, with the share over a 60 Hz budget. */
export function frameWorkStats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return {
    count: sorted.length,
    avg: round(total / sorted.length, 2),
    p50: round(percentileOf(sorted, 50), 2),
    p95: round(percentileOf(sorted, 95), 2),
    p99: round(percentileOf(sorted, 99), 2),
    max: round(sorted[sorted.length - 1], 2),
    over16Pct: round((sorted.filter(value => value > VSYNC_MS).length / sorted.length) * 100, 2),
  }
}

// ─── TRACE ────────────────────────────────────────────────────────────────────────

export const WINDOW_START_MARK = 'dribble-perf-window-start'
export const WINDOW_END_MARK = 'dribble-perf-window-end'

/** Trace event name -> report category for the renderer main thread (self time). */
const CATEGORY_RULES = [
  ['gc', /(^|[.:])(MinorGC|MajorGC|Scavenge|GC|BlinkGC)|^V8\.GC|^v8\.gc|^cppgc|CppGC|Sweep|Marking/],
  ['style', /^(UpdateLayoutTree|RecalculateStyles|ScheduleStyleRecalculation|Document::(UpdateStyle|updateStyle|recalcStyle|rebuildLayoutTree|updateActiveStyle)|StyleEngine|StyleRecalc|InvalidateLayout|ParseAuthorStyleSheet|Blink\.Style\.)/],
  ['layout', /^(Layout$|LayoutShift|LayoutNG|LocalFrameView::(PerformLayout|performLayout|UpdateLayout|layout|performPostLayoutTasks)|UpdateLayout|LayoutObject|InlineNode::|Blink\.Layout\.)/],
  ['prePaint', /^(PrePaint|LocalFrameView::RunPrePaint|PrePaintTreeWalk|CullRectUpdate|Blink\.PrePaint\.)/],
  ['paint', /^(Paint$|PaintImage|LocalFrameView::RunPaint|PaintController|PaintLayerPainter|Paint::|GraphicsLayer|RecordingSource::|Blink\.Paint\.)/],
  ['layerize', /^(Layerize|UpdateLayer|UpdateLayerTree|CompositeLayers|PaintArtifactCompositor|LocalFrameView::(UpdateStyleAndLayout|RunStyleAndLayout|RunAccessibility|RunCompositingInputs|pushPaintArtifact)|LayerTreeHost::UpdateLayers|LayerTreeHost::DoUpdateLayers|PictureLayer::Update|Blink\.(CompositingInputs|CompositingCommit)\.)/],
  ['commit', /^(Commit$|ProxyMain::|LayerTreeHost::(Commit|Finish|Begin|WillCommit|DidCommit|ApplyCompositorChanges)|ThreadProxy|cc::ProxyMain|Scheduler::|WebFrameWidgetImpl::|WidgetBase::|auto cc::LayerTreeHost::|AnimationHost::|LocalFrameView::ScheduleAnimation)/],
  ['hitTest', /^(HitTest|EventHandler::(HitTest|handleMouseMoveEvent)|LocalFrameView::HitTest|LayoutView::HitTest)/],
  ['gpuSubmit', /^(CommandBuffer|GLES2|GpuChannel|gpu::|SharedImage|WebGL|DrawingBuffer|ContextProvider|RasterImplementation|CanvasResource|Canvas2D|OffscreenCanvas|TransferBuffer|SwapBuffers)/],
  ['scripting', /^(FunctionCall|EvaluateScript|RunMicrotasks|FireAnimationFrame|TimerFire|FireIdleCallback|EventDispatch|MessagePort|v8\.|V8\.|V8Console|HandlePostMessage|BackgroundDeserialize|PageAnimator::serviceScriptedAnimations|FrameRequestCallbackCollection|SerializedScriptValueFactory)/],
  ['taskOverhead', /^(RunTask|ThreadControllerImpl::RunTask|AsyncTask|SimpleWatcher|Receive mojo message|BlinkScheduler_|EpollEvent)/],
]

export const categoryOf = name => CATEGORY_RULES.find(([, rule]) => rule.test(name))?.[0] ?? 'other'

/**
 * The events of a trace file's bytes. Each event is parsed by itself, because a trace with an event storm does not fit
 * one JavaScript string (512 MB), and only the fields the reports read are kept.
 */
export function parseTraceBuffer(buffer) {
  const events = []
  const QUOTE = 0x22
  const BACKSLASH = 0x5c
  const OPEN = 0x7b
  const CLOSE = 0x7d
  const start = buffer.indexOf('"traceEvents"')
  let at = start >= 0 ? buffer.indexOf('[', start) + 1 : buffer.indexOf('[') + 1
  let depth = 0
  let inString = false
  let begin = -1
  for (; at < buffer.length; at++) {
    const byte = buffer[at]
    if (inString) {
      if (byte === BACKSLASH) at++
      else if (byte === QUOTE) inString = false
      continue
    }
    if (byte === QUOTE) inString = true
    else if (byte === OPEN) {
      if (depth++ === 0) begin = at
    } else if (byte === CLOSE) {
      if (--depth === 0) {
        const { name, cat, ph, pid, tid, ts, dur, tdur, tts, args } = JSON.parse(buffer.toString('utf8', begin, at + 1))
        // args only for what is read later: thread names and the window's marks
        events.push({ name, cat, ph, pid, tid, ts, dur, tdur, tts, args: ph === 'M' || name === 'TimeStamp' ? args : undefined })
      }
    } else if (byte === 0x5d && depth === 0) break
  }
  return events
}

/** Complete events of one thread: X events plus matched B/E pairs. */
function completeEventsByThread(events) {
  const byThread = new Map()
  const open = new Map()
  const push = (key, event) => {
    let list = byThread.get(key)
    if (!list) byThread.set(key, (list = []))
    list.push(event)
  }
  for (const e of events) {
    if (e.ph === 'X' && e.dur > 0) push(`${e.pid}:${e.tid}`, { name: e.name, cat: e.cat ?? '', ts: e.ts, dur: e.dur, tdur: e.tdur ?? null })
    else if (e.ph === 'B' || e.ph === 'E') {
      const key = `${e.pid}:${e.tid}`
      let stack = open.get(key)
      if (!stack) open.set(key, (stack = []))
      if (e.ph === 'B') stack.push(e)
      else {
        const begin = stack.pop()
        if (begin && e.ts > begin.ts) push(key, { name: begin.name, cat: begin.cat ?? '', ts: begin.ts, dur: e.ts - begin.ts, tdur: e.tts && begin.tts ? e.tts - begin.tts : null })
      }
    }
  }
  return byThread
}

/** Clips events to [start, end] and returns { busyUs, cpuUs, selfByName, countByName } with nesting resolved. */
function threadTotals(list, start, end) {
  const inWindow = list
    .filter(e => e.ts < end && e.ts + e.dur > start)
    .map(e => {
      const ts = Math.max(e.ts, start)
      const stop = Math.min(e.ts + e.dur, end)
      return { ...e, ts, dur: stop - ts, whole: e.dur }
    })
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur)
  const selfByName = new Map()
  const countByName = new Map()
  const stack = []
  let busyUs = 0
  let cpuUs = 0
  let busyUntil = -Infinity
  const close = frame => {
    selfByName.set(frame.event.name, (selfByName.get(frame.event.name) ?? 0) + frame.self)
  }
  for (const event of inWindow) {
    countByName.set(event.name, (countByName.get(event.name) ?? 0) + 1)
    while (stack.length && stack[stack.length - 1].end <= event.ts) close(stack.pop())
    const stop = event.ts + event.dur
    if (stack.length) stack[stack.length - 1].self -= Math.min(event.dur, stack[stack.length - 1].end - event.ts)
    else {
      // an outermost event: wall-clock busy time, and its CPU time when the trace has it (scaled when clipped)
      busyUs += Math.max(0, stop - Math.max(event.ts, busyUntil))
      if (event.tdur != null) cpuUs += event.tdur * (event.dur / Math.max(1, event.whole))
    }
    busyUntil = Math.max(busyUntil, stop)
    stack.push({ event, end: stop, self: event.dur })
  }
  while (stack.length) close(stack.pop())
  return { busyUs, cpuUs, selfByName, countByName }
}

const THREAD_ROLES = [
  ['rendererMain', /^CrRendererMain/],
  ['rendererCompositor', /^Compositor$/],
  ['gpuMain', /^CrGpuMain/],
  ['viz', /^VizCompositorThread/],
  ['browserMain', /^CrBrowserMain/],
]
const REPORTED_COUNTS = ['FireAnimationFrame', 'BeginMainThreadFrame', 'Commit', 'Paint', 'Layout', 'UpdateLayoutTree', 'DrawFrame', 'Display::DrawAndSwap', 'Graphics.Pipeline.DrawAndSwap', 'MinorGC', 'MajorGC', 'V8.GC_SCAVENGER', 'SwapBuffers', 'BufferPresented']

/**
 * The busy time of a trace by thread role, and the renderer main thread by category, in ms per frame. The window comes
 * from the console.timeStamp marks shot.mjs sets around the measured seconds; without them the whole trace counts.
 * Returns { frames, elapsedMs, windowed, threads, rendererCategories, counts, text }.
 */
export function traceBreakdown(trace, elapsedMs, frames) {
  const events = trace.traceEvents ?? trace
  const threadName = new Map()
  const marks = {}
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args?.name)
    if (e.name === 'TimeStamp') {
      const message = e.args?.data?.message ?? e.args?.data?.name
      if (message === WINDOW_START_MARK) marks.start = e.ts
      if (message === WINDOW_END_MARK) marks.end = e.ts
    }
  }
  const windowed = marks.start !== undefined && marks.end !== undefined
  let start = marks.start
  let end = marks.end
  if (!windowed) {
    start = Infinity
    end = -Infinity
    for (const e of events) {
      if (e.ph === 'M' || !Number.isFinite(e.ts)) continue
      start = Math.min(start, e.ts)
      end = Math.max(end, e.ts + (e.dur ?? 0))
    }
  }
  const windowMs = (end - start) / 1000
  const perFrame = us => round(us / 1000 / Math.max(1, frames), 2)
  const byThread = completeEventsByThread(events)

  const totals = new Map()
  for (const [key, list] of byThread) {
    const name = threadName.get(key)
    if (!name) continue
    const role = THREAD_ROLES.find(([, rule]) => rule.test(name))?.[0]
    if (!role) continue
    const result = threadTotals(list, start, end)
    const known = totals.get(role)
    // several renderers exist (the probe page's, spare ones): keep the busiest of each role with one instance per page
    if (!known || result.busyUs > known.busyUs) totals.set(role, { ...result, key, name })
  }
  // The compositor thread of the page's renderer, not of another renderer.
  const rendererPid = totals.get('rendererMain')?.key.split(':')[0]
  if (rendererPid) {
    for (const [key, list] of byThread) {
      if (threadName.get(key) === 'Compositor' && key.split(':')[0] === rendererPid) totals.set('rendererCompositor', { ...threadTotals(list, start, end), key, name: 'Compositor' })
    }
  }

  const threads = {}
  for (const [role, total] of totals) {
    threads[role] = { thread: total.name, busyMsPerFrame: perFrame(total.busyUs), cpuMsPerFrame: total.cpuUs ? perFrame(total.cpuUs) : null, busyPct: round((total.busyUs / 1000 / Math.max(1, windowMs)) * 100) }
  }

  const rendererCategories = {}
  const renderer = totals.get('rendererMain')
  if (renderer) {
    const byCategory = new Map()
    for (const [name, us] of renderer.selfByName) {
      const category = categoryOf(name)
      byCategory.set(category, (byCategory.get(category) ?? 0) + us)
    }
    for (const [category, us] of [...byCategory].sort((a, b) => b[1] - a[1])) rendererCategories[category] = perFrame(us)
  }

  const counts = {}
  for (const name of REPORTED_COUNTS) {
    let count = 0
    for (const total of totals.values()) count += total.countByName.get(name) ?? 0
    if (count) counts[name] = count
  }

  const lines = [
    `# ${frames} frames in ${Math.round(elapsedMs)} ms; trace window ${Math.round(windowMs)} ms${windowed ? ' (marked)' : ' (whole trace, no marks)'}; ms per frame, self time, nesting resolved`,
    '',
    '# busy per thread (wall clock of outermost events; cpu from thread time when the trace has it)',
  ]
  for (const [role, row] of Object.entries(threads).sort((a, b) => b[1].busyMsPerFrame - a[1].busyMsPerFrame)) {
    lines.push(`${String(row.busyMsPerFrame).padStart(7)}  ${String(row.cpuMsPerFrame ?? '-').padStart(7)} cpu  ${String(row.busyPct).padStart(5)} % of the window  ${role} (${row.thread})`)
  }
  lines.push('', '# renderer main thread by category')
  for (const [category, ms] of Object.entries(rendererCategories)) lines.push(`${String(ms).padStart(7)}  ${category}`)
  lines.push('', '# event counts in the window')
  for (const [name, count] of Object.entries(counts)) lines.push(`${String(count).padStart(7)}  ${name}`)
  lines.push('', '# self time per event name')
  const rows = []
  for (const [role, total] of totals) for (const [name, us] of total.selfByName) rows.push([`${role} ${name}`, us])
  for (const [name, us] of rows.sort((a, b) => b[1] - a[1]).slice(0, 80)) lines.push(`${String(perFrame(us)).padStart(7)}  ${name}`)

  return { frames, elapsedMs: Math.round(elapsedMs), windowMs: Math.round(windowMs), windowed, threads, rendererCategories, counts, text: lines.join('\n') + '\n' }
}

// ─── CPU PROFILE ──────────────────────────────────────────────────────────────────

/** WebGL 2 entry points, so a CPU profile's native frames can be counted as command submission. */
const WEBGL_CALLS = new Set(
  `activeTexture attachShader beginQuery beginTransformFeedback bindAttribLocation bindBuffer bindBufferBase bindBufferRange bindFramebuffer
  bindRenderbuffer bindSampler bindTexture bindTransformFeedback bindVertexArray blendColor blendEquation blendEquationSeparate blendFunc
  blendFuncSeparate blitFramebuffer bufferData bufferSubData checkFramebufferStatus clear clearBufferfi clearBufferfv clearBufferiv
  clearBufferuiv clearColor clearDepth clearStencil clientWaitSync colorMask compileShader compressedTexImage2D compressedTexImage3D
  compressedTexSubImage2D compressedTexSubImage3D copyBufferSubData copyTexImage2D copyTexSubImage2D copyTexSubImage3D createBuffer
  createFramebuffer createProgram createQuery createRenderbuffer createSampler createShader createTexture createTransformFeedback
  createVertexArray cullFace deleteBuffer deleteFramebuffer deleteProgram deleteQuery deleteRenderbuffer deleteSampler deleteShader
  deleteSync deleteTexture deleteTransformFeedback deleteVertexArray depthFunc depthMask depthRange detachShader disable
  disableVertexAttribArray drawArrays drawArraysInstanced drawBuffers drawElements drawElementsInstanced drawRangeElements enable
  enableVertexAttribArray endQuery endTransformFeedback fenceSync finish flush framebufferRenderbuffer framebufferTexture2D
  framebufferTextureLayer frontFace generateMipmap getActiveAttrib getActiveUniform getAttribLocation getBufferSubData getContextAttributes
  getError getExtension getInternalformatParameter getParameter getProgramInfoLog getProgramParameter getShaderInfoLog getShaderParameter
  getShaderPrecisionFormat getSupportedExtensions getUniformBlockIndex getUniformLocation hint invalidateFramebuffer invalidateSubFramebuffer
  isContextLost lineWidth linkProgram pixelStorei polygonOffset readBuffer readPixels renderbufferStorage renderbufferStorageMultisample
  sampleCoverage samplerParameterf samplerParameteri scissor shaderSource stencilFunc stencilFuncSeparate stencilMask stencilMaskSeparate
  stencilOp stencilOpSeparate texImage2D texImage3D texParameterf texParameteri texStorage2D texStorage3D texSubImage2D texSubImage3D
  transformFeedbackVaryings uniform1f uniform1fv uniform1i uniform1iv uniform1ui uniform1uiv uniform2f uniform2fv uniform2i uniform2iv
  uniform2ui uniform2uiv uniform3f uniform3fv uniform3i uniform3iv uniform3ui uniform3uiv uniform4f uniform4fv uniform4i uniform4iv uniform4ui
  uniform4uiv uniformBlockBinding uniformMatrix2fv uniformMatrix2x3fv uniformMatrix2x4fv uniformMatrix3fv uniformMatrix3x2fv uniformMatrix3x4fv
  uniformMatrix4fv uniformMatrix4x2fv uniformMatrix4x3fv useProgram vertexAttrib1f vertexAttrib2f vertexAttrib3f vertexAttrib4f
  vertexAttribDivisor vertexAttribI4i vertexAttribI4ui vertexAttribIPointer vertexAttribPointer viewport waitSync`.split(/\s+/)
)

const NON_CODE = new Set(['(root)', '(idle)', '(program)', '(garbage collector)'])

/**
 * The tables of a V8 CPU profile, in ms per frame: self time and inclusive time per function, and native WebGL calls,
 * garbage collection and idle time apart. `locate(url, line, column)` (optional) names a frame's source group through a
 * source map, which adds self time per group, and `describe(url, line, column)` the source position to show instead of
 * the bundle's. Recursive functions count once in inclusive time.
 */
export function profileBreakdown(profile, { frames, locate = null, describe = null, topN = 30 } = {}) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const selfUs = new Map()
  const intervals = profile.timeDeltas ?? []
  ;(profile.samples ?? []).forEach((id, index) => selfUs.set(id, (selfUs.get(id) ?? 0) + (intervals[index] ?? 0)))

  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const keyOf = node => {
    const frame = node.callFrame
    const file = frame.url ? frame.url.replace(/^.*\//, '') : ''
    if (!file) return frame.functionName || '(anonymous)'
    const place = describe?.(frame.url, frame.lineNumber, frame.columnNumber)
    return `${frame.functionName || '(anonymous)'} ${place ?? `${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`}`
  }

  const self = new Map()
  const inclusive = new Map()
  const groups = new Map()
  let totalUs = 0
  let idleUs = 0
  let gcUs = 0
  let programUs = 0
  let webglUs = 0
  const webglByCall = new Map()
  for (const [id, us] of selfUs) {
    const node = byId.get(id)
    if (!node) continue
    const frame = node.callFrame
    totalUs += us
    const name = frame.functionName
    if (name === '(idle)') idleUs += us
    else if (name === '(garbage collector)') gcUs += us
    else if (name === '(program)') programUs += us
    else if (!frame.url && WEBGL_CALLS.has(name)) {
      webglUs += us
      webglByCall.set(name, (webglByCall.get(name) ?? 0) + us)
    }
    const key = keyOf(node)
    self.set(key, (self.get(key) ?? 0) + us)
    if (NON_CODE.has(name)) continue
    // inclusive: every distinct function on this node's stack
    const seen = new Set()
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const up = byId.get(at)
      if (!up || NON_CODE.has(up.callFrame.functionName)) continue
      const upKey = keyOf(up)
      if (seen.has(upKey)) continue
      seen.add(upKey)
      inclusive.set(upKey, (inclusive.get(upKey) ?? 0) + us)
    }
    if (locate && frame.url) {
      const group = locate(frame.url, frame.lineNumber, frame.columnNumber) ?? '(unmapped)'
      groups.set(group, (groups.get(group) ?? 0) + us)
    } else if (locate) {
      const group = WEBGL_CALLS.has(name) ? '(WebGL calls)' : '(native)'
      groups.set(group, (groups.get(group) ?? 0) + us)
    }
  }
  const perFrame = us => round(us / 1000 / Math.max(1, frames), 3)
  const rank = (map, n = topN) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, us]) => ({ name, msPerFrame: perFrame(us), pct: round((us / Math.max(1, totalUs - idleUs)) * 100) }))
  return {
    frames,
    totalMs: Math.round(totalUs / 1000),
    busyMsPerFrame: perFrame(totalUs - idleUs),
    idleMsPerFrame: perFrame(idleUs),
    gcMsPerFrame: perFrame(gcUs),
    programMsPerFrame: perFrame(programUs),
    webglMsPerFrame: perFrame(webglUs),
    topSelf: rank(self),
    topInclusive: rank(inclusive),
    topWebgl: rank(webglByCall, 15),
    groups: rank(groups, 30),
  }
}
