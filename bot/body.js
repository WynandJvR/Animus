'use strict'
// ==== BODY LIVENESS - is the body being SIMULATED at all? ===================================
//
// mineflayer's physics plugin (lib/plugins/physics.js) gates its entire simulation on one private
// closure variable, `shouldUsePhysics`. FOUR events set it false - `login`, `death`, the `respawn`
// packet and `mount` - and exactly ONE thing sets it true again: a clientbound `position` packet.
// Nothing re-arms it on `dismount` (a seat/vehicle entity that simply disappears - entityGone -
// dismounts the bot with no teleport), and nothing checks that a `position` packet actually
// followed a respawn or a login. While it is false, `physicsTick` never fires: mineflayer-
// pathfinder's monitorMovement never runs, control states move nothing, gravity does not apply,
// the position freezes to the decimal and `onGround` stays at the `false` the position handler
// left it. The library's assumption - "the server always teleports you before it matters" - is
// not true on a plugin server, and when it breaks the bot is PARALYSED, not stuck.
//
// Live 2026-08-26 (state-history + bot-events): 30 stretches of 2-36 minutes with the position
// frozen to 0.1b while `moving:true`, `onGround:false` at an integer y on open grass, hp falling
// under zombie hits with no knockback. Every layer above read that as terrain: unstick ran 2,352
// rescue lines that day ("in the open ... plan climb > nudge > stepout", `reactive-move netted
// 0.0b in 2000ms`), recorded the cells as wedges, the arbiter revoked the jobs for "no world
// delta", the supervisor killed and reconnected the process 32 times - and a reconnect is the one
// thing that does send a fresh `position`, which is why it "worked" for a while each time.
//
// THIS MODULE IS THE ONE OWNER of that fact (DESIGN-PRINCIPLES #4). It answers `simulating()` from
// the physicsTick heartbeat - the thing itself, not a proxy - keeps a short tape of the events
// that can switch the simulation off so the log names the trigger (#7), and when an alive,
// connected, positioned body has stopped ticking it RE-ARMS the simulation through the library's
// own switch: a dismount if it is mounted, else a synthesized position sync at its current
// coordinates (the same handler a server teleport runs). That is not a guard in front of
// behaviour (#1): it is the state transition the library is missing, made explicit, in one place.
// The nav layer asks `simulating()` before treating stillness as evidence of a wedge.

const { dbg, setDebugSink } = require('./debug-sink.js').makeDebug('[body]')

// physicsTick is every 50ms. Three seconds of none while alive + connected + positioned is not lag
// (a bad tick is hundreds of ms) and clears mineflayer's own 1.5s post-respawn delay with margin.
const SILENCE_MS = 3000
// A re-arm is judged by whether ticks resume; a second one inside this window would be spam on a
// body that is dead for a reason we cannot fix from here (a hung event loop, no physics interval).
const REARM_GAP_MS = 5000
const TAPE_MAX = 24

let lastTickAt = 0
let ticks = 0
let hzTicks = 0
let hzAt = 0
let hz = 0
let lastPositionAt = 0       // last clientbound position sync THIS connection (0 = none yet)
let lastTeleportId = 0
let connected = false
let deadSince = 0            // when the current silence began (0 = ticking)
let lastRearmAt = 0
let rearms = 0
let rearmsFailed = 0
let tape = []                // ring of { t, ev, detail } - the events that can switch simulation off
// SERVER CORRECTIONS (2026-08-26): a clientbound position sync that MOVES the body is the server
// refusing what the client did ("moved wrongly") - the client walked into cells the server does
// not agree are passable, or the server holds the player somewhere else entirely. Live: the bot
// walked 1.8b and was put back at the same 0.1b-exact spot every 3s for minutes, with the planner
// re-planning a perfectly good path each time. Without this ring the log says only 'stuck'.
let corrections = []         // ring of { t, from, to } for syncs that displaced the body >= 0.5b
let syncs = []               // ring of t for EVERY position sync (a per-tick correction is < 0.5b and still a refusal)
let lastPinNoteAt = 0
let lastCorrectionNoteAt = 0
let noteFn = null            // index.js injects note() so transitions land in the main log
let installed = false        // install() ran on a real bot. Until then nothing is MEASURED, and an
                             // unmeasured body is not a paralysed one (DESIGN-PRINCIPLES #10) - the
                             // offline harnesses drive fake bots with no physics at all.

function setNoteSink (fn) { noteFn = fn }
function note (msg) { if (noteFn) noteFn('(body) ' + msg); else dbg(msg) }
function record (ev, detail) {
  tape.push({ t: Date.now(), ev, detail: detail || null })
  if (tape.length > TAPE_MAX) tape.shift()
}
function lastEvent (now) {
  const e = tape.length ? tape[tape.length - 1] : null
  return e ? e.ev + (e.detail ? '(' + e.detail + ')' : '') + ' ' + Math.round(((now || Date.now()) - e.t) / 1000) + 's ago' : 'none'
}

