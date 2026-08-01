'use strict'
// PATCH LAYER over mineflayer-pathfinder (same durable pattern as installDigTimeGuard:
// we override behavior at runtime instead of forking, so npm installs never undo it and
// upstream fixes still arrive). Each patch targets a failure we watched live.
//
// PATCH 1 - never break your own fresh scaffold. The planner re-plans mid-move and treats
// the block the bot JUST placed as an obstacle: pillar up, break own dirt, pillar again
// (operator watched the full loop). Blocks self-placed in the last 60s are off-limits to
// the planner's dig moves - it walks around/on them like anyone sane.

const RECENT_MS = 60000  // dig-guard window (the planner may not break these)
const TRAIL_MS = 1800000 // trail window - 30 min (5 min expired before slow harvests finished; towers orphaned)
const recentlyPlaced = new Map() // "x,y,z" -> timestamp

// PERSIST the trail: it lived only in memory, so every death-restart/deploy orphaned
// whatever towers stood at that moment - the operator found COBBLE scaffolds abandoned
// in the orchard after a restart-heavy morning. Loaded on boot, saved debounced.
const fs = require('fs')
const path = require('path')
const TRAIL_FILE = process.env.TRAIL_FILE || path.join(__dirname, 'scaffold-trail.json')
try {
  const saved = JSON.parse(fs.readFileSync(TRAIL_FILE, 'utf8'))
  const cut = Date.now() - TRAIL_MS
  for (const [k, t] of Object.entries(saved)) { if (t >= cut) recentlyPlaced.set(k, t) }
} catch {}
let trailTimer = null
function saveTrail () {
  if (trailTimer) return
  trailTimer = setTimeout(() => {
    trailTimer = null
    try { fs.writeFileSync(TRAIL_FILE, JSON.stringify(Object.fromEntries(recentlyPlaced))) } catch {}
  }, 2000)
}

