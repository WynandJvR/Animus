'use strict'
// DYNAMIC GOAL PLANNER: state-driven, RE-PLANNING goal execution (design:
// docs/dynamic-planner-design.md). The old bootstraps (ironArmorBootstrap et al)
// are fixed SCRIPTS - they assume their preconditions and dead-end when reality
// differs (live 07-13: gearup anchored its cobble dig ON the hut's no-dig apron,
// declared "no reachable iron" and parked itself for 20+ minutes, naked, mobs
// chewing on it). A real player re-plans around every obstacle. This module is
// that loop:
//   decide()  - PURE frontier choice over planProvision's requirement DAG: the
//               first leaf action doable RIGHT NOW, with blocked actions skipped
//               and ALTERNATIVES (relocate/explore) offered instead of "give up".
//   runGoal() - the driver: reconcile (pack+bank) -> decide -> execute ONE bounded
//               leaf via the EXISTING executors -> score progress -> loop. Every
//               round re-plans from live state, so a blocked/failed step picks a
//               DIFFERENT legal action instead of backing off.
//   gearUp()  - slice-1 goal: a full iron set from ANY start (naked+toolless
//               included), wearing pieces as they land. Reached via the `planarmor`
//               command or PLANNER_GEARUP=1 (see commands.js armorup case).
// REUSE, not reinvention: item planning is provision.planProvision, holdings are
// resources.reconcile, execution is runGather/runCraft/runSmelt/runStrip, movement
// is navigate.navigateTo. This file only owns the CHOICE of the next action.
// NO require('./commands.js') here - commands requires us (cycle); the tiny bits
// we'd want from it (worn-armor read) are inlined below with a note.

const { goals } = require('mineflayer-pathfinder')
const provision = require('./provision.js')
const resources = require('./resources.js')
const navigate = require('./navigate.js')

let dbgSink = null
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[plan] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

// ---- pure decision logic (offline-testable: bot/plannertest.js) -------------------

const taskKey = t => `${t.type}:${t.item || t.output}`

// A craft/smelt that can't open its table/furnace window - the pit-crafting failure
// mode (live: "Event windowOpen did not fire within timeout of 20000ms"). Signals the
// spot is unworkable, so we relocate rather than re-hammer it.
const WINDOW_TIMEOUT_RE = /windowOpen|window did not open|did not fire within timeout|nowhere to place/i

// Tool tiers for the legality check. Gold mines the same set as wood (tier 1) -
// a golden pick does NOT unlock iron ore.
const TOOL_TIER = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }
const TOOL_RE = /^(wooden|stone|golden|iron|diamond|netherite)_(pickaxe|axe|shovel|sword|hoe)$/

// Does the pack hold a tool that satisfies `reqTool` (same kind, >= tier)? A
// stone_pickaxe requirement is met by stone/iron/diamond/netherite, never wood/gold -
// iron ore mined below stone tier drops NOTHING, so "any pickaxe" is a lie.
function packHasToolFor (pack, reqTool) {
  if (!reqTool) return true
  const want = String(reqTool).match(TOOL_RE)
  if (!want) return (pack[reqTool] || 0) > 0
  const minTier = TOOL_TIER[want[1]] || 1
  return Object.entries(pack).some(([n, c]) => {
    if (!(c > 0)) return false
    const m = n.match(TOOL_RE)
    return !!m && m[2] === want[2] && (TOOL_TIER[m[1]] || 0) >= minTier
  })
}

// Can the pack cover at least ONE craft of `itemName` right now (any recipe variant)?
// Crafts in a plan often depend on OUTPUTS of earlier tasks (boots need ingots the
// smelt hasn't produced yet) - without this check the frontier would pick a doomed
// craft over a real alternative (verified by the offline test: a blocked iron gather
// "fell through" to craft:iron_boots with zero ingots). Mirrors provision's
// recipeIngredients shape handling (inShape + shapeless ingredients).
function canCraftOneNow (mcData, itemName, pack) {
  const item = mcData.itemsByName[itemName]
  const recipes = (item && mcData.recipes[item.id]) || []
  for (const r of recipes) {
    const counts = {}
    if (r.inShape) {
      for (const row of r.inShape) for (const id of row) if (id !== null && id !== undefined && id !== -1) counts[id] = (counts[id] || 0) + 1
    } else if (r.ingredients) {
      for (const id of r.ingredients) if (id !== null && id !== undefined && id !== -1) counts[id] = (counts[id] || 0) + 1
    }
    const entries = Object.entries(counts)
    if (!entries.length) continue
    if (entries.every(([id, c]) => { const n = mcData.items[id] && mcData.items[id].name; return n && (pack[n] || 0) >= c })) return true
  }
  return false
}

