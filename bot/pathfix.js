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

// §4: one definition of the sink rule; this module still owns its own sink. index.js injects
// it so debug lines persist to logs/bot-events.log.
const { dbg, setDebugSink } = require('./debug-sink.js').makeDebug('[verify]')
let progressSink = null // S7 H3: injected by index.js (commands.touchProgress) - fired ONLY on a VERIFIED place/break transition
function setProgressSink (fn) { progressSink = fn }

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

// ---- BOUNDED BODY PRIMITIVES (ROOT A, 2026-08-02) ------------------------------------
// mineflayer's dig() and look() end in `await task.promise`, and those tasks settle ONLY on
// an event that a chunk unload / a lost server echo can simply never deliver:
//   digging.js:192  onBlockUpdate returns early unless newBlock?.type === 0, and every
//                   blockUpdate listener gets (null, null) on unload -> null?.type !== 0.
//   digging.js:143  finishDigging then nulls bot.targetDigBlock, so digging.js:166's
//                   `if (!bot.targetDigBlock) return` makes bot.stopDigging() a NO-OP - the
//                   per-position blockUpdate listener is the only settle path left.
//   physics.js:354  await lookingTask.promise, finished only by a converged 'move' event or
//                   by the NEXT bot.look() call (physics.js:330-331).
// An await that can never return defeats every cooperative `isStopped()/deadline` loop in the
// codebase: ensurePillarFiller checks its deadline at the loop TOP and then hangs forever on
// `await bot.dig(b)` (provision-recovery.js:274/285). The bound is what re-arms the cooperative
// model - once no single await can outlive its own physics, every loop is back at its own check
// within one bound. So the rule lives HERE, at the primitive, not at 55 call sites (#4).
const DIG_GRACE_MS = 10000       // dig bound = bot.digTime(block) + this. digTime is the engine's
                                 // own answer for this block/tool, so a legitimately slow dig
                                 // (obsidian by hand) is never falsely cut; the grace covers look
                                 // convergence + server echo lag.
const LOOK_BOUND_MS = 2000       // a look converges in a few 50ms physics ticks
const CUT_SETTLE_GRACE_MS = 250  // how long the cutter waits for the forced settle to land

// ---- CRAFT BOUND (ROOT F, 2026-08-02) ------------------------------------------------
// CORRECTION TO THE BRIEF, read not guessed: `once(emitter, event, timeout = 20000)`
// (mineflayer/lib/promise_utils.js:75) DEFAULTS to a 20s timeout, and onceWithCleanup removes
// its listener when that fires (:70). So craft.js:40's `await once(bot, 'windowOpen')` is not
// an eternal await - it rejects after 20s. provision.js:2872's `if (!/windowOpen/.test(...))`
// retry is the live proof: that error is reachable, so it is thrown.
//
// The defect is therefore not "never settles", it is "settles far too late, several times over".
// EVERY window round-trip inside a craft carries its own 20s allowance: the window open, plus
// (on 1.21, where transactionPacketExists is false) each grid-slot click via
// waitForWindowUpdate -> once(window,'updateSlot:0') (inventory.js:456-459), plus putAway's
// once(window,'updateSlot:N') (inventory.js:650). A 3x3 recipe is up to 20 such round-trips, so
// one craftOnce can legitimately hold the body for minutes. Live 2026-08-02: the recovery ladder
// ran `craft:crafting_table > craft:stick > craft:wooden_hoe` from a crawlspace under the hut
// floor where no table could be reached or placed; at ~20s per window-open failure plus
// provision.js's re-approach-and-retry that is ~55s per item, ~165s for the chain - which is
// exactly the `no verified progress for 154s` the watchdog measured before revoking the slot.
//
// The bound is derived from the engine's own per-round-trip answer, WINDOW_TIMEOUT = 5000
// (inventory.js:16) - the considered number, as opposed to `once`'s generic 20000 default - and
// from the click count:
//   +1 WINDOW_TIMEOUT: the ONE round-trip we allow to be pathologically slow. If more than one
//                      is that slow the craft is not progressing.
//   +1 WINDOW_TIMEOUT: the whole click sequence. craftOnce's worst case is ~20 round-trips
//                      (1 open + <=18 grid clicks + putAway + the out-shape putAways); at the
//                      server's 50ms tick a healthy sequence costs ~1s, so this is 5x headroom.
// = 10000ms per craftOnce, which is deliberately HALF `once`'s 20s default, so this bound always
// wins deterministically instead of racing the engine's own timeout. bot.craft loops craftOnce
// `count` times (craft.js:19-21), so the bound scales with count - it is a per-craft budget, not
// a per-call one.
const WINDOW_TIMEOUT_MS = 5000   // mineflayer's own WINDOW_TIMEOUT (inventory.js:16), restated
const CRAFT_BOUND_MS = WINDOW_TIMEOUT_MS * 2 // per craftOnce; x count in the wrapper