function key (p) { return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` }

let dbgSink = null // injected by index.js: debug lines persist to logs/bot-events.log
function setDebugSink (fn) { dbgSink = fn }
let progressSink = null // S7 H3: injected by index.js (commands.touchProgress) - fired ONLY on a VERIFIED place/break transition
function setProgressSink (fn) { progressSink = fn }
const dbg = (...a) => {
  const line = '[verify] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

// ---- UNIVERSAL PLACE/BREAK VERIFICATION --------------------------------------------
// On Paper a place/break is not "done" until the world says so: the server often never
// echoes the blockUpdate for a SUCCESSFUL placement (phantom failures -> over-fill: a
// threshold-fill stacked dirt to head height and walled its own door), and mineflayer
// zeroes a dug cell LOCALLY when the dig timer elapses, so an instant post-dig read
// reflects our own guess, not the server. These two polling primitives are the ONE way
// to decide success, and the wrappers below make them mandatory for every
// placeBlock/_placeBlockWithOptions/dig call in the codebase.
const AIR_RE = /^(air|cave_air|void_air)$/

// Did a block LAND at pos? Polls the world (Paper echo can lag). opts.before = the
// cell's stateId snapshot from before the placement - required to catch a "place" into
// a replaceable cell (tall grass) that silently failed: non-air alone would false-pass.
async function placedOK (bot, pos, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs != null ? opts.timeoutMs : 900)
  for (;;) {
    try {
      const b = bot.blockAt(pos)
      if (b && !AIR_RE.test(b.name) && (opts.before == null || b.stateId !== opts.before)) {
        // S7 H3: fire ONLY when a stateId CHANGE was proven (opts.before given). A bare non-air read
        // without the before-snapshot could be a pre-existing block - never a verified placement.
        if (progressSink && opts.before != null) progressSink('placed')
        return true
      }
    } catch {}
    if (Date.now() >= deadline) return false
    await new Promise(r => setTimeout(r, 120))
  }
}

// Is the cell at pos actually GONE (airish)? Polls, for symmetry with placedOK. Note
// the local-zeroing caveat above: right after bot.dig resolves this reads our own
// optimistic write - pass a timeoutMs of ~700+ and call it later when it matters.
async function brokeOK (bot, pos, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs != null ? opts.timeoutMs : 900)
  let sawSolid = false // S7 H3: did we ever observe a non-air block here? only a non-air->air TRANSITION is progress
  for (;;) {
    try {
      const b = bot.blockAt(pos)
      if (b && !AIR_RE.test(b.name)) sawSolid = true
      if (!b || AIR_RE.test(b.name)) {
        // fire ONLY on an observed transition inside this call. An already-air cell (a re-verify, a
        // spinning dig loop polling the same hole) proves nothing and must NOT touch.
        if (progressSink && sawSolid) progressSink('broke')
        return true
      }
    } catch {}
    if (Date.now() >= deadline) return false
    await new Promise(r => setTimeout(r, 120))
  }
}

function sweep () {
  const cut = Date.now() - TRAIL_MS
  for (const [k, t] of recentlyPlaced) { if (t < cut) recentlyPlaced.delete(k) }
  saveTrail()
}

// ---- GROUNDED WORLD READS ------------------------------------------------------------
// THE one honest block read. mineflayer returns null both for "there is nothing there"
// and for "I have never been sent that chunk" - and the codebase has been reading the
// second as the first for months. A null is NOT information; it is the absence of it.
// { known:false } is a THIRD state and callers must refuse to decide on it, never guess.
function readCell (bot, pos) {
  let b = null
  try {
    const { Vec3 } = require('vec3')
    b = bot.blockAt(pos && pos.offset ? pos : new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)))
  } catch { b = null }
  if (!b || !b.name) return { known: false, block: null }
  return { known: true, block: b }
}

// Canopy and clutter are not ground. A leaf block has a 'block' bounding box but standing
// "on the surface" never means standing in a treetop, and the climb-out must not aim at one.
const NOT_GROUND_RE = /_leaves$|^(vine|glow_lichen|scaffolding|bamboo|cave_vines|cave_vines_plant|weeping_vines|twisting_vines)/

function isGroundBlock (block) {
  if (!block || !block.name) return false
  if (AIR_RE.test(block.name)) return false
  if (NOT_GROUND_RE.test(block.name)) return false
  return block.boundingBox === 'block' // plants, water, lava, torches, snow layers: not a floor
}

// GROUNDED SURFACE LOCATOR (#111). Scans the column (x,z) top-down and returns the cell a
// player would STAND IN on the surface: `y` = one above the topmost ground block,
// `groundY` = that block. There is no arithmetic guess anywhere in it - it reads the world.
//
// This replaces `bot.entity.position.y + 10`, a number that was named for a surface it never
// located: it re-fired every time the bot got stuck ten blocks higher, so ONE burial produced
// a ladder of hops (live 16:44-16:47: y45 -> 55 -> 65 -> 75 over ground standing at y70-72)
// and left a 1x1 cobble tower several blocks into open sky.
//
// UNKNOWN handling (the point of the exercise): unknown cells at the TOP of the scan are
// tolerated - they only mean the scan started above this world's build height - but once a
// real cell has been read, any later unknown makes the whole answer UNKNOWN, and a column
// with NO readable cell at all (an unloaded chunk) is UNKNOWN. Never a guess. Callers refuse.
function surfaceYAt (bot, x, z, opts = {}) {
  const X = Math.floor(x); const Z = Math.floor(z)
  const UNKNOWN = { known: false, y: null, groundY: null }
  let topY = opts.maxY
  let botY = opts.minY
  try {
    if (topY == null && bot.game && Number.isFinite(bot.game.minY) && Number.isFinite(bot.game.height)) topY = bot.game.minY + bot.game.height - 1
    if (botY == null && bot.game && Number.isFinite(bot.game.minY)) botY = bot.game.minY
  } catch {}
  if (topY == null) topY = 319
  if (botY == null) botY = -64
  let sawKnown = false
  for (let y = topY; y >= botY; y--) {
    const r = readCell(bot, { x: X, y, z: Z })
    if (!r.known) {
      if (sawKnown) return UNKNOWN // a hole in a column we were reading: fail closed
      continue                      // still above the world's ceiling - not yet data
    }
    sawKnown = true
    // ==== AUDIT 2026-07-29 FIX 8: OUR OWN LITTER IS NOT TERRAIN ==========================
    // The mining descent asserted `INVARIANT VIOLATION - open sky at yN but the target claims a
    // surface at yM` ten times in one session. The assertion was right and the target was wrong,
    // and this is where the wrong target came from: this scan walks a column DOWNWARD and takes
    // the first solid block as the surface - including a block the bot itself left floating in
    // the air. With 336 unpaid scaffold cells standing (155 of them 1x1 pathfinder towers), the
    // bot's own abandoned litter reads as ground, so "the surface" lands metres above the real
    // one and every climb aimed at it overshoots into open sky.
    //
    // So the scaffold registry is not just a tidiness ledger - it is the only thing that can tell
    // the terrain model which solid blocks are the world's and which are the bot's own mess.
    // Skipping registered scaffold makes this scan describe the WORLD. (FIX 6 attacks the same
    // problem from the other end by not leaving the towers there in the first place.)
    if (isGroundBlock(r.block)) {
      let ours = false
      try { ours = !!require('./scaffold.js').isScaffold({ x: X, y, z: Z }) } catch {}
      if (ours) continue // our own tower/bridge - keep looking for real ground beneath it
      return { known: true, y: y + 1, groundY: y }
    }
  }
  return UNKNOWN // unloaded column, or nothing solid in it at all
}