// A craft/smelt opens a WINDOW at a station (a crafting table / furnace), which is
// impossible in a cramped mining pit - and placing a fresh table needs open ground to
// stand on. So before such a leaf, if we're underground or off the anchor, regroup to
// open ground first. PURE (offline-testable); the movement lives in regroupForCraft.
// Gathers are exempt (they dig DOWN on purpose); wearing/withdrawing don't open stations.
function shouldRegroupForCraft (taskType, underground, far) {
  return (taskType === 'craft' || taskType === 'smelt') && (!!underground || !!far)
}

// The planner's brain, PURE (no bot, no I/O): given a goal BOM and holdings, pick the
// FIRST leaf action that is doable RIGHT NOW. planProvision owns the requirement DAG
// (recipes, smelts, tools, fuel - never re-derived here); this function owns the
// frontier: which of its tasks is legal now, which are blocked, and what the
// ALTERNATIVE is when the primary route is blocked (a player goes somewhere else -
// they don't sit down for 20 minutes).
//
//   goal      {item: count} - what we ultimately want to HOLD
//   holdings  {item: count} - pack + bank (what planProvision nets against)
//   opts.pack     {item: count} - what's physically ON the bot (legality: a banked
//                 pickaxe can't mine until withdrawn). Defaults to holdings.
//   opts.blocked  Set of action keys ('gather:raw_iron', 'relocate:raw_iron',
//                 'explore') that recently produced zero progress.
//   opts.plan     precomputed planProvision result (runGoal passes reconcile's).
//
// Returns exactly one of:
//   { done: true }                          goal already satisfied by holdings
//   { type:'unobtainable', items:[...] }    no route exists at all - honest dead end
//   { task }                                one planProvision task to execute now
//   { type:'relocate', item, count }        primary gather blocked HERE - move + retry
//   { type:'explore' }                      everything blocked - walk a leg, look around
//   { task, retry:true }                    last resort: re-attempt the least-bad block
//   { type:'stuck', tried:[...] }           every action AND alternative is blocked
function decide (mcData, goal, holdings, opts = {}) {
  const blocked = opts.blocked || new Set()
  const pack = opts.pack || holdings
  const plan = opts.plan || provision.planProvision(mcData, goal, holdings, opts.planOpts || {})
  if (!plan.tasks.length) {
    // No tasks + something unobtainable = planProvision found no route (e.g. a goal
    // item with no recipe/gather/smelt source). No tasks + nothing unobtainable =
    // the holdings already cover the goal.
    if (Object.keys(plan.unobtainable || {}).length) return { type: 'unobtainable', items: Object.keys(plan.unobtainable), plan }
    return { done: true, plan }
  }
  let firstBlockedGather = null
  let fallback = null
  for (const t of plan.tasks) {
    // LEGALITY: skip leaves whose enabler sits LATER in the same plan. planProvision's
    // phase ordering puts ore gathers before the stone-pick craft (otherGathers phase
    // precedes finals) and smelts before their input exists on a partial run - the old
    // bootstrap papered over this with hand-written stages; the frontier just skips
    // what isn't executable yet and the enabling task gets picked instead.
    if (t.type === 'gather' && t.tool && !packHasToolFor(pack, t.tool)) continue
    if (t.type === 'smelt' && !((pack[t.input] || 0) > 0)) continue
    if (t.type === 'strip' && !((pack[t.input] || 0) > 0)) continue
    if (t.type === 'craft' && !canCraftOneNow(mcData, t.item, pack)) continue
    const key = taskKey(t)
    if (blocked.has(key)) {
      if (!firstBlockedGather && t.type === 'gather') firstBlockedGather = t
      if (!fallback) fallback = t
      continue
    }
    return { task: t, plan }
  }
  // Everything runnable is blocked. Offer alternatives in player order: move somewhere
  // ELSE and retry the blocked gather (the reference trap - cobble blocked by the hut
  // apron - is exactly this), then a blind explore leg to change the surroundings.
  if (firstBlockedGather && !blocked.has('relocate:' + firstBlockedGather.item)) {
    return { type: 'relocate', item: firstBlockedGather.item, count: firstBlockedGather.count, plan }
  }
  if (!blocked.has('explore')) return { type: 'explore', plan }
  if (fallback) return { task: fallback, retry: true, plan }
  return { type: 'stuck', tried: [...blocked], plan }
}

