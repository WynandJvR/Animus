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
const navigate = require('./navigate.js')
const provCore = require('./provision-core.js')
const { AIRISH, REPLACEABLE, canBreakNaturally, countItem, inventoryCounts, toolForBlock,
  gotoWithTimeout, collectDrops, stepInto, placeAt, nearHostile, isNight, SHELTER_HOSTILE } = provCore
const worldMemory = require('./world-memory.js')
const { loadWorldMem, saveWorldMem, listInfra, rememberInfra, recallInfra, forgetInfra, knownBed } = worldMemory
const provHut = require('./provision-hut.js')
const { hutAnchor, insideOwnStructure, hasSolidCeiling, ownHutAt, onHutApron } = provHut
const provMining = require('./provision-mining.js')
const { mineDanger, ensureTorches, placeTorch, climbToSurface } = provMining

const P = () => require('./provision.js')
const S = () => require('./provision.js').__siblings

// Mirrored from provision.js via setBuildZone (see the header note).
let buildZone = null
function setBuildZone (box) { buildZone = box || null }
function inBuildZone (x, z) { return !!buildZone && x >= buildZone.x1 && x <= buildZone.x2 && z >= buildZone.z1 && z <= buildZone.z2 }

let dbgSink = null
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[prov] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

const DEFEND_WHEN_HIT_ON = process.env.DEFEND_WHEN_HIT !== '0'

const NIGHT_FROZEN_MS = parseInt(process.env.NIGHT_STUCK_MS || '90000', 10) // tod pinned this long at night = dawn isn't coming

const NIGHT_OVERLONG_MS = 900000 // ...or one continuous night runs 15 min (a normal night's dark is ~8-9 min; backstop for a non-frozen but stuck/very-laggy night)

let _nightStart = 0 // start of the current unbroken night

let _todSeen = { tod: null, at: 0 } // last time timeOfDay changed meaningfully

let lastFlood = null // {x, z, at}

let _sheltering = false

function isSheltering () { return _sheltering }

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

