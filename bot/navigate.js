'use strict'
// UNIFIED NAVIGATION. One entry point - navigateTo() - with the full stuck-recovery
// toolkit baked in, so every caller (goto/come/recover/travel/nightRest/treks) gets the
// same rescues instead of whichever hacks happened to be wired into its loop. Before
// this, door-assist lived only in travelFar (the bot sat "no path" inside its own hut on
// a plain goto), pit-escape only in travelFar+walkStaged, the water-hop only in
// walkStaged... reliable on one route, permanently stuck on another.
//
// Design mirrors buildSurvival's grounded loop: act -> re-read the world -> decide from
// real state. A recovery only "counts" if the bot demonstrably moved; when the toolkit
// is spent it gives up HONESTLY (the error says what it tried) instead of hanging.
//
// Layering: commands.js / provision.js / schematic.js all require this module. The
// recovery primitives that need dig/scaffold machinery (climbToSurface, pillarUpTo,
// manualHopFromWater) stay in provision.js and are require()d LAZILY at call time -
// provision requires us at load, we require it only once both are fully loaded.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

let dbgSink = null // injected by index.js: debug lines persist to logs/bot-events.log
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[nav] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

const prov = () => require('./provision.js') // lazy - see layering note above

// ---- reflex arbitration ------------------------------------------------------------
// While a recovery is physically maneuvering (pillaring out of a pit, threading a
// doorway, hopping from water) the flee/defend reflexes must not hijack the pathfinder
// sideways - the recovery IS the escape. index.js checks this next to isEscaping().
let recoveringDepth = 0
function isRecovering () { return recoveringDepth > 0 }
// Active navigations (for observability + later flow arbitration).
let navDepth = 0
function isNavigating () { return navDepth > 0 }
// A watchdog force-escape is driving on manual controls - other gotos must stand down.
let forceUnsticking = false
function isForceUnsticking () { return forceUnsticking }

// ---- the ONE deadline-goto ----------------------------------------------------------
// pathfinder.goto with a hard deadline. An unreachable target can hang goto FOREVER
// (verified live: froze a 432-block build for 10+ minutes; froze the whole brain loop).
// This used to exist as three identical copies (commands/provision/schematic).
async function gotoOnce (bot, goal, ms = 20000, gopts = {}) {
  // Yield to a watchdog FORCE-ESCAPE and to any ACTIVE RECOVERY maneuver: their manual
  // control-state driving must not fight a concurrent goto's physics ticks (the pathfinder
  // rewrites the controls every tick, so the manual escape LOSES - live: step-out rungs
  // reported 'no progress' for 3+ minutes at 433,62,112 while another flow's goto stomped
  // them). Bounded wait. Door-assist's own gotos pass duringRecovery to skip the gate
  // (they ARE the recovery).
  if ((forceUnsticking || recoveringDepth > 0) && !gopts.duringRecovery) {
    const t0 = Date.now()
    while ((forceUnsticking || recoveringDepth > 0) && Date.now() - t0 < 45000) await new Promise(r => setTimeout(r, 250))
  }
  // SCAFFOLD SESSION: any block the pathfinder places while EXECUTING a goto (bridge,
  // 1x1 tower) is by definition movement scaffold, never build fabric - build blocks
  // are placed after the goto completes. The bracket lets the scaffold manager tag and
  // later tear down exactly those, even right next to a build made of the same material.
  const scaffold = require('./scaffold.js')
  scaffold.beginSession('goto')
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; scaffold.endSession(); fn(v) } }
    const timer = setTimeout(() => {
      try { bot.pathfinder.setGoal(null) } catch {}
      done(reject, new Error('goto timed out'))
    }, ms)
    bot.pathfinder.goto(goal).then(
      () => { clearTimeout(timer); done(resolve) },
      e => { clearTimeout(timer); done(reject, e) }
    )
  })
}

// A goto rejection that means "someone else took the pathfinder" (a reflex setGoal, a
// concurrent flow) rather than "no route exists".
function goalWasChanged (e) { return /goal.*chang|chang.*goal/i.test((e && e.message) || '') }

// Best-effort target XZ out of any pathfinder goal (for aiming the jump-nudge).
function goalXZ (goal) {
  if (!goal) return null
  if (typeof goal.x === 'number' && typeof goal.z === 'number') return { x: goal.x, z: goal.z }
  if (goal.pos && typeof goal.pos.x === 'number') return { x: goal.pos.x, z: goal.pos.z }
  if (goal.entity && goal.entity.position) return { x: goal.entity.position.x, z: goal.entity.position.z }
  return null
}
function goalY (goal) {
  if (!goal) return null
  if (typeof goal.y === 'number') return goal.y
  if (goal.pos && typeof goal.pos.y === 'number') return goal.pos.y
  return null
}

// ---- situation detectors ------------------------------------------------------------
const AIRISH = (n) => /^(air|cave_air|void_air)$/.test(n)

function feetInWater (bot) {
  const b = bot.blockAt(bot.entity.position.floored())
  return !!b && /water/.test(b.name)
}

