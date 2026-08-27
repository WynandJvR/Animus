'use strict'
// SHELTER + NIGHT: deciding when the bot is unsafe in the open, and doing something about it -
// digging in for the night, sealing the shaft, torching the alcove, and the water-safety
// predicates that keep it from pitting itself into a pond. Split out of provision.js unchanged.
//
// shelter.js holds the PURE bed/hold timing; this is the executor - it reads the world, picks a
// dry diggable cell, and digs.
//
// It also owns the ARMOUR-AND-HP read side (underArmored, armorPieceCount, lowHpCalm): those
// exist to answer "is it safe to be out here", which is the same question the shelter decision
// asks. The gear-up EXECUTION that fixes a bad answer stays in provision.js.
//
// shelterSite lives here now. It used to be reachable only through provision.js's __siblings
// bridge because farm and bank both consult it (a shelter pit must not eat the crop plot, and
// the bank stand must not sit in one). They now import it from this module directly, which is
// one fewer internal on the bridge.
//
// buildZone is MIRRORED in from provision.js the same way world-memory does it - an active
// build site suppresses shelter siting, and reaching back for the binding is what caused two
// silent ReferenceErrors earlier in this refactor.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const shelter = require('./shelter.js')   // PURE bed/hold timing
// S7 forward-progress heartbeat (same helper provision-recovery.js uses).
const touchP = tag => { try { require('./commands.js').touchProgress(tag) } catch {} }
// PLAN-one-runner S4: a hold that sits still until a named wake DECLARES itself here, and both
// watchdogs read that one declaration - see digInForNight, which never had the old heartbeat and
// was dug out of its own sealed shelter into a creeper on 2026-07-29.
const reflexes = require('./reflexes.js')
const navigate = require('./navigate.js')
const provCore = require('./provision-core.js')
const { AIRISH, canBreakNaturally, countItem, toolForBlock, gotoWithTimeout, collectDrops, placeAt,
  nearHostile, isNight } = provCore
const worldMemory = require('./world-memory.js')
const { loadWorldMem, listInfra, rememberInfra, recallInfra, forgetInfra, knownBed } = worldMemory
const provHut = require('./provision-hut.js')
const { insideOwnStructure, onHutApron } = provHut
const provMining = require('./provision-mining.js')
const { ensureTorches, placeTorch, climbToSurface } = provMining

const P = () => require('./provision.js')
const S = () => require('./provision.js').__siblings

// Mirrored from provision.js via setBuildZone (see the header note).
let buildZone = null
function setBuildZone (box) { buildZone = box || null }
function inBuildZone (x, z) { return !!buildZone && x >= buildZone.x1 && x <= buildZone.x2 && z >= buildZone.z1 && z <= buildZone.z2 }

const { dbg, setDebugSink } = require('./debug-sink.js').makeDebug('[prov]') // §4: one definition of the sink rule; this module still owns its own sink

// fix #15 Piece C (flag DEFEND_WHEN_HIT, default ON, read once at module load - mirrors index.js):
// a sealed shelter that is nonetheless TAKING DAMAGE (breached/leaky seal, mob fell in before the
// cap) must bail out to fight/flee instead of holding _sheltering for up to 600s while hits land.
// =0 reverts both pit waits to their old `!fullySealed`/`!recapped`-only damage bails.
const DEFEND_WHEN_HIT_ON = process.env.DEFEND_WHEN_HIT !== '0'

// FROZEN / ETERNAL NIGHT: on the live server doDaylightCycle is off - timeOfDay is pinned in the
// night band and DAWN NEVER COMES (grounded live: tod stuck ~15438, delta 0 over 45s). Left to
// the normal rhythm the bot shelters forever: underArmored -> shelterNeeded -> it re-seals its
// bunker every cycle, and gearup is night-gated so it never re-arms - the exact "no armor, mobs
// about" hole it never climbed out of (live 379,62,40, pinned 25+ min). Detect a night that will
// not end so the reflexes can shelter BRIEFLY, then resume careful progress (gear up first). On a
// NORMAL server timeOfDay always advances, so this never trips and nights end at dawn as before.
const NIGHT_FROZEN_MS = parseInt(process.env.NIGHT_STUCK_MS || '90000', 10) // tod pinned this long at night = dawn isn't coming

const NIGHT_OVERLONG_MS = 900000 // ...or one continuous night runs 15 min (a normal night's dark is ~8-9 min; backstop for a non-frozen but stuck/very-laggy night)

let _nightStart = 0 // start of the current unbroken night

let _todSeen = { tod: null, at: 0 } // last time timeOfDay changed meaningfully

// Where a shelter pit last FLOODED - do not dig another hole next to the same aquifer
// for a while (the re-dig loop beside water is the entombment/drowning mechanism).
let lastFlood = null // {x, z, at}

// WHAT COUNTS AS A LID. Module scope because TWO functions need it and only one used to declare it
// (2026-08-26, live). It was a `const` inside sealShaft, while digInForNight's "a shelter needs a lid"
// guard - added the same day to stop the bot digging itself sixteen blocks straight down - referenced
// it from a different scope. So that guard threw ReferenceError EVERY time it was reached, and the
// throw surfaced only as one swallowed line from the scheduler:
//     (sched) nightShelter failed: CAP_RE is not defined
// The night-shelter job therefore died instantly on every dispatch and the bot spent every night
// standing in the open. One constant, one definition, both readers (#4).
// grass_block / podzol / mycelium / rooted_dirt (2026-08-27): these DROP DIRT bare-handed, and the
// 2026-08-26 "keeping the blocks is a precondition" check reads this list for "will the floor
// yield a lid". Without them a naked bot standing on GRASS - i.e. every respawn - was told
// "grass_block will not drop one without a tool; a pit i cannot lid is just a deeper hole" and
// could not dig in at night at all. Live 18:07-18:14: six deaths in seven minutes at spawn.
const CAP_RE = /terracotta|dirt|grass_block|podzol|mycelium|cobble|stone|gravel|sand|netherrack|deepslate|tuff|granite|diorite|andesite|clay|mud|_planks$|_log$|_concrete/

let _sheltering = false

function isSheltering () { return _sheltering }

// THE LATCH MUST BE RELEASABLE BY THE LAYER THAT REVOKES IT (2026-08-26, live).
// digInForNight raises `_sheltering` and lowers it in its own `finally` - which is right until the
// claim lease force-revokes the shelter at 150s, because then the finally never runs and the flag
// stays UP FOREVER. digInForNight's first line is `if (!bot.entity || _sheltering) return false`,
// so from that moment the bot can never dig a night shelter again for the life of the process: it
// stands in the open until dawn and takes the night on the chin (live: three deaths in ten minutes,
// hp 20 -> 3 -> dead to a zombie, at spawn, holding 30 dirt).
// The revoke path DID try - commands.BODY_LATCHES routes the 'shelter' claim at
// provision-recovery.releaseRecoveryLatches - but it could only ever clear a DEAD COPY; see the
// note on the export below. This is the real release, owned by the module that owns the flag.
function releaseShelterLatch () { const was = _sheltering; _sheltering = false; return was }

const shelterSite = require('./shelter.js') // pure shelter-siting: "can a safe pit be dug here" + nearest diggable dry cell

const SHELTER_FARM_R = Number(process.env.SHELTER_FARM_R || 7)

function shelterFarmConflict (bot, pos) {
  if (process.env.SHELTER_AVOID_FARM === '0' || !pos) return null
  let wf = null
  try { wf = loadWorldMem().wheatFarm } catch { return null }
  if (!wf) return null
  return shelterSite.farmConflict(wf, wf.cells || [], pos, SHELTER_FARM_R) ? wf : null
}

function inWaterNow (bot) {
  if (!bot.entity) return false
  const f = bot.blockAt(bot.entity.position.floored())
  const h = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))
  return !!((f && /water/.test(f.name)) || (h && /water/.test(h.name)))
}