// ---- relocation (the "go somewhere diggable" alternative) --------------------------

// Rotating compass directions; later rings step further out. The anchor move is the
// planner's answer to "this exact spot is the problem" (no-dig apron, mined-out field,
// unreachable face) - identical need to a player walking off to fresh ground.
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]

async function relocate (bot, startIdx, { isStopped = () => false } = {}) {
  const start = bot.entity.position.clone()
  for (let t = 0; t < DIRS.length; t++) {
    if (isStopped()) break
    const i = startIdx + t
    const dir = DIRS[i % DIRS.length]
    const dist = 40 + 16 * Math.floor(i / DIRS.length) // widen the ring on later rounds
    const tx = Math.round(start.x + dir[0] * dist)
    const tz = Math.round(start.z + dir[1] * dist)
    // Never move the anchor ONTO the hut: its no-dig apron is the reference trap -
    // an anchor there makes every future shaft illegal again.
    if (provision.onHutApron(bot, { x: tx, y: Math.floor(start.y), z: tz })) continue
    try {
      await navigate.navigateTo(bot, new goals.GoalNearXZ(tx, tz, 6), { deadlineMs: 60000, isStopped, label: 'plan-reloc' })
    } catch (e) { dbg('relocate leg to ' + tx + ',' + tz + ' failed (' + e.message + ')') }
    const moved = Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z)
    // Anywhere genuinely NEW is a win, even off a failed leg - the point is fresh
    // ground under the feet, not the exact waypoint.
    if (moved >= 16) return { ok: true, tries: t + 1 }
  }
  return { ok: false, tries: DIRS.length }
}

// ---- regroup to a workable crafting spot -------------------------------------------

// CRAFT/SMELT AT A REACHABLE STATION, not the mining pit. A cobble/iron gather sends the
// bot deep (live: y65, cramped, near water, oxygen 2), where craft:furnace and
// craft:stone_pickaxe both windowOpen-timed-out (a table can't be opened - or even placed
// with room to stand - in a shaft), ending a whole run STILL NAKED. A real player climbs
// out to open ground and puts their table down. The ANCHOR is that ground by construction:
// it's the surface spot the run started at (and where the bank/furnace/table live), so we
// return there before any station-craft. runGather already tries to surface in its finally,
// but that climb can fall short (slow/stuck nav, live) - this is the belt-and-suspenders
// that GUARANTEES the craft happens somewhere it can succeed.
async function regroupForCraft (bot, anchor, { isStopped = () => false, say = () => {} } = {}) {
  const underground = () => { try { return provision.hasSolidCeiling(bot, 45, { ignoreLeaves: true }) && !provision.insideOwnStructure(bot) } catch { return false } }
  const far = () => { const p = bot.entity && bot.entity.position; return !!p && Math.hypot(p.x - anchor.x, p.z - anchor.z) > 6 }
  if (!underground() && !far()) return false
  dbg('regroup for craft: at y=' + Math.floor(bot.entity.position.y) + ' (underground=' + underground() + ' far=' + Math.round(far() ? Math.hypot(bot.entity.position.x - anchor.x, bot.entity.position.z - anchor.z) : 0) + ') - to open ground at the anchor before crafting')
  say('climbing out to open ground to craft')
  // 1) climb out first if buried - a goto CAN'T plan out of a sealed shaft (no-dig travel
  //    profile), so the anchor walk below would just churn the recovery ladder (the slow
  //    3-min climb-out the operator saw). Surface on a dig-capable staircase/pillar first.
  if (underground()) { try { await provision.climbToSurface(bot, anchor.y, { isStopped }) } catch (e) { dbg('regroup climb-out: ' + e.message) } }
  // 2) walk back to the anchor's open ground (recovery ladder handles any residual pit/water)
  try { await navigate.navigateTo(bot, new goals.GoalNearXZ(anchor.x, anchor.z, 4), { deadlineMs: 60000, isStopped, label: 'plan-regroup' }) } catch (e) { dbg('regroup goto anchor: ' + e.message) }
  return true
}

// ---- survival checkpoint (arbiter rung 1, inlined for slice 1) ----------------------

