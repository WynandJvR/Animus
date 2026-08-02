'use strict'
// OFFLINE test for ROOT D (2026-08-02): protect the GROUND under and around our own structures.
// No bot, no world. Run:  cd bot && node digblockedtest.js
//
// canBreakNaturally is MATERIAL-ONLY (DIGGABLE_NATURAL && !STRUCTURE_RE), so the hut's planks
// were protected and the dirt they stand on was not. Nothing anywhere was positional about the
// ground under registered infra. Live probe 2026-08-02: 16 hut floor cells with air directly
// beneath them, clearest excavation signature at the x=188 column; plus 2+ deep holes beside the
// wheat plot that fed 41 "wedged in a PIT" recoveries.
//
// The fix is ONE positional dig-permission predicate derived from the registry - not a fourth
// guard in front of the existing three. It is the 2026-08-01 `pitBlocked` hoisted out of
// provision-recovery.js with its arms in the same order, own-infra widened from "the hut box" to
// "the hut box + its support columns + point-infra columns + the farm's support ring", and the
// trapped carve-out (`allowOwnInfra`) preserved byte-for-byte in meaning.

const assert = require('assert')
const hutModel = require('./hut-model.js')
const provCore = require('./provision-core.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

// The live registry entry, so the geometry is checked against the hut that actually exists.
const HUT = { x: 188, y: 67, z: -104 }

// ---- 1. hutModel.inSupport (PURE) --------------------------------------------------------
t('inSupport: the column directly under the floor is support', () => {
  assert.strictEqual(hutModel.inSupport(HUT, 188, 66, -104), true,
    'the exact cell probed live: floor plank above, air below - this is the hole the filler dug')
})

t('inSupport: the ONE-CELL RING outside the footprint is support (lateral + doorstep)', () => {
  assert.strictEqual(hutModel.inSupport(HUT, 187, 66, -105), true, 'ring corner')
  assert.strictEqual(hutModel.inSupport(HUT, 194, 67, -98), true, 'far ring corner (anchor + DIMS)')
})

t('inSupport: outside the ring is NOT support - the protection is 8x8, not a radius', () => {
  assert.strictEqual(hutModel.inSupport(HUT, 186, 66, -103), false,
    'the natural grass column from the live probe stays diggable')
  assert.strictEqual(hutModel.inSupport(HUT, 195, 66, -104), false, 'one past the ring')
  assert.strictEqual(hutModel.inSupport(HUT, 188, 66, -97), false, 'one past the ring on z')
})

t('inSupport: it is DEPTH-UNBOUNDED, and it stops at the floor', () => {
  assert.strictEqual(hutModel.inSupport(HUT, 191, 30, -102), true,
    'no invented K-plane: this hut sits on a slope (grade y66 west, y65 east), so any fixed depth ' +
    'under-protects one side. "The whole column" needs no number at all.')
  assert.strictEqual(hutModel.inSupport(HUT, 190, 68, -104), false,
    'interior cells ABOVE the floor are not support - hut tidying/repair is unaffected')
})

t('inSupport is PURE - derived from DIMS, no world reads, no bot', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'hut-model.js'), 'utf8')
  const i = src.indexOf('const inSupport =')
  const line = src.slice(i, src.indexOf('\n\n', i))
  assert.ok(/DIMS\.w/.test(line) && /DIMS\.l/.test(line), 'the box comes from the schematic dims, not from copied literals')
  assert.ok(!/bot\./.test(line) && !/blockAt/.test(line), 'no world reads')
})

// ---- 2. digBlocked arms ------------------------------------------------------------------
// A bot stub: digBlocked reads only the registry (via the real modules) and the block it is
// handed. With empty registries only the material/fluid/farm arms can fire.
const botStub = {}
const B = name => ({ name })

function withRegistry (infra, wheatCells, fn) {
  const wm = require('./world-memory.js')
  const mem = wm.loadWorldMem()
  const savedInfra = mem.infra; const savedFarm = mem.wheatFarm
  mem.infra = infra
  mem.wheatFarm = wheatCells ? { cells: wheatCells } : undefined
  try { return fn() } finally { mem.infra = savedInfra; mem.wheatFarm = savedFarm }
}

t('digBlocked: someone else\'s build -> "build"; a fluid -> "fluid"; plain terrain -> null', () => {
  withRegistry({}, null, () => {
    assert.strictEqual(provCore.digBlocked(botStub, { x: 0, y: 60, z: 0 }, B('oak_planks')), 'build')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 0, y: 60, z: 0 }, B('water')), 'fluid')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 0, y: 60, z: 0 }, B('lava')), 'fluid')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 0, y: 60, z: 0 }, B('stone')), null)
    assert.strictEqual(provCore.digBlocked(botStub, { x: 0, y: 60, z: 0 }, B('air')), null, 'air is not a dig')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 0, y: 60, z: 0 }, null), null, 'an unreadable cell is not a dig')
  })
})

