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
      if (b && !AIR_RE.test(b.name) && (opts.before == null || b.stateId !== opts.before)) return true
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
  for (;;) {
    try {
      const b = bot.blockAt(pos)
      if (!b || AIR_RE.test(b.name)) return true
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
            if (b && !AIR_RE.test(b.name)) dbg('dig at ' + pos.x + ',' + pos.y + ',' + pos.z + ' REJECTED by the server (block back: ' + b.name + ')')
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
    for (const fname of ['openBlock', 'openEntity']) {
      const orig = bot[fname].bind(bot)
      bot[fname] = async function (target, ...rest) {
        for (let attempt = 0; ; attempt++) {
          const w = await Promise.race([
            orig(target, ...rest).catch(e => ({ __err: e || new Error('open failed') })),
            new Promise(resolve => setTimeout(() => resolve(null), 5000))
          ])
          if (w && !w.__err) return w
          const why = w && w.__err ? (w.__err.message || 'open failed') : 'window did not open within 5s'
          if (attempt >= 1) throw new Error(fname + ': ' + why + ' (2 attempts, world-verified)')
          dbg(fname + ' attempt 1 failed (' + why + ') - closing any half-open window and retrying')
          try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
          await new Promise(r => setTimeout(r, 500))
        }
      }
    }
  }
  // forbid the planner from digging those cells: safeToBreak is the single gate every
  // dig move consults (prototype patch -> covers every Movements profile in the codebase)
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

  // PATH RELIABILITY (operator: "fix the pathfinding, it seems unreliable"): the stock
  // 5s think budget throws "Took too long to decide path" in tight/cluttered terrain
  // (getting into the cramped hut, around furniture). More compute per attempt + a bigger
  // per-tick slice makes short indoor paths actually resolve instead of bailing.
  try {
    if (bot.pathfinder) {
      bot.pathfinder.thinkTimeout = 20000 // ms to find a path (was 5000)
      bot.pathfinder.tickTimeout = 80     // ms of compute per tick (was 40)
      if ('searchRadius' in bot.pathfinder) bot.pathfinder.searchRadius = -1 // unbounded (default)
    }
  } catch {}
}

module.exports = { installPathfinderTuning, selfPlacedNear, isSelfPlaced, placedOK, brokeOK, setDebugSink }
