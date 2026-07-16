'use strict'
// OFFLINE unit test for the external liveness supervisor (bot/supervise.js) - no bot, no
// live server. Proves the §8.2 ladder decisions (grace, frozen-vitals nudge, stale/silent/
// frozen kill, 10-min kill rate-limit, movement/idle/disconnect non-wedges) by threading `st`
// through consecutive decide() calls EXACTLY as run.js does, plus the three stdlib I/O helpers
// (readHeartbeat on scratch files, probeHealth/postCmd against ephemeral http.createServer
// mocks). Fixtures live under os.tmpdir(), never the repo.
// Run:  cd bot && node supervisortest.js

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const sup = require('./supervise.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}
// tiny sequential async runner for the probe/postCmd cases
const asyncTests = []
function ta (name, fn) { asyncTests.push({ name, fn }) }

const NOW = 1600000000000
const MIN = 60000

// Build a heartbeat fixture around a given poll-time `now`. Defaults are a HEALTHY sample
// (fresh t, recent progress, named activity, connected). Override to sculpt each case.
function hbAt (now, o) {
  o = o || {}
  return {
    t: now - (o.tAgo != null ? o.tAgo : 5000),
    lastProgressAt: now - (o.progressAgo != null ? o.progressAgo : 10000),
    pos: (o.pos !== undefined) ? o.pos : { x: 10, y: 64, z: 10 },
    activity: (o.activity !== undefined) ? o.activity : 'gather',
    connected: (o.connected !== undefined) ? o.connected : true
  }
}
// grace-over starting state (started 10 min ago)
const over = () => sup.freshState(NOW - 10 * MIN)

// ---- decision cases (§9 table) -----------------------------------------------------

t('#1 fresh hb + probe ok -> ok', () => {
  const r = sup.decide(hbAt(NOW, { tAgo: 5000, progressAgo: 10000, activity: 'gather' }), 'ok', NOW, over())
  assert.strictEqual(r.action, 'ok')
})

t('#2 null hb is never stale -> ok', () => {
  const r = sup.decide(null, 'ok', NOW, over())
  assert.strictEqual(r.action, 'ok')
})

t('#3 frozen baseline (A ok) then nudge (B)', () => {
  let st = over()
  const pos = { x: 10, y: 64, z: 10 }
  let r = sup.decide(hbAt(NOW, { progressAgo: 6 * MIN, pos, activity: 'gather' }), 'ok', NOW, st); st = r.st
  assert.strictEqual(r.action, 'ok', 'A baseline')
  r = sup.decide(hbAt(NOW + 15000, { progressAgo: 6 * MIN, pos, activity: 'gather' }), 'ok', NOW + 15000, st); st = r.st
  assert.strictEqual(r.action, 'nudge', 'B nudge')
})

t('#4 frozen streak: C ok (frozenPolls 2), D kill + lastKillAt stamped', () => {
  let st = over()
  const pos = { x: 10, y: 64, z: 10 }
  const times = [NOW, NOW + 15000, NOW + 30000, NOW + 45000]
  const acts = []
  for (const tm of times) { const r = sup.decide(hbAt(tm, { progressAgo: 6 * MIN, pos, activity: 'gather' }), 'ok', tm, st); st = r.st; acts.push(r.action) }
  assert.deepStrictEqual(acts, ['ok', 'nudge', 'ok', 'kill'])
  assert.strictEqual(st.lastKillAt, NOW + 45000, 'lastKillAt = now at kill')
})

t('#5 idle at home (activity null, 6 min still) never nudges', () => {
  let st = over()
  const pos = { x: 10, y: 64, z: 10 }
  for (let i = 0; i < 3; i++) { const tm = NOW + i * 15000; const r = sup.decide(hbAt(tm, { progressAgo: 6 * MIN, pos, activity: null }), 'ok', tm, st); st = r.st; assert.strictEqual(r.action, 'ok', 'poll ' + i) }
})

t('#6 disconnected (connected:false) is not a wedge', () => {
  let st = over()
  const pos = { x: 10, y: 64, z: 10 }
  for (let i = 0; i < 2; i++) { const tm = NOW + i * 15000; const r = sup.decide(hbAt(tm, { progressAgo: 6 * MIN, pos, activity: 'gather', connected: false }), 'ok', tm, st); st = r.st; assert.strictEqual(r.action, 'ok', 'poll ' + i) }
})

t('#7 stale heartbeat (t=NOW-120s) -> kill', () => {
  const st = over()
  const r = sup.decide(hbAt(NOW, { tAgo: 120000 }), 'ok', NOW, st)
  assert.strictEqual(r.action, 'kill')
  assert.strictEqual(r.st.lastKillAt, NOW)
})

t('#8 probe down 3 consecutive polls -> ok,ok,kill', () => {
  let st = over()
  const acts = []
  for (let i = 0; i < 3; i++) { const tm = NOW + i * 15000; const r = sup.decide(hbAt(tm, {}), 'down', tm, st); st = r.st; acts.push(r.action) }
  assert.deepStrictEqual(acts, ['ok', 'ok', 'kill'])
})

t('#9 kill rate-limit: suppressed within 10min (counters intact), fires past it', () => {
  const st = over(); st.lastKillAt = NOW - 4 * MIN
  const r = sup.decide(hbAt(NOW, { tAgo: 120000 }), 'ok', NOW, st)
  assert.strictEqual(r.action, 'kill-suppressed')
  assert.strictEqual(r.st.frozenPolls, 0, 'counters not reset by suppression')
  assert.strictEqual(r.st.lastKillAt, NOW - 4 * MIN, 'lastKillAt untouched while suppressed')
  const st2 = over(); st2.lastKillAt = NOW - 11 * MIN
  const r2 = sup.decide(hbAt(NOW, { tAgo: 120000 }), 'ok', NOW, st2)
  assert.strictEqual(r2.action, 'kill')
})

t('#10 startup grace: a stale leftover file never insta-kills', () => {
  const st = sup.freshState(NOW - 30000) // started 30s ago
  const r = sup.decide(hbAt(NOW, { tAgo: 10 * MIN }), 'ok', NOW, st)
  assert.strictEqual(r.action, 'grace')
})

t('#11 recent nudge blocks the nudge but never the kill', () => {
  let st = over()
  const pos = { x: 10, y: 64, z: 10 }
  st.prevPos = { x: 10, y: 64, z: 10 }; st.prevActivity = 'gather'; st.lastNudgeAt = NOW - 60000
  const acts = []
  for (let i = 0; i < 3; i++) { const tm = NOW + i * 15000; const r = sup.decide(hbAt(tm, { progressAgo: 6 * MIN, pos, activity: 'gather' }), 'ok', tm, st); st = r.st; acts.push(r.action) }
  assert.deepStrictEqual(acts, ['ok', 'ok', 'kill'], 'cooldown mutes nudge, streak still reaches kill')
})

t('#12 movement resets the frozen streak', () => {
  let st = over()
  let r = sup.decide(hbAt(NOW, { progressAgo: 6 * MIN, pos: { x: 10, y: 64, z: 10 }, activity: 'gather' }), 'ok', NOW, st); st = r.st
  assert.strictEqual(r.action, 'ok', 'A baseline')
  r = sup.decide(hbAt(NOW + 15000, { progressAgo: 6 * MIN, pos: { x: 13, y: 64, z: 10 }, activity: 'gather' }), 'ok', NOW + 15000, st); st = r.st
  assert.strictEqual(r.action, 'ok', 'B moved -> not frozen')
  assert.strictEqual(st.frozenPolls, 0, 'streak reset by movement')
})

// ---- I/O helper cases (§8.3) -------------------------------------------------------

t('readHeartbeat: fresh json -> object, garbage -> null, missing -> null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suptest-'))
  const good = path.join(dir, 'hb.json'); fs.writeFileSync(good, JSON.stringify({ t: 1, pos: { x: 1 } }))
  assert.deepStrictEqual(sup.readHeartbeat(good), { t: 1, pos: { x: 1 } })
  const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, 'not json {{{')
  assert.strictEqual(sup.readHeartbeat(bad), null, 'garbage -> null')
  assert.strictEqual(sup.readHeartbeat(path.join(dir, 'nope.json')), null, 'missing -> null')
})