async function findDiggableDryCell (bot, opts = {}) {
  const radius = opts.radius || 24
  if (!bot.entity) return null
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

function shelterNeeded (bot) { return !!(bot.time && bot.time.timeOfDay >= 12200 && bot.time.timeOfDay < 23500) && underArmored(bot) }

function nightStuck (bot) {
  if (!bot || !bot.time) return false
  const now = Date.now()
  const tod = bot.time.timeOfDay
  if (_todSeen.tod == null || Math.abs(tod - _todSeen.tod) > 30) _todSeen = { tod, at: now } // ~1.5s of ticks; frozen tod never refreshes this
  if (!isNight(bot)) { _nightStart = 0; return false }
  if (!_nightStart) _nightStart = now
  return (now - _todSeen.at) > NIGHT_FROZEN_MS || (now - _nightStart) > NIGHT_OVERLONG_MS
}

function nightRestWanted (bot) {
  if (shelterNeeded(bot)) return true
  if (!isNight(bot) || !bot.entity) return false
  if ((bot.health ?? 20) <= 8) return true // critically hurt at night: rest, armored or not (died at 1hp hunting in the dark)
  const bed = knownBed()
  return !!bed && Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 100 // must COVER THE BUILD SITE: it died working the castle at night, 66 blocks from bed, 2 past the old radius
}

async function sealShaft (bot, interior = {}) {
  const CAP_RE = /terracotta|dirt|cobble|stone|gravel|sand|netherrack|deepslate|tuff|granite|diorite|andesite|clay|mud|_planks$|_log$|_concrete/
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
    if (below && !AIRISH(below.name) && !/lava|water/.test(below.name) && canBreakNaturally(below) &&
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
            await nav.navigateTo(bot, new goals.GoalNear(hutNear.x + 2, hutNear.y + 1, hutNear.z + 2, 1), { timeoutMs: 20000, deadlineMs: 45000, isStopped, climb: false, budgets: { door: 2, pit: 0, water: 1, nudge: 1 }, label: 'shelter-home' })
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
      while (Date.now() < dl && !isStopped()) {
        // hold through the DUSK HEAD-START too (shelterNeeded fires at 12200, isNight at
        // 13000): breaking on "!isNight" alone made this return success instantly at dusk,
        // so the 5s reflex re-entered forever - the "waiting out the night" log spam (live)
        if ((!shelterNeeded(bot) && !isNight(bot) && !nearHostile(bot, 10)) || nightStuck(bot)) break // stuck night: stop waiting for a dawn that won't come
        if ((bot.health || 20) < hpIn - 3) { dbg('shelter: taking damage INSIDE the hut - releasing shelter to FIGHT'); hurtInside = true; break }
        if (inWaterNow(bot)) { dbg('shelter: hut interior flooding - bailing'); hurtInside = true; break }
        await new Promise(r => setTimeout(r, 3000))
      }
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
      try { await gotoWithTimeout(bot, new goals.GoalBlock(oldPit.x, oldPit.y, oldPit.z), 15000) } catch {}
      const here = bot.entity.position.floored()
      if (Math.abs(here.x - oldPit.x) <= 1 && Math.abs(here.z - oldPit.z) <= 1 && here.y <= oldPit.y + 1) {
        // we're in the old hole - RE-SEAL it (walls too, not just the lid: a reused pit can have
        // caved-in / re-opened sides), light a torch alcove if we carry one, then wait the night.
        const feet0 = bot.entity.position.floored()
        const head0 = feet0.offset(0, 1, 0)
        let alcove0 = null
        if (countItem(bot, 'torch') > 0) { try { alcove0 = await digTorchAlcove(bot, feet0) } catch {} }
        const seal0 = await sealShaft(bot, { feet: feet0, head: head0, alcoveCell: alcove0 })
        if (alcove0) { try { await placeTorch(bot) } catch {} }
        const capPos0 = seal0.capPos
        const recapped = seal0.capped && !seal0.sideHoles
        dbg('shelter: bunker re-entered, ' + (recapped ? 'RE-SEALED' : 'OPEN (leaky)') + (seal0.sideHoles ? ' ' + seal0.sideHoles + ' side(s)' : ''))
        say(recapped ? 'back in my bunker for the night' : 'in my bunker (lid open)')
        const dl = Date.now() + (recapped ? 600000 : 120000)
        const hpX = bot.health || 20
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
        try {
          const cap = bot.blockAt(capPos0)
          if (cap && !AIRISH(cap.name) && (!bot.canDigBlock || bot.canDigBlock(cap))) { try { await bot.dig(cap) } catch {} }
          await collectDrops(bot, 3)
          await climbToSurface(bot, Math.floor(bot.entity.position.y) + 4, { isStopped })
        } catch {}
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
      for (let i = 0; i < 2 && !isStopped(); i++) {
        const feet = bot.entity.position.floored()
        const below = bot.blockAt(feet.offset(0, -1, 0))
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
        const dry = await findDiggableDryCell(bot, { radius: 20 + attempt * 12 })
        if (!dry) { dbg('shelter: no diggable dry ground within reach - cannot pit'); break }
        dbg('shelter: cannot dig here (water/obstruction) - relocating to diggable dry ground at ' + dry.toString() + ' (try ' + (attempt + 1) + '/' + RELOCATE_TRIES + ')')
        if (opts.say && attempt === 0) opts.say('ground here is too wet to dig into - moving to dry ground to shelter')
        try { await gotoWithTimeout(bot, new goals.GoalBlock(dry.x, dry.y, dry.z), 20000) } catch (e) { dbg('shelter: relocate walk failed (' + e.message + ')') }
        if (inWaterNow(bot)) { try { await ensureAshore(bot, isStopped) } catch {} }
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
    const { capped, sideHoles, capPos } = await sealShaft(bot, { feet, head, alcoveCell })
    // Light it: after sealing, the alcove is the sole open floor-level neighbour, so placeTorch
    // lands the torch there (not against some other still-open side).
    if (alcoveCell) { try { await placeTorch(bot) } catch {} }
    dbg('shelter: pit ' + (capped ? 'SEALED' : 'OPEN (cap failed - mob funnel risk)') + (sideHoles ? ' with ' + sideHoles + ' open side(s)' : '') + (alcoveCell ? ' (lit alcove)' : ''))
    say(capped ? 'holed up till it\'s safe' : 'ducked into a hole till it\'s safe')
    // 3) wait until DAY and no hostile near, or a hard timeout (~one full night). An OPEN
    // pit is NOT a shelter - don't squat in a mob funnel for 10 minutes: short deadline,
    // and bail immediately if we're taking hits down there (fight/flee reflexes resume).
    const fullySealed = capped && !sideHoles
    if (fullySealed) { try { rememberInfra('shelter', bot.entity.position.floored()) } catch {} } // bunkers are reusable knowledge
    const deadline = Date.now() + (fullySealed ? 600000 : 120000)
    const hp0 = bot.health || 20
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
    // 4) break the cap and climb back to the surface. Use climbToSurface (staircase-up,
    //    which cuts steps and needs NO filler blocks) - pillarUpTo alone stranded the bot
    //    when it had no dirt left (deaths strip inventory), ratcheting it deeper each night.
    try {
      const cap = bot.blockAt(capPos)
      if (cap && !AIRISH(cap.name) && (!bot.canDigBlock || bot.canDigBlock(cap))) { try { await bot.dig(cap) } catch {} }
      await collectDrops(bot, 3) // recover the cap block as filler
      await climbToSurface(bot, surfaceY, { isStopped })
      // a FLOODED pit defeats climbToSurface (its dig primitives refuse water) - swim out
      if (inWaterNow(bot)) await ensureAshore(bot, isStopped)
    } catch {}
    return true
  } finally { _sheltering = false; bot.clearControlStates && bot.clearControlStates() }
}

function pickOpenSkyCell (cells) {
  if (!Array.isArray(cells)) return null
  for (const c of cells) { if (c && !c.solidCeiling && c.standable) return c }
  return null
}

module.exports = {
  setDebugSink, setBuildZone, inBuildZone,
  DEFEND_WHEN_HIT_ON, NIGHT_FROZEN_MS, NIGHT_OVERLONG_MS, _nightStart, _todSeen, lastFlood, _sheltering, isSheltering, shelterSite, SHELTER_FARM_R, shelterFarmConflict, inWaterNow, ensureAshore, nearRecentFlood, findDiggableDryCell, scoutForWater, armorPieceCount, underArmored, lowHpCalm, shelterNeeded, nightStuck, nightRestWanted, sealShaft, digTorchAlcove, digInForNight, pickOpenSkyCell
}