async function ensureAshore (bot, isStopped = () => false) {
  if (!inWaterNow(bot)) return true
  dbg('rest: in water - getting ashore before any resting')
  try { if (await navigate.swimToShore(bot, isStopped)) return true } catch {}
  try { await P().manualHopFromWater(bot) } catch {}
  return !inWaterNow(bot)
}

function nearRecentFlood (bot) {
  if (!lastFlood || Date.now() - lastFlood.at > 600000 || !bot.entity) return false
  return Math.hypot(bot.entity.position.x - lastFlood.x, bot.entity.position.z - lastFlood.z) <= 6
}

// opts.exclude: [{x,y,z}] cells this search must NOT return again. A retry that re-picks the cell
// that just failed is not a retry (AUDIT 2026-07-29; see the relocate loop in digInForNight).
async function findDiggableDryCell (bot, opts = {}) {
  const radius = opts.radius || 24
  if (!bot.entity) return null
  const excluded = new Set((opts.exclude || []).map(c => c && (c.x + ',' + c.y + ',' + c.z)).filter(Boolean))
  const mcData = require('minecraft-data')(bot.version)
  const GROUND_RE = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mud|sand|red_sand|gravel|stone|deepslate|granite|diorite|andesite|tuff|clay|terracotta|netherrack|moss_block|snow_block|calcite)$/
  const ids = Object.values(mcData.blocksByName).filter(b => GROUND_RE.test(b.name)).map(b => b.id)
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 96 }) || []
  const nameAt = p => { const b = bot.blockAt(p); return b ? b.name : null }
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const cand = []
  const nearFarm = [] // fix #30: cells inside the farm buffer - used ONLY as a last resort
  for (const gp of found) {
    const feet = gp.offset(0, 1, 0); const head = gp.offset(0, 2, 0)
    // standable + dry to STAND on (no water in the feet/head cell or its horizontal neighbours)
    if (!shelterSite.feetCellDry(nameAt(feet), nameAt(head), SIDES.map(([dx, dz]) => nameAt(feet.offset(dx, 0, dz))))) continue
    // a safe pit can be dug straight down from here (solid, no fluid below/beside the shaft,
    // and not a thin shelf over a cave - below3 lets shelterDiggable reject a void two deep)
    const below = nameAt(gp); const below2 = nameAt(gp.offset(0, -1, 0)); const below3 = nameAt(gp.offset(0, -2, 0))
    if (!shelterSite.shelterDiggable(below, below2, SIDES.map(([dx, dz]) => nameAt(gp.offset(dx, 0, dz))), below3)) continue
    // must be real natural ground the anti-grief dig will actually break (not a player block)
    const gb = bot.blockAt(gp); if (gb && !canBreakNaturally(gb)) continue
    // never relocate the pit onto our own hut apron (defaces the doorstep)
    if (onHutApron(bot, feet)) continue
    // SHELTER_AVOID_FARM (fix #30): never relocate the pit into our own farm (floods/wrecks
    // the crop) - hold these aside and only fall back to them if NOTHING clear of the farm exists.
    if (excluded.has(feet.x + ',' + feet.y + ',' + feet.z)) continue // already tried and failed this run
    if (shelterFarmConflict(bot, feet)) { nearFarm.push({ x: feet.x, y: feet.y, z: feet.z }); continue }
    cand.push({ x: feet.x, y: feet.y, z: feet.z })
  }
  const ranked = shelterSite.rankByDistance(cand, bot.entity.position)
  if (ranked.length) return new Vec3(ranked[0].x, ranked[0].y, ranked[0].z)
  // LAST RESORT (survival > farm): no dry diggable ground clear of the farm - take a farm-buffer
  // cell rather than freeze exposed all night, and log the override.
  const rankedFarm = shelterSite.rankByDistance(nearFarm, bot.entity.position)
  if (rankedFarm.length) { dbg('shelter: NO dry diggable ground clear of the farm - relocating INTO the farm buffer as a last resort (survival > crops)'); return new Vec3(rankedFarm[0].x, rankedFarm[0].y, rankedFarm[0].z) }
  return null
}

// Bounded water scout: 4 cardinal legs x expanding radius, scanning for surface water at
// each stop. Feeds BOTH fishing and the wheat farm (found ponds land in 'water' memory).
async function scoutForWater (bot, { isStopped = () => false, maxMs = 150000, rings } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const waterId = mcData.blocksByName.water.id
  const start = bot.entity.position.clone()
  const deadline = Date.now() + maxMs
  const surface = () => (bot.findBlocks({ matching: waterId, maxDistance: 48, count: 32 }) || [])
    .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) })
  // FOOD_FLOOR F4: the escalated floor widens the rings by one (a caller passes [48,96,144]);
  // default is today's [48,96] byte-for-byte.
  for (const r of (rings && rings.length ? rings : [48, 96])) {
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      if (isStopped() || Date.now() > deadline) return []
      try { await S().walkStaged(bot, start.x + dx * r, start.z + dz * r, { isStopped, range: 10, timeoutMs: 45000 }) } catch {}
      const w = surface()
      if (w.length) { rememberInfra('water', { x: w[0].x, y: w[0].y, z: w[0].z }); dbg('  water scout: surface water at ' + w[0].x + ',' + w[0].z); return w }
    }
  }
  dbg('  water scout: no surface water within ~96 blocks')
  return []
}

// How many armor slots are actually worn (0-4). Modulates the deep-mine plan (deepMinePlan):
// a naked bot digs shallower/shorter so it doesn't die on the same deep excursion an armored
// bot survives (naked-deep deaths, live). Complements underArmored (which is a boolean gate).
function armorPieceCount (bot) {
  let n = 0
  try { for (const s of ['head', 'torso', 'legs', 'feet']) { if (bot.inventory && bot.inventory.slots[bot.getEquipmentDestSlot(s)]) n++ } } catch { return 0 }
  return n
}

function underArmored (bot) {
  try { for (const s of ['head', 'torso', 'legs', 'feet']) { if (!(bot.inventory && bot.inventory.slots[bot.getEquipmentDestSlot(s)])) return true } return false } catch { return true }
}

function lowHpCalm (bot) {
  if (process.env.GATHER_HP_RECOVER === '0') return false
  return (bot.health ?? 20) < 12 && !nearHostile(bot, 6)
}

// Fire night-rest whenever we're under-armored and DUSK is falling. This USED to also wait for
// a hostile within 12 blocks - which meant the bot wandered exposed all night and only started
// digging once a skeleton was already shooting it (verified live: 7 night deaths in one
// evening, several while "sheltering"). A naked player doesn't wait to be chased: at dusk they
// go to bed or hole up BEFORE the mobs arrive. Trigger at DUSK (12200), NOT mob-spawn (13000):
// a fresh pit takes ~15-20s to dig + seal, so starting after dark means a zombie walks straight
// into the open hole mid-dig (verified live: began the pit at timeOfDay 13618, a zombie walked
// in during the dig, died). The ~800-tick (~40s) head start lets the pit be sealed before any
// mob spawns. isNight (13000) stays the trigger for the ARMORED "wanted" cases below.
// SHELTER_TOD (12200) now lives in shelter.js: scheduler.homeLeash has to know the exact tick
// this rule fires at in order to have the bot HOME by then, and a second copy of the deadline
// would drift from the rule it is supposed to serve (#4).
function shelterNeeded (bot) { return !!(bot.time && bot.time.timeOfDay >= shelter.SHELTER_TOD && bot.time.timeOfDay < 23500) && underArmored(bot) }

function nightStuck (bot) {
  if (!bot || !bot.time) return false
  const now = Date.now()
  const tod = bot.time.timeOfDay
  if (_todSeen.tod == null || Math.abs(tod - _todSeen.tod) > 30) _todSeen = { tod, at: now } // ~1.5s of ticks; frozen tod never refreshes this
  if (!isNight(bot)) { _nightStart = 0; return false }
  if (!_nightStart) _nightStart = now
  return (now - _todSeen.at) > NIGHT_FROZEN_MS || (now - _nightStart) > NIGHT_OVERLONG_MS
}

