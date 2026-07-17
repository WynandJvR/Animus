'use strict'
// OFFLINE unit test for the DRY-wedge dig-out geometry (the `drybreach` rung / breachDryPocket,
// DIGOUT_ESCAPE). Like pocketescapetest.js it exercises the PURE planner (bot/pocket-escape.js)
// with read/diggable stubs - no bot, no fs - but through the DRY entry point breachDryPocket
// feeds it: FEET are NOT in water, so waterSurfaceDy(read) === -1 and every candidate dig with
// water directly above is a hazard (the never-pour-water-on-your-own-head rule holds dry). The
// `diggable` stub is the SAME shape as the real escapeDiggable whitelist: natural terrain/ore
// and natural leaves are diggable; PLAYER BUILDS (planks/cobble/fence/door/farmland) are NOT.
// Proves: a dry dirt-wall hole breaches horizontally; a plank wall is REJECTED and the bot
// exits the other way; a box entirely of planks yields NO plan (never digs a build); water
// above a candidate dig is rejected on the dry path; an already-open neighbour is a zero-dig
// plan; and the vertical ceiling-breach fallback stays <=2 digs with air above the top dig.
// Run:  cd bot && node digouttest.js

const assert = require('assert')
const pe = require('./pocket-escape.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}

function grid (cells, def) {
  const map = new Map()
  for (const k in cells) map.set(k, cells[k])
  return (dx, dy, dz) => {
    const k = dx + ',' + dy + ',' + dz
    if (map.has(k)) return map.get(k)
    return typeof def === 'function' ? def(dx, dy, dz) : def
  }
}

// The DRY escape whitelist stub - the exact permission shape of escapeDiggable: natural
// terrain/ore + natural leaves diggable; player builds (planks/cobble/fence/door/farmland)
// NEVER diggable. (Coords ignored here - the pure planner only needs the name verdict.)
const WL = /^(dirt|grass_block|stone|cobbled_deepslate|deepslate|gravel|sand|coal_ore|iron_ore|.*_log|.*_leaves)$/
const escapeStub = (name) => WL.test(name)

// Sanity: dry feet -> surfaceDy is -1 (drives the whole dry path).
t('dry: waterSurfaceDy(air feet) === -1', () => {
  const read = grid({ '0,0,0': 'air', '0,1,0': 'air' }, null)
  assert.strictEqual(pe.waterSurfaceDy(read), -1)
})

// 1) DRY 1x1 dirt-wall hole: feet+head air, dirt walls, dirt floor beyond the east wall ->
//    a horizontal plan that digs the two east dirt cells and steps out at dx1 (<=8 digs).
t('dry hole: dirt wall breaches horizontally (2 digs) to the standable ground', () => {
  const read = grid({
    '0,0,0': 'air', '0,1,0': 'air',                      // dry feet + head (NOT water)
    '1,0,0': 'dirt', '1,1,0': 'dirt', '1,-1,0': 'dirt'   // east: 2-high dirt wall, solid floor beyond -> exit at r=1
  }, null)                                                // all other dirs unknown -> only east can exit
  const plan = pe.planPocketBreach(read, escapeStub, { march: 4, maxDigs: 8 })
  assert(plan, 'a plan exists')
  assert.strictEqual(plan.kind, 'horizontal')
  assert.strictEqual(plan.digs.length, 2, 'exactly the two east dirt cells')
  assert(plan.digs.length <= 8, 'within the dry maxDigs bound')
  assert.deepStrictEqual(plan.exit, { dx: 1, dy: 0, dz: 0 })
})

// 2) MANDATORY: a PLAYER PLANK wall on the short (east) side is REJECTED; the bot exits the
//    other (west) way through natural dirt. No dig cell may be on the plank side (dx>0).
t('anti-grief: plank wall on the short side is rejected -> exits the other way', () => {
  const read = grid({
    '0,0,0': 'air', '0,1,0': 'air',
    '1,0,0': 'oak_planks', '1,1,0': 'oak_planks', '1,-1,0': 'dirt',   // EAST: player wall (would-be exit) - must be refused
    '-1,0,0': 'dirt', '-1,1,0': 'dirt', '-1,-1,0': 'dirt'             // WEST: natural dirt wall + floor -> the real exit
  }, null)
  const plan = pe.planPocketBreach(read, escapeStub, { march: 4, maxDigs: 8 })
  assert(plan, 'a plan exists (west)')
  assert.strictEqual(plan.kind, 'horizontal')
  assert.strictEqual(plan.exit.dx, -1, 'exits WEST, away from the plank wall')
  for (const d of plan.digs) assert(d.dx <= 0, 'never digs a cell on the plank (east) side')
})

// 3) MANDATORY: boxed ENTIRELY by player planks (4 walls) with open sky above -> NO plan at
//    all (the executor then digs NOTHING - a player build is never breached).
t('anti-grief: a full plank box (open top) yields NO plan - never digs a build', () => {
  const read = grid({
    '0,0,0': 'air', '0,1,0': 'air', '0,2,0': 'air',      // open sky -> vertical fallback also declines
    '1,0,0': 'oak_planks', '1,1,0': 'oak_planks', '1,-1,0': 'dirt',
    '-1,0,0': 'oak_planks', '-1,1,0': 'oak_planks', '-1,-1,0': 'dirt',
    '0,0,1': 'oak_planks', '0,1,1': 'oak_planks', '0,-1,1': 'dirt',
    '0,0,-1': 'oak_planks', '0,1,-1': 'oak_planks', '0,-1,-1': 'dirt'
  }, null)
  const plan = pe.planPocketBreach(read, escapeStub, { march: 4, maxDigs: 8 })
  assert.strictEqual(plan, null, 'a player-plank box is never breached')
})

// 4) DRY water-hazard rule: the only horizontal candidate has WATER directly above a dig cell.
//    On the dry path surfaceDy=-1, so dig.dy(>=0) > -1 -> hazard -> the direction is rejected.
//    No other exit -> null (never dig a block that would drop water on the head).
t('dry: water directly above a candidate dig is rejected (surfaceDy=-1) -> null', () => {
  const read = grid({
    '0,0,0': 'air', '0,1,0': 'air',
    '1,0,0': 'dirt', '1,1,0': 'dirt', '1,-1,0': 'dirt', // east would be a 2-dig exit...
    '1,2,0': 'water'                                     // ...but water sits above the head-dig cell -> hazard
  }, null)
  const plan = pe.planPocketBreach(read, escapeStub, { march: 4, maxDigs: 8 })
  assert.strictEqual(plan, null, 'never opens a block with water directly above it')
})

// 5) OPEN NEIGHBOUR with a floor -> a zero-dig plan (the rung then just hops out).
t('dry: an already-open neighbour with a floor -> zero-dig plan', () => {
  const read = grid({
    '0,0,0': 'air', '0,1,0': 'air',
    '1,0,0': 'air', '1,1,0': 'air', '1,-1,0': 'dirt'   // east open, standable -> exit, nothing to dig
  }, null)
  const plan = pe.planPocketBreach(read, escapeStub, { march: 4, maxDigs: 8 })
  assert(plan, 'a plan exists')
  assert.strictEqual(plan.kind, 'horizontal')
  assert.strictEqual(plan.digs.length, 0, 'nothing to dig')
  assert.deepStrictEqual(plan.exit, { dx: 1, dy: 0, dz: 0 })
})

// 6) VERTICAL fallback under a dirt ceiling (no horizontal exit): 1-block ceiling -> 1 dig;
//    2-block ceiling -> 2 digs; in both the cell above the topmost dug block is KNOWN air.
t('dry: 1-block dirt ceiling -> vertical 1-dig plan, air above the top dig', () => {
  const read = grid({ '0,0,0': 'air', '0,1,0': 'air', '0,2,0': 'dirt', '0,3,0': 'air' }, null)
  const plan = pe.planPocketBreach(read, escapeStub, { march: 4, maxDigs: 8 })
  assert(plan, 'a vertical plan exists')
  assert.strictEqual(plan.kind, 'vertical')
  assert.strictEqual(plan.digs.length, 1)
  assert(plan.digs.length <= 2, 'vertical is capped at 2 digs')
  assert.strictEqual(read(plan.exit.dx, plan.exit.dy, plan.exit.dz), 'air', 'air above the top dig')
})
t('dry: 2-block dirt ceiling -> vertical 2-dig plan (<=2), air above the top dig', () => {
  const read = grid({ '0,0,0': 'air', '0,1,0': 'air', '0,2,0': 'dirt', '0,3,0': 'dirt', '0,4,0': 'air' }, null)
  const plan = pe.planPocketBreach(read, escapeStub, { march: 4, maxDigs: 8 })
  assert(plan, 'a vertical plan exists')
  assert.strictEqual(plan.kind, 'vertical')
  assert.strictEqual(plan.digs.length, 2)
  assert.strictEqual(read(plan.exit.dx, plan.exit.dy, plan.exit.dz), 'air', 'air above the top dig')
})

// 7) VERTICAL fallback refuses a PLANK ceiling (player floor above) -> null.
t('anti-grief: a plank ceiling is not breached vertically -> null', () => {
  const read = grid({ '0,0,0': 'air', '0,1,0': 'air', '0,2,0': 'oak_planks', '0,3,0': 'air' }, null)
  const plan = pe.planPocketBreach(read, escapeStub, { march: 4, maxDigs: 8 })
  assert.strictEqual(plan, null, 'never digs up through a player floor')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall dig-out (dry-wedge) tests passed')
process.exit(failures ? 1 : 0)