t('digBlocked: the ground under the hut is "own-infra" - the arm the material rule could not see', () => {
  withRegistry({ hut: [HUT] }, null, () => {
    assert.strictEqual(provCore.digBlocked(botStub, { x: 188, y: 66, z: -104 }, B('dirt')), 'own-infra',
      'THE live hole: plain dirt, materially diggable, holding up the floor')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 187, y: 40, z: -105 }, B('stone')), 'own-infra',
      'ring column, arbitrarily deep')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 186, y: 66, z: -103 }, B('dirt')), null,
      'and one cell outside the ring is still ordinary ground - this is a box, not a keep-out radius')
  })
})

t('digBlocked: the 3x3 column beneath point infra is protected too', () => {
  withRegistry({ chest: [{ x: 50, y: 70, z: 50 }] }, null, () => {
    assert.strictEqual(provCore.digBlocked(botStub, { x: 51, y: 69, z: 50 }, B('dirt')), 'own-infra')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 50, y: 70, z: 50 }, B('dirt')), null, 'not the chest cell itself, only BELOW it')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 52, y: 69, z: 50 }, B('dirt')), null, 'outside the 3x3')
  })
})

t('digBlocked: the farm SUPPORT ring covers the pit band the hut box cannot reach', () => {
  // real persisted geometry: 41 cells spanning x183..197, z-105..-95, y in {67,68}
  const cells = [{ x: 185, y: 67, z: -95 }, { x: 198, y: 68, z: -96 }]
  withRegistry({ hut: [HUT] }, cells, () => {
    // the hut box is x187..194 / z-105..-98: it misses (184,-95) and (186,-95) on BOTH axes
    assert.strictEqual(hutModel.inSupport(HUT, 184, 66, -95), false, 'the hut ring genuinely does not reach the pit band')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 184, y: 66, z: -95 }, B('dirt')), 'own-infra',
      'the farm support ring is what covers it - this is the band the filler dug 2+ deep')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 186, y: 60, z: -95 }, B('stone')), 'own-infra', 'whole column')
    // PER-CELL y, not one global plane: the plot spans y67 and y68
    assert.strictEqual(provCore.digBlocked(botStub, { x: 199, y: 67, z: -96 }, B('dirt')), 'own-infra',
      'the ring beneath the y68 cell - a single plane derived from the y67 cells would have stopped at y66 and missed it')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 185, y: 67, z: -95 }, B('dirt')), 'farm',
      'the crop cell itself is the FARM arm, and it fires first')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 181, y: 60, z: -95 }, B('stone')), null, 'two out laterally: ordinary ground')
  })
})

t('digBlocked: allowOwnInfra lifts own-infra ONLY - and lifts it for the hut FABRIC too (MUTATION CHECK)', () => {
  withRegistry({ hut: [HUT] }, [{ x: 185, y: 67, z: -95 }], () => {
    const floor = { x: 190, y: 67, z: -102 } // a hut floor plank
    assert.strictEqual(provCore.digBlocked(botStub, floor, B('oak_planks')), 'own-infra', 'normally refused')
    assert.strictEqual(provCore.digBlocked(botStub, floor, B('oak_planks'), { allowOwnInfra: true }), null,
      'the trapped last resort may dig its own floor. If the MATERIAL check is re-ordered ahead of the ' +
      'own-infra arm this returns "build" and the 2026-08-01 sealed-hut deadlock is back.')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 190, y: 64, z: -102 }, B('dirt'), { allowOwnInfra: true }), null,
      '...AND the dirt beneath it - the shaft spoil is what pays for the climb back')
    // everything else stays unconditional, trapped or not
    assert.strictEqual(provCore.digBlocked(botStub, { x: 185, y: 67, z: -95 }, B('dirt'), { allowOwnInfra: true }), 'farm')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 0, y: 60, z: 0 }, B('lava'), { allowOwnInfra: true }), 'fluid')
    assert.strictEqual(provCore.digBlocked(botStub, { x: 0, y: 60, z: 0 }, B('oak_planks'), { allowOwnInfra: true }), 'build',
      "someone else's build is NEVER dug, trapped or not")
  })
})

t('digBlocked is cheap: no world reads of its own, and it returns on the FIRST match', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'provision-core.js'), 'utf8')
  const i = src.indexOf('function digBlocked (bot, cell, b,')
  const fn = src.slice(i, src.indexOf('\n}', i))
  assert.ok(!/bot\.blockAt/.test(fn) && !/findBlock/.test(fn),
    'ensurePillarFiller calls this over up to 64 candidates - body responsiveness outranks everything (#8)')
  const arms = (fn.match(/return /g) || []).length
  assert.ok(arms >= 5, 'each arm returns immediately rather than computing a full verdict')
})

// ---- 3. the call sites (MUTATION CHECKS) -------------------------------------------------
const fs = require('fs')
const path = require('path')
const rec = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')