// THE one bounded await for raw mineflayer body promises. Races `promise` against `ms`.
//   settles first  -> its outcome passes through untouched (resolve OR reject).
//   deadline first -> run `settle()` (the primitive-specific force-settle), wait up to
//                     CUT_SETTLE_GRACE_MS for the underlying to land, then ALWAYS throw
//                     `<label> cut after <ms>ms (bounded)` regardless of whether it landed.
//                     Deterministic contract, so it is testable and callers cannot branch on luck.
// The raw promise's ONLY continuation is the bookkeeping wrapper below, which never rejects and
// never runs caller code. That is what makes "a hung call resolving into a dead context" -
// a second body-mover appearing minutes later - unrepresentable rather than merely unlikely.
async function bounded (label, promise, ms, settle) {
  const t0 = Date.now()
  let settled = false
  const tracked = Promise.resolve(promise).then(
    v => { settled = true; return { ok: true, v } },
    e => { settled = true; return { ok: false, e } }
  )
  let cutTimer = null
  const outcome = await Promise.race([tracked, new Promise(r => { cutTimer = setTimeout(() => r(null), ms) })])
  clearTimeout(cutTimer)
  if (outcome) { if (outcome.ok) return outcome.v; throw outcome.e }
  try { if (settle) settle() } catch (e) { dbg('(bounded) ' + label + ' settle action threw: ' + (e && e.message)) }
  let graceTimer = null
  await Promise.race([tracked, new Promise(r => { graceTimer = setTimeout(r, CUT_SETTLE_GRACE_MS) })])
  clearTimeout(graceTimer)
  const inGrace = settled
  if (!inGrace) tracked.then(() => { try { dbg('(bounded) ' + label + ' settled LATE after ' + (Date.now() - t0) + 'ms - result discarded') } catch {} })
  dbg('(bounded) ' + label + ' cut after ' + ms + 'ms - settle sent, underlying settled=' + (inGrace ? 'yes' : 'no') + ' within ' + CUT_SETTLE_GRACE_MS + 'ms')
  throw new Error(label + ' cut after ' + ms + 'ms (bounded)')
}

// The dig force-settle. TWO paths, because there are two shapes of stuck dig:
//  1. the task is still armed (finishDigging has not run) -> stopDigging() cancels it properly.
//  2. THE LIVE HANG: finishDigging already fired, targetDigBlock is null, stopDigging returned
//     at digging.js:166 without touching the task, and the per-position blockUpdate listener is
//     the only thing that can still finish it. Emit that event with a type-0 newBlock so
//     onBlockUpdate (digging.js:192) runs its own cleanup and finishes the task.
// oldBlock null is fine - onBlockUpdate inspects only newBlock.type. And finishDigging has
// already zeroed the cell locally (digging.js:158), so this asserts nothing about the world
// that mineflayer has not already assumed. Nothing in bot/ listens on 'blockUpdate:<pos>', and
// mineflayer-pathfinder listens on the GENERIC 'blockUpdate' (its index.js:398), not this one.
function forceSettleDig (bot, block) {
  try { bot.stopDigging() } catch {}
  try {
    const p = block && block.position
    if (p) bot.emit('blockUpdate:' + p, null, { type: 0, position: p })
  } catch {}
}

// The craft force-settle. It does exactly what craft() itself does on ANY craft error
// (craft.js:27-33) - the library's own cleanup, executed by us because the library's error path
// is unreachable while its promise is still pending. Two parts, and the FIRST one is the one
// that matters:
//
//  1. UNHOOK the craft's own pending `once(bot, 'windowOpen')` (craft.js:40). Left in place it is
//     a live one-shot listener with up to 20s to run: the next window ANY job opens would resolve
//     the abandoned craft, which then reads e.g. a CHEST as its crafting table, throws
//     'non craftingTable used as craftingTable' (craft.js:43-45), and craft()'s catch CLOSES THAT
//     WINDOW (craft.js:28-31) - a second body-mover slamming a container shut under the job that
//     opened it, minutes after the caller gave up. bounded()'s bookkeeping wrapper cannot prevent
//     this: it stops CALLER code from running late, not the library's own internals. Removing the
//     listener leaves the abandoned promise pending forever and genuinely inert. Only listeners
//     THIS call added are removed (snapshot taken before the call), so a concurrent opener's
//     listener is never touched.
//  2. CLOSE our table window if one is open. NARROW ON PURPOSE - a crafting window only; a
//     chest/furnace window is somebody else's and is never closed here. This cannot corrupt the
//     inventory: closeWindow copies the window's inventory section back into bot.inventory
//     (inventory.js:412/417-427), and vanilla returns an unfinished grid to the player as drops at
//     his feet - which is strictly better than leaving it stranded in a window nothing will ever
//     close. In the live shape (stuck at the window OPEN) nothing has been clicked at all, so
//     there is no half-completed craft to lose.
function forceSettleCraft (bot, listenersBefore) {
  let unhooked = 0
  try {
    const before = listenersBefore || []
    for (const l of bot.listeners('windowOpen')) {
      if (!before.includes(l)) { bot.removeListener('windowOpen', l); unhooked++ }
    }
  } catch {}
  let closed = 'none'
  try {
    const w = bot.currentWindow
    if (w && /crafting/.test(w.type || '')) { bot.closeWindow(w); closed = 'crafting' }
    else if (w) closed = 'left ' + w.type + ' alone (not mine)'
  } catch (e) { closed = 'close threw: ' + (e && e.message) }
  dbg('(bounded) craft force-settle: unhooked ' + unhooked + ' pending windowOpen wait(s), window=' + closed)
}