// ---- THE GROUNDED CLAIM CONTRACT (#115) ----------------------------------------------
// pathfix has enforced "the world re-read is the ONLY arbiter" for place/dig/window since
// 9fdc4ce - but only for those three PRIMITIVES. Arrival, occupancy, survey and recovery
// were left on the honour system and every one of them lied on the live tape:
//   - a grave 18 blocks STRAIGHT DOWN read as "7.6 blocks away, I'm here" (XZ-only hypot)
//   - a hut survey taken 200b away from an unloaded chunk read as PERFECT (`if (!g) continue`)
//   - "grave still present: false" was concluded from an entity scan taken at the wrong place
//   - "ashore, out of the water" was logged 1.7s AFTER the death that ended the episode
// The contract below scopes verification to CLAIMS instead of to primitives. Three parts,
// one per way the old code lied: a survey that can say UNKNOWN, an arrival that re-reads
// the body, and an epoch that makes a claim belong to the life it was made in.

// SURVEY WITH A THIRD STATE. `cells` is [{ pos, want }]; classify(want, got) -> true when
// the cell is WRONG. A survey that cannot see its subject REFUSES TO DECIDE: one unknown
// cell makes the whole verdict 'UNKNOWN' and the bad/solid counts PARTIAL. Callers must
// branch on verdict, never on bad===0 (that is precisely the `if (!g) continue` bug: an
// absent hut counted as zero damage and a hut nobody could see verified as perfect).
// Cheap by construction: one readCell per cell, no retries, no waiting, no world scan.
function surveyCells (bot, cells, classify) {
  let bad = 0; let solid = 0; let unknown = 0
  const isAir = n => /^(air|cave_air|void_air)$/.test(n)
  for (const c of (cells || [])) {
    const want = (c && c.want) || 'air'
    if (!isAir(want)) solid++
    const r = readCell(bot, c.pos)
    if (!r.known) { unknown++; continue }
    if (classify(want, r.block.name)) bad++
  }
  const total = (cells || []).length
  const verdict = unknown > 0 ? 'UNKNOWN' : (bad > 0 ? 'BAD' : 'OK')
  return { verdict, bad, solid, unknown, total, partial: unknown > 0 }
}

// GROUNDED ARRIVAL. "Did I get there" is answered by the goal's own isEnd against a
// RE-READ of the body's feet - never by a travel helper's return value, never by an XZ
// hypot that cannot see the 18 blocks of stone between the bot and its grave.
function arrivedOK (bot, goal) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (!p) return false
    if (goal && typeof goal.isEnd === 'function') return !!goal.isEnd(p.floored())
    // plain {x,y,z[,range]} target: 3D distance, Y INCLUDED (this is the whole point)
    if (!goal || goal.x == null) return false
    const r = goal.range != null ? goal.range : 3
    return Math.sqrt((goal.x - p.x) ** 2 + ((goal.y != null ? goal.y : p.y) - p.y) ** 2 + (goal.z - p.z) ** 2) <= r
  } catch { return false }
}