function startServer (handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
}
const closeServer = (s) => new Promise((resolve) => s.close(resolve))

ta('probeHealth: live /health -> ok; refused -> down; never-answers -> down within timeout', async () => {
  const s = await startServer((req, res) => { if (req.url === '/health') { res.writeHead(200); res.end('{"ok":true}') } else { res.writeHead(404); res.end() } })
  const port = s.address().port
  assert.strictEqual(await sup.probeHealth('127.0.0.1', port, 2000), 'ok', 'answering server -> ok')
  await closeServer(s)
  assert.strictEqual(await sup.probeHealth('127.0.0.1', port, 2000), 'down', 'connection refused -> down')

  const hung = await startServer(() => { /* never respond */ })
  const hport = hung.address().port
  const t0 = Date.now()
  assert.strictEqual(await sup.probeHealth('127.0.0.1', hport, 300), 'down', 'no response -> down')
  assert(Date.now() - t0 < 2000, 'timed out promptly, not hung')
  await closeServer(hung)
})

ta('postCmd: POST /cmd with X-Supervisor:1 and {command,reason} body', async () => {
  let captured = null
  const s = await startServer((req, res) => {
    let d = ''
    req.on('data', c => { d += c })
    req.on('end', () => { captured = { method: req.method, url: req.url, hdr: req.headers['x-supervisor'], body: d }; res.writeHead(200); res.end('ok') })
  })
  const port = s.address().port
  const r = await sup.postCmd('127.0.0.1', port, 'stop', 'supervisor: frozen-vitals nudge', 2000)
  assert.strictEqual(r.sent, true, 'reports sent')
  assert.strictEqual(captured.method, 'POST')
  assert.strictEqual(captured.url, '/cmd')
  assert.strictEqual(captured.hdr, '1', 'X-Supervisor header present')
  const j = JSON.parse(captured.body)
  assert.strictEqual(j.command, 'stop')
  assert.strictEqual(j.reason, 'supervisor: frozen-vitals nudge')
  await closeServer(s)
})

// ---- run the async cases, then report ----------------------------------------------
;(async () => {
  for (const { name, fn } of asyncTests) {
    try { await fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall supervisor tests passed')
  process.exitCode = failures ? 1 : 0
})()