// Rest is WANTED (not just needed) when night catches us with the bed close by - even in
// full armor a player sleeps if home is right there (operator rule: safer overall). Far
// from the bed and armored, keep working the night; the commute would cost more than the
// safety buys.
function nightRestWanted (bot) {
  if (shelterNeeded(bot)) return true
  if (!isNight(bot) || !bot.entity) return false
  if ((bot.health ?? 20) <= 8) return true // critically hurt at night: rest, armored or not (died at 1hp hunting in the dark)
  const bed = knownBed()
  return !!bed && Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 100 // must COVER THE BUILD SITE: it died working the castle at night, 66 blocks from bed, 2 past the old radius
}

async function sealShaft (bot, interior = {}) {
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const feet = interior.feet || bot.entity.position.floored()
  const keep = [interior.feet, interior.head, interior.alcoveCell].filter(Boolean)
  const isInterior = c => keep.some(m => m.x === c.x && m.y === c.y && m.z === c.z)
  // 1) WALLS FIRST: dy=0 ring (each cell places against the solid floor under it) THEN dy=1
  //    ring (each places against the dy=0 block just laid) - this ordering is what makes cave
  //    geometry sealable. Liquid counts as a hole (AIRISH misses water). Skip interior cells
  //    (the alcove) so we never wall the torch back in.
  let sideHoles = 0
  for (const dy of [0, 1]) {
    for (const [dx, dz] of SIDES) {
      const cell = feet.offset(dx, dy, dz)
      if (isInterior(cell)) continue
      const b = bot.blockAt(cell)
      if (b && (AIRISH(b.name) || /lava|water/.test(b.name))) {
        if (await placeAt(bot, cell, CAP_RE)) dbg('shelter: walled a side hole at ' + cell.toString())
        else { sideHoles++; dbg('shelter: side hole at ' + cell.toString() + ' UNSEALED (' + b.name + ') - ' + (placeAt.lastFail || '?')) }
      }
    }
  }
  // 2) CAP SECOND - the head ring now gives the cap cell solid neighbours so placeAt succeeds.
  let capPos = bot.entity.position.floored().offset(0, 2, 0)
  let capped = await placeAt(bot, capPos, CAP_RE)
  if (!capped) dbg('shelter: cap attempt 1 failed - ' + (placeAt.lastFail || '?'))
  // VERIFY the cap landed (placement can miss from inside a 1x1 pit) and retry once - an
  // uncapped pit is a mob funnel (they fall in ON TOP of the bot, seen live).
  if (!capped || AIRISH((bot.blockAt(capPos) || {}).name || 'air')) {
    await new Promise(r => setTimeout(r, 300))
    capped = await placeAt(bot, capPos, CAP_RE)
    if (!capped) dbg('shelter: cap attempt 2 failed - ' + (placeAt.lastFail || '?'))
  }
  // Last resort: dig one deeper and cap one lower - a 3-deep shaft with a lid at -2 still seals
  // (head keeps a 1-block air gap under the cap), and the deeper shaft gives a wall ring to place
  // against that some placements need.
  if (!capped || AIRISH((bot.blockAt(capPos) || {}).name || 'air')) {
    const f = bot.entity.position.floored()
    const below = bot.blockAt(f.offset(0, -1, 0))
    const below2 = bot.blockAt(f.offset(0, -2, 0))
    // BOUNDED BY THE RIM (2026-08-27). This last resort ran on EVERY failed lid, and the lid failed
    // on every re-seal ("place did not land ... (world re-read)"), so each night-cycle dug the
    // floor one deeper: live at the build site, feet 65 -> 57 in one night, an 8-deep well the
    // bot then had to climb out of at dawn. The comment above names the bound - "a 3-deep shaft
    // with a lid at -2 still seals" - so that IS the bound: the floor may go to rim-3 and no
    // further. The caller passes the rim (the fresh dig's surface, the re-used pit's registered y).
    const rimY = Number.isFinite(interior.rimY) ? interior.rimY : null
    const deeperOK = rimY == null || (f.y - 1) >= rimY - 3
    if (!deeperOK) dbg('shelter: NOT digging deeper - the floor is already ' + (rimY - f.y) + ' below the rim y' + rimY + '; deeper is a well, not a shelter')
    if (deeperOK && below && !AIRISH(below.name) && !/lava|water/.test(below.name) && canBreakNaturally(below) &&
        !(below2 && /lava|water/.test(below2.name))) {
      try {
        await bot.dig(below); await new Promise(r => setTimeout(r, 300)); await collectDrops(bot, 3)
        capPos = bot.entity.position.floored().offset(0, 2, 0)
        capped = await placeAt(bot, capPos, CAP_RE)
        if (!capped) dbg('shelter: deep-cap attempt failed - ' + (placeAt.lastFail || '?'))
      } catch (e) { dbg('shelter: deeper dig failed (' + e.message + ')') }
    }
  }
  return { capped, sideHoles, capPos }
}

// Widen ONE floor-level neighbour of `feet` into a torch alcove so a sealed pit can be LIT.
// PROBE everything first (world re-reads): the candidate must be natural + breakable, and its
// floor, far wall, both side faces AND ceiling must all be solid non-liquid (alcoveSafe) with no
// liquid on any of its 6 faces - so cutting the one cell keeps the box a complete seal. ONE
// attempt, first candidate that passes; returns the dug cell Vec3 or null. The ONLY new dig in
// the shelter flow, gated by canBreakNaturally (anti-grief) + the liquid probes.
async function digTorchAlcove (bot, feet) {
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]
  for (const [dx, dz] of SIDES) {
    const cell = feet.offset(dx, 0, dz)
    const cb = bot.blockAt(cell)
    if (!cb || AIRISH(cb.name) || /lava|water/.test(cb.name)) continue // must be a block we open INTO
    if (!canBreakNaturally(cb)) continue // anti-grief: never cut a player block
    if (bot.canDigBlock && !bot.canDigBlock(cb)) continue
    const floor = bot.blockAt(cell.offset(0, -1, 0))
    const farWall = bot.blockAt(cell.offset(dx, 0, dz))
    const perp = dx !== 0 ? [[0, 0, 1], [0, 0, -1]] : [[1, 0, 0], [-1, 0, 0]]
    const side1 = bot.blockAt(cell.offset(perp[0][0], perp[0][1], perp[0][2]))
    const side2 = bot.blockAt(cell.offset(perp[1][0], perp[1][1], perp[1][2]))
    const ceil = bot.blockAt(cell.offset(0, 1, 0))
    if (!shelterSite.alcoveSafe([floor, farWall, side1, side2, ceil].map(b => (b ? b.name : null)))) continue
    if (N6.some(([ox, oy, oz]) => { const b = bot.blockAt(cell.offset(ox, oy, oz)); return b && /lava|water/.test(b.name) })) continue // no liquid touching the pocket
    const tool = toolForBlock(bot, cb.name)
    if (tool) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(cb); await collectDrops(bot, 3); dbg('shelter: opened a torch alcove at ' + cell.toString()); return cell } catch (e) { dbg('shelter: alcove dig failed (' + e.message + ')'); return null }
  }
  return null
}

// FIX 15: cells where a pit was dug but the CAP could not be placed ("no solid neighbour to place
// against"). Such a hole is a mob funnel, not a shelter, so the siting search must stop offering
// it. A COUNT-bounded list of observations, not a timer - the geometry does not change on its own.
const capFailedCells = []