// SURVIVE outranks PROGRESS: between leaf actions, hand the body to the EXISTING
// survival owners - never reimplemented, never bypassed. (Inside a leaf the executors
// already do this themselves: gatherLoop shelters/eats/fights on its own; this covers
// the gaps BETWEEN leaves.) Cheap when nothing's wrong: secureFood early-returns when
// fed, the night predicates are simple reads.
async function survivalCheckpoint (bot, opts) {
  try { if (provision.isResting() || provision.isSecuringFood()) return } catch {}
  try { await provision.secureFood(bot, { threshold: 12, say: opts.say, isStopped: opts.isStopped, home: opts.home }) } catch (e) { dbg('checkpoint food: ' + e.message) }
  try {
    if (provision.shelterNeeded(bot) || provision.nightRestWanted(bot)) {
      dbg('checkpoint: night/shelter first - the goal waits')
      await provision.nightRest(bot, { say: opts.say, isStopped: opts.isStopped })
    }
  } catch (e) { dbg('checkpoint rest: ' + e.message) }
}

// ---- the driver ---------------------------------------------------------------------

// Drive `goal` ({item: count}) to completion by RE-PLANNING every round from live
// holdings. One round = reconcile -> decide -> execute ONE bounded leaf -> score.
// Zero-progress actions get an in-run escalating strike (1->2->4->8 min) so the next
// decide() routes AROUND them (relocate/explore/another leaf) - the fix for the
// "declare failure and back off 20 minutes" dead end. Honest bounded give-up: deadline,
// round cap, or maxFruitless consecutive no-progress rounds, always saying what was tried.
//
// opts: say, isStopped, at ({x,y,z} anchor, defaults to feet), avoid (box for gathers),
//       restoreMovements, deadlineMs (default 15 min), maxRounds (40), maxFruitless (6),
//       primaryWood, afterRound (async hook: gearUp wears pieces / shrinks the goal),
//       doneWhen (extra completion predicate beyond "plan is empty").
async function runGoal (bot, goal, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const p0 = opts.at || (bot.entity && bot.entity.position)
  if (!p0) return { ok: false, reason: 'not spawned yet', rounds: 0, tried: [] }
  let anchor = { x: Math.round(p0.x), y: Math.floor(p0.y), z: Math.round(p0.z) }
  const planOpts = () => ({
    primaryWood: opts.primaryWood || provision.detectWood(bot) || 'oak',
    furnacesNearby: (() => { try { return provision.countFurnacesNear(bot) } catch { return 0 } })(),
    // vouch for UNWORN picks or the durability rule re-plans a fresh one EVERY round
    // (planProvision zeroes possibly-worn picks; per-round re-planning turns that into
    // an infinite pick-crafting loop - caught by the offline walk test)
    freshPickaxes: (bot.inventory ? bot.inventory.items() : []).filter(i => i.name === 'wooden_pickaxe' && !(i.durabilityUsed > 0)).length
  })
  // in-run strike ledger: key -> {fails, until}. Short + escalating - a strike means
  // "try something ELSE for a bit", never "park the whole job".
  const blocked = new Map()
  const activeBlocked = () => new Set([...blocked.entries()].filter(([, b]) => b.until > Date.now()).map(([k]) => k))
  const strike = (k, why) => {
    const b = blocked.get(k) || { fails: 0 }
    b.fails++
    b.until = Date.now() + Math.min(8 * 60000, 60000 * Math.pow(2, b.fails - 1))
    blocked.set(k, b)
    dbg('blocked ' + k + ' x' + b.fails + (why ? ' (' + why + ')' : '') + ' - re-planning around it')
  }
  const deadline = Date.now() + (opts.deadlineMs || 15 * 60000)
  const maxRounds = opts.maxRounds || 40
  const maxFruitless = opts.maxFruitless || 6
  const beat = () => new Promise(r => setTimeout(r, 1500)) // no hot loops on repeated failures
  let relocIdx = 0
  let fruitless = 0
  const tried = [] // honest trail for the give-up message + the flight recorder
  for (let round = 1; round <= maxRounds; round++) {
    if (isStopped()) return { ok: false, reason: 'stopped', rounds: round, tried }
    if (Date.now() > deadline) return { ok: false, reason: 'out of time - keeping what i made', rounds: round, tried }
    if (fruitless >= maxFruitless) return { ok: false, reason: 'nothing worked ' + maxFruitless + ' rounds straight (' + tried.slice(-maxFruitless).join(', ') + ')', rounds: round, tried }
    if (opts.doneWhen && opts.doneWhen()) return { ok: true, rounds: round, tried }
    await survivalCheckpoint(bot, { say, isStopped, home: anchor })
    if (isStopped()) continue
    // RE-PLAN from live pack+bank EVERY round - this is the whole point. Reality moved
    // (mined some, died, a chest went dead)? The plan moves with it, for free: reconcile
    // nets holdings and resources' chest cooldowns already re-route dead banks.
    let rec
    try {
      rec = await resources.reconcile(bot, goal, { near: anchor, planOpts: planOpts() })
    } catch (e) {
      dbg('reconcile failed (' + e.message + ')')
      tried.push('reconcile-fail'); fruitless++; await beat(); continue
    }
    // Bank first: withdrawing is always the cheapest legal step toward the goal.
    if (rec.withdraws.length && !isStopped()) {
      let got = 0
      for (const w of rec.withdraws) {
        if (isStopped()) break
        try { got += await resources.withdrawItems(bot, w.item, w.count, { near: anchor }) } catch (e) { dbg('withdraw ' + w.item + ': ' + e.message) }
      }
      if (got > 0) {
        tried.push('withdrew+' + got); fruitless = 0
        if (opts.afterRound) { try { await opts.afterRound() } catch (e) { dbg('afterRound: ' + e.message) } }
        continue // re-plan with the fuller pack
      }
      tried.push('withdraw:0') // bank unreachable - reconcile re-routes next round
    }
    const pack = provision.inventoryCounts(bot)
    const d = decide(mcData, goal, rec.holdings, { plan: rec.plan, pack, blocked: activeBlocked(), planOpts: planOpts() })
    if (d.done) return { ok: true, rounds: round, tried }
    if (d.type === 'unobtainable') return { ok: false, reason: 'unobtainable: ' + d.items.join(', '), rounds: round, tried }
    if (d.type === 'stuck') return { ok: false, reason: 'every route blocked (' + d.tried.join(', ') + ')', rounds: round, tried }
    if (d.type === 'relocate' || d.type === 'explore') {
      dbg('round ' + round + ': ' + d.type + (d.item ? ' for ' + d.item : '') + ' - fresh ground beats a fixed spot')
      say(d.item ? "can't get at " + d.item.replace(/_/g, ' ') + ' here - trying a different spot' : 'striking out to look around')
      const r = await relocate(bot, relocIdx, { isStopped })
      relocIdx += r.tries || 1
      if (r.ok) {
        const p = bot.entity.position
        anchor = { x: Math.round(p.x), y: Math.floor(p.y), z: Math.round(p.z) }
        // A fresh anchor earns the blocked gather a fresh try (that was the point of
        // moving). Deliberately does NOT reset `fruitless` - relocating isn't progress,
        // so a relocate->fail->relocate loop still hits the honest cap.
        if (d.item) blocked.delete('gather:' + d.item)
        tried.push(d.type + '-ok')
      } else {
        strike(d.item ? 'relocate:' + d.item : 'explore', 'could not reach anywhere new')
        tried.push(d.type + ':0'); fruitless++
      }
      continue
    }
    // Execute the ONE chosen leaf, bounded, via the existing executors. Partial output
    // still counts as progress - the next round's re-plan nets it out automatically.
    const t = d.task
    const key = taskKey(t)
    dbg('round ' + round + ': ' + key + (t.count ? ' x' + t.count : '') + (d.retry ? ' (retrying a blocked step - nothing better left)' : '') + ' @ anchor ' + anchor.x + ',' + anchor.z)
    let progress = 0
    // A station-craft (needs a table/furnace window) can't happen in a mining pit -
    // regroup to the anchor's open ground first, or it windowOpen-times-out and the run
    // ends naked (live). Gathers are exempt (they dig down on purpose).
    {
      let underground = false; let far = false
      try { underground = provision.hasSolidCeiling(bot, 45, { ignoreLeaves: true }) && !provision.insideOwnStructure(bot) } catch {}
      try { const p = bot.entity.position; far = Math.hypot(p.x - anchor.x, p.z - anchor.z) > 6 } catch {}
      if (shouldRegroupForCraft(t.type, underground, far) && !isStopped()) await regroupForCraft(bot, anchor, { isStopped, say })
    }
    let leafErr = null
    try {
      const runOpts = { say, isStopped, restoreMovements: opts.restoreMovements, home: anchor, homeY: anchor.y, avoid: opts.avoid || null }
      if (t.type === 'gather') {
        const r = await provision.runGather(bot, t.item, t.count, runOpts)
        progress = r.gathered
        if (r.gathered < t.count) dbg('  partial gather ' + r.gathered + '/' + t.count + ' (' + r.reason + ')')
      } else if (t.type === 'craft') progress = await provision.runCraft(bot, t.item, t.crafts * t.perCraft, t.needsTable, runOpts)
      else if (t.type === 'smelt') progress = await provision.runSmelt(bot, t.output, t.input, t.count, runOpts)
      else if (t.type === 'strip') progress = await provision.runStrip(bot, t.output, t.input, t.count, runOpts)
    } catch (e) { leafErr = e; dbg('  ' + key + ' threw: ' + e.message) }
    if (progress > 0) { fruitless = 0; blocked.delete(key); tried.push(key + '+' + progress) } else { strike(key); fruitless++; tried.push(key + ':0') }
    // A station-craft that STILL windowOpen-times-out AT the anchor means this exact spot
    // is a bad crafting pocket (cramped/blocked table cell). Don't re-hammer it: move the
    // anchor to fresh open ground so the next round's ensureTable places a workable table
    // elsewhere - the option-3 fallback beyond the pre-craft regroup.
    if (leafErr && (t.type === 'craft' || t.type === 'smelt') && WINDOW_TIMEOUT_RE.test(leafErr.message || '') && !isStopped()) {
      dbg('  ' + key + ' timed out opening its station even at the anchor - relocating to a fresh crafting spot')
      const r = await relocate(bot, relocIdx, { isStopped })
      relocIdx += r.tries || 1
      if (r.ok) { const p = bot.entity.position; anchor = { x: Math.round(p.x), y: Math.floor(p.y), z: Math.round(p.z) } }
    }
    if (opts.afterRound) { try { await opts.afterRound() } catch (e) { dbg('afterRound: ' + e.message) } }
  }
  return { ok: false, reason: 'round cap reached', rounds: maxRounds, tried }
}