// PURE (unit-tested): is the simulation ticking, judged from the heartbeat alone?
function simulatingAt (lastTick, now) { return lastTick > 0 && now - lastTick < SILENCE_MS }
function simulating (now) { return !installed || simulatingAt(lastTickAt, now || Date.now()) }

// PURE (unit-tested): should check() re-arm now? Every condition is a fact about the body, none
// is a timer on its own: alive + connected + has had a real position this connection + silent for
// SILENCE_MS + the library's own position path is not in flight + not re-armed a moment ago.
function shouldRearm (s, now) {
  if (!s.connected || !s.alive || !s.hasEntity) return false
  if (s.lastPositionAt <= 0) return false                    // no server position yet: the library's login path owns this
  if (simulatingAt(s.lastTickAt, now)) return false
  if (s.deadSince <= 0 || now - s.deadSince < SILENCE_MS) return false
  if (now - s.lastPositionAt < SILENCE_MS) return false      // a sync just arrived; its (possibly delayed) re-arm is pending
  if (now - s.lastRearmAt < REARM_GAP_MS) return false
  return true
}

function install (bot) {
  installed = true
  bot.on('physicsTick', () => {
    const now = Date.now()
    lastTickAt = now
    ticks++
    hzTicks++
    if (now - hzAt >= 1000) { hz = hzTicks; hzTicks = 0; hzAt = now }
  })
  bot.on('login', () => { connected = true; lastPositionAt = 0; lastTickAt = 0; deadSince = 0; record('login') })
  bot.on('end', (why) => { connected = false; lastTickAt = 0; deadSince = 0; record('end', why) })
  bot.on('death', () => record('death'))
  bot.on('respawn', () => record('respawn'))
  bot.on('spawn', () => record('spawn'))
  bot.on('mount', () => record('mount', bot.vehicle ? (bot.vehicle.name || bot.vehicle.type || 'entity') + '#' + bot.vehicle.id : 'entity'))
  bot.on('dismount', (v) => record('dismount', v ? (v.name || v.type || 'entity') + '#' + v.id : 'unknown'))
  // PREPENDED so it runs before mineflayer's own handler moves bot.entity - `from` is where the
  // client had the body, `to` is where the server puts it.
  bot._client.prependListener('position', (p) => {
    const now = Date.now()
    lastPositionAt = now
    if (p && typeof p.teleportId === 'number') lastTeleportId = p.teleportId
    try {
      const e = bot.entity && bot.entity.position
      if (!e || !p || typeof p.x !== 'number') return
      const rel = p.flags && typeof p.flags === 'object' ? p.flags : {}
      const to = { x: rel.x ? e.x + p.x : p.x, y: rel.y ? e.y + p.y : p.y, z: rel.z ? e.z + p.z : p.z }
      const d = Math.hypot(to.x - e.x, to.y - e.y, to.z - e.z)
      syncs.push(now); while (syncs.length && now - syncs[0] > 10000) syncs.shift()
      // PINNED: the server answers (nearly) every client move with a teleport back. Ten in two seconds is
      // five a second - no legitimate teleport rate - and it is why the body 'cannot reach' a node 1.7b away.
      const recent = syncs.filter(t => now - t <= 2000).length
      if (recent >= 10 && now - lastPinNoteAt >= 3000) {
        lastPinNoteAt = now
        const f = v => v.x.toFixed(2) + ',' + v.y.toFixed(2) + ',' + v.z.toFixed(2)
        note('PINNED by the server: ' + recent + ' position syncs in 2s, last one moved me ' + d.toFixed(3) + 'b to ' + f(to) + ' (client had ' + f(e) + ') - the server refuses every move from here')
      }
      while (corrections.length && now - corrections[0].t > 10000) corrections.shift()
      if (d < 0.5) return
      corrections.push({ t: now, from: { x: e.x, y: e.y, z: e.z }, to })
      if (now - lastCorrectionNoteAt >= 3000) {
        lastCorrectionNoteAt = now
        const f = v => v.x.toFixed(1) + ',' + v.y.toFixed(1) + ',' + v.z.toFixed(1)
        note('SERVER CORRECTION: the client had me at ' + f(e) + ', the server put me at ' + f(to) + ' (' + d.toFixed(1) + 'b; ' + corrections.length + ' in 10s) - the server refuses that movement: client/server world or state disagree there')
      }
    } catch {}
  })
}

function snapshot (bot, now) {
  return {
    connected,
    alive: bot.isAlive === true,
    hasEntity: !!(bot.entity && bot.entity.position),
    lastPositionAt,
    lastTickAt,
    deadSince,
    lastRearmAt
  }
}

