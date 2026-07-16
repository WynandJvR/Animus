'use strict'
// OFFLINE unit test for the pure respawn grave-chase survival gate
// (commands.shouldChaseGrave) - no bot, no world. Run: cd bot && node gravegatetest.js
//
// The live death-spiral it guards: on a far respawn (bed creeper-destroyed -> WORLD SPAWN
// ~380b from home) the handler sent a NAKED, empty-pack, food-draining bot on a long trek to
// chase dropped gear - it starved (food 20->0) + got beaten to death en route, respawned, and
// repeated, bleeding gear each loop. A FAR grave must DEFER when the bot is hungry, when a
// hostile is on it, when it's fleeing, or when the grave is far from BOTH the bot and home.
//
// S1 HOTFIX (the ratchet fix): the food gate used to run BEFORE distance, so a grave 3b away was
// deferred *because* the corpse-run had made the bot hungry - each death respawned strictly
// weaker. Now a non-dangerous, no-threat grave within GRAVE_NEAR (16b) is chased REGARDLESS of
// food/hp (at arm's reach the grave IS the survival move); the food gate only guards FAR treks.
const C = require('./commands.js')

let failures = 0
function eq (got, want, label) {
  const ok = got === want
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`))
}

const home = { x: 416, y: 65, z: 87 }
const adjGrave = { x: 418, y: 65, z: 88 }   // ~2b from home (within GRAVE_NEAR)
const midGrave = { x: 456, y: 65, z: 87 }   // ~40b from home (beyond GRAVE_NEAR, within GRAVE_MAX_DIST)
const grave90 = { x: 506, y: 65, z: 87 }    // ~90b from home (within default GRAVE_MAX_DIST 96)
const farGrave = { x: 900, y: 71, z: 900 }  // far from BOTH world spawn and home

// ---- THE S1 RATCHET FIX: a NEAR grave is chased regardless of food/hp -----------------------
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 0, threat: null, home }).chase, true,
  'food 0 + grave 3b + no threat -> CHASE (arm-reach grave IS the survival move; the ratchet fix)')
eq(C.shouldChaseGrave({ grave: adjGrave, pos: { x: 700, y: 65, z: 700 }, food: 0, threat: null, home }).chase, true,
  'food 0 + grave near HOME though far from the bot -> CHASE (min(bot,home) within GRAVE_NEAR)')
// ...but the near override must still respect ACTIVE hazards.
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 0, threat: null, dangerous: true, home }).chase, false,
  'near grave in/over a hazard (dangerous) -> DEFER even at 3b')
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 0, threat: { type: 'zombie', dist: 4 }, home }).chase, false,
  'near grave with a hostile on the bot (threat) -> DEFER even at 3b')

// ---- FAR grave keeps the fed+safe trek gate -------------------------------------------------
eq(C.shouldChaseGrave({ grave: grave90, pos: home, food: 0, threat: null, home }).chase, false,
  'food 0 + grave 90b -> DEFER (do not starve trekking for a far grave)')
eq(C.shouldChaseGrave({ grave: grave90, pos: home, food: 18, threat: null, home }).chase, true,
  'food 18 + grave 90b within GRAVE_MAX_DIST -> CHASE (fed bot fetches a reachable grave)')
eq(C.shouldChaseGrave({ grave: farGrave, pos: { x: 0, y: 65, z: 1 }, food: 20, threat: null, home }).chase, false,
  'grave far from BOTH bot and home -> DEFER (do not starve trekking for it)')
eq(C.shouldChaseGrave({ grave: midGrave, pos: home, food: 8, threat: null, home }).chase, false,
  'hungry (food 8 < 12) + FAR grave (~40b) -> DEFER until fed')
eq(C.shouldChaseGrave({ grave: midGrave, pos: home, food: null, threat: null, home }).chase, false,
  'food unknown (not spawned yet) + FAR grave -> DEFER')
eq(C.shouldChaseGrave({ grave: midGrave, pos: home, food: 12, threat: null, home }).chase, true,
  'food exactly at the 12 floor + FAR grave in reach -> CHASE')
// A grave far from the bot but NEAR home is still fine to fetch (min(dBot,dHome) <= max).
eq(C.shouldChaseGrave({ grave: midGrave, pos: { x: 300, y: 65, z: 300 }, food: 20, threat: null, home }).chase, true,
  'FAR grave far from bot but near HOME -> CHASE (min of bot/home distance)')

// ---- hostiles / fleeing -> DEFER regardless of hunger/distance ----------------------------
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 20, threat: { type: 'zombie', dist: 6 }, home }).chase, false,
  'hostile on the bot -> DEFER even fed + close')
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 20, threat: null, escaping: true, home }).chase, false,
  'fleeing/escaping a hazard -> DEFER')

// ---- SAFE + FED -> CHASE (genuine behaviour must survive) ----------------------------------
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 20, threat: null, home }).chase, true,
  'safe + fed + near grave -> CHASE')

// ---- no grave / no position -> honest no-op ------------------------------------------------
eq(C.shouldChaseGrave({ grave: null, pos: home, food: 20, home }).chase, false, 'no grave -> no chase')
eq(C.shouldChaseGrave({ grave: adjGrave, pos: null, food: 20, home }).chase, false, 'no position -> no chase')

// ---- thresholds come from env when not passed ---------------------------------------------
{
  const savedFood = process.env.GRAVE_MIN_FOOD
  const savedDist = process.env.GRAVE_MAX_DIST
  const savedNear = process.env.GRAVE_NEAR
  process.env.GRAVE_MIN_FOOD = '18'
  eq(C.shouldChaseGrave({ grave: midGrave, pos: home, food: 15, threat: null, home }).chase, false,
    'GRAVE_MIN_FOOD=18 -> food 15 defers a FAR grave')
  delete process.env.GRAVE_MIN_FOOD
  process.env.GRAVE_MAX_DIST = '2000'
  eq(C.shouldChaseGrave({ grave: farGrave, pos: { x: 0, y: 65, z: 1 }, food: 20, threat: null, home }).chase, true,
    'GRAVE_MAX_DIST=2000 -> the far grave becomes reachable')
  delete process.env.GRAVE_MAX_DIST
  // GRAVE_NEAR shrinks the arm's-reach band: a 40b grave is no longer a near-override chase.
  process.env.GRAVE_NEAR = '4'
  eq(C.shouldChaseGrave({ grave: midGrave, pos: home, food: 0, threat: null, home }).chase, false,
    'GRAVE_NEAR=4 -> a 40b grave at food 0 is NOT a near override (falls to the food gate)')
  eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 0, threat: null, home }).chase, true,
    'GRAVE_NEAR=4 -> a 2b grave at food 0 still overrides')
  delete process.env.GRAVE_NEAR
  if (savedFood != null) process.env.GRAVE_MIN_FOOD = savedFood
  if (savedDist != null) process.env.GRAVE_MAX_DIST = savedDist
  if (savedNear != null) process.env.GRAVE_NEAR = savedNear
}

// ---- ROLLBACK: S1_HOTFIX=0 restores the old food-gate-before-distance behavior --------------
{
  process.env.S1_HOTFIX = '0'
  eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 0, threat: null, home }).chase, false,
    'S1_HOTFIX=0 -> old behavior: food 0 defers even a 3b grave (near override disabled)')
  eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 20, threat: null, home }).chase, true,
    'S1_HOTFIX=0 -> fed bot still chases a near grave via the fed path')
  delete process.env.S1_HOTFIX
}

// ============================================================================================
// S4: commands.gravesSnapshot() - the plain-data graves exporter the scheduler consumes.
// Uses the `ledger` seam (inject a fixture array; no fs / recordDeath ceremony). DESIGN §5.
// ============================================================================================
const Sched = require('./scheduler.js')
const NOW = 1_000_000_000_000
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.5 : tol)

// (1) near iron grave (~3b from home) -> listed, hasGear, value>0, dist ~= min(bot,home)
{
  const ironGrave = { x: 418, y: 65, z: 88, at: NOW, dangerous: false, items: { notable: ['iron_pickaxe', 'iron_helmet'], count: 2 } }
  const r = C.gravesSnapshot({ pos: home, home, now: NOW, ledger: [ironGrave] })
  eq(r.graves.length, 1, 'near iron grave -> LISTED')
  eq(r.graves[0].hasGear, true, 'iron gear -> hasGear:true')
  eq(r.graves[0].value > 0, true, 'iron grave has value>0')
  eq(near(r.graves[0].dist, Math.hypot(418 - 416, 88 - 87)), true, 'dist ~= min(bot,home) XZ')
  eq(r.graves[0].dangerous, false, 'not dangerous')
}

// (2) far grave 200b from BOTH -> still LISTED (distance never filters, only sequences)
{
  const farGrave = { x: 616, y: 65, z: 87, at: NOW, items: { notable: ['iron_sword'], count: 1 } } // 200b east of home
  const r = C.gravesSnapshot({ pos: home, home, now: NOW, ledger: [farGrave] })
  eq(r.graves.length, 1, 'far grave still LISTED (distance is not a filter)')
  eq(near(r.graves[0].dist, 200, 1), true, 'far grave dist ~200')
}

// (3) dangerous grave -> LISTED with the flag (the scheduler filters on dangerous, not the exporter)
{
  const dngr = { x: 418, y: 65, z: 88, at: NOW, dangerous: true, items: { notable: ['diamond_chestplate'], count: 1 } }
  const r = C.gravesSnapshot({ pos: home, home, now: NOW, ledger: [dngr] })
  eq(r.graves.length, 1, 'dangerous grave still LISTED')
  eq(r.graves[0].dangerous, true, 'dangerous flag carried through')
  eq(r.graves[0].hasGear, true, 'diamond gear -> hasGear:true')
}

// (4) worthless grave (1 dirt, graveWorthIt false) -> NOT listed
{
  const junk = { x: 418, y: 65, z: 88, at: NOW, items: { notable: [], count: 1 } }
  const r = C.gravesSnapshot({ pos: home, home, now: NOW, ledger: [junk] })
  eq(r.graves.length, 0, 'worthless grave (1 dirt) NOT listed')
}

// (5) retrieved:true -> not in graves, but counted in deathsRecent when fresh (< 20min)
{
  const reclaimed = { x: 418, y: 65, z: 88, at: NOW - 60000, retrieved: true, items: { notable: ['iron_pickaxe'], count: 1 } }
  const r = C.gravesSnapshot({ pos: home, home, now: NOW, ledger: [reclaimed] })
  eq(r.graves.length, 0, 'retrieved grave excluded from graves[]')
  eq(r.deathsRecent, 1, 'a reclaimed grave 1min ago still counts as a recent death (ratchet signal)')
}

// (5b) an OLD retrieved death (> 20min) is not counted in deathsRecent
{
  const oldReclaimed = { x: 418, y: 65, z: 88, at: NOW - 30 * 60000, retrieved: true, items: { notable: ['iron_pickaxe'], count: 1 } }
  const r = C.gravesSnapshot({ pos: home, home, now: NOW, ledger: [oldReclaimed] })
  eq(r.deathsRecent, 0, 'a 30-min-old death is not "recent"')
}

// (6) empty ledger -> {graves:[], deathsRecent:0}
{
  const r = C.gravesSnapshot({ pos: home, home, now: NOW, ledger: [] })
  eq(r.graves.length, 0, 'empty ledger -> no graves')
  eq(r.deathsRecent, 0, 'empty ledger -> deathsRecent 0')
}

// (7) pos FAR, home NEAR -> dist uses home (the min)
{
  const g = { x: 418, y: 65, z: 88, at: NOW, items: { notable: ['iron_helmet'], count: 1 } }
  const r = C.gravesSnapshot({ pos: { x: 900, y: 65, z: 900 }, home, now: NOW, ledger: [g] })
  eq(near(r.graves[0].dist, Math.hypot(418 - 416, 88 - 87)), true, 'dist uses the nearer of bot/home (home)')
}

// (7b) neither pos nor home -> dist null (the scheduler skips null-dist graves)
{
  const g = { x: 418, y: 65, z: 88, at: NOW, items: { notable: ['iron_helmet'], count: 1 } }
  const r = C.gravesSnapshot({ now: NOW, ledger: [g] })
  eq(r.graves[0].dist, null, 'no pos AND no home -> dist null')
}

// ---- COMPOSITION: the REAL exporter shape feeds the pure scheduler (proves gravesSnapshot ->
// pickJob matches what schedulertest built by hand for the headline livelock, §5 case 7+).
{
  const grave3b = { x: 418, y: 65, z: 88, at: NOW, items: { notable: ['iron_pickaxe', 'iron_helmet'], count: 2 } }
  const gs = C.gravesSnapshot({ pos: home, home, now: NOW, ledger: [grave3b] })
  const snap = {
    hp: 1, food: 0, packFoodPts: 0, armorPieces: 0,
    threatDist: null, creeperDist: null, isNight: false, nightStuck: false,
    drowning: false, onFire: false, inLava: false,
    graves: gs.graves, deathsRecent: gs.deathsRecent,
    homeDist: 3, bankFoodPts: 0, farm: { exists: false }, orchard: {},
    activeJob: { name: 'secureFood', cls: 'survival' }, persistedBuild: false, maintainNeeded: false
  }
  const pj = Sched.pickJob(snap)
  eq(!!pj && pj.cls === 'survival', true, 'livelock fixture (hp1/food0/naked/grave3b) via the REAL exporter -> survival job')
  eq(Sched.admissible('survival', snap).allow, true, 'a recover command is admitted for the livelock snapshot (the muzzle is gone)')
}

// ============================================================================================
// fix #12: commands.graveLootVerdict() - the PURE emptiness-verified grave-loot verdict that
// replaced the recorded*0.5 heuristic (212 looted, 2 stragglers left, grave marked done forever).
// DESIGN-fix12-grave-stragglers.md §4.1 decision table. Plain data in, {mark,kind} out.
// ============================================================================================
const V = C.graveLootVerdict
// (a) window emptied + notable back + FRESH scan empty -> full, MARK (the genuinely-clean case)
{
  const r = V({ sawWindow: true, emptied: true, remaining: [], exhausted: false, freeSlots: 19, gained: 214, recorded: 214, gotNotable: true, gravePresent: false, looseNearby: false })
  eq(r.kind, 'full', 'emptied + notable + fresh-scan-empty -> full')
  eq(r.mark, true, 'full -> MARK')
}
// (b) THE LIVE INCIDENT: 2 planks left, pack room, loop NOT exhausted -> partial, NO mark
{
  const r = V({ sawWindow: true, emptied: false, remaining: [{ name: 'oak_planks', count: 2 }], exhausted: false, freeSlots: 19, gained: 212, recorded: 214, gotNotable: true, gravePresent: true, looseNearby: false })
  eq(r.kind, 'partial', '2 planks remain, freeSlots 19, not exhausted -> partial (the live incident)')
  eq(r.mark, false, 'partial -> NO mark (grave stays for the 300s re-dispatch)')
}
// (c) same 2 planks but retries EXHAUSTED, pack room -> writeoff-junk, MARK (bounded write-off)
{
  const r = V({ sawWindow: true, emptied: false, remaining: [{ name: 'oak_planks', count: 2 }], exhausted: true, freeSlots: 19, gained: 212, recorded: 214, gotNotable: true, gravePresent: true, looseNearby: false })
  eq(r.kind, 'writeoff-junk', '2 junk planks the server refuses after every retry -> writeoff-junk')
  eq(r.mark, true, 'writeoff-junk -> MARK (not a cooldown-cycle forever)')
}
// (d) remaining contains iron_ingot, EXHAUSTED -> partial, NO mark (gear is NEVER written off)
{
  const r = V({ sawWindow: true, emptied: false, remaining: [{ name: 'iron_ingot', count: 3 }], exhausted: true, freeSlots: 19, gained: 100, recorded: 120, gotNotable: true, gravePresent: true, looseNearby: false })
  eq(r.kind, 'partial', 'iron_ingot left behind, even exhausted -> partial (gear never written off)')
  eq(r.mark, false, 'gear remainder -> NO mark')
}
// (d2) remaining contains a tool (diamond_pickaxe), exhausted -> partial, NO mark
{
  const r = V({ sawWindow: true, emptied: false, remaining: [{ name: 'diamond_pickaxe', count: 1 }], exhausted: true, freeSlots: 19, gained: 50, recorded: 60, gotNotable: true, gravePresent: true, looseNearby: false })
  eq(r.kind, 'partial', 'diamond_pickaxe left behind, exhausted -> partial (tool never written off)')
  eq(r.mark, false, 'tool remainder -> NO mark')
}
// (e) freeSlots 0 with anything remaining -> capacity, NO mark (honest "pack's full")
{
  const r = V({ sawWindow: true, emptied: false, remaining: [{ name: 'cobblestone', count: 40 }], exhausted: false, freeSlots: 0, gained: 100, recorded: 200, gotNotable: true, gravePresent: true, looseNearby: false })
  eq(r.kind, 'capacity', 'freeSlots 0 + items remain -> capacity')
  eq(r.mark, false, 'capacity -> NO mark (come back after off-loading)')
}
// (e2) capacity beats the junk-writeoff: a full pack is never a write-off even if the remainder is junk+small
{
  const r = V({ sawWindow: true, emptied: false, remaining: [{ name: 'dirt', count: 2 }], exhausted: true, freeSlots: 0, gained: 100, recorded: 110, gotNotable: true, gravePresent: true, looseNearby: false })
  eq(r.kind, 'capacity', 'freeSlots 0 outranks the junk write-off -> capacity, NO mark')
  eq(r.mark, false, 'capacity (pack full) -> NO mark')
}
// (f) !gotNotable -> never mark from here (case site keeps its own tails)
{
  const r = V({ sawWindow: true, emptied: true, remaining: [], exhausted: false, freeSlots: 19, gained: 5, recorded: 100, gotNotable: false, gravePresent: false, looseNearby: false })
  eq(r.mark, false, '!gotNotable -> NEVER mark from the verdict (operator-dropped-food fix intact)')
}
// (g) no-window + gained>0 + grave still present -> loose-only, NO mark
{
  const r = V({ sawWindow: false, emptied: false, remaining: [], exhausted: false, freeSlots: 19, gained: 8, recorded: 30, gotNotable: true, gravePresent: true, looseNearby: false })
  eq(r.kind, 'loose-only', 'no GUI + gained loose items + grave present -> loose-only')
  eq(r.mark, false, 'loose-only -> NO mark')
}
// (h) no-window + nothing present + gained 0 -> gone, MARK
{
  const r = V({ sawWindow: false, emptied: false, remaining: [], exhausted: false, freeSlots: 19, gained: 0, recorded: 30, gotNotable: true, gravePresent: false, looseNearby: false })
  eq(r.kind, 'gone', 'no GUI + gained 0 + nothing present -> gone')
  eq(r.mark, true, 'gone -> MARK (do not chase an empty grave forever)')
}
// (h2) no-window + nothing present + gained>0 -> full, MARK
{
  const r = V({ sawWindow: false, emptied: false, remaining: [], exhausted: false, freeSlots: 19, gained: 12, recorded: 12, gotNotable: true, gravePresent: false, looseNearby: false })
  eq(r.kind, 'full', 'no GUI + gained>0 + nothing present (attack-path pickup) -> full')
  eq(r.mark, true, 'full (no window) -> MARK')
}
// (h3) no-window + gained 0 + grave present -> unopened, NO mark (worth another try)
{
  const r = V({ sawWindow: false, emptied: false, remaining: [], exhausted: false, freeSlots: 19, gained: 0, recorded: 30, gotNotable: true, gravePresent: true, looseNearby: false })
  eq(r.kind, 'unopened', "no GUI + gained 0 + grave present -> unopened (won't open, retry)")
  eq(r.mark, false, 'unopened -> NO mark')
}
// (i) BULK junk (count >= 10) exhausted -> partial, NO mark (a real pile is worth another trip)
{
  const r = V({ sawWindow: true, emptied: false, remaining: [{ name: 'cobblestone', count: 32 }], exhausted: true, freeSlots: 19, gained: 100, recorded: 200, gotNotable: true, gravePresent: true, looseNearby: false })
  eq(r.kind, 'partial', 'bulk junk (>=10) even exhausted -> partial (a real pile is worth a trip)')
  eq(r.mark, false, 'bulk remainder -> NO mark')
}
// (i2) writeoff-junk needs BOTH exhausted AND <10: a small junk remainder NOT exhausted -> partial
{
  const r = V({ sawWindow: true, emptied: false, remaining: [{ name: 'oak_planks', count: 2 }], exhausted: false, freeSlots: 19, gained: 200, recorded: 202, gotNotable: true, gravePresent: true, looseNearby: false })
  eq(r.kind, 'partial', 'small junk remainder but NOT exhausted -> partial (retry, do not write off yet)')
}
// (j) emptied window but the fresh scan STILL sees the grave (AxGraves race) -> partial, NO mark
{
  const r = V({ sawWindow: true, emptied: true, remaining: [], exhausted: false, freeSlots: 19, gained: 214, recorded: 214, gotNotable: true, gravePresent: true, looseNearby: false })
  eq(r.kind, 'partial', 'window emptied but fresh scan still sees the grave (race) -> partial, NO mark')
  eq(r.mark, false, 'ambiguous standing grave -> NO mark (conservative)')
}

// ---- R1 STRING CONTRACT: index.js:~1173 reads /got my stuff back|nothing left where i died/i to
// decide recover success. Every MARKING verdict's case-site string must match it; every NON-marking
// (partial) string must NOT (so the grave stays unretrieved for the 300s cooldown re-dispatch).
{
  const R1 = /got my stuff back|nothing left where i died/i
  const x = 1, y = 2, z = 3, gained = 5, recorded = 10, remainingCount = 2, left = 0
  // exact strings the recover case returns per verdict kind:
  const strFull = `got my stuff back at ${x},${y},${z} (+${gained} items)${left ? ` - ${left} more grave to visit` : ''}`
  const strWriteoff = `got my stuff back at ${x},${y},${z} (+${gained} items) - left ${remainingCount} junk bits i couldn't pull`
  const strGone = `nothing left where i died at ${x},${y},${z} - it's gone`
  const strCapacity = `got some of my stuff at ${x},${y},${z} (+${gained}) - pack's full, the grave still has the rest, going back for it`
  const strPartial = `got some of my stuff at ${x},${y},${z} (+${gained} of ~${recorded}) - the grave still has the rest, going back for it`
  const strLoose = `picked up ${gained} loose items at ${x},${y},${z} but my gear is still in the grave - it won't open`
  const strUnopened = `my grave at ${x},${y},${z} is right here but it won't open - my stuff's stuck in it`
  eq(R1.test(strFull), true, 'R1: full string matches success regex (ledger + regex agree)')
  eq(R1.test(strWriteoff), true, 'R1: writeoff-junk string matches (prefix "got my stuff back" - no pointless cooldown)')
  eq(R1.test(strGone), true, 'R1: gone string matches success regex')
  eq(R1.test(strCapacity), false, 'R1: capacity string does NOT match (grave re-dispatched after cooldown)')
  eq(R1.test(strPartial), false, 'R1: partial string does NOT match (grave stays unretrieved)')
  eq(R1.test(strLoose), false, 'R1: loose-only string does NOT match')
  eq(R1.test(strUnopened), false, 'R1: unopened string does NOT match')
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