// ---- THE BODY-PRIMITIVE REGISTRY (ROOT G, 2026-08-02) --------------------------------
// WHY THIS EXISTS. Cancellation in this codebase is COOPERATIVE: every loop polls isStopped()
// or its own deadline BETWEEN awaits. So a single `await bot.<x>(...)` that does not settle
// defeats the whole model - the loop never gets back to its own check. ROOT A bounded dig and
// look, ROOT F bounded craft, and each time the hang moved to a different entry point. Fixing
// them one at a time cannot close a CLASS; only an enumeration can.
//
// SO THE ENUMERATION IS THE ARTEFACT, and it lives here as data. Every `await bot.X(` that
// appears anywhere in bot/*.js must have a row below - either in BODY_BOUNDS (pathfix installs
// the wrapper) or in NATIVELY_BOUNDED (mineflayer already bounds it, and the row cites the
// file:line that does). bodyboundtest.js re-derives the enumeration FROM SOURCE and fails when
// a call site appears for an entry point nobody has classified. That test, not any wrapper, is
// what stops the fifth recurrence.
//
// A CORRECTION TO THE ENUMERATION THE WORK STARTED FROM. The command
//     grep -rhoE "await bot\.[a-zA-Z_]+\(" --include=*.js bot/ | grep -v node_modules
// reports 37 distinct entry points. It is wrong: `-h` suppresses the filename, so the
// `grep -v node_modules` filter has nothing to match on and mineflayer's OWN internal
// `await bot.X(` calls are counted as ours. The true set - `for f in bot/*.js; do grep -ohE ...`
// - is 18. The 19 phantoms (openBlock/openEntity/openVillager/openAnvil/openEnchantmentTable/
// putAway/moveSlotItem/transfer/putSelectedItemRange/tossStack/unequip/trade/fish/elytraFly/
// writeBook/tabComplete/waitForTicks/waitForChunksToLoad/placeEntity/_genericPlace) are lines
// inside bot/node_modules/mineflayer/lib/plugins/*.js. They are still classified below where
// they are REACHED indirectly (openBlock, putAway, clickWindow, transfer...), because that is
// what actually bounds our call.
//
// AND THE FINDING, stated plainly: after reading the library source for all 18, NONE of the
// entry points our code awaits is unbounded today. Adding a wrapper to any of them would be a
// new guard in front of working behaviour, which principle #1 calls a patch. What was missing
// was not a bound - it was the WRITTEN-DOWN, TESTED enumeration. That is what this is.
//
// Row shape: { by, where, cut, worstMs }
//   by      what makes the await settle, in one line
//   where   the file:line that does it (library path relative to bot/node_modules/mineflayer/)
//   cut     what a caller sees when the bound bites: 'throws' | 'succeeds' | 'n/a'
//   worstMs the static worst case where one exists; null when it is derived at call time
const MF = 'mineflayer/lib/plugins/'

// Wrapped HERE, in installPathfinderTuning. One rule, one definition: the numbers are the
// consts above, not copies of them.
const BODY_BOUNDS = {
  dig: { by: 'pathfix bounded() + forceSettleDig; cut is re-judged against the world by brokeOK', where: 'pathfix.js bot.dig wrapper', cut: 'throws', worstMs: null, bound: 'bot.digTime(block) + DIG_GRACE_MS' },
  look: { by: 'pathfix bounded(); the settle IS the requested look, forced', where: 'pathfix.js bot.look wrapper', cut: 'succeeds', worstMs: LOOK_BOUND_MS, bound: 'LOOK_BOUND_MS' },
  craft: { by: 'pathfix bounded() + forceSettleCraft', where: 'pathfix.js bot.craft wrapper', cut: 'throws', worstMs: null, bound: 'CRAFT_BOUND_MS * count' },
  placeBlock: { by: 'pathfix verifiedPlace: bounded lookAt + placedOK poll deadline', where: 'pathfix.js verifiedPlace', cut: 'throws', worstMs: 1200 + LOOK_BOUND_MS, bound: 'LOOK_BOUND_MS + placedOK timeoutMs 1200' },
  _placeBlockWithOptions: { by: 'same wrapper as placeBlock (this IS the wrapped primitive)', where: 'pathfix.js verifiedPlace', cut: 'throws', worstMs: 1200 + LOOK_BOUND_MS, bound: 'LOOK_BOUND_MS + placedOK timeoutMs 1200' },
  // The window race below. NOTE for whoever reads this next: its worst case is large -
  // 2 attempts x (gotoOnce 12000 + lookAt + race 5000/8000) + the LOS face-walk goto - and the
  // abandoned attempt's `once(bot,'windowOpen')` (20s, promise_utils.js:75) is NOT unhooked the
  // way forceSettleCraft unhooks craft's. It is BOUNDED, so it is not the hang class; it is the
  // slowest bounded body call in the codebase and the one place a late settle can still touch a
  // window somebody else opened.
  openBlock: { by: 'pathfix window race + one retry + reach disambiguation', where: 'pathfix.js openBlock/openEntity wrapper', cut: 'throws', worstMs: 2 * (12000 + LOOK_BOUND_MS) + 5000 + 8000 + 500, bound: '2 attempts of (approach goto + lookAt + open race)' },
  openEntity: { by: 'pathfix window race + one retry + reach disambiguation', where: 'pathfix.js openBlock/openEntity wrapper', cut: 'throws', worstMs: 2 * (12000 + LOOK_BOUND_MS) + 5000 + 8000 + 500, bound: '2 attempts of (approach goto + lookAt + open race)' }
}