// LIFE EPOCH. Death resets the world's opinion of where the bot is, so every observation
// taken before it is void. An async flow that spans awaits captures epoch() at entry and
// treats a change as invalidation - that is the ONLY thing that would have stopped the
// drown guard logging "ashore" from the respawn point 137 blocks away.
let _epoch = 1
function epoch () { return _epoch }
function sameEpoch (e) { return e === _epoch }
function bumpEpoch () { _epoch++; return _epoch }

// Point query: was THIS cell self-placed recently? The replant reflex was planting
// saplings on the bot's own scaffold dirt (operator caught it live) - scaffold is
// temporary by definition, nothing should treat it as real ground.
function isSelfPlaced (pos, maxAgeMs) {
  const t = recentlyPlaced.get(key(pos))
  return !!t && t >= Date.now() - (maxAgeMs || TRAIL_MS)
}

// Self-placed blocks near a point (for scaffold teardown after tall-tree harvests -
// the operator found dirt towers abandoned all over the forest).
function selfPlacedNear (pos, r, maxAgeMs) {
  const out = []
  const cut = Date.now() - (maxAgeMs || TRAIL_MS)
  for (const [k, t] of recentlyPlaced) {
    if (t < cut) continue
    const [x, y, z] = k.split(',').map(Number)
    if (Math.hypot(x - pos.x, z - pos.z) <= r) out.push({ x, y, z, t })
  }
  return out
}