// DEEP-water rescue: manualHopFromWater only handles standing in a shallow trench with
// a bank RIGHT THERE - swimming mid-river it finds no adjacent bank and gives up while
// the pathfinder can't plan a single move (watched live: legs no-pathed in <1s each and
// the trek "blocked" in 2 seconds mid-channel). Do what a player does: float up, pick
// the nearest shore cell, and swim straight at it on manual controls.
async function swimToShore (bot, isStopped = () => false) {
  const feet = bot.entity.position.floored()
  // water surface: first non-water cell going up
  let ySurf = feet.y
  for (let dy = 0; dy <= 12; dy++) {
    const b = bot.blockAt(new Vec3(feet.x, feet.y + dy, feet.z))
    if (!b || !/water/.test(b.name)) { ySurf = feet.y + dy; break }
  }
  // nearest bank: solid ground within +-2 of the surface with 2 cells of headroom
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
  let bank = null; let bestD = Infinity
  for (const [dx, dz] of dirs) {
    for (let r = 2; r <= 14; r++) {
      const x = feet.x + dx * r; const z = feet.z + dz * r
      for (let dy = 1; dy >= -2; dy--) {
        const g = bot.blockAt(new Vec3(x, ySurf + dy - 1, z))
        const s1 = bot.blockAt(new Vec3(x, ySurf + dy, z))
        const s2 = bot.blockAt(new Vec3(x, ySurf + dy + 1, z))
        if (!g || g.boundingBox !== 'block' || /water|lava/.test(g.name)) continue
        if (!s1 || (!AIRISH(s1.name) && !/water/.test(s1.name))) continue
        if (!s2 || !AIRISH(s2.name)) continue
        const d = Math.hypot(dx * r, dz * r)
        if (d < bestD) { bestD = d; bank = new Vec3(x, ySurf + dy, z) }
        r = 99 // first hit along this ray is the shore - stop marching it
        break
      }
    }
  }
  if (!bank) { dbg('swim: no shore within 14 - staying put'); return false }
  dbg('swim: heading for the bank at ' + bank)
  try {
    try { bot.pathfinder.setGoal(null) } catch {}
    const t0 = Date.now()
    bot.setControlState('jump', true) // float/climb the water column
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    while (Date.now() - t0 < 15000 && !isStopped()) {
      try { await bot.lookAt(new Vec3(bank.x + 0.5, bot.entity.position.y + 0.4, bank.z + 0.5), true) } catch {}
      await new Promise(r => setTimeout(r, 120))
      const f = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (bot.entity.onGround && f && f.boundingBox === 'block' && !/water/.test(f.name) && !feetInWater(bot)) {
        dbg('swim: ashore on ' + f.name + ' at ' + bot.entity.position.floored())
        return true
      }
    }
  } finally { bot.clearControlStates() }
  dbg('swim: still wet after 15s')
  return false
}

