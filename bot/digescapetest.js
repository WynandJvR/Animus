'use strict'
// OFFLINE contract test for "after I take this block, can I climb out of the cell I just made?"
// (nav-profile.digEscapeVerdict + its one consumer, provision-recovery.ensurePillarFiller).
// No bot, no world, no clock - a stubbed sampler is the whole fixture.
//
// WHY THIS FILE EXISTS. On 2026-08-02 the bot DIED OF A FALL at (190,64,-103) into one of its own
// holes. The dig that makes those holes is the filler dig that feeds a pillar-out, and its guard
// asked the wrong question:
//     const under = bot.blockAt(p.offset(0, -1, 0))
//     if (!under || under.boundingBox !== 'block') { skipPitRisk++; continue }
// "Is the block BELOW my candidate solid?" is true of every block on a hillside. At (202,65,-103)
// y64 was solid, so the guard passed - and because the rim around that cell stands two blocks up
// on the slope, ONE legal dig left a pocket the bot could not step out of. It then walks into it
// (the dig steps onto the cell to pick up the drop).
//
// The prevention is the root: a rescue rung (widen detectPit, pillar out) is a second copy of the
// escape rule and only pays once the bot is already stuck. The prevention reuses `standable` - the
// one definition of "can I stand in this cell" - rather than inventing an eighth variant, and it
// is asked against the POST-DIG world so a chain of individually-legal digs cannot excavate a
// trench.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const np = require('./nav-profile.js')

let fails = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fails++ } }

// ---- fixture ----------------------------------------------------------------------------
// A sampler over a sparse block map. Anything unlisted is air; anything in `unknown` reads as
// null (an unloaded cell), which is what the live bot.blockAt returns outside loaded chunks.
function mkWorld (blocks, unknown) {
  const un = new Set(unknown || [])
  return (x, y, z) => {
    const k = x + ',' + y + ',' + z
    if (un.has(k)) return null
    const n = blocks[k] || 'air'
    return { name: n, solid: !/^(air|cave_air|void_air|water|lava)$/.test(n) }
  }
}
// Fill column (x,z) from y0 to y1 inclusive.
function col (blocks, x, z, y0, y1, name) { for (let y = y0; y <= y1; y++) blocks[x + ',' + y + ',' + z] = name }

// ---- THE LIVE GEOMETRY: (202,65,-103), the dig that made the hole -----------------------
// A dirt block in a notch on the slope. Its floor (y64) is solid - which is all the old guard
// asked - but every neighbouring column is filled to y66, so standing in the emptied cell (feet
// y65) leaves a rim TWO blocks up on all four sides. That is a pit, made in one legal dig.
function liveSlope () {
  const b = {}
  col(b, 202, -103, 60, 64, 'stone')   // the candidate's floor
  b['202,65,-103'] = 'dirt'            // <- the candidate itself
  for (const [nx, nz] of [[203, -103], [201, -103], [202, -102], [202, -104]]) col(b, nx, nz, 60, 66, 'stone')
  return b
}

t('THE FALL: the hillside notch at (202,65,-103) is REFUSED - its rim is 2 blocks up', () => {
  const s = mkWorld(liveSlope())
  assert.strictEqual(np.digEscapeVerdict({ x: 202, y: 65, z: -103 }, s), 'boxed')
})

t('...and the OLD guard would have allowed it (which is why the bot fell into it)', () => {
  const s = mkWorld(liveSlope())
  const under = s(202, 64, -103)
  assert.strictEqual(under.solid, true, 'the old question - "is the block below solid?" - answers YES here')
})

t('one neighbour a single step up is a rim: the SAME cell becomes diggable', () => {
  const b = liveSlope()
  delete b['201,66,-103'] // that column now tops out at y65 -> its feet cell is y66, one step up
  assert.strictEqual(np.digEscapeVerdict({ x: 202, y: 65, z: -103 }, mkWorld(b)), null)
})

// ---- the ordinary case must stay diggable (this guard must not starve the pillar) --------
t('flat ground: taking a surface block leaves a 1-deep scrape you can step out of', () => {
  const b = {}
  col(b, 100, 0, 60, 64, 'stone')
  b['100,65,0'] = 'grass_block'
  for (const [nx, nz] of [[101, 0], [99, 0], [100, 1], [100, -1]]) col(b, nx, nz, 60, 65, 'grass_block')
  assert.strictEqual(np.digEscapeVerdict({ x: 100, y: 65, z: 0 }, mkWorld(b)), null)
})

t("a niche in a WALL is not a pit - the body cannot stand in it, so the dig is allowed", () => {
  // This is the in-a-pit rescue path: the filler dig cuts blocks out of the pit WALL at feet
  // level so pillarUpTo has something to place. Refusing those would break the escape this
  // whole mechanism exists to make unnecessary.
  const b = {}
  col(b, 10, 0, 60, 70, 'stone')       // a solid wall column - the candidate is inside it
  for (const [nx, nz] of [[11, 0], [9, 0], [10, 1], [10, -1]]) col(b, nx, nz, 60, 70, 'stone')
  assert.strictEqual(np.digEscapeVerdict({ x: 10, y: 65, z: 0 }, mkWorld(b)), null)
})

