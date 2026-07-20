'use strict'
// OFFLINE unit test for #116 ESCAPE_ACCOUNTABLE (DESIGN §3.4 D1 + capability gap H, Root D).
// Run:  cd bot && node escapeaccountabletest.js
//
// WHAT IT PINS - the 2026-07-19 drowning, defect by defect:
//   D1  a SURVIVE maneuver that claims the body must PROVE progress or be revoked. The live
//       failure: `(drown-crisis) taking the controls` held the body 24s with zero progress and
//       no layer escalated, precisely BECAUSE a subsystem had declared it was handling this.
//   H   'submerged-enclosed' is a recognised situation whose ladder starts VERTICAL. The live
//       failure: `swim: heading for the bank` x3 at a y55 target while the bot sat at y53 under
//       stone; the only vertical idea fired 1 second AFTER the death.
//   --  the circular `breach: low oxygen - handing back to the drown reflex` handoff is gone.
//   --  the 10s `drownCooldownUntil` blanket timer is gone and is NOT replaced by a timer.
//   --  a false "out of the water" cannot be claimed from a position reached by DYING (epoch).
//   --  an escape dig is booked as shaft DEBT, not left as another open pit.
//
// AMBIENT-PROOF: env is set explicitly below, never inherited (three regressions came from
// ambient env leaking into tests).
//
// SOURCE-PIN HYGIENE (this repo checks out CRLF and it has burned builders twice):
//   - every pin normalises CRLF -> LF FIRST;
//   - the pins match CODE SHAPES (`drownCooldownUntil =`, `oxygenLevel ... < 6`), never English
//     phrases, because the phrases now live on in the tombstone COMMENTS that explain the
//     deletion - greping those is how #115b turned five correct fixes red;
//   - `selfTest` below proves the normaliser works on LF *and* CRLF input before any pin runs;
//   - each pin is mutation-verified in-test: we reinstate the defect in a COPY of the source
//     and assert the pin fires. A pin that cannot fail is not a pin.