// Standing in a HOLE: solid walls on 3+ sides at feet level. An open-sky pit makes the
// no-dig profiles no-path INSTANTLY (this was the "stalls on open ground" mystery - the
// bot idled 70s in its own orchard-leveling hole, live). Returns the rim height to
// pillar to, or null. Only counts as a pit under open sky - a walled corner INSIDE a
// roofed room is a door/climb problem, not a pillar problem (pillaring indoors just
// bonks the ceiling).
function detectPit (bot) {
  const f0 = bot.entity.position.floored()
  let pitWalls = 0; let rimY = f0.y
  for (const [wdx, wdz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const w = bot.blockAt(f0.offset(wdx, 0, wdz))
    if (w && w.boundingBox === 'block') pitWalls++
    for (let dy = 2; dy >= 0; dy--) {
      const t = bot.blockAt(f0.offset(wdx, dy, wdz))
      if (t && t.boundingBox === 'block') { rimY = Math.max(rimY, f0.y + dy + 1); break }
    }
  }
  if (pitWalls < 3) return null
  if (prov().insideOwnStructure && prov().insideOwnStructure(bot)) return null // my own hut is not a pit - don't pillar dirt in the living room
  if (prov().hasSolidCeiling(bot, 20, { ignoreLeaves: true })) return null // roofed = not a pit
  return { rimY }
}

// A 4+ deep drop within a few blocks along the nudge line? A blind sprint-jump once
// launched the bot off an edge into a shaft to bedrock (died at y=1, live).
function cliffAhead (bot, tx, tz) {
  const np = bot.entity.position
  const fdx = tx - np.x; const fdz = tz - np.z; const fn = Math.hypot(fdx, fdz) || 1
  for (const dist of [2, 3, 4]) {
    const cx = Math.floor(np.x + (fdx / fn) * dist); const cz = Math.floor(np.z + (fdz / fn) * dist)
    let solid = false
    for (let dy = -1; dy >= -4; dy--) {
      const b = bot.blockAt(new Vec3(cx, Math.floor(np.y) + dy, cz))
      if (b && b.boundingBox === 'block') { solid = true; break }
    }
    if (!solid) return true
  }
  return false
}

// ---- door-assist ----------------------------------------------------------------
// Walk to the nearest CLOSED wooden door / fence gate within 16 blocks and open it,
// like a player leaving a house. Iron doors need redstone - skipped. Returns whether
// a door was crossed/opened (the caller re-plans its path afterwards).
// The pathfinder cannot PLAN through door cells AT ALL (canOpenDoors only bumps them
// open on direct lines) - verified repeatedly in the hut test - so after opening we
// FORCE-WALK through the doorway on manual controls, exiting toward open sky.
// opts.towards {x,z}: cross the doorway toward the SIDE CLOSER TO THE GOAL. Without it
// the exit side is picked by open sky ("outside") - which can only ever LEAVE a building;
// a goto INTO the hut needs to cross the other way (navigateTo passes the goal through).
const OPENABLE_RE = /(_door|_fence_gate)$/
function openableIds (bot) {
  const md = require('minecraft-data')(bot.version)
  return Object.values(md.blocksByName).filter(b => OPENABLE_RE.test(b.name) && b.name !== 'iron_door').map(b => b.id)
}
// Scan centers: around the BOT and around the GOAL. A goto into a doored building
// times out wherever the planner happened to roam (live: 27 blocks off, hunting a way
// into a closed box) - the door that matters is the one next to the GOAL, not the bot.
function doorScanPoints (bot, towards) {
  const pts = [bot.entity.position]
  if (towards && typeof towards.x === 'number') pts.push(new Vec3(towards.x, towards.y != null ? towards.y : bot.entity.position.y, towards.z))
  return pts
}
function doorNearby (bot, towards) { // cheap existence probe - gates the ladder rung
  try {
    const ids = openableIds(bot)
    return doorScanPoints(bot, towards).some(pt => (bot.findBlocks({ point: pt, matching: ids, maxDistance: 16, count: 1 }) || []).length > 0)
  } catch { return false }
}
async function openNearbyDoor (bot, opts = {}) {
  try {
    const ids = openableIds(bot)
    const seen = new Set(); const cands = []
    for (const pt of doorScanPoints(bot, opts.towards)) {
      for (const c of (bot.findBlocks({ point: pt, matching: ids, maxDistance: 16, count: 8 }) || [])) {
        const k = c.x + ',' + c.y + ',' + c.z
        if (!seen.has(k)) { seen.add(k); cands.push(c) }
      }
    }
    cands.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    dbg('door-assist: ' + cands.length + ' door/gate candidates near me/goal')
    for (const p of cands) {
      const blk = bot.blockAt(p)
      if (!blk) continue
      // NOTE: the walk-through below runs regardless of the door's open/closed STATE -
      // the pathfinder cannot ROUTE through door cells at all (it only bumps them open
      // on direct lines), and "open" is normalized to "walk line clear" further down
      // (for a sideways-hung door those are OPPOSITES - see passageClear).
      try { await gotoOnce(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 15000, { duringRecovery: true }) } catch (e) { dbg('door-assist: cannot reach door at ' + p + ' (' + e.message + ')'); continue }
      if (bot.entity.position.distanceTo(p) > 4) continue
      try {
        // WALK THROUGH the doorway before re-planning: the pathfinder won't ROUTE
        // through even an open door that isn't on the direct line (verified in the hut
        // test - door opened, travel still "blocked"). But it CAN step INTO an open
        // doorway cell - so stand in the doorway first, then step out the far side
        // (height-tolerant: outside ground is often ±1).
        // Foot cell from the HALF property, never from the bot's y: a mid-hop read
        // (feet momentarily at y+1) picked the UPPER half here and shifted every
        // geometry probe one block up (live: bogus 'blocked side' flips at the hut).
        let half = null
        try { half = (blk.getProperties() || {}).half || null } catch {}
        const base = half === 'upper' ? p.offset(0, -1, 0) : p
        const before = bot.entity.position.clone()
        // CROSSING AXIS from WALL GEOMETRY, not the door's facing blockstate. facing
        // encodes the PLACER'S YAW at hang time, not which way the wall runs - the bot
        // hung its own hut door sideways during the safehouse build (facing east in a
        // north wall) and door-assist then force-walked ALONG the inside of the wall
        // into the chest corner instead of out the doorway (trapped in its own hut,
        // live 19:16-19:27). The wall is ground truth: the passage axis is the one
        // whose neighbor columns are walkable; the wall axis is solid. facing is only
        // a tiebreak (freestanding door), the old approach-line heuristic dead last.
        const clearCell = (b) => b && (b.boundingBox !== 'block' || OPENABLE_RE.test(b.name))
        const walkable = (cell) => { // can the bot stand there? (±1: outside ground is often a step up/down)
          for (const dy of [0, 1, -1]) {
            const feet = bot.blockAt(cell.offset(0, dy, 0)); const head = bot.blockAt(cell.offset(0, dy + 1, 0)); const floor = bot.blockAt(cell.offset(0, dy - 1, 0))
            if (clearCell(feet) && clearCell(head) && floor && floor.boundingBox === 'block') return true
          }
          return false
        }
        let facing = null
        try { facing = (bot.blockAt(base) && bot.blockAt(base).getProperties().facing) || null } catch {}
        const xOpen = (walkable(base.offset(1, 0, 0)) ? 1 : 0) + (walkable(base.offset(-1, 0, 0)) ? 1 : 0)
        const zOpen = (walkable(base.offset(0, 0, 1)) ? 1 : 0) + (walkable(base.offset(0, 0, -1)) ? 1 : 0)
        let axis
        if (xOpen !== zOpen) axis = xOpen > zOpen ? [1, 0] : [0, 1]
        else if (facing === 'east' || facing === 'west') axis = [1, 0]
        else if (facing === 'north' || facing === 'south') axis = [0, 1]
        else axis = [Math.abs(base.x + 0.5 - before.x) >= Math.abs(base.z + 0.5 - before.z) ? 1 : 0, 0]
        const dx = axis[0]; const dz = axis[0] === 1 ? 0 : 1
        dbg('door-assist: crossing axis ' + (dx ? 'x (east-west)' : 'z (north-south)') + ' - open sides x=' + xOpen + ' z=' + zOpen + ', facing=' + facing)
        // PASSAGE CLEAR, not "open": a sideways-hung door (facing along the wall - THIS
        // hut's door, hung by the builder, live) swings its OPEN panel flat ACROSS the
        // doorway and rests its CLOSED panel parallel to the walk line - forcing
        // open=true is exactly backwards there. The state's collision SHAPES are ground
        // truth: the walk line is clear when no box crosses the corridor's center strip
        // (bot body is 0.6 wide -> a panel overlapping [0.2, 0.8] of the perpendicular
        // coordinate blocks the line). Toggle (bounded) until it clears.
        const passageClear = () => {
          const b = bot.blockAt(base)
          if (!b) return true
          let shapes = null
          try { shapes = b.shapes } catch {}
          if (!Array.isArray(shapes)) { // no shape data - old behavior (trust the open flag)
            try { const pr = b.getProperties(); return !!pr && (pr.open === true || pr.open === 'true') } catch { return true }
          }
          return !shapes.some(s => dx ? (s[2] <= 0.8 && s[5] >= 0.2) : (s[0] <= 0.8 && s[3] >= 0.2))
        }
        const ensurePassage = async (when) => {
          for (let i = 0; i < 2 && !passageClear(); i++) {
            await bot.activateBlock(bot.blockAt(base))
            await new Promise(r => setTimeout(r, 300)) // let the door state land
            dbg('door-assist: toggled ' + blk.name + ' (' + when + ') - walk line ' + (passageClear() ? 'CLEAR' : 'still blocked'))
          }
        }
        // Exit toward OPEN SKY: "outside" is the side of the doorway with no ceiling.
        // (Away-from-where-I-stand flips when the bot is mid-doorway - verified: it
        // walked back INTO the hut. Ceiling check is position-independent.)
        const skyless = (cell) => { // solid cover within 12 above? (leaves are canopy, not ceiling)
          for (let dy = 2; dy <= 12; dy++) { const b = bot.blockAt(cell.offset(0, dy, 0)); if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return true }
          return false
        }
        const posSide = base.offset(dx * 2, 0, dz * 2); const negSide = base.offset(-dx * 2, 0, -dz * 2)
        let sign = 0; let how = ''
        // Is the GOAL itself inside a structure of ours (e.g. the hut chest), or out in
        // the world? This, not raw goal-distance, decides which way to cross a doorway.
        let goalInside = false
        try { goalInside = !!(opts.towards && typeof opts.towards.x === 'number' && prov().ownHutAt && prov().ownHutAt(new Vec3(opts.towards.x, opts.towards.y != null ? opts.towards.y : base.y, opts.towards.z))) } catch {}
        const posCovered = skyless(posSide); const negCovered = skyless(negSide)
        if (posCovered !== negCovered) {
          // One doorway side is ROOFED (inside a room), the other OPEN (outside). Cross to
          // the side that MATCHES WHERE THE GOAL IS: an outside goal => exit to open sky;
          // an inside goal => step into the covered room. This DOMINATES goal-distance,
          // which wrongly picks "inward" when an outside goal sits beyond the hut's far
          // wall (live: orchard goal is SOUTH, the only door is NORTH -> raw distance
          // walked the bot deeper INTO the hut toward the chest instead of out the door).
          const openSign = posCovered ? -1 : 1 // sign that points at the OPEN (outdoor) side
          sign = goalInside ? -openSign : openSign
          how = goalInside ? ' (toward inside goal)' : ' (open sky)'
        } else if (opts.towards && typeof opts.towards.x === 'number') {
          // Both sides equally open/covered (a freestanding gate): fall back to goal-distance.
          const dPos = Math.hypot(posSide.x + 0.5 - opts.towards.x, posSide.z + 0.5 - opts.towards.z)
          const dNeg = Math.hypot(negSide.x + 0.5 - opts.towards.x, negSide.z + 0.5 - opts.towards.z)
          if (Math.abs(dPos - dNeg) > 0.75) { sign = dPos < dNeg ? 1 : -1; how = ' (toward goal)' }
        }
        if (!sign) { sign = Math.sign((base.x + 0.5 - before.x) * dx + (base.z + 0.5 - before.z) * dz) || 1; how = ' (fallback)' }
        // GROUNDED sanity: never force-walk at a WALL. Flip only when the chosen far
        // side is wall-like (no walk gap at any tolerated step height) and the other
        // side has one. A FLOORLESS far side is NOT wall-like: a blast crater beyond
        // the doorstep is still crossable (step out and drop, recoveries handle the
        // climb) - flipping on it walked the bot right back inside its hut (live).
        const blockedSolid = (cell) => {
          for (const dy of [0, 1, -1]) {
            const feet = bot.blockAt(cell.offset(0, dy, 0)); const head = bot.blockAt(cell.offset(0, dy + 1, 0))
            if (clearCell(feet) && clearCell(head)) return false
          }
          return true
        }
        if (blockedSolid(base.offset(dx * sign * 2, 0, dz * sign * 2)) && !blockedSolid(base.offset(-dx * sign * 2, 0, -dz * sign * 2))) { sign = -sign; how += ' FLIPPED (chosen side blocked)' }
        dbg('door-assist: exit side ' + (dx ? (sign > 0 ? 'east' : 'west') : (sign > 0 ? 'south' : 'north')) + how)
        // Align on the inside cell in front of the door (pathfinder CAN reach that).
        try { await gotoOnce(bot, new goals.GoalBlock(base.x - dx * sign, base.y, base.z - dz * sign), 8000, { duringRecovery: true }) } catch (e2) { dbg('door-assist: could not align (' + e2.message + ')') }
        // FORCE-WALK through on manual controls. Thread the doorway CENTER-TO-CENTER -
        // one long diagonal walk clipped the open door panel and slid the bot off
        // sideways into the wall corner.
        try { bot.pathfinder.setGoal(null) } catch {}
        bot.setControlState('sprint', false)
        bot.setControlState('jump', false)
        const walkTo = async (tx, tz, doneDist, ms) => {
          try { await bot.lookAt(new Vec3(tx, bot.entity.position.y + 1.2, tz), true) } catch {}
          bot.setControlState('forward', true)
          const t0 = Date.now()
          let lastPos = bot.entity.position.clone(); let lastMove = Date.now()
          while (Date.now() - t0 < ms) {
            await new Promise(r => setTimeout(r, 80))
            if (Math.hypot(bot.entity.position.x - tx, bot.entity.position.z - tz) < doneDist) break
            const moved = bot.entity.position.distanceTo(lastPos)
            if (moved > 0.15) { lastPos = bot.entity.position.clone(); lastMove = Date.now() }
            else if (Date.now() - lastMove > 350) { // wedged on a step-up (e.g. higher ground outside) - hop
              bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 120)); bot.setControlState('jump', false)
              lastMove = Date.now()
            }
            try { await bot.lookAt(new Vec3(tx, bot.entity.position.y + 1.2, tz), true) } catch {} // keep the line straight
          }
          bot.setControlState('forward', false)
        }
        // Normalize the door RIGHT BEFORE crossing (the align goto's native bump logic
        // can toggle it behind our back) - and by SHAPES, not the open flag: this is
        // where the sideways-hung door gets CLOSED so its panel swings out of the walk
        // line (the old force-open here re-blocked the doorway every pass, live).
        try { await ensurePassage('before crossing') } catch {}
        await walkTo(base.x + 0.5, base.z + 0.5, 0.45, 2500)                                    // into the doorway
        // OWN-HUT crater heal, from THE DOORWAY: standing on the solid door floor the bot
        // reaches the whole exit lane, so fill any creeper crater HERE - before the second
        // step walks it off the doorstep edge into the pit. A blast turned the exit lane
        // into a hole the pathfinder can't cross, so the re-plan gave up at the threshold
        // (live: trapped at 418,67,89). ownHutAt-gated + survival place from our own filler
        // + skips solids => anti-grief and a no-op on a healthy apron. The step-out below
        // then lands on solid ground and the retry routes across.
        const ownHut = prov().ownHutAt && prov().ownHutAt(p)
        try {
          if (ownHut && prov().healHomeCrater) {
            // QUICK patch from the doorway (no repositioning - a rim walk here would pull
            // us off the crossing line): fill only the reachable western lane so the
            // step-out below lands on solid ground.
            const n = await prov().healHomeCrater(bot, ownHut, { isStopped: opts.isStopped, reposition: false })
            if (n) dbg('door-assist: quick-healed ' + n + ' crater cell(s) from the doorway')
          }
        } catch (e3) { dbg('door-assist: crater heal skipped (' + e3.message + ')') }
        await walkTo(base.x + dx * sign * 2 + 0.5, base.z + dz * sign * 2 + 0.5, 0.6, 2500)     // out the far side
        const prog = (bot.entity.position.x - (base.x + 0.5)) * dx * sign + (bot.entity.position.z - (base.z + 0.5)) * dz * sign
        dbg('door-assist: force-walk ' + (prog > 1.2 ? 'THROUGH to ' : 'did not clear, at ') + bot.entity.position.floored())
        // CLOSE THE DOOR BEHIND US so the hut stays sealed to mobs (it was opened/toggled
        // to pass). "Sealed" = the door's collision shape SPANS the doorway (passageClear
        // false) - the inverse of ensurePassage, same shape ground-truth. Do this BEFORE
        // the full crater heal (which walks the rim away from the door), while we're still
        // in reach; we're past the door now, so closing it can't lock us out.
        try {
          for (let i = 0; i < 2 && passageClear(); i++) { await bot.activateBlock(bot.blockAt(base)); await new Promise(r => setTimeout(r, 300)) }
          dbg('door-assist: door behind me ' + (passageClear() ? 'still open' : 'closed'))
        } catch {}
        // FULL crater heal whenever we're actually OUTSIDE the hut now (not just prog>1.2 -
        // a "did not clear" exit still lands the bot outside and can reach the crater): walk
        // the rim and bridge the whole footprint incl. the far EAST pit the doorway can't
        // touch (live: the bot fell into the unhealed (419,62,84) and died). From inside
        // (an entry crossing) this no-ops - it can't reach the outside cells anyway.
        try {
          if (ownHut && prov().healHomeCrater && !(prov().ownHutAt && prov().ownHutAt(bot.entity.position.floored()))) {
            const n = await prov().healHomeCrater(bot, ownHut, { isStopped: opts.isStopped, reposition: true })
            if (n) dbg('door-assist: full-healed ' + n + ' crater cell(s) around home')
          }
        } catch (e5) { dbg('door-assist: full crater heal skipped (' + e5.message + ')') }
        return true
      } catch { continue }
    }
  } catch { }
  return false
}

