'use strict'
// OFFLINE unit test for #112 HAZARD_NOT_LURE (DESIGN §3.5, Root E): the grave ledger used to be
// the bot's DANGER memory and its LOOT LURE at the same time, and the lure won.
//
// The tape this file locks down (live, 2026-07-19):
//   15:51:17 (death) at 429,52,-49            <- drowned in an enclosed flooded pocket
//   15:58:31 (core) chose graveSweep: near grave 10b - free gear | graves=1(near 10b)
//   15:59:15 (death) at 427,51,-48            <- DROWNED AGAIN, same pocket, four minutes later
// The death-spot routing cost (40) was ARMED at 15:58:31 and lost to job selection anyway. The
// fix is NOT a bigger number - it is that hazard memory has its own lifetime, that salvage
// requires surviving the medium, that desire is scored net of risk, and that a cell which has
// killed the bot twice without a survived traversal since is FORBIDDEN to the planner.
//
// Run: cd bot && node hazardluretest.js

const fs = require('fs')
const os = require('os')
const path = require('path')

// AMBIENT-PROOFING (mandatory): this test inherits NOTHING from the shell. Every env var that
// touches a decision here is set explicitly, and both files are redirected into a fresh tmp dir
// so a test run can never read or stomp live world-memory / last-death state.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hazardlure-'))
process.env.WORLD_MEM_FILE = path.join(TMP, 'world-memory.json')
process.env.DEATH_FILE = path.join(TMP, 'last-death.json')
delete process.env.DEATH_SPOT_COST
delete process.env.DEATH_SPOT_R
delete process.env.DEATH_SPOT_UP
delete process.env.DEATH_SPOT_DOWN
delete process.env.DEATH_SPOT_COST_VAL
delete process.env.GRAVE_URGENT
delete process.env.GRAVE_DESPAWN_S
delete process.env.GRAVE_TOOL_WORTH
delete process.env.GRAVE_BUILD_WORTH
process.env.GRAVE_NEAR = '16'
process.env.GRAVE_URGENT_DIST = '96'

const GP = require('./grave-policy.js')
const worldMemory = require('./world-memory.js')
const grave = require('./grave.js')
const provision = require('./provision.js')
const scheduler = require('./scheduler.js')
const schedCore = require('./scheduler-core.js')