// NOT wrapped, ON PURPOSE. mineflayer already bounds these; the row says with what. Adding a
// wrapper here would be a second definition of a bound that already exists (#4) and a guard in
// front of working behaviour (#1). Every claim was read in the installed source, not assumed.
const NATIVELY_BOUNDED = {
  lookAt: { by: 'delegates to bot.look by dynamic dispatch, so the look wrapper covers it', where: MF + 'physics.js:357', cut: 'succeeds', worstMs: LOOK_BOUND_MS },
  openContainer: { by: 'delegates to bot.openBlock / bot.openEntity, so the wrapper above covers it', where: MF + 'chest.js:19,21', cut: 'throws', worstMs: BODY_BOUNDS.openBlock.worstMs },
  openFurnace: { by: 'delegates to bot.openBlock, so the wrapper above covers it', where: MF + 'furnace.js:16', cut: 'throws', worstMs: BODY_BOUNDS.openBlock.worstMs },
  activateBlock: { by: 'awaits only bot.lookAt(pos,false); the interact itself is a synchronous packet write', where: MF + 'inventory.js:195', cut: 'succeeds', worstMs: LOOK_BOUND_MS },
  activateEntity: { by: 'awaits only bot.lookAt(pos,false); the use_entity packet is a synchronous write', where: MF + 'inventory.js:245', cut: 'succeeds', worstMs: LOOK_BOUND_MS },
  activateEntityAt: { by: 'awaits only bot.lookAt(pos,false); the use_entity packet is a synchronous write', where: MF + 'inventory.js:256', cut: 'succeeds', worstMs: LOOK_BOUND_MS },
  attack: { by: 'fully SYNCHRONOUS (returns undefined) - awaiting it can never suspend', where: MF + 'entities.js:839', cut: 'n/a', worstMs: 0 },
  wake: { by: 'one synchronous entity_action write; no await inside', where: MF + 'bed.js:67', cut: 'n/a', worstMs: 0 },
  consume: { by: 'withTimeout(eatingTask.promise, CONSUME_TIMEOUT)', where: MF + 'inventory.js:14,112', cut: 'throws', worstMs: 2500 },
  sleep: { by: 'waitUntilSleep(): a 3s setTimeout that REJECTS with "bot is not sleeping"', where: MF + 'bed.js:156-167', cut: 'throws', worstMs: 3000 },
  // The window family. On 1.21 `transactionPacketExists` is FALSE (minecraft-data: 1.8..1.16.5),
  // so clickWindow does NOT take the WINDOW_TIMEOUT branch at inventory.js:636 - it takes
  // waitForWindowUpdate (inventory.js:644), which awaits nothing at all unless the window is the
  // 2x2 inventory grid (slots 1-4), a crafting table (slots 1-9) or a merchant. For every
  // container window - which is every clickWindow our code makes - it returns immediately.
  // Where it DOES await, it is `once(...)`, whose default timeout is 20000 (promise_utils.js:75),
  // not infinity. NOTE the brief's claim that equip is bounded by WINDOW_TIMEOUT=5000 at
  // inventory.js:636 is true only on <=1.16.5; on this server that line is unreachable.
  clickWindow: { by: 'waitForWindowUpdate returns immediately for container windows; where it waits it is once() with its 20000 default', where: MF + 'inventory.js:451-478,644 + promise_utils.js:75', cut: 'throws', worstMs: 20000 },
  equip: { by: 'moveSlotItem -> clickWindow on bot.inventory at slots 5-8/36-45, none of which is the 1-4 grid range waitForWindowUpdate waits on', where: MF + 'simple_inventory.js:88-126', cut: 'throws', worstMs: 20000 },
  toss: { by: 'transfer -> clickWindow; the transferOne recursion is driven by `count`, not by an event', where: MF + 'simple_inventory.js:29 + ' + MF + 'inventory.js:284', cut: 'throws', worstMs: 20000 },
  // Its own setTimeout REJECTS at ticks*50 + 5000 and removes the physicsTick listener, so it can
  // never outlive that even on a frozen server. worstMs is quoted for the longest wait our code
  // asks for (autoCollect's 10-tick pickup settle = 5500ms); a longer call would scale from there.
  waitForTicks: { by: 'its own setTimeout rejects at ticks*50 + 5000ms and detaches the physicsTick listener', where: MF + 'physics.js:453-461', cut: 'throws', worstMs: 5500 }
}