// ---- slice-1 goal: iron armor, the player way ---------------------------------------

// Worn armor per slot. Inlined (8 lines) rather than imported from commands.js -
// commands requires this module, so requiring it back would be a cycle.
function wornBySlot (bot) {
  const out = { head: null, torso: null, legs: null, feet: null }
  try {
    for (const slot of ['head', 'torso', 'legs', 'feet']) {
      const it = bot.inventory && bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
      if (it) out[slot] = it.name
    }
  } catch { /* not spawned / slots not ready */ }
  return out
}

const ARMOR_SLOT_RE = { head: /_helmet$/, torso: /_chestplate$/, legs: /_leggings$/, feet: /_boots$/ }
const ARMOR_ORDER = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather', 'turtle']

// Equip the best piece in the pack onto every bare slot. Never downgrades (only fills
// EMPTY slots). Returns the names worn this call.
async function wearFromPack (bot) {
  const wore = []
  for (const slot of ['head', 'torso', 'legs', 'feet']) {
    if (wornBySlot(bot)[slot]) continue
    const cands = (bot.inventory ? bot.inventory.items() : []).filter(i => ARMOR_SLOT_RE[slot].test(i.name))
    const pick = ARMOR_ORDER.map(m => cands.find(i => i.name.startsWith(m))).find(Boolean) || cands[0]
    if (pick) { try { await bot.equip(pick, slot); wore.push(pick.name) } catch { /* transient */ } }
  }
  return wore
}