async function digInForNight (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  if (!bot.entity || _sheltering) return false
  // ETERNAL/FROZEN NIGHT: don't start a fresh dig-in that would just break out on the next poll -
  // dawn isn't coming, so resume careful progress (gear up) instead of re-bunkering every cycle.
  // The brief initial shelter already ran while the night still looked normal (see nightStuck).
  if (nightStuck(bot)) { dbg('shelter: night is stuck/eternal - not digging in; time to re-arm and work carefully'); return false }
  // ANTI-GRIEF is handled PER-DIG below (canBreakNaturally): the shelter can only cut natural
  // ground, never a placed block - so it can't punch through a base's floor, yet it CAN still
  // dig a bunker in natural dirt right next to a build (incl. the bot's OWN castle at the build
  // site, where it most needs to shelter). Standing ON a player floor -> the dig loop's natural
  // check fails immediately -> no hole, it just flees instead.
  _sheltering = true
  try {
    bot.pathfinder && bot.pathfinder.setGoal(null)
    // LIGHT THE SHELTER: try to have a couple of torches ready (free from coal/charcoal mine
    // bycatch + carried sticks; silent no-op if we have neither). A lit sealed alcove stops
    // mob spawns through a long night - the missing half of "an actual safe space, not a hole".
    try { await ensureTorches(bot, 2) } catch {}
    // IN WATER? Get ashore FIRST - digging attempts from a water column all fail while
    // the bot drowns through the retry carousel (watched it die that way on the test
    // server). If we can't reach land, say so honestly instead of pretending to shelter.
    if (!(await ensureAshore(bot, isStopped))) { dbg('shelter: stuck in water - cannot dig in here'); return false }
    // Don't dig a fresh hole beside the aquifer that just flooded the last one - walk
    // clear of it first (re-digging at the same wet spot is the drowning loop).
    if (nearRecentFlood(bot)) {
      const away = { x: bot.entity.position.x + (bot.entity.position.x >= lastFlood.x ? 8 : -8), z: bot.entity.position.z + (bot.entity.position.z >= lastFlood.z ? 8 : -8) }
      dbg('shelter: too close to the pit that flooded - moving to ' + Math.round(away.x) + ',' + Math.round(away.z) + ' first')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 2), 15000) } catch {}
    }
    // NEVER dig the bunker inside the active build footprint - step just past the nearest
    // edge first (a pit under the castle floor is a hole in the build, operator rule).
    const p0 = bot.entity.position
    if (inBuildZone(p0.x, p0.z)) {
      const exits = [
        { x: buildZone.x1 - 5, z: p0.z }, { x: buildZone.x2 + 5, z: p0.z },
        { x: p0.x, z: buildZone.z1 - 5 }, { x: p0.x, z: buildZone.z2 + 5 }
      ].sort((a, b) => Math.hypot(a.x - p0.x, a.z - p0.z) - Math.hypot(b.x - p0.x, b.z - p0.z))
      dbg('shelter: inside the build footprint - stepping out to ' + Math.round(exits[0].x) + ',' + Math.round(exits[0].z) + ' before digging')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(exits[0].x, exits[0].z, 2), 20000) } catch (e) { dbg('shelter: footprint exit walk failed (' + e.message + ') - digging where i stand') }
    }
    // MY HUT IS THE SHELTER: at the doorstep of the bot's own hut, step INSIDE (door-
    // assist) instead of digging a pit beside the walls; already inside, just wait the
    // night out - walls and roof beat any hole in the ground, and pitting here is how
    // the interior kept getting defaced (dirt piles, floor holes - live, repeatedly).
    if (!insideOwnStructure(bot)) {
      const hutNear = onHutApron(bot)
      if (hutNear) {
        try {
          const nav = require('./navigate.js') // lazy - navigate requires provision the same way
          // ATOMIC ENTER-MY-STRUCTURE (nav slice B): stand off just outside the door, then one
          // reflex-protected open-align-step-through - robust vs the plain goto that timed out
          // trying to path into the closed box and got its goal stolen mid-crossing (live).
          if (!await nav.enterStructure(bot, hutNear, { isStopped })) {
            await nav.navigateTo(bot, new goals.GoalNear(hutNear.x + 2, hutNear.y + 1, hutNear.z + 2, 1), { timeoutMs: 20000, deadlineMs: 45000, isStopped, climb: false, rescue: 'light', label: 'shelter-home' })
          }
        } catch (e) { dbg('shelter: could not get inside my hut (' + e.message + ')') }
      }
    }
    if (insideOwnStructure(bot)) {
      dbg('shelter: inside my own hut - waiting out the night, no digging')
      say('holed up at home for the night')
      const dl = Date.now() + 600000
      const hpIn = bot.health || 20
      let hurtInside = false
      // A DECLARED HOLD, like the fresh pit's (below) - see the note at the bunker re-entry.
      const holdHut = reflexes.beginHold('nightShelter:hut', 'dawn|hostile-gone|damage|flooding', dl - Date.now() + 5000)
      try {
      while (Date.now() < dl && !isStopped()) {
        // hold through the DUSK HEAD-START too (shelterNeeded fires at 12200, isNight at
        // 13000): breaking on "!isNight" alone made this return success instantly at dusk,
        // so the 5s reflex re-entered forever - the "waiting out the night" log spam (live)
        if ((!shelterNeeded(bot) && !isNight(bot) && !nearHostile(bot, 10)) || nightStuck(bot)) break // stuck night: stop waiting for a dawn that won't come
        if ((bot.health || 20) < hpIn - 3) { dbg('shelter: taking damage INSIDE the hut - releasing shelter to FIGHT'); hurtInside = true; break }
        if (inWaterNow(bot)) { dbg('shelter: hut interior flooding - bailing'); hurtInside = true; break }
        await new Promise(r => setTimeout(r, 3000))
      }
      } finally { reflexes.endHold(holdHut); touchP('shelterHold:released') }
      if (!hurtInside) return true
      // Hurt while holed up inside the hut (an enderman teleported in, a mob at the door):
      // do NOT abandon the walls to dig a pit - RELEASE the shelter so the now-ungated
      // flee/defend reflexes take over. Armored, inside its own walls, the bot wins the
      // fight; a creeper it flees. Standing still absorbing hits killed it (live: enderman
      // -> 'attack suppressed' -> dead). restUntilSafe re-shelters once the threat clears.
      if (inWaterNow(bot)) { /* flooding: fall through to relocate/pit below */ } else return false
    }
    // Near (but not in) the hut with no way inside: dig AWAY from the walls/apron, never
    // against them - same rule as the build footprint below.
    if (onHutApron(bot)) {
      const h = onHutApron(bot)
      const away = { x: h.x + 12, z: h.z + 12 }
      dbg('shelter: on my hut apron - stepping clear to ' + away.x + ',' + away.z + ' before digging')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 2), 15000) } catch {}
    }
    // SHELTER_AVOID_FARM (fix #30): never dig the bunker into/beside our own wheat farm - a pit at
    // the farm waterline floods and WRECKS the crop (#28's physical cause). Step clear of the farm
    // first, same rule as the build footprint / hut apron above. The relocation cell-picker
    // (findDiggableDryCell) also excludes the farm, so a blocked in-place dig won't fall back onto it.
    const farmHere = shelterFarmConflict(bot, bot.entity.position)
    if (farmHere) {
      const p = bot.entity.position
      let dx = p.x - farmHere.x, dz = p.z - farmHere.z
      if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) { dx = 1; dz = 1 } // standing on the anchor: pick a corner
      const norm = Math.hypot(dx, dz) || 1
      const away = { x: Math.round(farmHere.x + (dx / norm) * (SHELTER_FARM_R + 6)), z: Math.round(farmHere.z + (dz / norm) * (SHELTER_FARM_R + 6)) }
      dbg('shelter: too close to my wheat farm - stepping clear to ' + away.x + ',' + away.z + ' before digging (would flood the crops)')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 2), 15000) } catch {}
    }
    // REUSE MY BUNKER: four nights of fresh digs at one spot, each side-sealing against
    // the previous night's holes, ENTOMBED the bot in a hillside (live - needed a rescue
    // agent). If a registered shelter is within 24, go sit in it and re-SEAL instead (24 not
    // 12: a branch-mine head drifts, and a bounded goto to a known bunker beats a fresh dig).
    const oldPit = recallInfra('shelter', bot.entity.position, 24)
    if (oldPit) {
      dbg('shelter: reusing my bunker at ' + oldPit.x + ',' + oldPit.y + ',' + oldPit.z)
      const inPit = () => { const h = bot.entity.position.floored(); return Math.abs(h.x - oldPit.x) <= 1 && Math.abs(h.z - oldPit.z) <= 1 && h.y <= oldPit.y + 1 }
      // ALREADY IN IT: never ask the planner to walk to a cell it cannot reach from inside a sealed
      // pit. Live 2026-08-27 that goto answered noPath in 1ms, the rescue behind it opened the lid
      // at night with a creeper 3.7m outside, and the rung was cut 150s later mid-"walk".
      if (!inPit()) { try { await gotoWithTimeout(bot, new goals.GoalBlock(oldPit.x, oldPit.y, oldPit.z), 15000) } catch {} }
      if (inPit()) {
        // we're in the old hole - RE-SEAL it (walls too, not just the lid: a reused pit can have
        // caved-in / re-opened sides), light a torch alcove if we carry one, then wait the night.
        const feet0 = bot.entity.position.floored()
        const head0 = feet0.offset(0, 1, 0)
        let alcove0 = null
        if (countItem(bot, 'torch') > 0) { try { alcove0 = await digTorchAlcove(bot, feet0) } catch {} }
        const seal0 = await sealShaft(bot, { feet: feet0, head: head0, alcoveCell: alcove0, rimY: oldPit.y })
        if (alcove0) { try { await placeTorch(bot) } catch {} }
        const capPos0 = seal0.capPos
        const recapped = seal0.capped && !seal0.sideHoles
        dbg('shelter: bunker re-entered, ' + (recapped ? 'RE-SEALED' : 'OPEN (leaky)') + (seal0.sideHoles ? ' ' + seal0.sideHoles + ' side(s)' : ''))
        say(recapped ? 'back in my bunker for the night' : 'in my bunker (lid open)')
        const dl = Date.now() + (recapped ? 600000 : 120000)
        const hpX = bot.health || 20
        // A DECLARED HOLD (2026-08-27). The fresh-pit wait below has declared one since S4; this
        // re-entry path was added later and never did - so it looked, to boundedRung and the claim
        // lease, exactly like a hung rung: "no verified progress for 150s and no declared hold",
        // cut at 150s EVERY night (live 14:31, 15:37, ...), its exit tail then ran with isStopped()
        // already true and opened nothing, and R5 sealed the lid again. Sitting sealed until dawn
        // IS this rung's job; it says so now, once, with its own deadline as the TTL.
        const holdBunker = reflexes.beginHold('nightShelter:bunker', 'dawn|hostile-gone|damage|flooding', dl - Date.now() + 5000)
        try {
        while (Date.now() < dl && !isStopped()) {
          if ((!isNight(bot) && !nearHostile(bot, 10)) || nightStuck(bot)) break // stuck night: don't squat till a dawn that won't come
          if ((!recapped || DEFEND_WHEN_HIT_ON) && (bot.health || 20) < hpX - 3) { dbg('shelter: taking damage in the ' + (recapped ? 'SEALED bunker - breached' : 'open bunker') + ' - bailing out to fight/flee'); break }
          // same flooding bail as the fresh-pit wait: a reused bunker beside an aquifer
          // can flood too, and this loop had no way out (drowned sealed, test server)
          if (inWaterNow(bot)) {
            dbg('shelter: reused bunker is FLOODING - emergency exit')
            lastFlood = { x: bot.entity.position.x, z: bot.entity.position.z, at: Date.now() }
            break
          }
          await new Promise(r => setTimeout(r, 3000))
        }
        } finally { reflexes.endHold(holdBunker); touchP('shelterHold:released') }
        // the ONE way out of a pit (breakOut) - not "dig the cap i remember and climb to feet+4":
        // a re-used bunker can have gained a second lid course, and +4 was an arithmetic guess (#111)
        try { await breakOut(bot, { isStopped }) } catch (e) { dbg('shelter: bunker exit failed (' + e.message + ')') }
        return true
      }
      dbg('shelter: could not re-enter the bunker - digging fresh')
    }
    // ON A TREE CANOPY? The shelter can't dig leaves (not in DIGGABLE_NATURAL) and used to
    // NO-OP in a 5s loop all night (reproduced on test server, savanna oak). Leaves are
    // always natural: if the ground is close below, punch through and drop; if it's a tall
    // tree (jungle!), walk off to real ground instead - never a lethal fall.
    for (let i = 0; i < 8; i++) {
      const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (!under || !/_leaves$/.test(under.name)) break
      let depth = 0 // how far we'd fall past this leaf layer
      for (let dy = 2; dy <= 8; dy++) { const b = bot.blockAt(bot.entity.position.floored().offset(0, -dy, 0)); if (b && !AIRISH(b.name) && !/_leaves$/.test(b.name)) break; depth++ }
      if (depth > 4) {
        dbg('shelter: on a TALL canopy (' + depth + '+ drop) - walking to ground instead of punching through')
        const mcData = require('minecraft-data')(bot.version)
        const gids = Object.values(mcData.blocksByName).filter(b => /^(grass_block|dirt|coarse_dirt|podzol|sand|red_sand|gravel|stone)$/.test(b.name)).map(b => b.id)
        const spots = (bot.findBlocks({ matching: gids, maxDistance: 16, count: 12 }) || [])
          .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); const a2 = bot.blockAt(p.offset(0, 2, 0)); return a && AIRISH(a.name) && a2 && AIRISH(a2.name) })
        if (spots.length) { try { await gotoWithTimeout(bot, new goals.GoalBlock(spots[0].x, spots[0].y + 1, spots[0].z), 12000) } catch (e) { dbg('shelter: walk-to-ground failed (' + e.message + ')') } }
        break
      }
      try { await bot.dig(under) } catch (e) { dbg('shelter: leaf-punch failed (' + e.message + ')'); break }
      await new Promise(r => setTimeout(r, 400)) // drop through
    }
    // CENTER on the feet cell. Digging from a cell edge (x.5/z.5 boundary) digs the
    // column under floored(feet) while the body stays supported by the NEIGHBOUR block -
    // the bot opens a perfect pit and stands beside it all night with the "cap" aimed at
    // thin air (root cause of every 'ducked into a hole' night death; reproduced on the
    // test server at x=-330.5: "cap failed - no solid neighbour to place against").
    // Dig the pit HERE; if the flooding/obstruction guard blocks it, RELOCATE to the nearest
    // diggable DRY cell and retry (bounded). ensureAshore only gets us OUT of the water - on a
    // river bank the bot can be ashore yet water-adjacent on every side, so an in-place-only
    // pit hits the side-liquid guard forever ("water beside the next cell" -> "NO-OP" every
    // ~4s, bricked the bot, live). Relocating to genuinely diggable dry ground is the fix.
    let dug = 0
    let surfaceY = Math.floor(bot.entity.position.y)
    let shaft = bot.entity.position.floored()
    const RELOCATE_TRIES = 3
    const relocFailed = [] // cells this call has already tried and ruled out - see the relocate block below
    for (let attempt = 0; attempt <= RELOCATE_TRIES && dug < 1 && !isStopped(); attempt++) {
      // CENTER on the feet cell. Digging from a cell edge (x.5/z.5) digs the column under
      // floored(feet) while the body stays supported by the NEIGHBOUR block - the bot opens a
      // perfect pit and stands beside it with the "cap" aimed at thin air (every 'ducked into
      // a hole' night death; reproduced at x=-330.5: "no solid neighbour to place against").
      try { const f0 = bot.entity.position.floored(); await gotoWithTimeout(bot, new goals.GoalBlock(f0.x, f0.y, f0.z), 4000) } catch {}
      surfaceY = Math.floor(bot.entity.position.y)
      shaft = bot.entity.position.floored() // the column we dig - we must END UP inside it
      // 1) dig straight down 2, keeping the blocks (need one to cap with). NEVER dig into a
      //    void/lava/water below, and ONLY natural terrain (never a player build block).
      //
      // "KEEPING THE BLOCKS" IS A PRECONDITION, NOT A HOPE (2026-08-26). This loop assumed the spoil
      // would become the cap. Bare-handed that is only true for dirt/gravel/sand; stone, andesite
      // and deepslate list harvestTools and drop NOTHING without a pickaxe. So an empty-handed bot
      // in stone dug a pit, could not cap it, correctly refused to call an uncapped pit a shelter -
      // and the next dispatch dug TWO BLOCKS DEEPER, forever. Live 2026-08-26, same x/z, one block
      // at a time:
      //   16:37:50 y=44   16:39:50 y=36   16:41:20 y=28
      // Sixteen blocks straight down into a shaft it had no pickaxe to leave and no blocks to
      // pillar out of. The bot buried itself trying to shelter.
      // A shelter needs a LID. If we hold no cap material and the spoil will not yield any, digging
      // cannot produce a shelter and can only deepen the hole - so it is refused here, at the one
      // place that knows, rather than discovered again after every dig (rule 5: the refusal names
      // the blocker, and nightShelter's caller then reports honestly that it cannot shelter here).
      const holdsCap = () => (bot.inventory ? bot.inventory.items() : []).some(i => CAP_RE.test(i.name))
      const willDropCap = (b) => {
        if (!b || !CAP_RE.test(b.name)) return false
        try {
          const md = require('minecraft-data')(bot.version)
          const def = md.blocksByName[b.name]
          if (!def || !def.harvestTools) return true // drops bare-handed (dirt/gravel/sand/grass)
          return !!toolForBlock(bot, b.name)         // needs a tool and we have one
        } catch { return false }                      // unreadable -> assume no drop, the safe side
      }
      for (let i = 0; i < 2 && !isStopped(); i++) {
        const feet = bot.entity.position.floored()
        const below = bot.blockAt(feet.offset(0, -1, 0))
        if (!holdsCap() && !willDropCap(below)) {
          dbg('shelter: NOT digging at ' + i + ' - no cap material in the pack and ' + (below ? below.name : 'the floor') + ' will not drop one without a tool; a pit i cannot lid is just a deeper hole')
          break
        }
        const below2 = bot.blockAt(feet.offset(0, -2, 0))
        if (!below || AIRISH(below.name) || /lava|water/.test(below.name) || !canBreakNaturally(below)) { dbg('shelter: dig blocked at ' + i + ' (' + (below ? below.name : 'unloaded') + ')'); break }
        if (below2 && /lava|water/.test(below2.name)) { dbg('shelter: liquid 2 below - not digging'); break }
        // VOID BELOW: if BOTH below2 AND below3 are airish we're on a thin shelf over a CAVE -
        // digging `below` drops us >=2 blocks into the open cavern (the exposed dark-cave death
        // this fix targets). below2-air over SOLID below3 is legit 3-deep geometry -> allowed.
        // Break into the relocate machinery to find real ground instead of falling in.
        const below3 = bot.blockAt(feet.offset(0, -3, 0))
        const airish = b => !b || AIRISH(b.name)
        if (airish(below2) && airish(below3)) { dbg('shelter: void 2+ below (thin shelf over a cave) - not digging, relocating'); break }
        // NEVER open a cell whose SIDE touches liquid - an aquifer beside the shaft floods
        // the pit the instant the wall drops (drowned at 4hp in its own sealed pit, live).
        let sideLiquid = null
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const s = bot.blockAt(below.position.offset(dx, 0, dz))
          if (s && /lava|water/.test(s.name)) { sideLiquid = s.name; break }
        }
        if (sideLiquid) { dbg('shelter: ' + sideLiquid + ' beside the next cell - not digging deeper'); break }
        const tool = toolForBlock(bot, below.name)
        if (tool) await bot.equip(tool, 'hand').catch(() => {})
        if (bot.canDigBlock && !bot.canDigBlock(below)) { dbg('shelter: canDigBlock=false for ' + below.name); break }
        try { await bot.dig(below) } catch (e) { dbg('shelter: dig failed (' + e.message + ')'); break }
        await new Promise(r => setTimeout(r, 250)) // fall into the hole
        // VERIFY we dropped in - a straddling bot digs without falling. Steer into the shaft.
        if (Math.floor(bot.entity.position.y) > feet.y - 1) {
          try { await gotoWithTimeout(bot, new goals.GoalBlock(shaft.x, feet.y - 1, shaft.z), 3000) } catch {}
          await new Promise(r => setTimeout(r, 200))
        }
        dug++
      }
      if (dug >= 1) break
      // Blocked in place (water-adjacent / obstruction). Walk to the nearest diggable dry cell
      // and try again - PROGRESS instead of the 4s NO-OP spin. Widen the search each retry.
      if (attempt < RELOCATE_TRIES) {
        // AUDIT 2026-07-29 - "a retry must differ from the attempt that failed".
        // Live (test server, 14:02): all three relocation tries picked the IDENTICAL cell
        // (-403,59,409), because the search had no memory of what it had just rejected and
        // nothing checked whether the walk to it ARRIVED. The bot stood at y=62 re-evaluating a
        // column at y=59, three times, then reported "no diggable ground" and held in the open all
        // night - a third instance of the same defect class as the recovery-ladder livelock.
        // Two things are now true: the cell we just failed at is EXCLUDED from the next search,
        // and a walk that did not arrive marks its target failed rather than being retried blind.
        const dry = await findDiggableDryCell(bot, { radius: 20 + attempt * 12, exclude: relocFailed.concat(capFailedCells) })
        if (!dry) { dbg('shelter: no diggable dry ground within reach (' + relocFailed.length + ' cell(s) already ruled out) - cannot pit'); break }
        dbg('shelter: cannot dig here (water/obstruction) - relocating to diggable dry ground at ' + dry.toString() + ' (try ' + (attempt + 1) + '/' + RELOCATE_TRIES + ')')
        if (opts.say && attempt === 0) opts.say('ground here is too wet to dig into - moving to dry ground to shelter')
        try { await gotoWithTimeout(bot, new goals.GoalBlock(dry.x, dry.y, dry.z), 20000) } catch (e) { dbg('shelter: relocate walk failed (' + e.message + ')') }
        if (inWaterNow(bot)) { try { await ensureAshore(bot, isStopped) } catch {} }
        // GROUNDED ARRIVAL CHECK: re-read where the body actually is. Anything more than a step
        // away means the walk failed, and the cell is not a candidate we may test again.
        const at = bot.entity.position.floored()
        const arrived = Math.abs(at.x - dry.x) <= 1 && Math.abs(at.z - dry.z) <= 1 && Math.abs(at.y - dry.y) <= 1
        relocFailed.push({ x: dry.x, y: dry.y, z: dry.z })
        if (!arrived) dbg('shelter: relocate did NOT arrive (wanted ' + dry.toString() + ', standing at ' + at.toString() + ') - ruling that cell out')
      }
    }
    if (dug < 1) { dbg('shelter: NO-OP (dug 0 after ' + RELOCATE_TRIES + ' relocation tries) - caller must do something else'); return false } // genuinely nowhere diggable+dry nearby
    if (Math.floor(bot.entity.position.y) >= surfaceY) { dbg('shelter: dug ' + dug + ' but NEVER FELL IN (still at surface) - aborting, not pretending'); return false }
    await collectDrops(bot, 3)
    // LIT ALCOVE: BEFORE sealing, if we carry a torch, widen ONE floor-level neighbour into a
    // torch alcove (probed for solidity + dryness) so the sealed box is LIT - no mob spawns
    // through a long night. Skipped on any probe fail / no torch (a sealed 1x1 needs no light).
    const feet = bot.entity.position.floored()
    const head = feet.offset(0, 1, 0)
    let alcoveCell = null
    if (countItem(bot, 'torch') > 0) { try { alcoveCell = await digTorchAlcove(bot, feet) } catch {} }
    // WALLS FIRST, THEN CAP (sealShaft) - the head ring gives the cap solid faces so it seals in
    // open-cave geometry, and the alcove cell is kept OPEN (not walled) for the torch.
    const { capped, sideHoles, capPos } = await sealShaft(bot, { feet, head, alcoveCell, rimY: surfaceY })
    // Light it: after sealing, the alcove is the sole open floor-level neighbour, so placeTorch
    // lands the torch there (not against some other still-open side).
    if (alcoveCell) { try { await placeTorch(bot) } catch {} }
    dbg('shelter: pit ' + (capped ? 'SEALED' : 'OPEN (cap failed - mob funnel risk)') + (sideHoles ? ' with ' + sideHoles + ' open side(s)' : '') + (alcoveCell ? ' (lit alcove)' : ''))
    // ==== AUDIT 2026-07-29 FIX 15: AN UNCAPPABLE PIT IS NOT A SHELTER =====================
    // Live, 15:39:24 -> 15:40:36, from nothing on the live server:
    //   shelter: cap attempt 1 failed - no solid neighbour to place against
    //   shelter: cap attempt 2 failed - no solid neighbour to place against
    //   shelter: deep-cap attempt failed - no solid neighbour to place against
    //   shelter: pit OPEN (cap failed - mob funnel risk)      <- the bot KNOWS
    //   (shelter) rested for the night (bed or pit)           <- and rests in it anyway
    //   (flee) low hp (1) ... (death) mob - Zombie            <- 72 seconds later
    // The observation was exactly right and changed nothing about the decision - the audit's
    // thesis in one incident. The relocate loop above only ever retried a failed DIG, so a spot
    // that digs fine but cannot be sealed was accepted as a shelter every time.
    //
    // A cell whose cap cannot be placed is now REMEMBERED and EXCLUDED, and the failure is
    // returned honestly so nightRest escalates to its next option (a real bed, another site)
    // instead of bedding down in a mob funnel. Scoped to this life via the world epoch: geometry
    // that could not be capped will not have changed by itself, but a fresh life re-tests it.
    if (!capped) {
      const here = { x: feet.x, y: feet.y, z: feet.z }
      if (!capFailedCells.some(c => c.x === here.x && c.y === here.y && c.z === here.z)) capFailedCells.push(here)
      while (capFailedCells.length > 24) capFailedCells.shift()
      dbg('shelter: this hole CANNOT be capped (' + capFailedCells.length + ' such cell(s) ruled out) - not calling it a shelter; handing back so a real one can be found')
      say('this hole won\'t close over - not sleeping in a mob funnel')
      return false
    }
    say('holed up till it\'s safe')
    // 3) wait until DAY and no hostile near, or a hard timeout (~one full night). An OPEN
    // pit is NOT a shelter - don't squat in a mob funnel for 10 minutes: short deadline,
    // and bail immediately if we're taking hits down there (fight/flee reflexes resume).
    const fullySealed = capped && !sideHoles
    if (fullySealed) { try { rememberInfra('shelter', bot.entity.position.floored()) } catch {} } // bunkers are reusable knowledge
    const deadline = Date.now() + (fullySealed ? 600000 : 120000)
    const hp0 = bot.health || 20
    // ==== AUDIT FIX 22, MADE STRUCTURAL (PLAN-one-runner S4) ==============================
    // THIS is what was killing the bot at night, and the chain is exact (live 19:20-19:24):
    //   19:20:22  shelter: pit SEALED                      <- correct: holed up till dawn
    //   19:21:07  (wd) NUDGE recoveryLadder - no verified progress for 45s
    //   19:21:52  (wd) FAIL-JOB recoveryLadder - 90s       <- stop latch set on the ladder
    //   19:22:57  (wd) scheduler tick chain stalled >90s - re-arming
    //   19:23:32  (watchdog) position FROZEN ~195s - forcing an escape
    //   19:23:32  recovery: stuck UNDERGROUND - climbing to the surface
    //   19:24:33  (death) explosion - Creeper
    // The bot did the right thing and the forward-progress watchdog dug it out into the dark to
    // be killed. FIX 22 answered it with a heartbeat inside the loop - which worked, and was
    // still the wrong shape: every hold had to REMEMBER to fake progress, this one had not for
    // its entire existence, and a heartbeat claims progress that never happened.
    // So the hold DECLARES itself instead, once, with the condition that releases it and its own
    // deadline as the TTL. Both watchdogs read reflexes.activeHold() and stand down - and they do
    // so no matter WHO called this (the standalone shelter, or the ladder rung that killed it).
    // The loop body is still the validity check: it re-reads night, hp, water and the seal every
    // pass and breaks on any of them, so declaring a hold cannot mask a real hang.
    const holdToken = reflexes.beginHold('nightShelter:pit', 'dawn|hostile-gone|damage|flooding', deadline - Date.now() + 5000)
    try {
    while (Date.now() < deadline && !isStopped()) {
      if ((!isNight(bot) && !nearHostile(bot, 10)) || nightStuck(bot)) break // stuck night: climb out and re-arm rather than wait forever
      if ((!fullySealed || DEFEND_WHEN_HIT_ON) && (bot.health || 20) < hp0 - 3) { dbg('shelter: taking damage in the ' + (fullySealed ? 'SEALED pit - breached' : 'LEAKY pit') + ' - bailing out to fight/flee'); break }
      // DROWNING BAIL: water reaching the body cells means the pit is flooding - get out
      // NOW, sealed or not (a "sealed" pit beside an aquifer drowned the bot at 4hp, live)
      if (inWaterNow(bot)) {
        dbg('shelter: pit is FLOODING - emergency exit')
        // remember the spot so the next shelter attempt digs somewhere DRY, and drop the
        // registered bunker here - re-entering a flooded pit is not shelter
        lastFlood = { x: bot.entity.position.x, z: bot.entity.position.z, at: Date.now() }
        try { const reg = recallInfra('shelter', bot.entity.position, 3); if (reg) forgetInfra('shelter', listInfra('shelter').find(e => e.x === reg.x && e.z === reg.z)) } catch {}
        break
      }
      await new Promise(r => setTimeout(r, 3000))
    }
    } finally { reflexes.endHold(holdToken); touchP('shelterHold:released') } // ONE honest stamp on the way out, so standing up again is not instantly "stale"
    // 4) break the cap and climb back to the surface. Use climbToSurface (staircase-up,
    //    which cuts steps and needs NO filler blocks) - pillarUpTo alone stranded the bot
    //    when it had no dirt left (deaths strip inventory), ratcheting it deeper each night.
    try {
      await breakOut(bot, { isStopped, surfaceY })
      // a FLOODED pit defeats the climb (its dig primitives refuse water) - swim out
      if (inWaterNow(bot)) await ensureAshore(bot, isStopped)
    } catch {}
    return true
  } finally { _sheltering = false; bot.clearControlStates && bot.clearControlStates() }
}

