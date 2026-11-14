'use strict'
// Names what holds the event loop: a worker watches the main thread's heartbeat and, once it has been stale for
// `ms`, pauses the main thread in the debugger and reports the stack it was caught in. Costs nothing until a stall -
// timing exported functions (main.js timeHeavy) misses the code after an await, and that is where the castle
// stalls were (2026-09-27: a 4.6s stall named no slow call).
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')

if (!isMainThread && workerData && workerData.stallwatch) {
  const inspector = require('inspector')
  const beat = new Int32Array(workerData.sab)
  let last = Atomics.load(beat, 0); let lastAt = Date.now(); let caught = false; let busy = false
  const capture = () => {
    const s = new inspector.Session(); s.connectToMainThread()
    const post = (m, p) => new Promise((resolve, reject) => s.post(m, p || {}, (e, r) => e ? reject(e) : resolve(r)))
    const urls = new Map()
    s.on('Debugger.scriptParsed', ({ params }) => { if (params.url) urls.set(params.scriptId, params.url) })
    let ended = false
    // (the beat as the capture starts: the watcher below rewrites `last` the moment it moves - audit 2026-09-27)
    const beat0 = Atomics.load(beat, 0); const lastAt0 = lastAt
    // the pause never outlives the capture: a frozen bot in water drowns. Debugger.disable resumes and cancels a
    // pause still pending (the stall ended, no JS ran) - always before the disconnect (audit 2026-09-27)
    const done = async st => {
      if (ended) return; ended = true; clearInterval(deadline)
      try { await post('Debugger.disable') } catch {}
      try { s.disconnect() } catch {}
      busy = false; if (st) parentPort.postMessage(st)
    }
    // the deadline follows the stall, not a clock: a long native call (a big synchronous write) only takes the pause
    // when it returns, so wait while the beat is still frozen (capped at 30s); once it moves the pause lands with the
    // next tick - give it 1s, then cancel it (audit 2026-09-27)
    const t0 = Date.now(); let movedAt = 0
    const deadline = setInterval(() => {
      if (!movedAt && Atomics.load(beat, 0) !== beat0) movedAt = Date.now()
      if ((movedAt && Date.now() - movedAt > 1000) || Date.now() - t0 > 30000) done([`no capture (deadline, ${movedAt ? 'the stall ended' : '30s frozen'})`])
    }, 100)
    s.on('Debugger.paused', async ({ params }) => {
      const staleMs = Date.now() - lastAt0
      // the beat moved: the loop recovered before the pause landed, and this stack is whatever ran next - not the culprit
      const st = Atomics.load(beat, 0) !== beat0 ? ['stall ended before capture']
        : [`(${(staleMs / 1000).toFixed(1)}s in)`].concat(params.callFrames.slice(0, 14).map(f => `${f.functionName || '(anon)'} ${(urls.get(f.location.scriptId) || '?').replace(/^.*[\\/]/, '')}:${f.location.lineNumber + 1}`))
      try { await post('Debugger.resume') } catch {}
      done(st)
    })
    post('Debugger.enable').then(() => post('Debugger.pause')).catch(e => done(['pause failed: ' + e.message]))
  }
  setInterval(() => {
    const b = Atomics.load(beat, 0)
    if (b !== last) { last = b; lastAt = Date.now(); caught = false; return }
    if (busy || caught || Date.now() - lastAt < workerData.ms) return
    busy = caught = true; capture() // (once per stall)
  }, 100)
}

// main thread: start the watcher; returns the heartbeat to call from a regular interval
function start (ms, onStack) {
  const sab = new SharedArrayBuffer(4); const beat = new Int32Array(sab)
  const w = new Worker(__filename, { workerData: { stallwatch: true, sab, ms } })
  w.on('message', onStack)
  w.on('error', () => {}) // (a broken watcher never takes the bot down)
  w.unref()
  return () => Atomics.add(beat, 0, 1)
}

module.exports = { start }
