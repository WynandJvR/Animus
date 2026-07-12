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

// ---- the ONE deadline-goto ----------------------------------------------------------
// pathfinder.goto with a hard deadline. An unreachable target can hang goto FOREVER
// (verified live: froze a 432-block build for 10+ minutes; froze the whole brain loop).
// This used to exist as three identical copies (commands/provision/schematic).
function gotoOnce (bot, goal, ms = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { bot.pathfinder.setGoal(null) } catch {}
      reject(new Error('goto timed out'))
    }, ms)
    bot.pathfinder.goto(goal).then(
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } },
      e => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } }
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
async function openNearbyDoor (bot, opts = {}) {
  try {
    const md = require('minecraft-data')(bot.version)
    const ids = Object.values(md.blocksByName).filter(b => OPENABLE_RE.test(b.name) && b.name !== 'iron_door').map(b => b.id)
    const cands = (bot.findBlocks({ matching: ids, maxDistance: 16, count: 8 }) || [])
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    dbg('door-assist: ' + cands.length + ' door/gate candidates within 16')
    for (const p of cands) {
      const blk = bot.blockAt(p)
      if (!blk) continue
      let open = false
      try { const props = blk.getProperties(); open = props && (props.open === true || props.open === 'true') } catch {}
      // NOTE: an already-OPEN door still gets the walk-through below - the pathfinder
      // cannot ROUTE through door cells regardless of state (it only bumps them open on
      // direct lines), so "it's open" doesn't mean the planner will use it.
      try { await gotoOnce(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 15000) } catch (e) { dbg('door-assist: cannot reach door at ' + p + ' (' + e.message + ')'); continue }
      if (bot.entity.position.distanceTo(p) > 4) continue
      try {
        if (!open) {
          await bot.activateBlock(bot.blockAt(p))
          await new Promise(r => setTimeout(r, 350)) // let the door state land
          dbg('door-assist: opened ' + blk.name + ' at ' + p)
        } else dbg('door-assist: ' + blk.name + ' at ' + p + ' already open - walking through')
        // WALK THROUGH the doorway before re-planning: the pathfinder won't ROUTE
        // through even an open door that isn't on the direct line (verified in the hut
        // test - door opened, travel still "blocked"). But it CAN step INTO an open
        // doorway cell - so stand in the doorway first, then step out the far side
        // along the door's facing axis (height-tolerant: outside ground is often ±1).
        const base = p.y > Math.floor(bot.entity.position.y) ? p.offset(0, -1, 0) : p // upper half -> foot cell
        const before = bot.entity.position.clone()
        let facing = null
        try { facing = (bot.blockAt(base) && bot.blockAt(base).getProperties().facing) || null } catch {}
        const axis = (facing === 'east' || facing === 'west') ? [1, 0] : (facing === 'north' || facing === 'south') ? [0, 1] : [Math.abs(base.x + 0.5 - before.x) >= Math.abs(base.z + 0.5 - before.z) ? 1 : 0, 0]
        const dx = axis[0]; const dz = axis[0] === 1 ? 0 : 1
        // Exit toward OPEN SKY: "outside" is the side of the doorway with no ceiling.
        // (Away-from-where-I-stand flips when the bot is mid-doorway - verified: it
        // walked back INTO the hut. Ceiling check is position-independent.)
        const skyless = (cell) => { // solid cover within 12 above? (leaves are canopy, not ceiling)
          for (let dy = 2; dy <= 12; dy++) { const b = bot.blockAt(cell.offset(0, dy, 0)); if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return true }
          return false
        }
        const posSide = base.offset(dx * 2, 0, dz * 2); const negSide = base.offset(-dx * 2, 0, -dz * 2)
        let sign = 0; let how = ''
        if (opts.towards && typeof opts.towards.x === 'number') {
          // GOAL-AWARE crossing: exit toward the side that gets closer to where we're
          // actually going (entering a hut crosses INWARD; open sky would always pick
          // outside). Only when the goal clearly favors a side - a goal right at the
          // doorway says nothing about direction.
          const dPos = Math.hypot(posSide.x + 0.5 - opts.towards.x, posSide.z + 0.5 - opts.towards.z)
          const dNeg = Math.hypot(negSide.x + 0.5 - opts.towards.x, negSide.z + 0.5 - opts.towards.z)
          if (Math.abs(dPos - dNeg) > 0.75) { sign = dPos < dNeg ? 1 : -1; how = ' (toward goal)' }
        }
        if (!sign) {
          const posCovered = skyless(posSide); const negCovered = skyless(negSide)
          if (posCovered !== negCovered) { sign = posCovered ? -1 : 1; how = ' (open sky)' } // walk to the uncovered (outdoor) side
          else { sign = Math.sign((base.x + 0.5 - before.x) * dx + (base.z + 0.5 - before.z) * dz) || 1; how = ' (fallback)' }
        }
        dbg('door-assist: exit side ' + (dx ? (sign > 0 ? 'east' : 'west') : (sign > 0 ? 'south' : 'north')) + how)
        // Align on the inside cell in front of the door (pathfinder CAN reach that).
        try { await gotoOnce(bot, new goals.GoalBlock(base.x - dx * sign, base.y, base.z - dz * sign), 8000) } catch (e2) { dbg('door-assist: could not align (' + e2.message + ')') }
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
        // the pathfinder's native bump logic can TOGGLE the door shut again between our
        // open and our walk - re-open if needed right before crossing
        try { const b2 = bot.blockAt(base); const pr = b2 && b2.getProperties(); if (pr && !(pr.open === true || pr.open === 'true')) { await bot.activateBlock(b2); await new Promise(r => setTimeout(r, 250)); dbg('door-assist: re-opened before crossing') } } catch {}
        await walkTo(base.x + 0.5, base.z + 0.5, 0.45, 2500)                                    // into the doorway
        await walkTo(base.x + dx * sign * 2 + 0.5, base.z + dz * sign * 2 + 0.5, 0.6, 2500)     // out the far side
        const prog = (bot.entity.position.x - (base.x + 0.5)) * dx * sign + (bot.entity.position.z - (base.z + 0.5)) * dz * sign
        dbg('door-assist: force-walk ' + (prog > 1.2 ? 'THROUGH to ' : 'did not clear, at ') + bot.entity.position.floored())
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
function defaultBudgets () { return { water: 2, door: 3, pit: 2, climb: 2, nudge: 2 } }

async function recoverOnce (bot, goal, counts, budgets, opts) {
  const isStopped = opts.isStopped || (() => false)
  const p0 = bot.entity.position.clone()
  const movedEnough = () => {
    const p1 = bot.entity.position
    return Math.hypot(p1.x - p0.x, p1.z - p0.z) >= 2 || Math.floor(p1.y) > Math.floor(p0.y)
  }
  const xz = goalXZ(goal)
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
      // person, crossing toward the goal side.
      kind: 'door',
      when: () => true, // openNearbyDoor itself scans (16 blocks) and returns false fast when there's none
      run: async () => openNearbyDoor(bot, { towards: xz })
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
async function navigateTo (bot, goal, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000
  const deadline = Date.now() + (opts.deadlineMs || Math.max(90000, timeoutMs * 4))
  const isStopped = opts.isStopped || (() => false)
  const budgets = Object.assign(defaultBudgets(), opts.budgets || {})
  const counts = {}
  const label = opts.label ? opts.label + ': ' : ''
  let interrupts = 0
  let recoveries = 0
  let recoveryMs = 0
  navDepth++
  try {
    for (;;) {
      if (isStopped()) throw new Error('stopped')
      if (opts.movements) { try { bot.pathfinder.setMovements(opts.movements()) } catch {} }
      let lastErr
      try {
        await gotoOnce(bot, goal, Math.min(timeoutMs, Math.max(2000, deadline - Date.now())))
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
        continue
      }
      if (Date.now() >= deadline || isStopped()) throw honestFail(lastErr, counts, label, recoveryMs)
      const r0 = Date.now()
      const rescued = await recoverOnce(bot, goal, counts, budgets, opts)
      recoveryMs += Date.now() - r0
      if (!rescued) throw honestFail(lastErr, counts, label, recoveryMs)
      recoveries++
      dbg(label + 'recovered via ' + rescued + ' - retrying the path')
    }
  } finally { navDepth-- }
}

function honestFail (lastErr, counts, label, recoveryMs) {
  const tried = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => k + ' x' + n).join(', ')
  const e = new Error(((lastErr && lastErr.message) || 'no path') + (tried ? ' (tried: ' + tried + ')' : ''))
  e.nav = { counts, recoveryMs: recoveryMs || 0 }
  return e
}

module.exports = { navigateTo, gotoOnce, openNearbyDoor, isNavigating, isRecovering, setDebugSink, detectPit, goalWasChanged }