function installPathfinderTuning (bot) {
  if (!bot.__pathfixInstalled) {
    bot.__pathfixInstalled = true
    // #115: the life epoch. Every claim made before this fires belongs to a bot that no
    // longer exists at that position, holding that inventory, in that chunk.
    try { bot.on('death', () => { bumpEpoch() }) } catch {}
    // Wrap the ONE placement primitive - bot._placeBlockWithOptions - and rebuild
    // bot.placeBlock on top of it. (placeBlock is a closure over the lib-internal
    // function, so wrapping placeBlock alone missed buildSurvival's tryPlace, which
    // calls _placeBlockWithOptions directly - the verifier must catch BOTH.)
    // Three patches ride on it:
    //  1. record self-placed cells (feeds the scaffold guard below)
    //  2. TOWER TIMING: when placing the block under our own feet (1x1 tower), wait for
    //     the jump APEX before sending - the lib fires at arbitrary jump phases and the
    //     server rejects the mistimed ones, which is the bunny-hop spam the operator
    //     watched ("jumps for a few seconds before it places one block")
    //  3. GROUNDED SUCCESS: the world re-read (placedOK) is the ONLY arbiter. The lib's
    //     blockUpdate-timeout and "No block has been placed" both fall through to it -
    //     Paper phantom failures resolve as the successes they are, and a place that
    //     genuinely didn't land throws an honest error instead of trusting the ack.
    const origPBWO = bot._placeBlockWithOptions.bind(bot)
    async function verifiedPlace (referenceBlock, faceVector, options) {
      const target = referenceBlock.position.plus(faceVector)
      let before = null
      try { const b0 = bot.blockAt(target); before = b0 ? b0.stateId : null } catch {}
      try {
        const feet = bot.entity.position.floored()
        if (faceVector.y === 1 && target.x === feet.x && target.z === feet.z && target.y === feet.y) {
          const t0 = Date.now()
          while (Date.now() - t0 < 700 && (bot.entity.position.y - feet.y) < 0.95) await new Promise(r => setTimeout(r, 20))
        }
      } catch {}
      try {
        await origPBWO(referenceBlock, faceVector, options)
      } catch (e) {
        // real errors (not holding an item, no face, too far) stay errors; only the
        // echo-shaped ones are re-judged against the world below
        if (!/blockUpdate|No block has been placed/i.test(e.message || '')) throw e
      }
      if (await placedOK(bot, target, { timeoutMs: 1200, before })) {
        try { recentlyPlaced.set(key(target), Date.now()); saveTrail(); if (recentlyPlaced.size > 256) sweep() } catch {}
        try { require('./scaffold.js').onPlaced(target) } catch {} // files it as scaffold IF a movement session is open
        return
      }
      throw new Error(`place did not land at ${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)} (world re-read)`)
    }
    bot._placeBlockWithOptions = verifiedPlace
    bot.placeBlock = (referenceBlock, faceVector) => verifiedPlace(referenceBlock, faceVector, { swingArm: 'right' })

    // SETTLE ON ARRIVAL (nav slice C - flat-ground overshoot/bunny-hop): the pathfinder
    // leaves control states (forward/sprint/jump) SET when a goal resolves, so on latency the
    // bot slides PAST the target and re-paths, or keeps hopping a beat after arriving (the
    // flat-ground bunny-hop the operator watched). Clearing controls the moment a goal is
    // reached (or a path ends with no path / timeout) damps the slide - it stops ON the
    // target instead of overshooting. Cheap, and it only fires at path boundaries. PATHFIX_SETTLE=0 off.
    if (process.env.PATHFIX_SETTLE !== '0' && !bot.__pathfixSettle) {
      bot.__pathfixSettle = true
      const settle = (why) => { try { bot.clearControlStates() } catch {} ; dbg('settle: cleared control states on ' + why) }
      bot.on('goal_reached', () => settle('goal_reached'))
      bot.on('path_update', (r) => { if (r && (r.status === 'noPath' || r.status === 'timeout')) settle('path ' + r.status) })
    }

    // DIG VERIFICATION, same philosophy, different physics: mineflayer zeroes the cell
    // locally when the dig timer elapses, so (a) a dig ERROR with the block actually
    // gone is a phantom - swallow it; (b) a synchronous confirm would read our own
    // optimistic write, and stalling every gather-dig ~700ms is unaffordable - so watch
    // asynchronously for the server's CORRECTION and put it in the flight recorder:
    // "which breaks did the server reject" was previously invisible, and grounded
    // loops (buildSurvival passes, clear/fill re-reads) pick the truth up from there.
    const origDig = bot.dig.bind(bot)
    bot.dig = async function (block, ...rest) {
      const pos = block && block.position && block.position.clone ? block.position.clone() : (block && block.position)
      try {
        await origDig(block, ...rest)
      } catch (e) {
        if (!pos) throw e
        await new Promise(r => setTimeout(r, 150))
        if (await brokeOK(bot, pos, { timeoutMs: 0 })) return // it broke - phantom failure
        throw e
      }
      if (pos) {
        setTimeout(() => {
          try {
            const b = bot.blockAt(pos)
            if (b && !AIR_RE.test(b.name)) {
              dbg('dig at ' + pos.x + ',' + pos.y + ',' + pos.z + ' REJECTED by the server (block back: ' + b.name + ')')
              // ==== AUDIT 2026-07-29 FIX 14: A FLOODING TUNNEL IS A SIGNAL, NOT A LOG LINE ====
              // Live, 15:10:33-35: three consecutive digs came back `block back: water` - the bot
              // had breached an aquifer and was flooding its own tunnel. It kept digging, went
              // under at :35 and drowned at :59. This verification SAW it three times and told
              // nobody: the observation lived and died inside a setTimeout that only logs.
              // Recording it lets the existing break-out authority (provision.mineDanger, which
              // already yanks the bot out of a committed dig on low hp or a near hostile) treat
              // "the hole I am in is filling with water" as what it plainly is - a reason to stop
              // digging and get out. Grounded verification must produce an action.
              if (/water|bubble_column/.test(b.name)) floodHits.push(Date.now())
              else floodHits.length = 0 // a non-water rejection means we are not flooding
              while (floodHits.length > 8) floodHits.shift()
            } else floodHits.length = 0 // a clean break: whatever was flooding has stopped
          } catch {}
        }, 700)
      }
    }

    // WINDOW-OPEN VERIFICATION (same disease, container flavor): the lib's openBlock /
    // openEntity fire activateBlock/Entity then await 'windowOpen' with NO TIMEOUT - a
    // lost or rejected open (mob hit mid-open, lag, reach edge) hangs the caller
    // FOREVER. Every chest count / withdraw / deposit / furnace open / grave GUI
    // funnels through these two. Deadline + one clean retry + an honest error replace
    // the scattered per-caller timeout hacks (openFurnace retry, grave "won't open").
    //
    // REACH DISAMBIGUATION (live overnight: half the "window did not open" failures were
    // gotos that never arrived - the interact was sent from 8+ blocks out and the server
    // rightly ignored it): out of reach is a NAV problem, not a container problem. Close
    // the gap first; if we still can't get within reach, throw an error that SAYS
    // "cannot reach" so callers (dead-chest tracking, grave recovery) can act on the
    // difference. A true from-in-reach window failure gets a look-at + a longer second
    // deadline (lag), then an honest window error.
    for (const fname of ['openBlock', 'openEntity']) {
      const orig = bot[fname].bind(bot)
      bot[fname] = async function (target, ...rest) {
        const tpos = target && target.position
        const distTo = () => {
          try { return tpos ? bot.entity.position.distanceTo(tpos.clone ? tpos.clone().offset(0.5, 0.5, 0.5) : tpos) : null } catch { return null }
        }
        for (let attempt = 0; ; attempt++) {
          // OWN-HUT DOOR: an interior container (bank/furnace) is UNPLANNABLE through a closed
          // door, so both the reach-close goto below and the LOS face-walk time out at the wall.
          // If the target sits in our own hut and we're outside, cross the doorway first with the
          // mutex-free crossing core - then both approaches become plannable. Best-effort.
          if (attempt === 0 && tpos) {
            try {
              const prov = require('./provision.js'); const nav = require('./navigate.js')
              const hut = prov.ownHutAt && prov.ownHutAt(tpos)
              if (hut && !(prov.insideOwnStructure && prov.insideOwnStructure(bot)) && nav.crossOwnDoor) await nav.crossOwnDoor(bot, hut, 'in', {})
            } catch (e) { dbg(fname + ': own-hut door pre-flight skipped (' + e.message + ')') }
          }
          let d = distTo()
          if (d != null && d > 4.5) {
            // too far for the server to accept the interact - close the gap first
            try {
              const { goals } = require('mineflayer-pathfinder')
              await require('./navigate.js').gotoOnce(bot, new goals.GoalNear(Math.floor(tpos.x), Math.floor(tpos.y), Math.floor(tpos.z), 2), 12000)
            } catch {}
            d = distTo()
            if (d != null && d > 5) throw new Error(fname + ': cannot reach the container (' + d.toFixed(1) + 'b away after approach) - unreachable, not a window failure')
          }
          // NO-REACH-THROUGH-WALLS (item 4): within reach can still be THROUGH A WALL (a chest
          // inside, bot outside, 3 blocks away). A real player walks to a face they can SEE.
          // If the straight line from the eye to the block is blocked by a solid non-target
          // cell, walk to an adjacent, LOS-clear face cell before interacting. Bounded; if none
          // is reachable, fall through and try anyway (better than hanging).
          if (process.env.STATION_LOS !== '0' && tpos && attempt === 0) {
            try {
              const los = require('./los.js')
              const tgt = { x: Math.floor(tpos.x), y: Math.floor(tpos.y), z: Math.floor(tpos.z) }
              const isSolid = (x, y, z) => { if (x === tgt.x && y === tgt.y && z === tgt.z) return false; const b = bot.blockAt(new (require('vec3').Vec3)(x, y, z)); return !!(b && b.boundingBox === 'block' && !AIR_RE.test(b.name)) }
              const eye = bot.entity.position.offset(0, bot.entity.height || 1.62, 0)
              // #88 CHEST_STEP_OFF (default on): STANDING ON the container defeats the open with
              // clear LOS (live: 5x 'window did not open, in reach 1.1b' from on top of the bank
              // double-chest -> the chest got deregistered + the resource model went stale-blind
              // and planned wood gathers for a hoe the bank held). Same face-walk as the wall case.
              const standingOn = process.env.CHEST_STEP_OFF !== '0' &&
                Math.floor(bot.entity.position.x) === tgt.x && Math.floor(bot.entity.position.z) === tgt.z &&
                bot.entity.position.y > tgt.y
              if (standingOn || los.lineBlocked(eye, { x: tgt.x + 0.5, y: tgt.y + 0.5, z: tgt.z + 0.5 }, isSolid)) {
                dbg(fname + ': ' + (standingOn ? 'standing ON ' : 'a wall is between me and ') + tgt.x + ',' + tgt.y + ',' + tgt.z + ' - walking to a clear face (not reaching through)')
                const { goals } = require('mineflayer-pathfinder')
                const Vec3 = require('vec3').Vec3
                // pick the nearest face cell that is standable (air feet+head, solid floor) AND LOS-clear
                const cells = los.faceApproachCells(tgt).map(c => ({ ...c, d: bot.entity.position.distanceTo(new Vec3(c.x, c.y, c.z)) })).sort((a, b) => a.d - b.d)
                for (const c of cells) {
                  const feet = bot.blockAt(new Vec3(c.x, c.y, c.z)); const head = bot.blockAt(new Vec3(c.x, c.y + 1, c.z)); const floor = bot.blockAt(new Vec3(c.x, c.y - 1, c.z))
                  const standable = feet && AIR_RE.test(feet.name) && head && AIR_RE.test(head.name) && floor && floor.boundingBox === 'block'
                  if (!standable) continue
                  const eyeC = { x: c.x + 0.5, y: c.y + 1.62, z: c.z + 0.5 }
                  if (los.lineBlocked(eyeC, { x: tgt.x + 0.5, y: tgt.y + 0.5, z: tgt.z + 0.5 }, isSolid)) continue
                  try { await require('./navigate.js').gotoOnce(bot, new goals.GoalNear(c.x, c.y, c.z, 0), 12000) } catch {}
                  break
                }
              }
            } catch (e) { dbg(fname + ': LOS check skipped (' + e.message + ')') }
          }
          try { if (tpos) await bot.lookAt(tpos.clone ? tpos.clone().offset(0.5, 0.5, 0.5) : tpos, true) } catch {}
          const w = await Promise.race([
            orig(target, ...rest).catch(e => ({ __err: e || new Error('open failed') })),
            new Promise(resolve => setTimeout(() => resolve(null), attempt === 0 ? 5000 : 8000))
          ])
          if (w && !w.__err) return w
          const why = w && w.__err ? (w.__err.message || 'open failed') : 'window did not open within ' + (attempt === 0 ? 5 : 8) + 's'
          if (attempt >= 1) throw new Error(fname + ': ' + why + ' (2 attempts, in reach ' + (distTo() != null ? distTo().toFixed(1) + 'b' : '?') + ' - genuine window failure)')
          dbg(fname + ' attempt 1 failed (' + why + ') - closing any half-open window and retrying')
          try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
          await new Promise(r => setTimeout(r, 500))
        }
      }
    }
  }
  // ==== AUDIT 2026-07-29 FIX 6: TOWERING IS NOT FREE =======================================
  // mineflayer-pathfinder prices a block PLACEMENT at `placeCost = 1` - the same as taking one
  // ordinary step. So A* will happily pillar rather than walk ten blocks around, and every one
  // of those placements becomes a 1x1 tower the bot can never reach again to dismantle (a tower
  // is reachable exactly once, while you are standing on it). 155 of the 336 unpaid cells in the
  // live registry were placed by the pathfinder under purpose 'goto'.
  //
  // This does NOT forbid towering - the capability is load-bearing (without it there is "no path
  // to a tree below a cliff"). It prices it honestly: at 12, A* takes a detour of up to ~12 steps
  // before it will place a block, so towers become the last resort they should always have been.
  // The VALUE lives here, in one place (PLACE_COST below); each Movements profile applies it via
  // pathfix.applyPlaceCost(m). It cannot be set on the prototype because mineflayer-pathfinder's
  // constructor assigns `this.placeCost = 1` as an own property, which would shadow it.
  const { Movements } = require('mineflayer-pathfinder')
  if (!Movements.prototype.__selfScaffoldGuard) {
    const orig = Movements.prototype.safeToBreak
    Movements.prototype.safeToBreak = function (block) {
      const t = block && block.position && recentlyPlaced.get(key(block.position))
      if (t && Date.now() - t < RECENT_MS) return false // our own fresh scaffold - walk, don't chew (older trail entries are breakable again)
      return orig.call(this, block)
    }
    Movements.prototype.__selfScaffoldGuard = true
  }

  // ==== A* BUDGET (AUDIT 2026-07-29, navigation review) ====================================
  //
  // What was here: thinkTimeout 20000, tickTimeout 80, searchRadius -1. It was set in response to
  // "fix the pathfinding, it seems unreliable" by giving the search FOUR TIMES more time - and it
  // made the body less responsive, not more, for a reason worth writing down.
  //
  // `searchRadius: -1` means the A* has NO cost ceiling, so an UNREACHABLE goal does not fail
  // fast: it enumerates every reachable node in every loaded chunk before it can prove failure.
  // With a 20s think budget at 80ms of compute per 50ms tick, one impossible path could occupy the
  // event loop, over-budget, for twenty seconds. The 2026-07-20 tape emitted `path noPath` 2722
  // times in 4h46m - one every 6 seconds - so this was not a rare worst case, it was the normal
  // operating mode, and it is the most likely reason short reflex moves kept reporting `short`
  // (the body could not respond because A* owned the loop). [[body-first-priority]]
  //
  // The right knob is the SPACE, not the TIME. In this A* `searchRadius` is a DETOUR ALLOWANCE:
  // maxCost = straight-line-distance + searchRadius (lib/astar.js). 192 permits a very generous
  // way around an obstacle while making a genuinely impossible goal fail in a fraction of a
  // second - and long treks are legged into ~48-64 block hops by walkStaged, so it never binds on
  // a real route. tickTimeout returns to 40ms: a value above the 50ms tick can only make the body
  // late. The think budget stays above stock (10s) for the cramped-interior case that motivated
  // the original change - it just no longer has to expire to prove a wall is a wall.
  try {
    if (bot.pathfinder) {
      bot.pathfinder.thinkTimeout = Number(process.env.PATH_THINK_MS || 10000)
      bot.pathfinder.tickTimeout = Number(process.env.PATH_TICK_MS || 40)
      if ('searchRadius' in bot.pathfinder) bot.pathfinder.searchRadius = Number(process.env.PATH_SEARCH_RADIUS || 192)
    }
  } catch {}
}