let failures = 0
function eq (got, want, label) {
  const ok = got === want
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`))
}
function ok (cond, label) { eq(!!cond, true, label) }

// The pocket from the tape, and the two deaths in it.
const D1 = { x: 429, y: 52, z: -49 }
const D2 = { x: 427, y: 51, z: -48 }
const NOTABLE = ['iron_chestplate', 'iron_pickaxe'] // a genuinely worthwhile grave
// recordDeath stamps the grave's contents from the rolling inventory snapshot, which an offline
// test never takes - so the carried gear is written onto the fresh ledger row directly. `die` is
// therefore exactly what the live death handler does, minus the body.
function die (g, pos, cause) {
  g.recordDeath({ x: pos.x, y: pos.y, z: pos.z, cause, at: Date.now(), retrieved: false })
  const row = g.ledger()[g.ledger().length - 1]
  row.items = { count: 2, notable: NOTABLE.slice(), build: 0 }
  return row
}

// ---- 1. CAUSE TAXONOMY: a drowning trap is now representable at all ------------------------
eq(GP.classifyDeathCause({ y: 52, headWater: true }), 'drowning', 'cause: head in water -> drowning')
eq(GP.classifyDeathCause({ y: 52, hazardNear: true, headWater: true }), 'lava', 'cause: lava beats a wet head (it is what burned the gear)')
eq(GP.classifyDeathCause({ y: -70 }), 'void', 'cause: below -60 -> void')
eq(GP.classifyDeathCause({ y: 64, fallDistance: 9 }), 'fall', 'cause: a long fall -> fall')
eq(GP.classifyDeathCause({ y: 64 }), 'unknown', 'cause: nothing readable -> unknown (never a guess)')
// `dangerous` is DERIVED, and derives to exactly what it always meant.
eq(GP.causeWritesOff('lava'), true, 'dangerous derives true for lava (the old hand-set branch)')
eq(GP.causeWritesOff('void'), true, 'dangerous derives true for void')
eq(GP.causeWritesOff('drowning'), false, 'dangerous stays FALSE for drowning - the gear is guarded, not gone (deferred, never written off)')

// ---- 2. HAZARD MEMORY HAS ITS OWN LIFETIME -------------------------------------------------
// The first death: recorded through the SAME call the ledger uses, but landing in world-memory.
die(grave, D1, 'drowning')
ok(worldMemory.hazardAt(D1), 'hazard: the drowning is remembered at the death cell')
eq(worldMemory.hazardAt(D1).cause, 'drowning', 'hazard: with the cause that produced it')
// The second death 2 blocks away is the SAME pocket - one record, two deaths, not two records.
die(grave, D2, 'drowning')
eq(worldMemory.listHazards().length, 1, 'hazard: two deaths 2b apart merge into ONE pocket record')
eq(worldMemory.hazardAt(D1).deaths.length, 2, 'hazard: and the record counts BOTH deaths')

// (a) RETRIEVING THE GRAVES MUST NOT ERASE THE DANGER.
for (const g of grave.ledger()) g.retrieved = true
grave.persistDeath()
ok(worldMemory.hazardAt(D1), 'lifetime: the hazard SURVIVES every grave at the cell being retrieved')
// (b) WIPING last-death.json MUST NOT ERASE THE DANGER. (The coordinator wiped this file twice on
//     2026-07-19 at the operator's request and unknowingly destroyed the bot's only memory of
//     where it drowns. That coupling is what this assertion makes impossible.)
try { fs.unlinkSync(process.env.DEATH_FILE) } catch {}
delete require.cache[require.resolve('./grave.js')]
const graveReloaded = require('./grave.js')
eq(graveReloaded.ledger().length, 0, 'lifetime: the ledger really is gone after the wipe (the test is testing something)')
ok(worldMemory.hazardAt(D1), 'lifetime: the hazard SURVIVES the last-death.json wipe')
eq(worldMemory.hazardAt(D1).deaths.length, 2, 'lifetime: with both deaths intact')

// ---- 3. SALVAGE REQUIRES SURVIVING THE MEDIUM ----------------------------------------------
const pocket = worldMemory.hazardAt(D1)
const graveRow = { x: D1.x, y: D1.y, z: D1.z, value: 40 }
const onePocket = { x: D1.x, y: D1.y, z: D1.z, cause: 'drowning', deaths: [1], traversedSinceDeath: false }
// 2026-08-27: the DARK is a medium too - an underground grave is deferred while the bot is naked
{
  const cave = { x: 284, y: 57, z: -291, value: 40, underground: true }
  eq(GP.salvageVerdict(cave, null, { armored: false }).go, false, 'salvage: underground + no armour -> deferred')
  ok(/underground/.test(GP.salvageVerdict(cave, null, { armored: false }).why), 'salvage: and it says why')
  eq(GP.salvageVerdict(cave, null, { armored: true }).go, true, 'salvage: armoured -> the cave grave is back on the books')
  eq(GP.salvageVerdict(cave, null, {}).go, true, 'salvage: armour unknown -> no veto (absence of a reading is not a verdict)')
  eq(GP.salvageVerdict({ x: 1, y: 64, z: 1, value: 40, underground: false }, null, { armored: false }).go, true, 'salvage: a surface grave is untouched by the clause')
}
let v = GP.salvageVerdict(graveRow, onePocket)
eq(v.go, false, 'salvage: ONE drowning death already rules the grave out - the MEDIUM is the gate, not a body count')
ok(/drowning/.test(v.why), 'salvage: and it says so in the bot\'s own words')
eq(GP.salvageVerdict(graveRow, pocket).go, false, 'salvage: two drowning deaths, still no (now on the escalation clause)')
eq(GP.salvageVerdict(graveRow, null).go, true, 'salvage: no hazard recorded -> nothing to object to')
eq(GP.salvageVerdict(graveRow, null).discount, 1, 'salvage: and the value is undiscounted')
// The discount is the netting term: 1/(1+deaths).
eq(GP.salvageVerdict(graveRow, { x: D1.x, y: D1.y, z: D1.z, cause: 'mob', deaths: [1] }).discount, 1 / 2, 'salvage: one death -> half value')
eq(GP.salvageVerdict(graveRow, { x: D1.x, y: D1.y, z: D1.z, cause: 'mob', deaths: [1, 2, 3] }).discount, 1 / 4, 'salvage: three deaths -> quarter value')
// lava/fire keep the existing burned-grave write-off.
eq(GP.salvageVerdict(graveRow, { x: D1.x, y: D1.y, z: D1.z, cause: 'lava', deaths: [1] }).go, false, 'salvage: lava keeps the burned-grave write-off')
// A cause with no medium and one death is still worth going for - netted, not vetoed.
eq(GP.salvageVerdict(graveRow, { x: D1.x, y: D1.y, z: D1.z, cause: 'mob', deaths: [1] }).go, true, 'salvage: one mob death does not veto - it discounts')
// The condition that releases it: the bot got through there alive, out of the medium.
eq(GP.salvageVerdict(graveRow, { ...pocket, traversedSinceDeath: true }).go, true, 'salvage: RELEASED once the bot has walked the pocket alive and dry')
// ...and the forward seam for the (later) vertical-escape rung, without which nothing sets it.
eq(GP.salvageVerdict(graveRow, onePocket, { dryStandpoint: true }).go, true, 'salvage: or when the approach proves a dry standpoint (capability seam)')

// And it reaches the grave layer: a deferred grave is not "the best grave", but it is NOT junk
// and is NOT written off - it stays on the books, still owned, behind a condition.
die(graveReloaded, D1, 'drowning')
eq(graveReloaded.bestGrave(), null, 'grave: a drowning-pocket grave is not a recovery candidate')
eq(graveReloaded.deferredGraves().length, 1, 'grave: it is DEFERRED - still on the books, still ours')
eq(graveReloaded.deferredGraves()[0].retrieved, false, 'grave: and never marked retrieved (that would throw the gear away)')

// ---- 4. ESCALATION IS CONDITION-GATED, AND RELEASES ON A CONDITION -------------------------
const armed = { x: D1.x, y: D1.y, z: D1.z, cause: 'drowning', deaths: [1, 2], traversedSinceDeath: false }
const oneDeath = { x: D1.x, y: D1.y, z: D1.z, cause: 'drowning', deaths: [1], traversedSinceDeath: false }
eq(GP.hazardHardArmed(oneDeath), false, 'escalation: ONE death is a cost, not a wall (#85 semantics unchanged)')
eq(GP.hazardHardArmed(armed), true, 'escalation: TWO deaths with no survived traversal since -> armed')
eq(GP.hazardHardArmed({ ...armed, traversedSinceDeath: true }), false, 'escalation: a survived traversal RELEASES it')
// The step verdict. The hard rung fires ONLY on cells that still read as the killing medium, so
// it can never become a wall nothing is able to walk through and prove safe again.
const at = (x, y, z) => ({ x, y, z })
const spotsArmed = [{ x: D1.x, y: D1.y, z: D1.z, cause: 'drowning', hard: true }]
const spotsSoft = [{ x: D1.x, y: D1.y, z: D1.z, cause: 'drowning', hard: false }]
eq(GP.hazardStepCost(at(D1.x, D1.y, D1.z), 'water', spotsArmed, {}), GP.HAZARD_FORBID, 'step: armed hazard + the cell is still water -> FORBID (pathfinder drops any neighbour over 100)')
ok(GP.HAZARD_FORBID > 100, 'step: the forbid really is above pathfinder\'s drop threshold')
eq(GP.hazardStepCost(at(D1.x, D1.y, D1.z), 'stone', spotsArmed, {}), 0, 'step: armed hazard but the pocket has DRAINED -> the cell is not the killer any more: FREE (the ground is not priced for what the water did)')
eq(GP.hazardStepCost(at(D1.x, D1.y, D1.z), 'water', spotsSoft, {}), 40, 'step: one death -> soft cost even in the water')
eq(GP.hazardStepCost(at(D1.x + 9, D1.y, D1.z), 'water', spotsArmed, {}), 0, 'step: outside the box -> free')
eq(GP.hazardStepCost(at(D1.x, D1.y, D1.z), 'water', [{ x: D1.x, y: D1.y, z: D1.z, cause: 'fall', hard: true }], {}), 0,
  'step: a cause with NO readable medium prices nothing and never forbids - an unreleasable wall is forbidden by §5, and a mob/fall death at spawn must not make spawn dearer to walk than to tunnel')
eq(GP.hazardStepCost(at(D1.x, D1.y, D1.z), 'water', [], {}), 0, 'step: no hazards -> free')

// markTraversed is the wired release, and it is evidence-shaped: it only ever sets a flag.
worldMemory.markTraversed(D1)
eq(worldMemory.hazardAt(D1).traversedSinceDeath, true, 'release: markTraversed records the survived pass-through')
eq(GP.hazardHardArmed(worldMemory.hazardAt(D1)), false, 'release: and the escalation is gone')
eq(graveReloaded.bestGrave() != null, true, 'release: the deferred grave becomes a candidate again - the value was never lost')
// A fresh death RE-ARMS it: the last "i got through fine" proves nothing about the new trap.
die(graveReloaded, D2, 'drowning')
eq(worldMemory.hazardAt(D1).traversedSinceDeath, false, 're-arm: a new death here clears the survived-traversal proof')

// ---- 5. THE ROUTING CLOSURE READS HAZARDS, NOT THE LOOT LEDGER -----------------------------
const blk = (x, y, z, name) => ({ position: at(x, y, z), name })
let ex = provision.deathSpotExclusion({})
ok(ex, 'routing: an exclusion closure is built from hazard memory (the ledger is not consulted)')
eq(ex(blk(D1.x, D1.y, D1.z, 'water')), GP.HAZARD_FORBID, 'routing: the twice-drowned pocket is FORBIDDEN to autonomous planning')
eq(ex(blk(D1.x + 20, D1.y, D1.z, 'grass_block')), 0, 'routing: ordinary ground is untouched')
// ANTI-GRIEF (§5): the hard rung is for autonomous planning only. An operator command may always
// send the bot anywhere; the closure degrades to the cost-only rung while one is in flight.
worldMemory.setOperatorRouting(true)
ex = provision.deathSpotExclusion({})
eq(ex(blk(D1.x, D1.y, D1.z, 'water')), 40, 'anti-grief: under an operator command the forbid degrades to cost-only')
worldMemory.setOperatorRouting(true)
worldMemory.setOperatorRouting(false)
ex = provision.deathSpotExclusion({})
eq(ex(blk(D1.x, D1.y, D1.z, 'water')), 40, 'anti-grief: the latch is COUNTED - a nested command does not release it early')
worldMemory.setOperatorRouting(false)
ex = provision.deathSpotExclusion({})
eq(ex(blk(D1.x, D1.y, D1.z, 'water')), GP.HAZARD_FORBID, 'anti-grief: and it is fully released when the operator command unwinds')
// The one existing flag still turns the whole thing off, byte-for-byte. No new flags were added.
process.env.DEATH_SPOT_COST = '0'
eq(provision.deathSpotExclusion({}), null, 'flag: DEATH_SPOT_COST=0 -> no exclusion at all (unchanged)')
delete process.env.DEATH_SPOT_COST

// ---- 6. DESIRE IS SCORED NET OF RISK -------------------------------------------------------
// A rich grave in a cell that keeps killing the bot must LOSE to a modest one in a safe cell.
const lethal = { x: 100, y: 60, z: 0, dist: 10, value: 60, hasGear: true, salvage: GP.salvageVerdict(null, { cause: 'mob', deaths: [1, 2, 3] }) }
const safe = { x: 0, y: 60, z: 0, dist: 10, value: 20, hasGear: true, salvage: { go: true, discount: 1 } }
ok(GP.graveNetValue(lethal) < GP.graveNetValue(safe), 'net: 60 gross in a 3-death cell nets less than 20 gross in a safe one')
const snapBoth = { hp: 20, food: 19, armorPieces: 2, graves: [lethal, safe], deathsRecent: 0, isNight: false }
eq(schedCore.nearestReachGrave(snapBoth, 16, 96).x, safe.x, 'net: the core picks the SAFE grave over the richer lethal one')
// ...and with no hazards at all, equal-value graves still pick the nearest (old behaviour intact).
const nearG = { x: 1, y: 60, z: 0, dist: 4, value: 30, hasGear: true }
const farG = { x: 2, y: 60, z: 0, dist: 14, value: 30, hasGear: true }
eq(schedCore.nearestReachGrave({ graves: [farG, nearG] }, 16, 96).dist, 4, 'net: with no hazard and equal value the nearest still wins (no behaviour churn)')

// ---- 7. THE 15:58:31 FIXTURE: the lure must not be chosen ----------------------------------
// hp20 food19 armor2, one worthwhile grave 10b away in the pocket that drowned the bot.
const lureGrave = { x: D1.x, y: D1.y, z: D1.z, dist: 10, value: 40, hasGear: true, dangerous: false, salvage: GP.salvageVerdict(null, worldMemory.hazardAt(D1)) }
const snap1558 = { hp: 20, food: 19, armorPieces: 2, graves: [lureGrave], deathsRecent: 1, isNight: false, homeReachable: true }
eq(lureGrave.salvage.go, false, 'fixture: the grave in the pocket is ruled out by salvageVerdict')
const picked = scheduler.pickJob(snap1558)
ok(picked.job !== 'graveSweep', 'fixture: pickJob does NOT choose graveSweep for it ("free gear" over a drowning pocket)')
const pickedCore = schedCore.chooseActivity(snap1558)
ok(pickedCore.job !== 'graveSweep', 'fixture: the DYNAMIC CORE does not either - this is the exact line that killed the bot')
eq(schedCore.nearestReachGrave(snap1558, 16, 96), null, 'fixture: it is not a reachable candidate in the core at all')

// ---- 8. NO TIMERS. ANYWHERE. ---------------------------------------------------------------
// The absolute project rule (no-blanket-time-holds): every gate here is a CONDITION. This asserts
// it against the source of the DECISION functions - a future edit that reaches for a cooldown,
// an expiry, or a wall clock fails this test rather than the operator's patience.
const TIMEY = /Date\.now|setTimeout|setInterval|cooldown|expire|elapsed|\buntil\b|\bage(Ms)?\b/i
for (const [name, fn] of [
  ['gravePolicy.hazardHardArmed', GP.hazardHardArmed],
  ['gravePolicy.salvageVerdict', GP.salvageVerdict],
  ['gravePolicy.hazardStepCost', GP.hazardStepCost],
  ['gravePolicy.hazardBoxHas', GP.hazardBoxHas],
  ['gravePolicy.graveNetValue', GP.graveNetValue],
  ['gravePolicy.graveScore', GP.graveScore],
  ['gravePolicy.graveSalvageBlocked', GP.graveSalvageBlocked],
  ['gravePolicy.classifyDeathCause', GP.classifyDeathCause],
  ['worldMemory.markTraversed', worldMemory.markTraversed],
  ['worldMemory.hazardAt', worldMemory.hazardAt]
]) ok(!TIMEY.test(String(fn)), 'no-timers: ' + name + ' gates on conditions only')

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall hazard/lure assertions passed')
process.exit(failures ? 1 : 0)