// ==== BREAK OUT: the ONE way out of my own pit (2026-08-27) ====================================
// Live 2026-08-27, 12:03-16:01: the bot sat sealed in its own bunker at 197,64,-179 for four hours -
// a 1x1 air pocket under two dirt courses and its own plank lid, hp 1, a creeper waiting outside.
// The chain: the re-used-bunker wait was not a declared hold, so the ladder cut it at 150s every
// night; a cut rung's exit tail runs with isStopped() already true, so it opened nothing; the next
// R5 sealPit re-sealed the lid; by day the planner refused every move (nav-profile.wildAllowedAt:
// no digging within 32b of own infra - and the bunker IS own infra) and returned noPath in 1ms;
// unstick called the pocket "terrain" and handed it back to the planner; the terminal action fired
// 1,000+ full resets that touched nothing. Nobody OWNED "i am sealed in". This does: the shelter
// sealed the pit, the shelter opens it - and navigate.unstick's 'sealed' rung calls it, so a body
// that finds itself sealed in on ANY path (not just the shelter's own dawn) has an owner.
//
// What it may dig: the column straight above its own head, and only cells that are natural terrain
// (canBreakNaturally - the anti-grief rule every other shelter dig obeys) or, within 3b of a
// REGISTERED own shelter, a cap-type block (CAP_RE: the lid / side-fill this module places from
// the pack). Nothing sideways, nothing below, never a liquid (an aquifer overhead = do not open it),
// never inside the bot's own house (that is a door problem, provision-hut's). Bounded to 8 cells.
// Then it climbs to the RIM THE DIG ITSELF FOUND - the y of the topmost lid cell it removed, a
// block that was really there - never an arithmetic "+4" (#111), and never a column read of its
// own now-open shaft (which would report the pit floor as the surface). pillarUpTo is asked with
// that rim as its hard stop; if the pack has no filler, the staircase cut is the fallback.
// Returns true when the feet ended at or above the rim.
// Does the pack hold a block the shelter would cap with - which is also the block a pillar climbs on.
function holdsCapMaterial (bot) { return (bot.inventory ? bot.inventory.items() : []).some(i => CAP_RE.test(i.name)) }