// Cheapest-first, so partial iron still guards SOMETHING asap (graceful degradation -
// same order the old bootstrap converged on): boots(4) -> helmet(5) -> leggings(7) ->
// chestplate(8) ingots.
const IRON_PIECES = [
  { item: 'iron_boots', slot: 'feet', iron: 4 },
  { item: 'iron_helmet', slot: 'head', iron: 5 },
  { item: 'iron_leggings', slot: 'legs', iron: 7 },
  { item: 'iron_chestplate', slot: 'torso', iron: 8 }
]

const hasSword = bot => (bot.inventory ? bot.inventory.items() : []).some(i => /_sword$/.test(i.name))

// PURE (offline-testable): did a gear-up pass make progress? YES if it wore a new piece
// (bareAfter < bareBefore) OR netted iron ANYWHERE (pack+bank, in ingot-equivalents).
// Iron is measured on TOTAL holdings so a productive MINING pass that BANKS its iron
// still counts as progress - the old score read the PACK, which the end-of-run autoBank
// empties, so a pass that mined iron read as zero progress and wrongly fed the back-off.
// withdraw/deposit shuffling nets to zero on a total measure; wearing (which spends iron)
// is already caught by the bare() term. Only a genuinely fruitless pass (no piece, no new
// iron) returns false - which is exactly when the convergence back-off should fire.
function gearupProgressed (bareBefore, bareAfter, ironBefore, ironAfter) {
  return bareAfter < bareBefore || ironAfter > ironBefore
}