// ---- the recovery ladder --------------------------------------------------------
// Ordered, situation-gated, per-type budgets. Each entry: when() says whether it can
// help right now; run() maneuvers. A recovery "worked" if the bot demonstrably MOVED
// (>=2 blocks horizontally or rose >=1) or the entry vouches for itself (door-assist
// returns whether it crossed) - re-read the world, never trust intent.
function defaultBudgets () { return { water: 2, door: 3, pit: 2, climb: 2, nudge: 2, stepout: 2 } }

async function recoverOnce (bot, goal, counts, budgets, opts) {
  const isStopped = opts.isStopped || (() => false)
  const p0 = bot.entity.position.clone()
  const movedEnough = () => {
    const p1 = bot.entity.position
    return Math.hypot(p1.x - p0.x, p1.z - p0.z) >= 2 || Math.floor(p1.y) > Math.floor(p0.y)
  }
  const xz = goalXZ(goal)
  const twd = xz ? { x: xz.x, z: xz.z, y: goalY(goal) } : null // door scans also look near the GOAL
  const ladder = [
    { // in water the pathfinder never registers "on ground", so its planned jumps never
      // fire - it stands in a puddle forever (watched live, 8 min). Shallow trench: hop
      // straight onto the adjacent bank. Deep water (mid-river, no adjacent bank): swim
      // for the nearest shore on manual controls.
      kind: 'water',
      when: () => feetInWater(bot),
      run: async () => {
        await prov().manualHopFromWater(bot)
        if (movedEnough() && !feetInWater(bot)) return true
        return swimToShore(bot, isStopped)
      }
    },
    { // open-sky hole: pillar out to the rim with carried filler. Checked BEFORE the
      // door rung - from inside a pit every door-approach goto just burns its timeout.
      // (A walled corner in a ROOFED room is not a pit - detectPit excludes it - so the
      // inside-the-hut case still reaches door-assist first.)
      kind: 'pit',
      when: () => !!detectPit(bot),
      run: async () => {
        const pit = detectPit(bot)
        if (!pit) return false
        dbg('recovery: wedged in a PIT at ' + p0.floored() + ' - pillaring out to y=' + pit.rimY)
        try { await prov().pillarUpTo(bot, pit.rimY, { isStopped }) } catch (e) { dbg('recovery: pillar-out failed (' + e.message + ')') }
        return movedEnough()
      }
    },
    { // walled into a room with a door (or out of one): open it and walk through like a
      // person, crossing toward the goal side. GATED on a door actually existing nearby:
      // "no door within 16" is NOT APPLICABLE, not a failed attempt - running it in open
      // country burned the whole door budget mid-trek, and by the time the bot reached
      // its hut wall the rung was spent (live: re-entry died at (420,66,85), 3 blocks
      // from its own door, with 'door x3' all wasted 60+ blocks away).
      kind: 'door',
      when: () => doorNearby(bot, twd),
      run: async () => openNearbyDoor(bot, { towards: twd })
    },
    { // buried underground (real ceiling, not a canopy): staircase/pillar up to daylight.
      kind: 'climb',
      when: () => opts.climb !== false && prov().hasSolidCeiling(bot, 12, { ignoreLeaves: true }),
      run: async () => {
        const gy = goalY(goal)
        const targetY = Math.max(Math.floor(bot.entity.position.y) + 10, gy == null ? -Infinity : Math.floor(gy))
        dbg('recovery: stuck UNDERGROUND at ' + p0.floored() + ' - climbing toward y=' + targetY)
        try { await prov().climbToSurface(bot, targetY, { isStopped }) } catch (e) { dbg('recovery: climb-out failed (' + e.message + ')') }
        return movedEnough()
      }
    },
    { // surface wedge the planner just can't solve: face the target and jump-sprint at
      // it - but never blind over a drop (cliff check).
      kind: 'nudge',
      when: () => !!xz && bot.entity.onGround && !cliffAhead(bot, xz.x, xz.z),
      run: async () => {
        dbg('recovery: surface nudge at ' + p0.floored() + ' toward ' + Math.round(xz.x) + ',' + Math.round(xz.z))
        try {
          try { bot.pathfinder.setGoal(null) } catch {}
          await bot.lookAt(new Vec3(xz.x, bot.entity.position.y + 1, xz.z), true)
          bot.setControlState('jump', true); bot.setControlState('forward', true); bot.setControlState('sprint', true)
          await new Promise(r => setTimeout(r, 2000))
        } catch {} finally { bot.clearControlStates() }
        return movedEnough()
      }
    },
    { // SOFT WEDGE, last rung: the planner refuses to move but the immediate cells are
      // walkable (live: 12-min freeze at 512,68,147 with air/grass on every side - the
      // whole ladder above whiffed and walkStaged looped "giving up wedged"). Do the
      // dumbest human thing: hop in place (clears a block-clip desync), then STEP OUT one
      // or two cells on manual controls - goal-ward first - and verify we actually moved.
      // Unlike the nudge this needs no goal, tolerates a step down, and probes each of 8
      // directions instead of blindly charging one.
      kind: 'stepout',
      when: () => bot.entity.onGround || feetInWater(bot),
      run: async () => {
        try { bot.pathfinder.setGoal(null) } catch {}
        bot.clearControlStates()
        try { bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 260)) } catch {} finally { bot.setControlState('jump', false) }
        await new Promise(r => setTimeout(r, 300)) // land
        const feet = bot.entity.position.floored()
        const clear = b => !b || b.boundingBox !== 'block'
        const walkable = (cell) => { // can the bot stand there? (±1: steps up/down are fine)
          for (const dy of [0, -1, 1]) {
            const f = bot.blockAt(cell.offset(0, dy, 0)); const h = bot.blockAt(cell.offset(0, dy + 1, 0)); const g = bot.blockAt(cell.offset(0, dy - 1, 0))
            if (clear(f) && clear(h) && g && g.boundingBox === 'block' && !/lava|magma/.test(g.name)) return true
          }
          return false
        }
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
        if (xz) { // try the goal-ward directions first
          const gx = xz.x - (feet.x + 0.5); const gz = xz.z - (feet.z + 0.5)
          dirs.sort((a, b) => (b[0] * gx + b[1] * gz) / Math.hypot(b[0], b[1]) - (a[0] * gx + a[1] * gz) / Math.hypot(a[0], a[1]))
        }
        for (const [dx, dz] of dirs) {
          const c1 = feet.offset(dx, 0, dz)
          if (!walkable(c1)) continue
          const c2 = feet.offset(dx * 2, 0, dz * 2)
          const steps = walkable(c2) ? 2 : 1 // 2 cells out when the lane continues
          const tx = feet.x + 0.5 + dx * steps; const tz = feet.z + 0.5 + dz * steps
          dbg('recovery: step-out ' + steps + ' cell(s) toward ' + Math.floor(tx) + ',' + Math.floor(tz))
          try {
            await bot.lookAt(new Vec3(tx, bot.entity.position.y + 1.2, tz), true)
            bot.setControlState('forward', true)
            const t0 = Date.now()
            while (Date.now() - t0 < 1800) {
              await new Promise(r => setTimeout(r, 100))
              if (Math.hypot(bot.entity.position.x - tx, bot.entity.position.z - tz) < 0.4) break
              if (Date.now() - t0 > 600 && bot.entity.position.distanceTo(p0) < 0.3) { // bumped - hop once
                bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 150)); bot.setControlState('jump', false)
              }
            }
          } catch {} finally { bot.clearControlStates() }
          const p1 = bot.entity.position
          if (Math.hypot(p1.x - p0.x, p1.z - p0.z) >= 1.0) return true // we broke the freeze - that's the job
        }
        return false
      }
    }
  ]
  for (const step of ladder) {
    if (isStopped()) return null
    if ((counts[step.kind] || 0) >= (budgets[step.kind] != null ? budgets[step.kind] : 0)) continue
    let applies = false
    try { applies = step.when() } catch {}
    if (!applies) continue
    counts[step.kind] = (counts[step.kind] || 0) + 1
    recoveringDepth++
    let ok = false
    try { ok = await step.run() } catch (e) { dbg('recovery ' + step.kind + ' threw: ' + e.message) } finally { recoveringDepth-- }
    dbg('recovery ' + step.kind + ' -> ' + (ok ? 'MOVED' : 'no progress'))
    if (ok) return step.kind
    // no progress from this tool - spend its remaining budget so the next pass tries the
    // next rung instead of hammering the same one
    counts[step.kind] = Math.max(counts[step.kind], budgets[step.kind] != null ? budgets[step.kind] : 0)
  }
  return null
}