// THE ONE RE-ARM. Mounted -> dismount (the server then teleports us and the library re-arms
// itself). Otherwise run the library's own position handler with our current coordinates: it
// confirms the (stale) teleport id, sends one position_look the server already agrees with, and
// flips shouldUsePhysics. Returns what it did, for the log; the verdict is read from the ticks.
function rearm (bot) {
  lastRearmAt = Date.now()
  rearms++
  if (bot.vehicle) {
    try { bot.dismount(); return 'dismount(' + (bot.vehicle.name || 'vehicle') + ')' } catch (e) { return 'dismount threw: ' + e.message }
  }
  try {
    const conv = require('mineflayer/lib/conversions')
    const p = bot.entity.position
    bot._client.emit('position', {
      teleportId: lastTeleportId,
      x: p.x, y: p.y, z: p.z, dx: 0, dy: 0, dz: 0,
      yaw: conv.toNotchianYaw(bot.entity.yaw), pitch: conv.toNotchianPitch(bot.entity.pitch),
      flags: { x: false, y: false, z: false, yaw: false, pitch: false }
    })
    return 'position-sync at ' + p.floored()
  } catch (e) { return 'position-sync threw: ' + e.message }
}

// Called from the 1s trackTick. Logs the OFF transition once (with the event that preceded it),
// re-arms when the facts say so, and logs the verdict of the previous re-arm from the ticks.
let pendingVerdict = null // { at, how } - a re-arm whose outcome the next tick reports
function check (bot) {
  const now = Date.now()
  if (pendingVerdict && now - pendingVerdict.at >= 1000) {
    const ok = simulating(now)
    if (ok) { note('re-armed via ' + pendingVerdict.how + ' -> ticking again (' + hz + '/s); the body was paralysed ' + Math.round((pendingVerdict.at - pendingVerdict.deadSince) / 1000) + 's'); record('rearmed', pendingVerdict.how) } else { rearmsFailed++; note('re-arm via ' + pendingVerdict.how + ' did NOT restore ticks (vehicle=' + (bot.vehicle ? 'yes' : 'no') + ', alive=' + bot.isAlive + ', last event ' + lastEvent(now) + ') - a reconnect is the only lever left') }
    pendingVerdict = null
  }
  const s = snapshot(bot, now)
  if (!s.connected || !s.alive || !s.hasEntity) { deadSince = 0; return }
  if (simulatingAt(lastTickAt, now)) { deadSince = 0; return }
  // First tick of silence: after a fresh login/respawn the library's own (1.5s-delayed) re-arm is
  // still due, so this is not yet a fact about the body - the alarm is SILENCE_MS later.
  if (!deadSince) { deadSince = now; return }
  // Announce ONCE per silence, at the moment it became a fact: the tape's last entry is the
  // announcement until something else (a successful re-arm, an event) follows it.
  if (now - deadSince >= SILENCE_MS && (!tape.length || tape[tape.length - 1].ev !== 'paralysed')) {
    const p = bot.entity.position
    note('SIMULATION OFF - no physicsTick for ' + Math.round((now - deadSince) / 1000) + 's while alive+connected at ' + p.floored() +
      ' (last position sync ' + (lastPositionAt ? Math.round((now - lastPositionAt) / 1000) + 's ago' : 'never') + ', vehicle=' + (bot.vehicle ? 'yes' : 'no') + ', last event ' + lastEvent(now) + ')')
    record('paralysed', lastEvent(now))
  }
  if (!pendingVerdict && shouldRearm({ ...s, deadSince }, now)) {
    const how = rearm(bot)
    pendingVerdict = { at: now, how, deadSince }
  }
}

// For /state and the nav layer.
function info (bot) {
  const now = Date.now()
  const sim = simulating(now)
  return {
    measured: installed,
    simulating: sim,
    hz: sim ? hz : 0,
    offForSec: sim || !deadSince ? 0 : Math.round((now - deadSince) / 1000),
    lastEvent: lastEvent(now),
    vehicle: !!(bot && bot.vehicle),
    corrections10s: corrections.filter(c => now - c.t <= 10000).length,
    syncs2s: syncs.filter(t => now - t <= 2000).length,
    rearms,
    rearmsFailed
  }
}
// How long the body has been silent (0 when ticking) - the nav layer's one question.
function offForMs (now) { now = now || Date.now(); return simulating(now) || !deadSince ? 0 : now - deadSince }
// Bounded wait for the simulation to come back (the re-arm is check()'s job; this only waits).
async function waitSimulating (ms, isStopped) {
  const t0 = Date.now()
  while (!simulating() && Date.now() - t0 < ms && !(isStopped && isStopped())) await new Promise(r => setTimeout(r, 200))
  return simulating()
}

// test hooks
function _reset () { syncs = []; lastPinNoteAt = 0; corrections = []; lastCorrectionNoteAt = 0; installed = false; lastTickAt = 0; ticks = 0; hzTicks = 0; hzAt = 0; hz = 0; lastPositionAt = 0; lastTeleportId = 0; connected = false; deadSince = 0; lastRearmAt = 0; rearms = 0; rearmsFailed = 0; tape = []; pendingVerdict = null }

module.exports = { install, check, info, simulating, simulatingAt, shouldRearm, offForMs, waitSimulating, setNoteSink, setDebugSink, SILENCE_MS, REARM_GAP_MS, _reset }