// ---- the old guard's question survives as one arm ----------------------------------------
t('nothing solid below: still refused, and named "nofloor" (I would drop further than I dug)', () => {
  const b = {}
  b['5,65,5'] = 'dirt' // floating block: air below
  assert.strictEqual(np.digEscapeVerdict({ x: 5, y: 65, z: 5 }, mkWorld(b)), 'nofloor')
})

t('an unreadable cell fails CLOSED - never dig on a guess', () => {
  const b = {}
  col(b, 7, 7, 60, 64, 'stone')
  b['7,65,7'] = 'dirt'
  assert.strictEqual(np.digEscapeVerdict({ x: 7, y: 65, z: 7 }, mkWorld(b, ['7,64,7'])), 'unknown')
  assert.strictEqual(np.digEscapeVerdict({ x: 7, y: 65, z: 7 }, mkWorld(b, ['7,66,7'])), 'unknown')
  assert.strictEqual(np.digEscapeVerdict(null, () => null), 'unknown')
  assert.strictEqual(np.digEscapeVerdict({ x: 0, y: 0, z: 0 }, null), 'unknown')
})

// ---- the TRENCH: each dig legal, the sequence lethal --------------------------------------
t('CHAINED DIGS: digging straight down is refused once the cell above is already gone', () => {
  const b = {}
  col(b, 100, 0, 55, 64, 'stone')
  b['100,65,0'] = 'grass_block'
  for (const [nx, nz] of [[101, 0], [99, 0], [100, 1], [100, -1]]) col(b, nx, nz, 55, 65, 'grass_block')
  const removed = new Set()
  const base = mkWorld(b)
  const sample = (x, y, z) => removed.has(x + ',' + y + ',' + z) ? { name: 'air', solid: false } : base(x, y, z)
  // 1st dig: the surface scrape, allowed (rim one step up on all sides).
  assert.strictEqual(np.digEscapeVerdict({ x: 100, y: 65, z: 0 }, sample), null)
  removed.add('100,65,0')
  // 2nd dig: the block BELOW it. Every neighbour is now a 2-step wall - this is the trench.
  assert.strictEqual(np.digEscapeVerdict({ x: 100, y: 64, z: 0 }, sample), 'boxed')
})

t('...but two ADJACENT surface scrapes stay legal - a 1-deep scrape is not a trap', () => {
  const b = {}
  col(b, 100, 0, 55, 64, 'stone'); col(b, 101, 0, 55, 64, 'stone')
  b['100,65,0'] = 'grass_block'; b['101,65,0'] = 'grass_block'
  for (const [nx, nz] of [[99, 0], [100, 1], [100, -1], [102, 0], [101, 1], [101, -1]]) col(b, nx, nz, 55, 65, 'grass_block')
  const removed = new Set()
  const base = mkWorld(b)
  const sample = (x, y, z) => removed.has(x + ',' + y + ',' + z) ? { name: 'air', solid: false } : base(x, y, z)
  assert.strictEqual(np.digEscapeVerdict({ x: 100, y: 65, z: 0 }, sample), null)
  removed.add('100,65,0')
  assert.strictEqual(np.digEscapeVerdict({ x: 101, y: 65, z: 0 }, sample), null)
})

// ---- water/lava are the standable rule's business, not a second copy ----------------------
t('a rim of water is not a rim (standable owns that rule, and this asks IT)', () => {
  const b = {}
  col(b, 100, 0, 60, 64, 'stone')
  b['100,65,0'] = 'dirt'
  for (const [nx, nz] of [[101, 0], [99, 0], [100, 1], [100, -1]]) { col(b, nx, nz, 60, 64, 'stone'); b[nx + ',65,' + nz] = 'water'; b[nx + ',66,' + nz] = 'water' }
  assert.strictEqual(np.digEscapeVerdict({ x: 100, y: 65, z: 0 }, mkWorld(b)), 'boxed')
})

// ---- ANTI-DRIFT: the consumer asks the one definition -------------------------------------
t('ANTI-DRIFT: the filler dig asks digEscapeVerdict, not "is the block below solid"', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')
  const i = src.indexOf('async function ensurePillarFiller')
  assert(i > 0, 'ensurePillarFiller exists')
  const body = src.slice(i, src.indexOf('\n}', i))
  assert(/navProfile\.digEscapeVerdict\(/.test(body), 'the guard must consult the one definition')
  assert(!/const under = bot\.blockAt\(p\.offset\(0, -1, 0\)\)/.test(body),
    'the weaker "is the block below solid?" question is what let the bot dig its own grave')
  // the post-dig world: a chained dig must be judged against the cells this pass already took
  assert(/removed\.add\(/.test(body) && /removed\.has\(/.test(body),
    'candidates must be judged against the cells already removed THIS pass, or the sequence digs a trench')
  assert(/skipNoWayOut/.test(body) && /no-way-out/.test(body),
    'the refusal needs its own class on the filler-dig line, or the reason is invisible in the tape')
})

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall dig-escape tests passed')
process.exit(fails ? 1 : 0)