// ---- THE entry point ------------------------------------------------------------
// navigateTo(bot, goal, opts): goto with a deadline; on failure, run the recovery
// ladder and retry; on a reflex stealing the pathfinder (flee/defend setGoal), WAIT for
// it to finish and resume instead of failing with "goal was changed". Resolves with
// { recoveries, recoveryMs } (so trek loops can credit rescue time against their travel
// clocks); throws an HONEST error listing what it tried when the toolkit is spent.
//
// opts: timeoutMs (per goto attempt, default 20000) | deadlineMs (overall) | isStopped
//       | movements: () => Movements re-asserted before each attempt (recoveries switch
//         profiles) | budgets: per-rung recovery caps (see defaultBudgets) | climb:false
//         to disable the climb rung (trek loops that manage their own surfacing)
//       | label (debug tag)
// ONE BODY, ONE ROUTE: concurrent navigateTo calls fight over the single pathfinder and
// the control states - live at 433,62,112 a bank-withdraw nav and the build travel each
// ran their own recovery ladder, interleaved every ~2s, and every manual step-out was
// stomped by the other flow's goto physics: position frozen for many minutes while both
// "recovered". Serialize behind a mutex: the body can only walk one route at a time; a
// queued flow just experiences a slower nav (honest) instead of a phantom wedge.
let navChain = Promise.resolve()
function navigateTo (bot, goal, opts = {}) {
  const run = () => navigateToInner(bot, goal, opts)
  const p = navChain.then(run, run)
  navChain = p.then(() => {}, () => {}) // failures release the mutex like successes
  return p
}

