// Init script of the perf scenarios in spectator mode. Headless Chromium answers a pointer lock with a storm of
// synthetic input events: 20 000 WidgetInputHandler messages a second, which keep the browser's main thread and the
// renderer's compositor thread at 100 %, and on battery take from the power budget the page needs. Nothing moves the
// spectator camera during a window, so the lock is turned into a no-op there and the window measures the page alone.
Element.prototype.requestPointerLock = function () {
  return Promise.resolve()
}
