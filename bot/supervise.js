'use strict'
// EXTERNAL LIVENESS SUPERVISOR - pure decision core + thin stdlib I/O (REDESIGN §8, layer d).
//
// run.js is the out-of-process parent of index.js; today it only reacts to child EXIT. An
// alive-but-wedged bot (hung event loop, never-settling promise) or one whose body is frozen
// while HTTP still answers runs forever - no IN-process watchdog can catch it, because the
// watchdogs are themselves on the wedged loop. This module is the consumer half of the ladder:
// run.js polls two out-of-band signals (the heartbeat FILE index.js writes every ~5s, and a
// cheap GET /health) and feeds them to `decide`, which returns one of
// ok / grace / nudge / kill / kill-suppressed. run.js acts (nudge = POST stop then recover;
// kill = child.kill() -> the EXISTING exit handler restarts with the existing backoff).
//
// House style (route-mem.js / arbiter.js): the decision core is PURE - no bot, no timers, no
// sockets, `now` injected (no Date.now() inside decide, mirroring arbiter's testability). Only
// the four I/O helpers touch fs/http, stdlib only. No side effects at require time.
//
// SAFETY: the supervisor's entire verb set is stop, recover, child.kill(). stop is a PAUSE that
// preserves the persisted build (commands.js); recover is mutexed + no-op-safe. Everything is
// bounded: one nudge / 5 min, one kill / 10 min (unless the child exits on its own), 3-poll
// streaks, 5s probe timeout, 120s startup grace, every intervention logged.
//
// Offline tests: bot/supervisortest.js.

const fs = require('fs')
const path = require('path')
const http = require('http')

// ---- CONSTANTS (every tunable a named export so the test pins them) -----------------
const T = {
  POLL_MS: 15000, //            ladder cadence (§8.2)
  HB_STALE_MS: 90000, //        heartbeat file silent (its t older than this) -> kill class
  FROZEN_MS: 300000, //         lastProgressAt older than 5 min = hasn't moved a block
  START_GRACE_MS: 120000, //    no verdicts right after (re)start - login/auth/device-code
  NUDGE_WAIT_MS: 20000, //      stop -> recover gap
  NUDGE_COOLDOWN_MS: 300000, // at most one nudge per 5 min
  KILL_COOLDOWN_MS: 600000, //  >= 10 min between supervisor kills (§8.2 item 4)
  PROBE_TIMEOUT_MS: 5000, //    GET /health hard timeout
  POST_TIMEOUT_MS: 10000, //    POST /cmd disconnect-but-keep-running timeout
  DOWN_POLLS_KILL: 3, //        probe down 3 consecutive polls (~45s) -> kill
  FROZEN_POLLS_KILL: 3 //       nudge at 1, wait at 2, kill at 3
}

// ---- freshState: the threaded supervisor state -------------------------------------
function freshState (now) {
  return {
    startedAt: now,
    lastKillAt: 0,
    lastNudgeAt: 0,
    downPolls: 0,
    frozenPolls: 0,
    prevPos: null,
    prevActivity: null
  }
}

// same-pos rule = the heartbeat writer's OWN progress rule (index.js:1830): a move counts
// when |dx|+|dy|+|dz| >= 1, so "same pos" is a manhattan delta strictly < 1.
function samePos (a, b) {
  if (!a || !b) return false
  return (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)) < 1
}

