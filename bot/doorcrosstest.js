'use strict'
// OFFLINE test for the 2026-08-02 hut-trap fix. No server, no world. Run: cd bot && node doorcrosstest.js
//
// WHAT KILLED THE BOT. Live 2026-08-02 16:19-16:28+, sealed inside its own 4x4 hut at
// (191,68,-100) with its door 4.1b away at (190,68,-104) and 17 mature wheat OUTSIDE:
//
//   [nav] door-assist: 1 door/gate candidates near me/goal      <- found the door
//   [verify] settle: cleared control states on path noPath      <- the approach goto planned nothing
//   [nav] door-assist: 1 door/gate candidates near me/goal      <- ...and the SECOND try, 76ms later
//   [nav] crossOwnDoor(out): still on the wrong side (door 190,-104)
//   [prov] wheat harvest failed (path ended short of the goal (tried: indoor x3, door x3, nudge x2))
//
// Two defects, one behaviour:
//   1. openNearbyDoor measured `distanceTo(door) > 4` and SILENTLY `continue`d - a decision that
//      produced no action and no log line (#5/#7). It reached that line two ways, and the second
//      is invisible: mineflayer-pathfinder's goto RESOLVES SUCCESSFULLY when the planner returns
//      status 'noPath' with an EMPTY path (node_modules/mineflayer-pathfinder/lib/goto.js:24), which
//      is exactly what a bot wedged among its own furniture gets.
//   2. Three of those "failures" armed a 120s door-cross cooldown (crossVerdict/doorCrossLedger)
//      during which crossOwnDoor did NOTHING and handed off to a "plain goto" that cannot cross a
//      closed door - the very reason crossOwnDoor exists. ~40 `cooling down` lines in nine minutes.
//
// It now MEASURES, WALKS AT THE DOOR on the bounded reactive primitive, and only then skips - loudly.

const assert = require('assert')
const { Vec3 } = require('vec3')
const navigate = require('./navigate.js')
const farm = require('./farm.js')

let failures = 0
const results = []
function ok (name) { results.push('PASS  ' + name) }
function bad (name, e) { failures++; results.push('FAIL  ' + name + '\n      ' + (e && e.message ? e.message : e)) }
function t (name, fn) { try { fn(); ok(name) } catch (e) { bad(name, e) } }
async function ta (name, fn) { try { await fn(); ok(name) } catch (e) { bad(name, e) } }

// THE SUITE'S OWN DEADLINE (same reason bodyboundtest.js has one): this file drives real timers
// and a re-entrant body primitive. A regression that hangs would leave node with an empty event
// loop, exit 0 silently, and score as a PASS in `for f in *test*.js; do node "$f"; done`. A
// REFERENCED timer makes that impossible.
const WALL = setTimeout(() => {
  console.log('FAIL  the suite did not finish within 90s - something in it HUNG (a bound is gone)')
  console.log('\n1 FAILED')
  process.exit(1)
}, 90000)

// ---- ROOT J: one number for "this leg has taken too long" --------------------------------
// navLegBudget is the whole seam. Before it, `Math.max(90000, timeoutMs*4)` meant a caller asking
// for 10s silently got 90s, plus up to 90s of reflex credit, plus a 45s gate inside gotoOnce -
// while the supervisor concluded "hung promise" at SURVIVAL_FAIL_MS + LATCH_GRACE_MS = 150s. The
// watchdog was less patient than the layer it was watching.
t('navLegBudget: the caller\'s timeoutMs finally MEANS something (4 attempts, not a 90s floor)', () => {
  assert.strictEqual(navigate.navLegBudget(10000, null, 90000), 40000, 'a 10s hop gets 40s, not 90s')
  assert.strictEqual(navigate.navLegBudget(15000, null, 90000), 60000)
})
t('navLegBudget: an explicit deadlineMs still wins', () => {
  assert.strictEqual(navigate.navLegBudget(20000, 75000, 90000), 75000, 'walkStaged\'s first-leg deadline is unchanged')
  assert.strictEqual(navigate.navLegBudget(15000, 35000, 90000), 35000, 'the bank/table reach legs are unchanged')
})
t('navLegBudget: NOTHING may outlive the supervisor\'s patience', () => {
  assert.strictEqual(navigate.navLegBudget(45000, null, 90000), 90000, '45s*4 = 180s would be judged hung before it answered')
  assert.strictEqual(navigate.navLegBudget(30000, 600000, 90000), 90000, 'an explicit over-long deadline is capped too')
})
t('navLegBudget: a leg always gets at least ONE full attempt', () => {
  assert.strictEqual(navigate.navLegBudget(30000, null, 10000), 30000, 'a ceiling below one attempt cannot make the attempt impossible')
})
t('navLegBudget: the ceiling is the SUPERVISOR\'S number, not a literal of our own', () => {
  const sched = require('./scheduler.js')
  const src = require('fs').readFileSync(require('path').join(__dirname, 'navigate.js'), 'utf8')
  assert.ok(/require\('\.\/scheduler\.js'\)[\s\S]{0,120}SURVIVAL_FAIL_MS/.test(src),
    'navigate.js must derive its ceiling from scheduler.SURVIVAL_FAIL_MS - a second literal is the seam coming back')
  assert.ok(Number.isFinite(sched.SURVIVAL_FAIL_MS) && sched.SURVIVAL_FAIL_MS > 0, 'the scheduler must actually export it')
})