process.env.SCAFFOLD_FILE = require('path').join(require('os').tmpdir(), 'escacc-scaffold-' + process.pid + '.json')
process.env.WORLD_MEM_FILE = require('path').join(require('os').tmpdir(), 'escacc-worldmem-' + process.pid + '.json')
process.env.DEATH_FILE = require('path').join(require('os').tmpdir(), 'escacc-death-' + process.pid + '.json')
process.env.RESUME_FILE = require('path').join(require('os').tmpdir(), 'escacc-resume-' + process.pid + '.json')
delete process.env.BUILD_DEBUG

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const arbiter = require('./arbiter.js')
const pe = require('./pocket-escape.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}
async function ta (name, fn) {
  try { await fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}

// ---------------------------------------------------------------------------
// 0. THE CRLF NORMALISER + ITS OWN SELF-TEST (runs before any pin uses it)
// ---------------------------------------------------------------------------
const norm = (s) => String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
const srcOf = (f) => norm(fs.readFileSync(path.join(__dirname, f), 'utf8'))

t('selfTest: the CRLF normaliser works, and the classic stripper is a SILENT NO-OP without it', () => {
  const lf = 'a = 1\nb = 2\n'
  const crlf = 'a = 1\r\nb = 2\r\n'
  assert.strictEqual(norm(lf), lf, 'LF input must pass through unchanged')
  assert.strictEqual(norm(crlf), lf, 'CRLF input must normalise to the LF form')
  assert.strictEqual(norm(crlf), norm(lf), 'both encodings must agree')

  // THE TRAP, demonstrated live: the comment-stripper that has burned two builders in this
  // repo. `.` does not match `\r` and a bare `$` wants the true end of string, so on a CRLF
  // line the match never fires and the "stripped" source comes back IDENTICAL - silently.
  const strip = (s) => s.split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  const stripped = (s) => !/note/.test(strip(s)) // did the comment actually come off?
  const lfSrc = 'x = 1 // note\n'
  const crlfSrc = 'x = 1 // note\r\n'
  assert.ok(stripped(lfSrc), 'on LF source the stripper works')
  assert.ok(!stripped(crlfSrc), 'on CRLF source it is a SILENT NO-OP - this is the trap that burned two builders')
  assert.strictEqual(strip(crlfSrc), crlfSrc, 'and the "stripped" source comes back byte-identical, with no error')
  assert.ok(stripped(norm(crlfSrc)), 'normalising FIRST is what makes it work - which is what every pin below does')
})

// A pin is (name, predicate over source, mutation that reinstates the defect).
function pin (label, file, isClean, reinstateDefect) {
  t(label, () => {
    const src = srcOf(file)
    assert.ok(isClean(src), 'the defect is still present in ' + file)
    const mutated = reinstateDefect(src)
    assert.notStrictEqual(mutated, src, 'MUTATION SETUP FAILED: the mutation did not change ' + file + ' - the pin is untestable')
    assert.ok(!isClean(mutated), 'MUTATION CHECK FAILED: the pin does not fire when the defect is reinstated - it cannot fail, so it proves nothing')
  })
}

// ---------------------------------------------------------------------------
// 1. D1 - PROGRESS REVOCATION (arbiter). No wall clock is touched anywhere here:
//    the clock is FROZEN for every case, so any revocation that happens is
//    proven to be condition-driven, not time-driven (no-blanket-time-holds).
// ---------------------------------------------------------------------------
const FROZEN = 1000000
function freezeClock () { arbiter._reset(); arbiter._setNow(() => FROZEN) }

t('D1: a SURVIVE maneuver with a FLAT probe is REVOKED and stops owning the body', () => {
  freezeClock()
  const tok = arbiter.beginManeuver('drown-escape', arbiter.PRIORITY.SURVIVE, 40000, { probe: () => 53 })
  assert.ok(arbiter.maneuverActive(arbiter.PRIORITY.SURVIVE), 'the span should own the body to begin with')
  let revoked = []
  for (let i = 0; i <= arbiter.PROBE_STALLS; i++) revoked = arbiter.sampleManeuvers() // the first sample establishes the baseline
  assert.ok(arbiter.maneuverRevoked(tok), 'a flat probe must revoke the claim')
  assert.strictEqual(revoked.length, 1, 'the revocation must be reported to the caller so it can escalate')
  assert.strictEqual(revoked[0].label, 'drown-escape')
  assert.ok(!arbiter.maneuverActive(arbiter.PRIORITY.SURVIVE), 'a revoked claimant must NOT still be holding the body (the 24s hold)')
})

t('D1: revocation is CONDITION-driven, not time-driven (clock never advances)', () => {
  freezeClock()
  const tok = arbiter.beginManeuver('drown-escape', arbiter.PRIORITY.SURVIVE, 40000, { probe: () => 53 })
  for (let i = 0; i <= arbiter.PROBE_STALLS; i++) arbiter.sampleManeuvers()
  assert.ok(arbiter.maneuverRevoked(tok), 'revoked with a frozen clock => no timer is involved')
})

t('D1: a maneuver that IS making progress is never revoked', () => {
  freezeClock()
  let y = 53
  const tok = arbiter.beginManeuver('escape:vertical', arbiter.PRIORITY.SURVIVE, 40000, { probe: () => y++ })
  for (let i = 0; i < arbiter.PROBE_STALLS * 4; i++) arbiter.sampleManeuvers()
  assert.ok(!arbiter.maneuverRevoked(tok), 'a rising probe must keep the body')
  assert.ok(arbiter.maneuverActive(arbiter.PRIORITY.SURVIVE), 'and the span must still be active')
})

t('D1: bobbing (probe returns to a previous value) does not count as progress', () => {
  freezeClock()
  let i = 0
  const seq = [53, 54, 53, 54, 53, 54, 53, 54]
  const tok = arbiter.beginManeuver('escape:swim', arbiter.PRIORITY.SURVIVE, 40000, { probe: () => seq[i++ % seq.length] })
  for (let n = 0; n < 8; n++) arbiter.sampleManeuvers()
  assert.ok(arbiter.maneuverRevoked(tok), 'oscillating without ever beating the best is not progress')
})

t('D1: a probe that THROWS is treated as no progress (fail closed)', () => {
  freezeClock()
  const tok = arbiter.beginManeuver('escape:swim', arbiter.PRIORITY.SURVIVE, 40000, { probe: () => { throw new Error('world read blew up') } })
  for (let i = 0; i <= arbiter.PROBE_STALLS; i++) arbiter.sampleManeuvers()
  assert.ok(arbiter.maneuverRevoked(tok), 'an escape whose own progress measure is broken must not keep the body')
})

t('D1: unprobed and sub-SURVIVE spans are untouched (every existing caller is unaffected)', () => {
  freezeClock()
  const plain = arbiter.beginManeuver('nav', arbiter.PRIORITY.SURVIVE, 40000)          // no probe
  const lower = arbiter.beginManeuver('trek', arbiter.PRIORITY.PROGRESS, 40000, { probe: () => 1 })
  for (let i = 0; i < arbiter.PROBE_STALLS * 3; i++) arbiter.sampleManeuvers()
  assert.ok(!arbiter.maneuverRevoked(plain), 'a span with no probe must never be revoked')
  assert.ok(!arbiter.maneuverRevoked(lower), 'a PROGRESS-tier span must never be revoked by this mechanism')
  assert.ok(arbiter.maneuverActive(arbiter.PRIORITY.PROGRESS), 'both spans still own the body')
})

t('D1: endManeuver retires the id (the revocation set does not leak)', () => {
  freezeClock()
  const tok = arbiter.beginManeuver('escape:swim', arbiter.PRIORITY.SURVIVE, 40000, { probe: () => 53 })
  for (let i = 0; i <= arbiter.PROBE_STALLS; i++) arbiter.sampleManeuvers()
  assert.ok(arbiter.maneuverRevoked(tok))
  arbiter.endManeuver(tok)
  assert.ok(!arbiter.maneuverRevoked(tok), 'a retired id must not stay in the revocation set forever')
})
arbiter._reset(); arbiter._setNow(null)

// ---------------------------------------------------------------------------
// 2. H - SITUATION CLASSIFICATION. Fixtures in the pure `read(dx,dy,dz)` contract.
// ---------------------------------------------------------------------------
function grid (cells, def) {
  const map = new Map()
  for (const k in cells) map.set(k, cells[k])
  return (dx, dy, dz) => {
    const k = dx + ',' + dy + ',' + dz
    if (map.has(k)) return map.get(k)
    return typeof def === 'function' ? def(dx, dy, dz) : def
  }
}

t('H: THE LIVE GEOMETRY - a flooded pocket under solid stone with void sides is submerged-enclosed', () => {
  // The 15:51:17 pocket: bot at y53, water column, stone ceiling overhead, nothing standable
  // anywhere in reach. `staircase: all 4 directions hazardous (void)` - lateral was impossible.
  const read = grid({ '0,0,0': 'water', '0,1,0': 'water' }, (dx, dy, dz) => dy >= 2 ? 'stone' : 'water')
  assert.strictEqual(pe.classifySubmersion(read, null), 'submerged-enclosed')
})

t('H: open water with a standable bank classifies as open-water-with-bank', () => {
  const read = grid({
    '0,0,0': 'water', '0,1,0': 'water', '0,2,0': 'air',
    '2,0,0': 'air', '2,-1,0': 'dirt' // a standable, breathable bank two east
  }, (dx, dy, dz) => dy >= 2 ? 'air' : (dx === 2 ? 'dirt' : 'water'))
  assert.strictEqual(pe.classifySubmersion(read, null), 'open-water-with-bank')
})

t('H: roofed, bankless, but a thin diggable wall to a bank is a thin-wall-pocket', () => {
  const read = grid({
    '0,0,0': 'water', '0,1,0': 'water', '0,2,0': 'oak_log',
    '1,0,0': 'oak_log', '1,1,0': 'oak_log', '1,2,0': 'oak_log',
    '2,0,0': 'air', '2,1,0': 'air', '2,-1,0': 'dirt'
  }, (dx, dy, dz) => dy <= -1 ? 'stone' : 'oak_log')
  // With no diggable predicate there is no lateral option and it reads as enclosed...
  assert.strictEqual(pe.classifySubmersion(read, null), 'submerged-enclosed')
  // ...but once the logs are diggable, the bounded horizontal breach is available.
  assert.strictEqual(pe.classifySubmersion(read, (n) => /oak_log/.test(n)), 'thin-wall-pocket')
})

t('H: a head out of the water is not a submersion at all', () => {
  const read = grid({ '0,0,0': 'water', '0,1,0': 'air' }, 'stone')
  assert.strictEqual(pe.classifySubmersion(read, null), 'not-submerged')
})

t('H: UNKNOWN (unloaded) reads never manufacture an enclosure', () => {
  // Everything overhead unloaded: absence of observation must not become observation of a ceiling.
  const read = grid({ '0,0,0': 'water', '0,1,0': 'water' }, null)
  const v = pe.classifySubmersion(read, null)
  assert.notStrictEqual(v, 'submerged-enclosed', 'an unloaded chunk is not evidence of being sealed in')
  assert.strictEqual(v, 'open-water-no-bank')
})

t('H: unknown cells are not traversable and not banks', () => {
  assert.ok(!pe.isBankCell(grid({ '1,0,0': null }, null), 1, 0, 0), 'an unknown cell is not a bank')
  assert.ok(!pe.isBankCell(grid({ '1,0,0': 'air', '1,-1,0': null }, null), 1, 0, 0), 'air over an unknown floor is not a bank')
  assert.ok(pe.isBankCell(grid({ '1,0,0': 'air', '1,-1,0': 'dirt' }, null), 1, 0, 0), 'air over known solid IS a bank')
})

// ---------------------------------------------------------------------------
// 3. H - THE LADDER ORDER. This is the whole capability gap in one assertion.
// ---------------------------------------------------------------------------
t('H: a submerged enclosure runs VERTICAL FIRST, not swim-to-a-bank-that-does-not-exist', () => {
  const order = pe.escapeRungOrder('submerged-enclosed')
  assert.strictEqual(order[0], 'vertical', 'vertical must be the FIRST rung, not the one that fires 1s after death')
  assert.ok(order.indexOf('swim') > order.indexOf('vertical'), 'swim must not outrank vertical when there is no bank')
  assert.notStrictEqual(order[0], 'swim')
})

t('H: a thin-wall pocket breaches first; open water still swims first', () => {
  assert.strictEqual(pe.escapeRungOrder('thin-wall-pocket')[0], 'breach')
  assert.strictEqual(pe.escapeRungOrder('open-water-with-bank')[0], 'swim', 'ordinary open water must be UNCHANGED')
  assert.strictEqual(pe.escapeRungOrder('open-water-no-bank')[0], 'rise')
})

t('H: every situation can still reach every rung (no rung is made unreachable)', () => {
  for (const s of ['submerged-enclosed', 'thin-wall-pocket', 'open-water-no-bank', 'open-water-with-bank', 'whatever']) {
    const order = pe.escapeRungOrder(s)
    assert.strictEqual(order.length, pe.ESCAPE_RUNGS.length, s + ': wrong rung count')
    for (const r of pe.ESCAPE_RUNGS) assert.ok(order.includes(r), s + ': rung ' + r + ' became unreachable')
  }
})

// ---------------------------------------------------------------------------
// 4. THE DELETIONS - source pins, each mutation-verified.
// ---------------------------------------------------------------------------

// The circular handoff: breachWaterPocket bailed on low oxygen straight back to the drown
// reflex that had already been failing for 15s, which came right back. Pin the CODE SHAPE.
pin('DELETED: breachWaterPocket no longer bails to the drown reflex on low oxygen (circular handoff)',
  'provision.js',
  (src) => !/oxygenLevel[^\n]*<\s*6/.test(src),
  (src) => src.replace('const feet = bot.entity.position.floored()',
    "if ((bot.oxygenLevel ?? 20) < 6) { dbg('  breach: low oxygen'); return false }\n  const feet = bot.entity.position.floored()'"))

// The 10s blanket timer. Pin the ASSIGNMENT, not the word - the word survives in the
// tombstone comment that explains why it is gone.
pin('DELETED: the drownCooldownUntil 10s blanket timer is gone from index.js',
  'index.js',
  (src) => !/drownCooldownUntil\s*=/.test(src),
  (src) => src.replace('let drowning = false', 'let drownCooldownUntil = 0\n  let drowning = false'))

pin('DELETED: and it was not replaced by another cooldown/backoff timer on the drown path',
  'index.js',
  (src) => {
    const m = src.match(/DROWN CRISIS[\s\S]*?\n\}\n/)
    assert.ok(m, 'could not locate the drown-crisis block - the landmark moved, fix this pin')
    return !/(cooldown|backoff|retryAfter)\s*(Until|At|Ms)?\s*=\s*Date\.now\(\)\s*\+/i.test(m[0])
  },
  (src) => src.replace('let drowning = false', 'let cooldownUntil = Date.now() + 10000\n  let drowning = false'))

// The drowning bot must never reach the wetbreach rung - that is the other end of the loop.
pin('WIRED: the wetbreach recovery rung is gated OFF while the head is underwater',
  'navigate.js',
  (src) => {
    const m = src.match(/kind: 'wetbreach',[\s\S]*?run: async/)
    assert.ok(m, 'could not locate the wetbreach rung - the landmark moved, fix this pin')
    return /!headInWater\(bot\)/.test(m[0])
  },
  (src) => src.replace('feetInWater(bot) && !headInWater(bot) &&', 'feetInWater(bot) &&'))

// The water rung must delegate to the one owner instead of running a rival ladder.
pin('WIRED: the water recovery rung delegates a DROWNING bot to escapeWater (single owner)',
  'navigate.js',
  (src) => {
    const m = src.match(/kind: 'water',[\s\S]*?kind: 'wetbreach'/)
    assert.ok(m, 'could not locate the water rung - the landmark moved, fix this pin')
    return /if \(headInWater\(bot\)\)[\s\S]{0,200}escapeWater\(bot/.test(m[0])
  },
  (src) => src.replace(/if \(headInWater\(bot\)\) \{\n          const out = await escapeWater\(bot, \{ isStopped \}\)\n          return out \|\| movedEnough\(\)\n        \}\n/, ''))

// Epoch-scoped success: the 15:51:19 `out of the water` was logged from the RESPAWN POINT.
pin('EPOCH: escapeWater cannot claim success in a life it did not start in',
  'navigate.js',
  (src) => {
    const m = src.match(/async function escapeWater[\s\S]*?\n\}\n/)
    assert.ok(m, 'could not locate escapeWater - the landmark moved, fix this pin')
    return /const e0 = pathfix\.epoch\(\)/.test(m[0]) && /const out = !wet\(\) && pathfix\.sameEpoch\(e0\)/.test(m[0])
  },
  (src) => src.replace('const out = !wet() && pathfix.sameEpoch(e0)', 'const out = !wet()'))

pin('EPOCH: the drown-crisis reflex cannot announce an escape it did not make',
  'index.js',
  (src) => /if \(!pathfix\.sameEpoch\(e0\)\)/.test(src),
  (src) => src.replace('if (!pathfix.sameEpoch(e0))', 'if (false)'))

// Anti-grief / Root C: the escape hole is DEBT, not litter.
pin('LEDGER: every escape dig is booked as shaft debt (both the breach and the column)',
  'provision.js',
  (src) => {
    const digs = src.match(/await bot\.dig\([^)]*\); scaffold\.oweShaft\(/g) || []
    return digs.length >= 2
  },
  (src) => src.replace('await bot.dig(block); scaffold.oweShaft(pos, block.name)', 'await bot.dig(block)'))

pin('ANTI-GRIEF: escapeUpColumn fails closed on an UNKNOWN cell overhead and refuses build zones',
  'provision.js',
  (src) => {
    const m = src.match(/async function escapeUpColumn[\s\S]*?\n\}\n/)
    assert.ok(m, 'could not locate escapeUpColumn - the landmark moved, fix this pin')
    return /if \(!cell\.known\)[\s\S]{0,160}return false/.test(m[0]) &&
      /inBuildZone\(start\.x, start\.z\)/.test(m[0]) &&
      /insideOwnStructure\(bot\)/.test(m[0]) &&
      /diggable\(b\.name, 0, 2, 0\)/.test(m[0])
  },
  (src) => src.replace('if (!cell.known) {', 'if (false) {'))