t('provision-recovery no longer defines a local copy of the rule (MUTATION CHECK)', () => {
  assert.ok(!/const pitBlocked = /.test(rec), 'pitBlocked is gone - two copies of a dig rule is how they drift (#4)')
  assert.ok(/provCore\.digBlocked\(bot, cell, b, \{ allowOwnInfra \}\)/.test(rec), 'the column scan calls the hoisted rule')
  assert.ok(/provCore\.digBlocked\(bot, v, b, \{ allowOwnInfra: spendFloor \}\)/.test(rec), 'and so does the dig')
})

t('ensurePillarFiller consults digBlocked and NEVER passes allowOwnInfra (MUTATION CHECK)', () => {
  const i = rec.indexOf('async function ensurePillarFiller')
  const fn = rec.slice(i, rec.indexOf('\n// Deliberate, bounded death by FALL', i))
  assert.ok(/if \(provCore\.digBlocked\(bot, p, b\)\) \{ skipProtected\+\+; continue \}/.test(fn),
    'the dig that hollowed out the hut floor now asks permission')
  assert.ok(!/digBlocked\([^)]*allowOwnInfra/.test(fn), 'a few blocks of filler are never worth undermining the house')
  assert.ok(!/if \(!canBreakNaturally\(b\)\) continue/.test(fn), 'the material-only check it replaced is gone, not stacked in front of')
  assert.ok(!/scaffold\.onFarmFootprint\(p\) \|\| farmFootprintHas\(p\)/.test(fn), 'and so is the hand-written farm check')
})

t('ensurePillarFiller refuses to MANUFACTURE the pit it keeps getting wedged in', () => {
  // SUPERSEDED, NOT RELAXED (2026-08-02). This used to pin the guard's exact text - "is the block
  // BELOW my candidate solid?" - which is true of every block on a hillside, so it passed at
  // (202,65,-103) and the bot DIED OF A FALL at (190,64,-103) in the hole it left. The intent
  // this test states is unchanged and now asked properly, against navProfile.digEscapeVerdict
  // ("after I take this block, can I climb out of the cell I just made?"), evaluated on the
  // post-dig world so chained digs cannot form a trench. The geometry lives in digescapetest.js.
  const i = rec.indexOf('async function ensurePillarFiller')
  const fn = rec.slice(i, rec.indexOf('\n// Deliberate, bounded death by FALL', i))
  assert.ok(/const verdict = navProfile\.digEscapeVerdict\(\{ x: p\.x, y: p\.y, z: p\.z \}, sample\)/.test(fn) &&
            /if \(verdict === 'boxed'\) \{ skipNoWayOut\+\+; continue \}/.test(fn) &&
            /if \(verdict\) \{ skipPitRisk\+\+; continue \}/.test(fn),
    'a candidate whose removal leaves a hole I cannot climb out of is not a candidate - 41 PIT recoveries in one day, then a fall death')
  assert.ok(!/const under = bot\.blockAt\(p\.offset\(0, -1, 0\)\)/.test(fn),
    'the weaker question must be GONE, not stacked in front of the real one (#1)')
  assert.ok(/filler dig: dug ' \+ dug \+ '\/' \+ cands\.length \+ ' candidates \(skipped ' \+ skipProtected \+ ' own-infra\/farm, ' \+ skipPitRisk \+ ' pit-risk, ' \+ skipNoWayOut \+ ' no-way-out\)/.test(fn),
    'one greppable line with the numbers in it (#7)')
})

t('the material diggers in provision-mining consult the same rule', () => {
  const min = fs.readFileSync(path.join(__dirname, 'provision-mining.js'), 'utf8')
  const hits = (min.match(/provCore\.digBlocked\(bot,/g) || []).length
  assert.strictEqual(hits, 4, 'shaft descent, tunnel face, staircase-down tread, ore bycatch; got ' + hits)
  // ...and the ESCAPE digs are deliberately NOT migrated: a bot trapped in a cave under its own
  // hut must still be able to dig upward/outward through natural ground (#2 outranks tidiness).
  const up = min.slice(min.indexOf('async function digStaircaseUp'), min.indexOf('async function digStaircaseDown'))
  assert.ok(/canBreakNaturally\(b\) && !S\(\)\.scaffoldDigOK\(b\)/.test(up),
    'digStaircaseUp keeps exactly today\'s material gate - the protection must never be able to entomb the bot')
  assert.ok(/if \(!canBreakNaturally\(above\) && !S\(\)\.scaffoldDigOK\(above\)\)/.test(min),
    'and so does pillarUpTo')
})

t('ROOT D adds no process.env flag', () => {
  const core = fs.readFileSync(path.join(__dirname, 'provision-core.js'), 'utf8')
  const i = core.indexOf('function digBlocked (bot, cell, b,')
  assert.ok(!/process\.env/.test(core.slice(i, core.indexOf('\n}', i))), 'the rule has no off switch')
})

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
process.exit(failures ? 1 : 0)