async function breakOut (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  if (!bot.entity || !bot.entity.position) return false
  if (insideOwnStructure(bot)) { dbg('shelter: break-out refused - inside my own structure; the way out is the door'); return false }
  // THE LID STAYS ON AT NIGHT. A sealed pit is the shelter's whole purpose; opening it in the dark
  // (a creeper was 3.7m outside, live) is the death the pit exists to prevent. The night wait
  // above owns "until dawn"; this only ever opens by day - or when the operator forces it (`die`).
  if (!opts.force && isNight(bot)) { dbg('shelter: break-out deferred - night: the lid stays on until dawn'); return false }
  const p0 = bot.entity.position.clone()
  const ownPit = (() => { try { return recallInfra('shelter', p0, 3) } catch { return null } })()
  const mayDig = (b) => {
    if (/water|lava/.test(b.name)) return false
    if (canBreakNaturally(b) || /_leaves$/.test(b.name)) return true // a canopy over the lid is not a build (live: refused birch_leaves at +4)
    return !!ownPit && CAP_RE.test(b.name)
  }
  const SIDES4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const solidAt = (c) => { const b = bot.blockAt(c); return !!b && !AIRISH(b.name) && b.boundingBox === 'block' }
  // the first solid cell over the head (a lid), or null = open sky
  const lidAbove = (feet) => { for (let k = 2; k <= 24; k++) { const c = feet.offset(0, k, 0); if (solidAt(c)) return c } return null }
  // the lowest level at/above the feet with a side opening - where the body can step OUT
  const openingY = (feet) => {
    for (let dy = 0; dy <= 12; dy++) {
      const y = feet.y + dy
      let walled = true
      for (const [dx, dz] of SIDES4) { const b = bot.blockAt(new Vec3(feet.x + dx, y, feet.z + dz)); if (!b || AIRISH(b.name)) { walled = false; break } }
      if (!walled) return y
    }
    return null
  }
  const climbTo = async (target) => {
    try { await provMining.pillarUpTo(bot, target, { isStopped, surfaceY: target, ignoreOpenSkyBreak: true }) } catch (e) { dbg('shelter: break-out pillar failed (' + e.message + ')') }
    if (bot.entity && Math.floor(bot.entity.position.y) < target && !isStopped()) { try { await provMining.digStaircaseUp(bot, target, { isStopped, escape: true, surfaceY: target }) } catch (e) { dbg('shelter: break-out staircase failed (' + e.message + ')') } }
  }
  dbg('shelter: break-out at ' + p0.floored() + (ownPit ? ' (my registered pit at ' + ownPit.x + ',' + ownPit.y + ',' + ownPit.z + ')' : ' (no registered pit within 3b - natural terrain only)') + (opts.force ? ' [forced]' : ''))
  let dug = 0
  // REACH-AWARE (2026-08-27): the arm reaches ~4 blocks. The first cut of this dug the column
  // "up to 8" from the floor and hit canDigBlock=false at +7 (out of reach), then guessed a rim.
  // Now: open what the arm reaches, climb, look again - bounded passes, every step a world read.
  for (let pass = 0; pass < 8 && !isStopped(); pass++) {
    const feet = bot.entity.position.floored()
    const lid = lidAbove(feet)
    if (lid && lid.y - feet.y <= 4) {
      const b = bot.blockAt(lid)
      if (!mayDig(b)) { dbg('shelter: break-out REFUSED at ' + lid + ' (' + b.name + ') - not natural terrain and not my own lid; not my block to cut'); return false }
      if (bot.canDigBlock && !bot.canDigBlock(b)) { dbg('shelter: break-out - canDigBlock=false for ' + b.name + ' at ' + lid); return false }
      const tool = toolForBlock(bot, b.name)
      if (tool) await bot.equip(tool, 'hand').catch(() => {})
      dbg('shelter: break-out - digging ' + b.name + ' at ' + lid)
      try { await bot.dig(b) } catch (e) { dbg('shelter: break-out dig failed at ' + lid + ' (' + e.message + ')'); return false }
      dug++
      continue
    }
    // no lid within reach: the next move is UP - to the rim if the sky is open, else to just under the lid
    const rim = openingY(feet)
    if (rim != null && rim === feet.y && !lid) break // standing at an opening under open sky: out
    const target = lid ? lid.y - 2 : rim
    if (target == null) { dbg('shelter: break-out - no side opening within 12 above ' + feet + ' and open sky - not climbing blind'); break }
    if (feet.y >= target) break
    dbg('shelter: break-out - climbing ' + feet.y + ' -> ' + target + (lid ? ' (to reach the lid at y' + lid.y + ')' : ' (the rim)'))
    await climbTo(target)
    if (!bot.entity || Math.floor(bot.entity.position.y) <= feet.y) { dbg('shelter: break-out - could not climb from ' + feet); break }
  }
  if (dug) { try { await collectDrops(bot, 3) } catch {} }
  const feetEnd = bot.entity ? bot.entity.position.floored() : null
  const out = !!feetEnd && openingY(feetEnd) === feetEnd.y && !lidAbove(feetEnd)
  dbg('shelter: break-out -> ' + (out ? 'OUT at ' : 'still in at ') + (feetEnd || '?') + ' (dug ' + dug + ')')
  return out
}