// FIX 6: the ONE definition of what a block placement costs the planner. Applied by every
// Movements profile (commands.setupMovements/travelMovements, provision.gatherMovements/
// trekMovements) so the five profiles cannot drift on this the way they have on everything else.
// The schematic's buildMovements deliberately does NOT apply it - a build is SUPPOSED to pillar.
// FIX 14: consecutive dig-verifications that came back WATER. Consumed by provision.mineDanger so
// a bot digging into an aquifer breaks out instead of drowning in its own tunnel. A COUNT of
// consecutive events, not a clock: one clean break clears it.
const floodHits = []
const FLOOD_DIGS = Number(process.env.FLOOD_DIGS || 2) // 2 in a row = the tunnel is filling, not a fluke
function floodingNow () { return floodHits.length >= FLOOD_DIGS }
function clearFlood () { floodHits.length = 0 }

const PLACE_COST = Number(process.env.PATH_PLACE_COST || 12)
function applyPlaceCost (m) { try { if (m && 'placeCost' in m) m.placeCost = PLACE_COST } catch {} ; return m }

module.exports = { installPathfinderTuning, selfPlacedNear, isSelfPlaced, placedOK, brokeOK, setDebugSink, setProgressSink, readCell, surfaceYAt, surveyCells, arrivedOK, epoch, sameEpoch, bumpEpoch, applyPlaceCost, floodingNow, clearFlood, FLOOD_DIGS }