async function navigateToInner (bot, goal, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000
  const deadline = Date.now() + (opts.deadlineMs || Math.max(90000, timeoutMs * 4))
  const isStopped = opts.isStopped || (() => false)
  const budgets = Object.assign(defaultBudgets(), opts.budgets || {})
  const counts = {}
  const label = opts.label ? opts.label + ': ' : ''
  let interrupts = 0
  let recoveries = 0
  let recoveryMs = 0
  // Time spent parked while a REFLEX held the pathfinder must not consume the deadline:
  // in a reflex storm (creeper standoff re-fleeing every second, live 2h+) every nav
  // burned its whole budget waiting and DIED at the deadline check before the recovery
  // ladder ever ran once. Credit the wait back (bounded) so recovery always gets a shot.
  let reflexWaitMs = 0
  const dl = () => deadline + Math.min(reflexWaitMs, 90000)
  navDepth++
  try {
    for (;;) {
      if (isStopped()) throw new Error('stopped')
      if (opts.movements) { try { bot.pathfinder.setMovements(opts.movements()) } catch {} }
      let lastErr
      try {
        await gotoOnce(bot, goal, Math.min(timeoutMs, Math.max(2000, dl() - Date.now())))
        // GROUNDED, not optimistic: goto "succeeds" WITHOUT ARRIVING when the planner
        // returns an empty path (wedged in a pit = zero legal moves, verified live) or
        // settles at the closest reachable node. Only the goal's own isEnd on our real
        // position counts as arrival - anything else feeds the recovery ladder.
        let arrived = true
        try { arrived = goal.isEnd(bot.entity.position.floored()) } catch {}
        if (arrived) return { recoveries, recoveryMs }
        lastErr = new Error('path ended short of the goal')
      } catch (e) { lastErr = e }
      // Reflex handoff: someone SET a new goal mid-goto (flee/defend/charge). The
      // survival reflex wins - wait for it to release the pathfinder, then resume.
      // A goal cleared to NULL means a cancel (`stop`, our own timeout) - not resumable.
      if (goalWasChanged(lastErr) && bot.pathfinder.goal && interrupts < 6 && !isStopped()) {
        interrupts++
        dbg(label + 'goal taken by a reflex - waiting to resume (' + interrupts + ')')
        const t0 = Date.now()
        while (bot.pathfinder.goal && Date.now() - t0 < 15000 && !isStopped()) await new Promise(r => setTimeout(r, 250))
        await new Promise(r => setTimeout(r, 300)) // let the reflex's controls settle
        reflexWaitMs += Date.now() - t0
        continue
      }
      if (Date.now() >= dl() || isStopped()) throw honestFail(lastErr, counts, label, recoveryMs)
      const r0 = Date.now()
      const rescued = await recoverOnce(bot, goal, counts, budgets, opts)
      recoveryMs += Date.now() - r0
      if (!rescued) throw honestFail(lastErr, counts, label, recoveryMs)
      recoveries++
      dbg(label + 'recovered via ' + rescued + ' - retrying the path')
    }
  } finally { navDepth-- }
}