// #63 SUICIDE_DIES §A (PURE, unit-tested): given a list of candidate cells each already world-
// sampled + tagged { solidCeiling, standable }, return the FIRST that is genuine OPEN SKY and
// stand-able (!solidCeiling && standable), else null. The suicide-reset uses this to choose where
// to walk before pillaring for the lethal fall. Pure -> testable without a live bot.
function pickOpenSkyCell (cells) {
  if (!Array.isArray(cells)) return null
  for (const c of cells) { if (c && !c.solidCeiling && c.standable) return c }
  return null
}

module.exports = {
  setDebugSink, setBuildZone, inBuildZone,
  // `_sheltering` IS NOT EXPORTED, AND MUST NOT BE. It is a `let`, so putting it in this object
  // literal exports its VALUE - a snapshot of `false` taken once, at require time. provision-recovery
  // destructured that snapshot and then owned a dead variable that could never change and could never
  // be cleared, while believing it held the live latch. Ask isSheltering(); clear releaseShelterLatch().
  DEFEND_WHEN_HIT_ON, isSheltering, releaseShelterLatch, shelterSite, SHELTER_FARM_R, shelterFarmConflict, inWaterNow, ensureAshore, findDiggableDryCell, scoutForWater, armorPieceCount, underArmored, lowHpCalm, shelterNeeded, nightStuck, nightRestWanted, sealShaft, digInForNight, breakOut, holdsCapMaterial, pickOpenSkyCell
}
