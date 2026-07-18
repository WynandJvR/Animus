'use strict'
// Supervisor: keeps index.js (the bot + control API + dashboard) running, and
// restarts it when it exits - which is how the dashboard's "Save & reconnect"
// applies new server/account settings (index.js writes config.json, exits, and
// we bring it right back up with the new config). Rapid crashes back off so a
// bad config doesn't spin the CPU. Ctrl+C stops for good.
//
// LIVENESS LADDER (REDESIGN §8, layer d): today's react-to-exit is blind to an
// alive-but-wedged bot (hung loop, frozen body while /health still answers). When
// SUPERVISE !== '0' we also poll two out-of-band signals every T.POLL_MS - the
// heartbeat file index.js writes, and GET /health - feed them to the PURE
// supervise.decide, and act: nudge = POST stop then recover; kill = child.kill()
// (the EXISTING exit handler then restarts with the existing backoff). SUPERVISE=0
// creates NO interval and behaves byte-for-byte as before (the require is inert).
const { spawn } = require('child_process')
const path = require('path')
const supervise = require('./supervise.js')

const SUPERVISE = process.env.SUPERVISE !== '0'

let stopping = false
let quickCrashes = 0
let lastStart = 0
let child = null
let st = supervise.freshState(Date.now())
let killedBySupervisor = false
let nudgeTimer = null

// ---- probe target: mirror index.js's control-API + heartbeat-file resolution ------
let cfg = {}
try { cfg = require('./config.json') } catch { cfg = {} }
const host = process.env.CONTROL_HOST || cfg.controlHost || '127.0.0.1'
const port = parseInt(process.env.CONTROL_PORT || cfg.controlPort || 3001, 10)
const HB_FILE = process.env.HEARTBEAT_FILE || path.join(__dirname, 'heartbeat.json') // IDENTICAL to index.js HEARTBEAT_FILE

function start () {
  lastStart = Date.now()
  // Re-arm the grace window on every (re)start, but PRESERVE the kill rate-limit across a
  // supervisor-kill restart (else kill -> restart -> grace-ends -> kill would loop at
  // grace-speed).
  st = Object.assign(supervise.freshState(Date.now()), { lastKillAt: st.lastKillAt })
  child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    stdio: 'inherit', // pass through console - incl. the microsoft.com/link device code
    env: process.env
  })
  child.on('exit', (code, signal) => {
    if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null }
    // ">= 10 min between kills UNLESS the child exited on its own": a natural exit clears the
    // cooldown so it never delays a legitimate restart; a supervisor kill keeps it.
    if (!killedBySupervisor) st.lastKillAt = 0
    killedBySupervisor = false
    if (stopping) return
    const ranMs = Date.now() - lastStart
    if (ranMs < 4000) quickCrashes++; else quickCrashes = 0
    // exit(0) = intentional restart (reconnect) -> come back fast; crashes back off
    const delay = code === 0 && quickCrashes === 0 ? 500 : Math.min(2000 * Math.max(1, quickCrashes), 15000)
    console.log(`[run] bot exited (code ${code}${signal ? ', ' + signal : ''}); restarting in ${delay}ms...`)
    setTimeout(start, delay)
  })
  const stop = () => { stopping = true; try { child.kill() } catch {}; process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

// ---- the liveness poll (only armed when SUPERVISE) ---------------------------------
async function pollTick () {
  if (stopping || !child || child.exitCode != null) return // no live child - nothing to supervise
  const hb = supervise.readHeartbeat(HB_FILE)
  const probe = await supervise.probeHealth(host, port, supervise.T.PROBE_TIMEOUT_MS)
  const r = supervise.decide(hb, probe, Date.now(), st)
  st = r.st
  if (r.action === 'ok' || r.action === 'grace') return

  const now = Date.now()
  const agoSec = (hb && typeof hb.lastProgressAt === 'number') ? Math.round((now - hb.lastProgressAt) / 1000) : null
  if (r.action === 'nudge') {
    const entry = { t: now, action: 'nudge', reason: r.why || 'frozen-vitals', activity: hb && hb.activity, pos: hb && hb.pos, lastProgressAgoSec: agoSec }
    supervise.logIntervention(entry)
    console.log('[run] SUPERVISOR nudge (frozen-vitals) - stop then recover; last progress ' + agoSec + 's ago')
    await supervise.postCmd(host, port, 'stop', 'supervisor: frozen-vitals nudge', supervise.T.POST_TIMEOUT_MS)
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null
      supervise.postCmd(host, port, 'recover', 'supervisor: post-stop recover', supervise.T.POST_TIMEOUT_MS)
    }, supervise.T.NUDGE_WAIT_MS)
    return
  }
  if (r.action === 'kill') {
    supervise.logIntervention({ t: now, action: 'kill', reason: r.why, downPolls: st.downPolls, frozenPolls: st.frozenPolls })
    console.log('[run] SUPERVISOR kill (' + r.why + ') - restarting via the exit handler')
    killedBySupervisor = true
    try { child.kill() } catch {}
    return
  }
  if (r.action === 'kill-suppressed') {
    // the operator's crash-loop alarm: rate-limited kill, do nothing else.
    supervise.logIntervention({ t: now, action: 'kill-suppressed', reason: r.why, lastKillAgoSec: Math.round((now - st.lastKillAt) / 1000) })
    console.log('[run] SUPERVISOR kill-suppressed (' + r.why + ') - within the ' + Math.round(supervise.T.KILL_COOLDOWN_MS / 60000) + '-min kill cooldown')
  }
}

console.log('[run] supervising the bot (Ctrl+C to stop). The dashboard\'s "Save & reconnect" restarts through here.')
if (SUPERVISE) setInterval(pollTick, supervise.T.POLL_MS) // plain interval; the child holds the process open
start()