// GEAR UP, the planner way: a full iron set from ANY start (naked+toolless included),
// but INCREMENTAL - cheapest piece first, each as its OWN sub-goal, so the bot gets
// real protection FAST instead of mining 24 iron naked before it wears anything.
//
// WHY sub-goals (slice 1.2): pursuing {boots,helmet,leggings,chestplate} as one goal
// makes planProvision emit a single gather:raw_iron count 24, and decide() keeps picking
// that gather until holdings hit 24 - so the bot mined the WHOLE set's iron naked before
// the first smelt (live: raw_iron 1/24 after 7 min on an iron-poor site = the exact
// window it dies in). Instead we run {iron_boots} (4 iron) to completion FIRST, WEAR it,
// then {iron_helmet}, then leggings, then chestplate. After ~4 raw iron the bot smelts,
// crafts and wears boots, capping naked exposure and banking worn progress against death -
// the graceful-degradation the old ironArmorBootstrap had and the one-shot goal lost.
//
// Same contract as ironArmorBootstrap ({progressed, msg}) so the armorup seam can A/B
// them: honest message, persisted gearupState back-off respected + updated ONCE across
// the whole run, loose iron banked at the end. A blocked step still relocates/retries
// (runGoal), never a 20-minute park.
async function gearUp (bot, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const p0 = opts.at || (bot.entity && bot.entity.position)
  if (!p0) return { progressed: false, msg: 'not spawned yet' }
  const at = { x: Math.round(p0.x), y: Math.floor(p0.y), z: Math.round(p0.z) }
  await wearFromPack(bot) // free protection first - never mine for what the pack holds
  // S6 SAFEKEEP (trigger 3): the iron grind is the classic depart-with-a-full-pack excursion
  // (how it lost the hoe + iron on 07-15). If we're AT the hut and NOT mid-build, stash spare
  // tools + material surplus into the bank FIRST so a death on the grind costs only the loadout.
  // Behind MAINTAIN (+ MAINT_SAFEKEEP / build-placement refusal inside safekeepSweep).
  try {
    if (process.env.SCHEDULER !== '0' && process.env.MAINTAIN !== '0') {
      const hut = provision.hutAnchor && provision.hutAnchor()
      let building = false
      try { const c = require('./commands.js'); building = !!(c.persistedResume && c.persistedResume()) } catch {}
      if (hut && bot.entity && bot.entity.position.distanceTo(hut) <= 24 && !building && provision.safekeepSweep) {
        await provision.safekeepSweep(bot, { isStopped, say })
      }
    }
  } catch (e) { dbg('gearUp: pre-excursion safekeep skipped (' + e.message + ')') }
  const bare = () => IRON_PIECES.filter(p => !wornBySlot(bot)[p.slot])
  if (!bare().length) return { progressed: false, msg: 'already armored in every slot' }
  // TOTAL (pack+bank) iron in ingot-equivalents (raw smelts 1:1). ONE honest measure used
  // for both the banked-iron short-circuit (below) and the progress score (at the end) -
  // reads pack + verified chests near the anchor.
  const ironUnits = async () => {
    try { const t = await resources.totalCounts(bot, { near: at }); return (t.iron_ingot || 0) + (t.raw_iron || 0) } catch { return 0 }
  }
  const ironBefore = await ironUnits()
  // SHORT-CIRCUIT the back-off when iron is ALREADY BANKED. The convergence back-off exists
  // for iron-POOR sites (repeated no-iron grinds); it must NOT strand iron that is already
  // in the bank/pack. If we hold enough iron for the cheapest bare piece, BYPASS the
  // cooldown and run the normal reconcile path (withdraw banked iron -> smelt raw if needed
  // -> craft -> wear) so free armor gets worn instead of sitting for ~28 min.
  const cheapestBare = bare()[0] // IRON_PIECES is cheapest-first, so bare()[0] is the cheapest
  const bankedEnough = !!cheapestBare && ironBefore >= cheapestBare.iron
  // Cross-run back-off parity with the old path: a genuinely fruitless RUN still cools
  // off (the planner's in-run strikes are minutes and re-route; this guards run-level churn).
  const gb = provision.gearupState && provision.gearupState()
  if (!opts.force && !bankedEnough && gb && gb.until > Date.now()) {
    const min = Math.max(1, Math.round((gb.until - Date.now()) / 60000))
    return { progressed: false, msg: `iron grind cooling off after ${gb.fails} fruitless tries - retrying in ~${min} min` }
  }
  if (bankedEnough && gb && gb.until > Date.now()) dbg(`gearUp: ${ironBefore} iron already banked - bypassing back-off to make ${cheapestBare.item}`)
  const bareBefore = bare().length
  // ONE overall deadline shared across all sub-goals, so 4 pieces can't each burn a full
  // 15 min - total naked-exposure stays bounded like the single-goal version was.
  const overallDeadline = Date.now() + (opts.deadlineMs || 15 * 60000)
  say('gearing up - one piece at a time, cheapest first, so i get some armor on fast')
  let lastReason = ''
  // Cheapest-first sub-goals. IRON_PIECES is already boots->helmet->leggings->chestplate.
  for (const p of IRON_PIECES) {
    if (isStopped()) break
    if (wornBySlot(bot)[p.slot]) continue // already covered (worn from pack, or a prior pass)
    const remaining = overallDeadline - Date.now()
    if (remaining < 20000) { lastReason = 'out of time'; break } // no point starting a piece we can't finish
    // The sub-goal BOM: THIS piece + a wooden_sword if still unarmed (the sword rides the
    // FIRST bare piece - an unarmed miner loses the cave dive, the deaths behind efba7bd).
    // planProvision chains everything else (tools/table/furnace/fuel) on demand.
    const wantSword = !hasSword(bot)
    const goal = {}
    if (wantSword) goal.wooden_sword = 1
    goal[p.item] = 1
    dbg('gearUp sub-goal: ' + Object.keys(goal).join('+') + ' (' + (4 - bare().length) + '/4 slots covered so far)')
    const res = await runGoal(bot, goal, {
      say,
      isStopped,
      at,
      avoid: opts.avoid || null,
      restoreMovements: opts.restoreMovements,
      deadlineMs: remaining,
      // done when THIS piece is worn and (if we wanted one) a sword is in hand - the
      // check runs at the top of each round BEFORE re-planning, so once afterRound wears
      // the piece the sub-goal ends instead of re-planning a piece that's no longer in
      // the pack (worn armor doesn't count as holdings).
      doneWhen: () => wornBySlot(bot)[p.slot] && !goal.wooden_sword,
      // After each round: WEAR what landed and SHRINK the goal (a worn piece / made sword
      // leaves the pack, so without the delete the next reconcile would re-plan it).
      afterRound: async () => {
        const wore = await wearFromPack(bot)
        if (wore.length) { say('put on ' + wore.join(', ')); dbg('worn this round: ' + wore.join(', ')) }
        if (wornBySlot(bot)[p.slot]) delete goal[p.item]
        if (goal.wooden_sword && hasSword(bot)) delete goal.wooden_sword
      }
    })
    lastReason = res.reason || lastReason
    await wearFromPack(bot) // belt-and-suspenders: wear it even if the last afterRound's equip glitched
    // Couldn't finish this (cheapest remaining) piece -> the pricier ones cost MORE iron,
    // so stop rather than grind on. What we did wear/mine is already progress + banked.
    if (!wornBySlot(bot)[p.slot]) break
  }
  // BANK the loose gear-up progress (same rationale as the old bootstrap: pack iron
  // dies with the bot; banked iron survives and counts next pass). Worn armor is in
  // equipment slots - depositing only touches the loose surplus.
  try {
    const c = provision.inventoryCounts(bot)
    if ((c.raw_iron || 0) + (c.iron_ingot || 0) > 0) await resources.autoBank(bot, { near: at, keepDirt: opts.keepDirt || 16, isStopped })
  } catch {}
  if (opts.restoreMovements) { try { opts.restoreMovements() } catch {} }
  // PROGRESS on TOTAL holdings, measured AFTER banking: a pass that mined iron and banked
  // it (line above) still gained iron in the bank, so it counts as progress and does NOT
  // feed the fruitless back-off. Only a pass that wore nothing AND netted no iron anywhere
  // is fruitless. (Old bug: pack-only score read 0 right after autoBank -> false back-off.)
  const ironAfter = await ironUnits()
  const progressed = gearupProgressed(bareBefore, bare().length, ironBefore, ironAfter)
  try { provision.gearupResult && provision.gearupResult(progressed) } catch {}
  const bareNow = bare().length
  const msg = !bareNow ? 'full set on'
    : progressed ? `progress (${4 - bareNow}/4 slots covered, iron banked) - ${bareNow} slot(s) still bare`
      : `no progress: ${lastReason}`
  dbg('gearUp done: ' + msg)
  return { progressed, msg }
}

module.exports = { decide, runGoal, gearUp, gearupProgressed, relocate, regroupForCraft, shouldRegroupForCraft, packHasToolFor, taskKey, setDebugSink }