// ---- decide: the PURE liveness ladder (§8.2) ---------------------------------------
// hb    : parsed heartbeat object (§2.1 shape) or null (missing/unreadable/STATE_HISTORY=0).
//         null is NEVER stale - it just means "no heartbeat signal".
// probe : 'ok' | 'down'. ANY HTTP response (incl. 500) = 'ok' (event loop is alive);
//         timeout / refused / socket error = 'down'.
// now   : ms epoch (injected).
// st    : threaded state (mutated + returned every call; caller stores r.st).
// returns { action, st, why? }.
function decide (hb, probe, now, st) {
  // 1. Startup grace - no verdicts, but keep building the pos/activity baseline so a
  //    LEFTOVER stale heartbeat from before a restart is harmless (fresh write lands ~5s in).
  if (now - st.startedAt < T.START_GRACE_MS) {
    st.downPolls = 0
    st.frozenPolls = 0
    if (hb) { st.prevPos = hb.pos || null; st.prevActivity = (typeof hb.activity === 'string') ? hb.activity : null }
    return { action: 'grace', st }
  }

  // 2. Down-streak (probe silence).
  if (probe === 'down') st.downPolls++
  else st.downPolls = 0

  // 3. Frozen-streak: connected, has a named activity, hasn't progressed in FROZEN_MS,
  //    same pos AND same activity as last poll, and /health still answers. An idle bot
  //    standing still at home (activity null) is NOT a wedge; a disconnected bot is NOT a
  //    wedge. First poll after start has prevPos === null -> never frozen (baseline builds).
  const frozen = probe === 'ok' && hb != null && hb.connected !== false &&
    typeof hb.activity === 'string' && hb.activity &&
    typeof hb.lastProgressAt === 'number' && now - hb.lastProgressAt > T.FROZEN_MS &&
    st.prevPos && hb.pos && samePos(st.prevPos, hb.pos) &&
    hb.activity === st.prevActivity
  if (frozen) st.frozenPolls++
  else st.frozenPolls = 0
  if (hb != null) {
    st.prevPos = hb.pos || null
    st.prevActivity = (typeof hb.activity === 'string') ? hb.activity : null
  }

  // 4. Kill class: stale-OR-silent heartbeat, sustained probe silence, or a frozen streak
  //    that outlasted the nudge. stale = a live file whose t stopped advancing (commands.state
  //    is permanently throwing -> restart is correct); null hb is never stale.
  const stale = hb != null && typeof hb.t === 'number' && now - hb.t > T.HB_STALE_MS
  if (stale || st.downPolls >= T.DOWN_POLLS_KILL || st.frozenPolls >= T.FROZEN_POLLS_KILL) {
    const why = stale ? 'heartbeat-stale' : (st.downPolls >= T.DOWN_POLLS_KILL ? 'probe-silent' : 'frozen-after-nudge')
    if (st.lastKillAt > 0 && now - st.lastKillAt < T.KILL_COOLDOWN_MS) {
      // Rate-limited: do NOT reset counters - re-evaluated next poll so a crash-looping bug
      // surfaces in the log instead of masking itself.
      return { action: 'kill-suppressed', st, why }
    }
    st.lastKillAt = now
    st.downPolls = 0
    st.frozenPolls = 0
    return { action: 'kill', st, why }
  }

  // 5. Nudge on the FIRST frozen poll only (streak 2 -> the "still frozen next poll" wait;
  //    streak 3 -> kill above). The 5-min cooldown stops nudge-spam even if a nudge merely
  //    flaps the activity string and restarts the streak.
  if (st.frozenPolls === 1 && (st.lastNudgeAt === 0 || now - st.lastNudgeAt > T.NUDGE_COOLDOWN_MS)) {
    st.lastNudgeAt = now
    return { action: 'nudge', st, why: 'frozen-vitals' }
  }

  // 6. Nothing to do.
  return { action: 'ok', st }
}

// ---- I/O helpers (stdlib only; each independently testable) -------------------------

// Read + parse the heartbeat file. Any throw (missing / unreadable / garbage / STATE_HISTORY=0
// absent) -> null. No caching.
function readHeartbeat (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// GET /health with a hard timeout. ANY response (any status incl. 500) proves the event loop
// is alive -> 'ok'. Timeout / connection refused / socket error -> 'down'. Never rejects.
function probeHealth (host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs || T.PROBE_TIMEOUT_MS }, (res) => {
      res.on('data', () => {}) // consume + discard
      res.on('end', () => finish('ok'))
      res.on('error', () => finish('ok')) // we already have a response - loop is alive
      res.resume()
    })
    req.on('timeout', () => { try { req.destroy() } catch {}; finish('down') })
    req.on('error', () => finish('down'))
  })
}

// POST /cmd with the X-Supervisor header (matches the parser at index.js:1615 + §6 predicate).
// A timeout AFTER connect is success-in-progress: recover awaits commands.handle (a grave trek
// can take minutes) - the server keeps executing after the client disconnects, so destroy the
// request and treat it as sent. Never rejects.
function postCmd (host, port, command, reason, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const body = JSON.stringify({ command, reason })
    const req = http.request({
      host,
      port,
      path: '/cmd',
      method: 'POST',
      timeout: timeoutMs || T.POST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Supervisor': '1'
      }
    }, (res) => {
      let out = ''
      res.on('data', c => { out += c })
      res.on('end', () => finish({ sent: true, body: out }))
      res.on('error', () => finish({ sent: true }))
    })
    req.on('timeout', () => { try { req.destroy() } catch {}; finish({ sent: true }) }) // disconnect, keep running
    req.on('error', () => finish({ sent: false }))
    req.end(body)
  })
}

// Append one intervention as a JSON line to logs/supervisor.log. Same defensive shape as
// loghistory.appendSample: recreate a vanished logs/ dir + retry once, swallow all errors so
// logging can never harm the parent. No rotation (interventions are rare by construction).
function logIntervention (entry, file) {
  const f = file || path.join(__dirname, '..', 'logs', 'supervisor.log')
  const line = JSON.stringify(entry) + '\n'
  try { fs.appendFileSync(f, line); return true } catch {
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, line); return true } catch { return false }
  }
}

module.exports = { decide, freshState, readHeartbeat, probeHealth, postCmd, logIntervention, T }