// One row per entry point, whichever half it lives in. Consumed by bodyboundtest.js.
function bodyEntryPointRow (name) { return BODY_BOUNDS[name] || NATIVELY_BOUNDED[name] || null }

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

// ==== TERRAIN HAS WIDTH; LITTER, LEDGES AND BRIDGES DO NOT (2026-08-26, live) ==========
// This file's surface locator and provision-hut.hasSolidCeiling are the same world-read pointed
// in opposite directions - "what is the top of my column" and "is there a roof over my column" -
// and BOTH answered by scanning ONE column and trusting the first solid cell they met. A column
// is one block wide, so a single strip of blocks floating in open air is, to both of them,
// indistinguishable from forty metres of overburden.
//
// Live 2026-08-26, spawn: a 1-wide, 3-long grass strip at y65 hung over the bot's crater at
// (0,61,-2) - our own unregistered litter. From that one strip:
//   - hasSolidCeiling said ROOFED, so isUnderground() said true, so secureFood deferred the
//     wheat farm as a "real cave roof" and every craft/regroup was gated off;
//   - unstickPlan therefore led every rescue with the climb rung, ahead of nudge/stepout - the
//     two rungs that would simply have walked it out;
//   - surfaceYAt called the top of the strip THE SURFACE, so that climb was aimed at y66, a
//     cell on top of a one-block ledge, and could never report arrival.
// 19 recorded failures in one cell, hours of it, one step from open grass. The operator's words:
// "its literally stuck in a small crater it can easily walk/break out of."
//
// The distinguishing fact is EXTENT. Real ground and a real cave roof continue sideways; a
// bridge, an overhang lip, a branch and our own abandoned scaffold are one block wide with air
// on both sides - you step out from under them, you do not cut through them. Asked ONCE, here,
// so the two readers cannot disagree about it (#4: one definition of one rule).
//
// SKIPPING IS SAFE BECAUSE IT CONTINUES THE SCAN, not because it decides anything: a narrow rib
// under real overburden is skipped and the broad stone above it is still found, so a cave stays
// a cave. The only thing that changes is that a speck can no longer BE the answer.
//
// Unknown cells count as SOLID. "Narrow" is the permissive verdict - it is what stops a roof
// being a roof - so an unreadable neighbour must never be the reason we reach it (fail closed:
// an unloaded chunk keeps exactly today's answer).
function isNarrowSpan (bot, x, y, z, opts = {}) {
  const maxWidth = Number.isFinite(opts.maxWidth) ? opts.maxWidth : 1
  const solidAt = (dx, dz) => {
    const r = readCell(bot, { x: x + dx, y, z: z + dz })
    if (!r.known) return true // unreadable -> assume terrain
    return !!r.block && r.block.boundingBox === 'block' && !AIR_RE.test(r.block.name)
  }
  for (const [ax, az] of [[1, 0], [0, 1]]) {
    let run = 1 // the cell itself
    for (const sign of [1, -1]) {
      for (let d = 1; d <= maxWidth; d++) {
        if (!solidAt(ax * d * sign, az * d * sign)) break
        run++
      }
    }
    if (run <= maxWidth) return true // you can step sideways out from under this
  }
  return false
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
    //
    // ==== 2026-08-25 (review D5/§3.4): AND NEITHER IS OUR OWN HOUSE =====================
    // FIX 8 skipped registered SCAFFOLD and stopped there, so the other half of the bot's own
    // masonry still read as terrain: its hut roof slab, its walls, its floor. Live 2026-08-03
    // at (190,69,-100) that produced a "surface" at y72 - the hut's roof course - which the
    // climb rung then tried to reach by cutting, and digBlocked (correctly) refused: 243
    // `climb -> no progress` lines two blocks from the bot's own bed. One subsystem's
    // protected structure was another subsystem's terrain.
    // self-world.ownBlockAt is now the ONE definition of "this solid block is mine, not the
    // world's", shared with provision-hut.hasSolidCeiling scanning the other way. Skipping it
    // makes this scan describe the WORLD - which is the only thing it ever claimed to do.
    if (isGroundBlock(r.block)) {
      let ours = null
      try { ours = require('./self-world.js').ownBlockAt({ x: X, y, z: Z }) } catch {}
      if (ours) continue // our own tower/bridge/roof/wall/floor - keep looking for real ground beneath it
      // ...AND NEITHER IS A ONE-BLOCK LEDGE, whoever left it (2026-08-26). The registry above can
      // only disown litter it still REMEMBERS, and it is lossy by construction - a reset, a crash, a
      // block placed before the registry existed, or a dirt tower the world quietly turned to grass.
      // The live 1x3 strip at y65 over (0,61,-2) was in no registry, so this scan called it THE
      // SURFACE and every climb was aimed five blocks up at the top of a one-block bridge. Extent is
      // the world-read that needs no memory: see isNarrowSpan above.
      if (isNarrowSpan(bot, X, y, Z)) continue // a ledge/branch/bridge - not the top of the terrain
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
      // ANTI-BRICK (2026-08-02). THIS is where the place rule belongs, for the same reason the
      // three patches below live here: it is the ONE placement primitive. bot.placeBlock is
      // rebuilt on it, mineflayer-builder's tryPlace calls it directly (index.js:95) and
      // mineflayer-pathfinder's own scaffolding goes through bot.placeBlock (index.js:556) - so
      // a guard at any CALLER (placeAt, pillarUpTo, the builder) would leave the library's own
      // placements unguarded, and the library's are the ones that drop filler on the furniture
      // while merely walking past. A refusal THROWS, which is the failure shape every caller
      // already handles (placeAt returns false with the blocker, pillarUpTo retries elsewhere,
      // the pathfinder resetPath('place_error')s and re-paths).
      const heldName = bot.heldItem && bot.heldItem.name
      const refuse = require('./provision-core.js').placeBlocked(bot, target, heldName)
      if (refuse) {
        dbg('REFUSING to place ' + heldName + ' at ' + Math.floor(target.x) + ',' + Math.floor(target.y) + ',' + Math.floor(target.z) + ' - ' + refuse + ' (that cell must stay open; clear the blocker or place elsewhere)')
        throw new Error(`refusing to place ${heldName} at ${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}: ${refuse}`)
      }
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
    // THE PLAN IS EVIDENCE (2026-08-26, #7). Every computed path used to be invisible: the operator
    // watched the bot punch a stone wall with a clear exit beside it, and nothing in the tape said
    // "the planner chose 2 digs over 12 steps because those steps cost 41 each". One line per
    // computed path, with the numbers that decide it - status, length, digs, placements, first dig
    // cell - so a bad plan is readable the moment it is made, not reverse-engineered from a stall.
    // Throttled to one line per 2s per status so a partial-path re-plan loop stays greppable, not
    // a flood ([[body-first-priority]]: this runs per plan, never per tick).
    if (!bot.__pathfixPlanLog) {
      bot.__pathfixPlanLog = true
      // ...and why the library dropped a path it was following (stuck / dig_error / place_error /
      // goal_moved ...): the other half of the plan story, throttled per reason.
      let lastResetAt = 0; let lastResetWhy = ''
      let lastPlan = null // the path the library is following (it assigns results.path after emitting)
      bot.on('path_update', (r) => { if (r && Array.isArray(r.path)) lastPlan = r.path })
      bot.on('path_reset', (why) => {
        const now = Date.now()
        if (why === lastResetWhy && now - lastResetAt < 2000) return
        lastResetWhy = why; lastResetAt = now
        try {
          const p = bot.entity.position
          let detail = ''
          if (why === 'stuck') {
            // THE PHYSICAL FACTS of not reaching the next node - so "stuck" names a cause, not a feeling:
            // where the node is and how far, what the controls were doing, whether the physics had ground,
            // and what the world says at the feet/head cells here and at the node.
            const n = lastPlan && lastPlan.length ? lastPlan[0] : null
            const { Vec3 } = require('vec3')
            const nm = v => { try { const b = bot.blockAt(v); return b ? b.name : '?' } catch { return '?' } }
            const cs = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].filter(k => { try { return bot.controlState[k] } catch { return false } }).join('+') || 'none'
            const v = bot.entity.velocity
            detail = ' - next node ' + (n ? n.x + ',' + n.y + ',' + n.z + ' (' + Math.hypot(n.x + 0.5 - p.x, n.z + 0.5 - p.z).toFixed(2) + 'b away, dy ' + (n.y - Math.floor(p.y)) + (n.toBreak && n.toBreak.length ? ', ' + n.toBreak.length + ' dig' : '') + (n.toPlace && n.toPlace.length ? ', ' + n.toPlace.length + ' place' : '') + ')' : 'none') +
              ', me ' + p.x.toFixed(2) + ',' + p.y.toFixed(2) + ',' + p.z.toFixed(2) + ' onGround=' + bot.entity.onGround + ' vel=' + v.x.toFixed(2) + ',' + v.y.toFixed(2) + ',' + v.z.toFixed(2) + ' controls=' + cs +
              ' | here feet=' + nm(p.floored()) + ' head=' + nm(p.floored().offset(0, 1, 0)) + ' below=' + nm(p.floored().offset(0, -1, 0)) +
              (n ? ' | node feet=' + nm(new Vec3(n.x, n.y, n.z)) + ' head=' + nm(new Vec3(n.x, n.y + 1, n.z)) + ' below=' + nm(new Vec3(n.x, n.y - 1, n.z)) : '')
          }
          dbg('plan: RESET (' + why + ') at ' + p.floored() + detail)
        } catch (e) { dbg('plan: RESET (' + why + ')') }
      })
      let lastPlanAt = 0; let lastPlanKey = ''
      bot.on('path_update', (r) => {
        try {
          if (!r || !Array.isArray(r.path)) return
          // A GUESS MAY WALK, NEVER CUT (2026-08-26, live). A 'partial' result is the best node the
          // search reached in one 40ms tick - a guess, refined on the next tick - and the library
          // executes it as if it were the plan: at the spawn crater the 40ms guess put a bare-hand
          // stone dig first, the bot started the 7.5s dig, the full plan (13 steps, no digs, cost 20)
          // arrived 200ms later and had to wait for the dig, the dig was cut, the path reset, and the
          // next tick's guess dug the same wall again - the operator watched it "mining into a stone
          // wall with a clear path out". Walking the free prefix of a guess is harmless; committing a
          // block on one is not. `results.path` is the array the pathfinder will follow (it assigns
          // after emitting), so the truncation is what runs.
          const cut = truncatePartialPlan(r.path, r.status)
          if (cut) dbg('plan: partial - holding ' + cut + ' move(s) that dig/place until the search completes (a guess may walk, never cut)')
          const digs = r.path.reduce((n, m) => n + ((m.toBreak && m.toBreak.length) || 0), 0)
          const places = r.path.reduce((n, m) => n + ((m.toPlace && m.toPlace.length) || 0), 0)
          const key = r.status + ':' + (digs > 0) + ':' + (places > 0)
          const now = Date.now()
          if (key === lastPlanKey && now - lastPlanAt < 2000) return
          lastPlanKey = key; lastPlanAt = now
          const last = r.path.length ? r.path[r.path.length - 1] : null
          let firstDig = null
          for (const m of r.path) { if (m.toBreak && m.toBreak.length) { firstDig = m.toBreak[0]; break } }
          const first = r.path.length ? r.path[0] : null
          dbg('plan: ' + r.status + ' ' + r.path.length + ' move(s)' + (first ? ' via ' + first.x + ',' + first.y + ',' + first.z : '') + (last ? ' to ' + last.x + ',' + last.y + ',' + last.z : '') +
            (digs ? ', ' + digs + ' dig(s) first at ' + firstDig.x + ',' + firstDig.y + ',' + firstDig.z : '') + (places ? ', ' + places + ' placement(s)' : '') +
            (Number.isFinite(r.cost) ? ', cost ' + Math.round(r.cost) : '') + (r.time != null ? ', ' + Math.round(r.time) + 'ms' : ''))
        } catch {}
      })
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
        // ROOT A: the dig is BOUNDED by the engine's own physics answer for this block/tool.
        // A cut throws, which lands in the catch below and is re-judged against the world by
        // brokeOK - so a cut dig whose block is actually gone still resolves as the success it
        // was, and a cut dig whose block still stands rethrows into the failure path all 55
        // call sites already have. No call site changes; no success-shaped timeout exists.
        let digMs = 5000 + DIG_GRACE_MS
        try { const t = bot.digTime(block); if (Number.isFinite(t) && t >= 0) digMs = t + DIG_GRACE_MS } catch {}
        await bounded('dig at ' + (pos ? pos.x + ',' + pos.y + ',' + pos.z : '?'), origDig(block, ...rest), digMs,
          () => forceSettleDig(bot, block))
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

    // LOOK BOUND (ROOT A). Wrapping bot.look covers bot.lookAt (physics.js:357 calls
    // bot.look by dynamic dispatch), dig's own pre-dig look (digging.js:121) and
    // activateBlock's (inventory.js:195) - so a stalled head no longer hangs digs, doors
    // and levers. A FORCED look never awaits the task (physics.js:325-328), so it cannot
    // hang and is passed straight through untouched (the pathfinder's per-tick
    // bot.look(yaw, 0) at its index.js:607 is the only hot caller and it is fire-and-forget).
    // A CUT look is a SUCCESS, not an error: the settle action IS the requested look, forced -
    // it finishes the stuck lookingTask (physics.js:330-331) and snaps the head. Callers see
    // no change beyond "never hangs".
    const origLook = bot.look.bind(bot)
    bot.look = async function (yaw, pitch, force) {
      if (force) return origLook(yaw, pitch, true)
      try {
        return await bounded('look', origLook(yaw, pitch, false), LOOK_BOUND_MS,
          () => { try { const p = origLook(yaw, pitch, true); if (p && p.catch) p.catch(() => {}) } catch {} })
      } catch (e) {
        if (/cut after/.test((e && e.message) || '')) return // the forced look DID the look
        throw e
      }
    }

    // CRAFT BOUND (ROOT F). bot.craft is the one body primitive that bypasses the openBlock
    // wrapper below entirely: it calls `bot.activateBlock` + `once(bot,'windowOpen')` itself
    // (craft.js:39-41), so none of the reach disambiguation, retry or deadline under this comment
    // has ever applied to it. Bounding it HERE covers all 12 bot.craft( call sites in bot/ by
    // dynamic dispatch, exactly as the dig and look wrappers do - no call site migrates, and every
    // one of them already has a failure path, because bounded() reports a cut as a THROW.
    const origCraft = typeof bot.craft === 'function' ? bot.craft.bind(bot) : null
    if (origCraft) bot.craft = async function (recipe, count, craftingTable) {
      const n = Math.max(1, parseInt(count ?? 1, 10) || 1)
      let what = 'recipe'
      try {
        const id = recipe && recipe.result && recipe.result.id
        const it = id != null && bot.registry && bot.registry.items && bot.registry.items[id]
        what = (it && it.name) || ('item#' + id)
      } catch {}
      // snapshot BEFORE the call so the settle can tell this craft's windowOpen wait from anyone
      // else's (see forceSettleCraft)
      let before = []
      try { before = bot.listeners('windowOpen').slice() } catch {}
      return bounded('craft ' + what + ' x' + n + (craftingTable ? ' at a table' : ' in the 2x2'),
        origCraft(recipe, count, craftingTable), CRAFT_BOUND_MS * n,
        () => forceSettleCraft(bot, before))
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
      // EVERY profile is hardened the moment it is handed to the planner - one hook, five profiles.
      if (!bot.pathfinder.__hardenedSet) {
        bot.pathfinder.__hardenedSet = true
        const origSet = bot.pathfinder.setMovements
        bot.pathfinder.setMovements = (m) => origSet(hardenMovements(m))
        if (bot.pathfinder.movements) hardenMovements(bot.pathfinder.movements)
      }
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

// ==== NO CORNER-CUTTING (2026-08-26, live) ================================================
// mineflayer-pathfinder allows a diagonal when EITHER orthogonal neighbour is free (getMoveDiagonal
// takes the cheaper side), i.e. it plans the squeeze past the corner of a solid block. Vanilla
// physics can do that squeeze; the client's prismarine-physics resolves the corner a hair
// differently, and the SERVER then answers every tick with a teleport back ('moved wrongly'):
// 35 position syncs per 2s at (4.31,64.00,8.30), next node the diagonal (3.5,9.5) with (3,64,8)
// solid on the corner, for as long as the plan stood. Not terrain, not a wedge: a move THIS body's
// physics cannot reproduce to the server's satisfaction. So this body does not plan it: a diagonal
// needs BOTH sides clear at feet and head; otherwise A* takes the two straight moves (cost 2 vs
// 1.41 - the path is a hair longer, and every step of it is one the server accepts).
function hardenMovements (m) {
  if (!m || m.__noCornerCut || typeof m.getMoveDiagonal !== 'function') return m
  m.__noCornerCut = true
  const orig = m.getMoveDiagonal.bind(m)
  m.getMoveDiagonal = function (node, dir, neighbors) {
    const y = this.getBlock(node, dir.x, 0, dir.z).physical ? 1 : 0 // the library's own 'diagonal jump-up' offset
    const side1 = this.getBlock(node, 0, y, dir.z); const side1h = this.getBlock(node, 0, y + 1, dir.z)
    const side2 = this.getBlock(node, dir.x, y, 0); const side2h = this.getBlock(node, dir.x, y + 1, 0)
    if (!(side1.safe && side1h.safe && side2.safe && side2h.safe)) return
    return orig(node, dir, neighbors)
  }
  return m
}

// PURE (gototest.js): drop everything from the first move that digs or places when the plan is
// only PARTIAL; returns how many moves were held back. A complete plan is never touched.
function truncatePartialPlan (path, status) {
  if (status !== 'partial' || !Array.isArray(path)) return 0
  const k = path.findIndex(m => (m.toBreak && m.toBreak.length) || (m.toPlace && m.toPlace.length))
  if (k < 0) return 0
  const cut = path.length - k
  path.length = k
  return cut
}

const PLACE_COST = Number(process.env.PATH_PLACE_COST || 12)
function applyPlaceCost (m) { try { if (m && 'placeCost' in m) m.placeCost = PLACE_COST } catch {} ; return m }

module.exports = { truncatePartialPlan, hardenMovements, installPathfinderTuning, selfPlacedNear, isSelfPlaced, placedOK, brokeOK, setDebugSink, setProgressSink, readCell, surfaceYAt, isNarrowSpan, surveyCells, arrivedOK, epoch, sameEpoch, bumpEpoch, applyPlaceCost, floodingNow, clearFlood, FLOOD_DIGS, bounded, forceSettleDig, forceSettleCraft, DIG_GRACE_MS, LOOK_BOUND_MS, CUT_SETTLE_GRACE_MS, WINDOW_TIMEOUT_MS, CRAFT_BOUND_MS, BODY_BOUNDS, NATIVELY_BOUNDED, bodyEntryPointRow }