// ---- watchdog FORCE-ESCAPE ---------------------------------------------------------
// Called by index.js's freeze watchdog when the position has been FROZEN for minutes
// while something was trying to move (live: 2h creeper standoff in a cave pocket; the
// 12-min surface wedge). Runs the recovery ladder directly - no goal needed - with the
// door rung OFF (door-assist calls gotoOnce, which yields to us: deadlock). Sets
// forceUnsticking so concurrent gotos stand down instead of fighting the manual
// controls, and recoveringDepth so the flee/defend reflexes hold off.
async function forceUnstick (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const p0 = bot.entity.position.clone()
  forceUnsticking = true
  recoveringDepth++
  try {
    try { bot.pathfinder.setGoal(null) } catch {}
    bot.clearControlStates()
    const counts = {}
    const budgets = { water: 1, pit: 2, door: 0, climb: 2, nudge: 0, stepout: 2 }
    for (let i = 0; i < 4 && !isStopped(); i++) {
      const rescued = await recoverOnce(bot, null, counts, budgets, { isStopped })
      if (!rescued) break
      dbg('forceUnstick: ' + rescued + ' moved us to ' + bot.entity.position.floored())
      // keep going only while still boxed in (buried or pitted) - once in the open the
      // normal flows take back over
      const buried = prov().hasSolidCeiling(bot, 12, { ignoreLeaves: true })
      if (!buried && !detectPit(bot)) break
    }
  } finally { recoveringDepth--; forceUnsticking = false; bot.clearControlStates() }
  const p1 = bot.entity.position
  return Math.hypot(p1.x - p0.x, p1.z - p0.z) >= 1.5 || Math.abs(p1.y - p0.y) >= 1
}

function honestFail (lastErr, counts, label, recoveryMs) {
  const tried = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => k + ' x' + n).join(', ')
  const e = new Error(((lastErr && lastErr.message) || 'no path') + (tried ? ' (tried: ' + tried + ')' : ''))
  e.nav = { counts, recoveryMs: recoveryMs || 0 }
  return e
}

module.exports = { navigateTo, gotoOnce, openNearbyDoor, swimToShore, isNavigating, isRecovering, isForceUnsticking, forceUnstick, setDebugSink, detectPit, goalWasChanged }