// ---------------------------------------------------------------------------
// 5. escapeUpColumn - BEHAVIOURAL, on a fake world. The capability that did not exist.
// ---------------------------------------------------------------------------
const provision = require('./provision.js')
const scaffold = require('./scaffold.js')
const pathfix = require('./pathfix.js')

// A minimal fake bot over an explicit column: stone from y54 up to y62, air at y63+.
// The bot stands at y53 with water at y53/y54 - the live geometry.
function fakeBot (opts = {}) {
  const dug = []
  const world = new Map()
  const key = (x, y, z) => x + ',' + y + ',' + z
  const set = (x, y, z, name) => world.set(key(x, y, z), name)
  // water at feet+head, stone above to y62, air from y63
  set(430, 53, -49, 'water'); set(430, 54, -49, 'water')
  for (let y = 55; y <= 62; y++) set(430, y, -49, 'stone')
  for (let y = 63; y <= 70; y++) set(430, y, -49, 'air')
  if (opts.world) for (const k in opts.world) world.set(k, opts.world[k])
  const bot = {
    entity: { position: { x: 430.5, y: 53, z: -49.5, floored: () => mkVec(430, Math.floor(bot.entity.position.y), -49) }, yaw: 0, onGround: false },
    heldItem: null,
    inventory: { items: () => [] },
    blockAt (p) {
      const name = world.get(key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
      if (name === undefined) return null            // unloaded
      return { name, position: mkVec(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: /air|water/.test(name) ? 'empty' : 'block' }
    },
    canDigBlock: () => true,
    async dig (b) { dug.push(b); set(b.position.x, b.position.y, b.position.z, 'air') },
    async equip () {},
    async look () {},
    clearControlStates () {},
    setControlState () {},
    pathfinder: { setGoal () {} },
    _dug: dug,
    _world: world
  }
  return bot
}
function mkVec (x, y, z) {
  return { x, y, z, floored: () => mkVec(x, y, z), offset: (dx, dy, dz) => mkVec(x + dx, y + dy, z + dz) }
}

async function main () {
await ta('H: escapeUpColumn digs the column overhead and books every cell as shaft debt', async () => {
  const bot = fakeBot()
  // The fake bot rises as it clears each ceiling cell (jumpForAir's real-world effect).
  const origDig = bot.dig.bind(bot)
  bot.dig = async (b) => { await origDig(b); bot.entity.position.y = b.position.y - 1 }
  const before = scaffold.shaftDebts({ x: 430, z: -49 }, 8).length
  const ok = await provision.escapeUpColumn(bot, { maxUp: 16 })
  const debts = scaffold.shaftDebts({ x: 430, z: -49 }, 8)
  assert.ok(bot._dug.length > 0, 'it must actually dig - this is the move that did not exist')
  for (const b of bot._dug) assert.strictEqual(b.name, 'stone', 'it must only break the natural stone ceiling')
  assert.ok(debts.length - before >= bot._dug.length, 'every dug cell must become shaft DEBT, not an unowned hole (Root C)')
  assert.ok(ok === true || ok === false, 'it must return an honest boolean, never wedge')
})

await ta('ANTI-GRIEF: escapeUpColumn refuses to dig a cell it cannot read (unloaded chunk)', async () => {
  const bot = fakeBot()
  bot._world.delete('430,55,-49') // unloaded directly overhead
  const dugBefore = bot._dug.length
  const ok = await provision.escapeUpColumn(bot, { maxUp: 16 })
  assert.strictEqual(ok, false, 'an unknown cell overhead must abort, not be guessed at')
  assert.strictEqual(bot._dug.length, dugBefore, 'it must not have dug anything blind')
})

await ta('ANTI-GRIEF: escapeUpColumn refuses to break a player/own structure block overhead', async () => {
  const bot = fakeBot()
  bot._world.set('430,55,-49', 'oak_planks') // a build, not terrain
  const ok = await provision.escapeUpColumn(bot, { maxUp: 16 })
  assert.strictEqual(ok, false, 'planks are not the bot\'s to break to escape')
  assert.strictEqual(bot._dug.length, 0, 'it must not have touched the structure')
})

await ta('EPOCH: escapeUpColumn claims nothing if the bot dies mid-climb', async () => {
  const bot = fakeBot()
  const origDig = bot.dig.bind(bot)
  let n = 0
  bot.dig = async (b) => { await origDig(b); if (++n === 1) pathfix.bumpEpoch() } // die after the first dig
  const ok = await provision.escapeUpColumn(bot, { maxUp: 16 })
  assert.strictEqual(ok, false, 'a claim must never outlive the bot that made it (the 15:51:19 respawn line)')
})

await ta('H: escapeUpColumn stops the moment the head is breathing (bounded, no over-digging)', async () => {
  const bot = fakeBot()
  bot._world.set('430,54,-49', 'air') // head already clear
  const ok = await provision.escapeUpColumn(bot, { maxUp: 16 })
  assert.strictEqual(ok, true, 'a breathing bot has already escaped')
  assert.strictEqual(bot._dug.length, 0, 'and it must not dig a single block to "escape" something it is not in')
})

} // end main

// ---------------------------------------------------------------------------
main().then(() => {
  try { fs.unlinkSync(process.env.SCAFFOLD_FILE) } catch {}
  console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall green')
  process.exit(failures ? 1 : 0)
}).catch((e) => {
  console.log('FAIL  harness crashed: ' + (e && e.stack ? e.stack : e))
  process.exit(1)
})