t('navigateTo: a leg that outlives the caller\'s timeoutMs SAYS SO, with its numbers (#7)', () => {
  // The old budget could run ~180-278s while logging nothing at all, which is precisely why
  // "slow" and "hung" became indistinguishable in the tape.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'navigate.js'), 'utf8')
  const tail = src.slice(src.indexOf('async function navigateToInner'))
  assert.ok(/if \(took > timeoutMs\) \{/.test(tail), 'the long-leg line must be emitted on the real condition, not disabled')
  const line = (tail.match(/dbg\(label \+ 'leg took[\s\S]{0,400}?\)\n/) || [''])[0]
  for (const n of ['budget', 'ceiling', 'reflex-hold', 'recoveries']) {
    assert.ok(line.includes(n), 'the long-leg line must carry ' + n + ' - one greppable line with the numbers in it')
  }
})

t('gotoOnce: the recovery yield is part of the ATTEMPT, not a second 45s bound beside it', () => {
  // The gate used to wait up to 45000ms for a force-escape/recovery to finish BEFORE starting the
  // `ms` timer - so a caller asking for a 15s attempt could be gone 60s, invisible to
  // navigateToInner's deadline arithmetic. #6: one attempt, one deadline.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'navigate.js'), 'utf8')
  const fn = src.slice(src.indexOf('async function gotoOnce'), src.indexOf('async function gotoOnce') + 2500)
  assert.ok(!/45000/.test(fn), 'gotoOnce must not carry a bound of its own: ' + (fn.match(/.*45000.*/) || [''])[0])
  assert.ok(/Date\.now\(\) - started < ms/.test(fn), 'the yield must be bounded by the caller\'s own ms')
  assert.ok(/ms - \(Date\.now\(\) - started\)/.test(fn), 'and the goto timer must get only what the yield did not spend')
})

// ---- ROOT L: the crossing may not give up silently ---------------------------------------
// A fake world holding ONE hut door at (190,68,-104), and a pathfinder that ALWAYS answers the way
// the live one did: an empty path (goto resolves, the bot never moves). The bot starts 4.1b away -
// inside its own hut - which is exactly the live geometry.
const DOOR = new Vec3(190, 68, -104)
// `done: () => false` = "still on the wrong side" throughout, which is what crossOwnDoor threads in
// while the bot is stuck indoors; `towards` is the cell just outside the door (crossOwnDoor's own
// `out`). This is openNearbyDoor called exactly as the failing live crossing called it.
const CROSS_OPTS = { doorAt: DOOR, towards: { x: 190, y: 68, z: -105 }, done: () => false, isStopped: () => false }
function fakeBot (opts = {}) {
  const pos = new Vec3(191.5, 68, -99.5) // 4.7b from the door - the live geometry (bot at 191,68,-100)
  const bot = {
    version: '1.21.1',
    entity: { position: pos, onGround: true },
    controls: {},
    lookedAt: [],
    pathfinder: {
      goto: () => opts.gotoRejects ? Promise.reject(new Error('No path to the goal!')) : Promise.resolve(), // the empty-path "success"
      setGoal () {},
      setMovements () {}
    },
    findBlocks () { return [DOOR.clone()] },
    blockAt (p) {
      const k = Math.floor(p.x) + ',' + Math.floor(p.y) + ',' + Math.floor(p.z)
      if (k === '190,68,-104') return { name: 'oak_door', boundingBox: 'empty', shapes: [], getProperties: () => ({ half: 'lower', facing: 'north', open: 'false' }) }
      if (k === '190,69,-104') return { name: 'oak_door', boundingBox: 'empty', shapes: [], getProperties: () => ({ half: 'upper', facing: 'north', open: 'false' }) }
      if (Math.floor(p.y) === 67) return { name: 'oak_planks', boundingBox: 'block', getProperties: () => ({}) } // the floor
      return { name: 'air', boundingBox: 'empty', getProperties: () => ({}) }
    },
    setControlState (k, v) { bot.controls[k] = v; if (k === 'forward' && v && opts.walkable !== false) bot.__walking = true },
    clearControlStates () { bot.controls = {}; bot.__walking = false },
    lookAt: async (v) => { bot.lookedAt.push(v) },
    activateBlock: async () => {}
  }
  return bot
}
// The body physically moving is the point of the fix, so the fake body actually moves: while
// `forward` is held, step toward whatever the caller last looked at.
function driveBody (bot, stopAfterMs) {
  const iv = setInterval(() => {
    if (!bot.controls.forward || !bot.lookedAt.length) return
    const tgt = bot.lookedAt[bot.lookedAt.length - 1]
    const dx = tgt.x - bot.entity.position.x; const dz = tgt.z - bot.entity.position.z
    const d = Math.hypot(dx, dz)
    if (d < 0.05) return
    const step = Math.min(0.45, d) // ~4.5 b/s at a 100ms tick - a walking player
    bot.entity.position.x += dx / d * step
    bot.entity.position.z += dz / d * step
  }, 100)
  setTimeout(() => clearInterval(iv), stopAfterMs || 20000)
  return () => clearInterval(iv)
}

async function crossingTests () {
  await ta('door-assist: a goto that ends short is FOLLOWED BY A WALK - the bot closes on its own door', async () => {
    const bot = fakeBot()
    const stop = driveBody(bot, 20000)
    const startDist = bot.entity.position.distanceTo(DOOR)
    assert.ok(startDist > 4, 'precondition: the live geometry is out of the 4b crossing reach (' + startDist.toFixed(1) + 'b)')
    try { await navigate.openNearbyDoor(bot, CROSS_OPTS) } finally { stop() }
    const endDist = bot.entity.position.distanceTo(DOOR)
    assert.ok(endDist < startDist - 1.5,
      'the crossing must MOVE THE BODY at the door instead of skipping it silently (' + startDist.toFixed(1) + 'b -> ' + endDist.toFixed(1) + 'b)')
  })

  await ta('door-assist: an honestly-rejected approach is walked too (both routes to the old silent skip)', async () => {
    const bot = fakeBot({ gotoRejects: true })
    const stop = driveBody(bot, 20000)
    const startDist = bot.entity.position.distanceTo(DOOR)
    try { await navigate.openNearbyDoor(bot, CROSS_OPTS) } finally { stop() }
    assert.ok(bot.entity.position.distanceTo(DOOR) < startDist - 1.5,
      '"No path to the goal!" is not a reason to abandon the only way out of the hut')
  })

  await ta('door-assist: a door it genuinely cannot close on is SKIPPED WITH THE NUMBERS (never silently)', async () => {
    const bot = fakeBot() // body never moves: driveBody is not started
    const lines = []
    navigate.setDebugSink(s => lines.push(String(s)))
    try { await navigate.openNearbyDoor(bot, CROSS_OPTS) } finally { navigate.setDebugSink(null) }
    const skip = lines.find(l => /SKIPPING the door/.test(l))
    assert.ok(skip, 'the give-up must be greppable (#7): ' + JSON.stringify(lines.slice(0, 8)))
    assert.ok(/\d+\.\d+b away/.test(skip), 'and it must carry the measured distance: ' + skip)
    assert.ok(lines.some(l => /close-in .*b -> .*b/.test(l)), 'the attempted close-in must report its own before/after')
  })
}

// ---- the 120s hut seal is GONE ------------------------------------------------------------
// Under F3, three failed crossings of a (hut,dir) armed a 120s cooldown during which crossOwnDoor
// returned in ~0ms having printed `cooling down - plain goto takes over`. It is not reachable to
// exercise offline (the cooldown gate sat above the maneuver, keyed on a registry hut), so the
// deletion is guarded structurally: the function, the ledger and the handoff line must all be gone.
t('crossOwnDoor: no cooldown can make it do nothing (the hut seal is deleted, not tuned)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'navigate.js'), 'utf8')
  assert.strictEqual(typeof navigate.crossVerdict, 'undefined', 'crossVerdict must stay deleted')
  assert.ok(!/doorCrossLedger\s*\.\s*(get|set|delete)/.test(src), 'no ledger reads/writes may survive')
  assert.ok(!/cooling down - plain goto takes over/.test(src.replace(/^\s*\/\/.*$/gm, '')),
    'a crossing may never hand off to a plain goto that cannot cross a closed door (#5)')
})

// ---- ROOT L: the tend pass is a walk, not a zig-zag ---------------------------------------
// The live 41-cell plot, persisted in tilling order, alternates between the band SOUTH of the hut
// and the band EAST of it - so almost every cell was 5-8b from the last and paid a full goto.
t('orderCellsNearest: the live zig-zag becomes a lawn-mower route', () => {
  const cells = [ // verbatim from the head of world-memory.json's wheatFarm.cells
    { x: 190, y: 68, z: -97 }, { x: 195, y: 68, z: -102 }, { x: 191, y: 68, z: -97 },
    { x: 195, y: 68, z: -103 }, { x: 192, y: 68, z: -97 }, { x: 195, y: 68, z: -104 }
  ]
  const from = { x: 190, y: 68, z: -100 }
  const leg = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  const walked = arr => { let d = 0; let cur = from; for (const c of arr) { d += leg(cur, c); cur = c } return d }
  const routed = farm.orderCellsNearest(cells, from)
  assert.strictEqual(routed.length, cells.length, 'every cell is still visited exactly once')
  assert.strictEqual(new Set(routed.map(c => c.x + ',' + c.z)).size, cells.length, 'no duplicates, no drops')
  assert.ok(walked(routed) < walked(cells) * 0.7,
    'the route must be substantially shorter than the persisted order (' + walked(routed).toFixed(1) + 'b vs ' + walked(cells).toFixed(1) + 'b)')
})
t('orderCellsNearest: pure - the caller\'s array is never mutated, and it is deterministic', () => {
  const cells = [{ x: 5, y: 68, z: 5 }, { x: 1, y: 68, z: 1 }, { x: 3, y: 68, z: 3 }]
  const copy = JSON.parse(JSON.stringify(cells))
  const a = farm.orderCellsNearest(cells, { x: 0, y: 68, z: 0 })
  const b = farm.orderCellsNearest(cells, { x: 0, y: 68, z: 0 })
  assert.deepStrictEqual(cells, copy, 'input untouched')
  assert.deepStrictEqual(a.map(c => c.x), [1, 3, 5], 'nearest first')
  assert.deepStrictEqual(a.map(c => c.x), b.map(c => c.x), 'same plot, same route')
})
t('orderCellsNearest: an empty/missing plot is not an error', () => {
  assert.deepStrictEqual(farm.orderCellsNearest([], { x: 0, y: 0, z: 0 }), [])
  assert.deepStrictEqual(farm.orderCellsNearest(null, { x: 0, y: 0, z: 0 }), [])
})
t('tendWheatFarm actually ROUTES its cells (the ordering is wired, not just written)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'provision-farm.js'), 'utf8')
  assert.ok(/cells = farm\.orderCellsNearest\(cells, bot\.entity\.position/.test(src),
    'the harvest loop must iterate the routed order - an unwired helper is a helper that does nothing')
})

;(async () => {
  await crossingTests()
  clearTimeout(WALL)
  for (const r of results) console.log(r)
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
