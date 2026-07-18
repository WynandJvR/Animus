'use strict'
// FOOD SECURITY (pure decisions): when should a bot PROACTIVELY establish a renewable food
// supply, vs when is it already supplied? Kept PURE (numbers/booleans in, decision out - no
// bot, no I/O) so it is offline-testable (bot/foodtest.js), like mining.js / shelter.js.
//
// Why this exists (live-confirmed, the critical-path blocker for gear-up-from-nothing): the
// bot secured food only REACTIVELY (secureFood fires at food<=12), and by food=1 it's too
// late to set up a multi-step source (a wheat farm) - so on a no-animal site it STARVES, and
// the de-facto food source is respawn (die -> full at the hut bed), which can't sustain long
// mining/building. The fix: treat "have a working renewable food supply" as a first-class
// BASE-SETUP goal established EARLY while the bot is FED, not scrambled for at food=1. On a
// no-animal site the reliable renewable is a WHEAT FARM (grass seeds + a hoe + a tilled dirt
// bank beside the REMEMBERED open-sky pond -> wheat -> bread) - no animals/string needed.

// A comfortable pack/bank food buffer to "coast" on until the farm is set up / harvested.
const DEFAULT_BUFFER = 8

// FOOD CLASSIFIERS (pure, offline-testable) - the fix for "starved at food 8 with 10 raw
// mutton banked". BAD_FOOD is hold-out-only garbage (poisons the bot / net-negative unless
// truly desperate); RAW_COOKABLE_FOOD is REAL food that just needs a furnace first (raw is
// ~1/3 the food value of cooked). Anchored regexes keep cooked_* / bread / etc. at tier 0.
//   tier 0 = ready-to-eat (cooked meat, bread, baked_potato, golden_carrot, apple, ...)
//   tier 1 = raw cookable (beef/porkchop/chicken/mutton/rabbit/cod/salmon) - cook, then eat
//   tier 2 = bad (rotten_flesh/spider_eye/poisonous_potato/pufferfish) - hold out, last resort
const BAD_FOOD = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish)$/
const RAW_COOKABLE_FOOD = /^(beef|porkchop|chicken|mutton|rabbit|cod|salmon)$/
function foodTier (name) { return BAD_FOOD.test(name) ? 2 : RAW_COOKABLE_FOOD.test(name) ? 1 : 0 }

// Is the bot ALREADY supplied? Either it has a STANDING renewable source (a planted wheat
// farm - it will keep producing), OR it's carrying enough of a food buffer to coast for now.
// A standing farm counts as supplied even before it's ripe: the point of establishing it
// EARLY is that it's grown by the time hunger comes, so no re-establish churn is needed.
function hasFoodSupply (hasRenewable, packFood, bankedFood, opts = {}) {
  const buffer = opts.buffer != null ? opts.buffer : DEFAULT_BUFFER
  return !!hasRenewable || ((packFood || 0) + (bankedFood || 0)) >= buffer
}

// Should the bot PROACTIVELY establish its food supply RIGHT NOW? Yes when it is SAFE and NOT
// already in a hunger crisis (a crisis is reactive secureFood's job) and NOT already
// supplied. This is what a fed, idle, safe bot does: set up the wheat farm before the next
// crisis, so the farm EXISTS (and is grown) by the time hunger arrives.
//   food        current hunger (0..20)
//   hasRenewable a standing wheat farm exists (the durable food source)
//   packFood    edible items in the pack
//   bankedFood  edible items in reachable chests (pass 0 for a cheap check)
//   safe        no nearby threat / healthy / day (the caller decides)
function needsFoodSupply (food, hasRenewable, packFood, bankedFood, safe, opts = {}) {
  const crisisFood = opts.crisisFood != null ? opts.crisisFood : 6
  if (!safe) return false                                       // never go farming while in danger
  if (food != null && food <= crisisFood) return false          // a crisis is reactive secureFood's job
  return !hasFoodSupply(hasRenewable, packFood, bankedFood, opts) // supplied? then nothing to do
}

// Should ensureFoodSupply run the OUTWARD SWEEP (scoutForFood) to DISCOVER a food source? Yes
// when there is NO known food source at all - no standing farm, no animal within a REAL range
// (a distance-bounded check, not "any entity loaded server-wide"), and no reachable remembered
// pond. This is the fix for "the sweep never ran": a cow loaded 200 blocks away (seesAnimal
// unbounded) or a stale remembered pond used to skip the sweep straight to the narrow
// wheat-farm-or-defer. PURE (three booleans in). The driver hunts/farms what's already known
// instead of sweeping.
function shouldSweepForFood (hasFarm, hasNearAnimal, hasKnownWater) {
  return !hasFarm && !hasNearAnimal && !hasKnownWater
}

// The NEXT ACTION for the proactive food-supply flow, given what's known. This is the
// discovery->action handoff that was BROKEN (live: the sweep FOUND + remembered water, then
// the flow idled at the hut instead of building the farm there). The rule: a standing farm ->
// tend it; KNOWN WATER (found by the sweep, or remembered) -> BUILD THE FARM at it (do NOT
// keep sweeping for animals - water at ring 48 is plenty); a near animal but no water -> hunt
// it; nothing known -> SWEEP outward to discover water/animals. Never "found it, did nothing".
// PURE (three booleans in, an action string out). Offline-tested.
function foodSupplyAction (hasFarm, hasKnownWater, hasNearAnimal) {
  if (hasFarm) return 'tend'
  if (hasKnownWater) return 'buildFarm' // the missing handoff: found water -> farm THERE
  if (hasNearAnimal) return 'huntNear'
  return 'sweep'
}

// HOME FOOD FIRST (the "walk BACK home before wandering outward" decision). Live bug: a
// starving bot 110b from its hut kept sweeping OUTWARD (scoutForFood) for new food while its
// own bank (wheat + seeds) and farm sat at home - because the in-range bank withdraw silently
// no-ops beyond ~64b and the chain then escalated hunt/farm/fish/scout, marching it further
// away. This says: if we've drifted beyond withdraw range of home AND home holds USABLE food,
// trek back and use what we own before any outward discovery. PURE (a snapshot in, go/no-go
// out) so the ordering/thresholds are covered offline.
//   distHome    blocks from the home anchor (hut / bed / opts.home)
//   bankFoodPts cached edible-food points reachable at home (pack+bank; a cheap cached read)
//   wheatCount  bank+pack wheat (>=3 wheat -> 1 bread, so raw-but-bakeable counts as usable)
//   hasFarm     a standing/tendable wheat farm exists at home
//   opts.range  withdraw range - beyond this the in-range bank read no-ops (default 48b)
//   opts.foodFloor  a small edible-points floor so a token crumb doesn't trigger a long trek
function shouldTrekHomeForFood ({ distHome, bankFoodPts, wheatCount, hasFarm } = {}, opts = {}) {
  const range = opts.range != null ? opts.range : 48
  const foodFloor = opts.foodFloor != null ? opts.foodFloor : 2
  if (!(distHome != null && distHome > range)) return false        // already in withdraw range - the in-range steps handle it
  const usable = (bankFoodPts || 0) > foodFloor ||                  // (a) real edible food banked
                 (wheatCount || 0) >= 3 ||                          // (b) bakeable wheat: 3 wheat -> 1 bread
                 !!hasFarm                                          // (c) a standing farm to tend/harvest
  return usable                                                     // far + home has something worth the trek
}

// ==== #40 (starve-despite-food) PURE TRIGGER PREDICATES ==================================
// All FOOD_SURVIVAL-gated (default ON); FOOD_SURVIVAL=0 restores the legacy numbers byte-for-
// byte. Each also honours its own env override. Kept here (pure, offline-tested) so the
// survival thresholds are locked against silent regression; the live wiring lives in
// provision.js (in-loop secureFood + ladder hp-abort) and index.js (busy-preempt).

// F3.1 - the in-loop secureFood trigger for a BUSY, packless bot. A gather loop must break off
// to secure food at this bar - FOOD_SURVIVAL raises it from the legacy crisis line (6) to 12
// (~2 min of margin at travel burn) so a stalled scheduler tick can't starve it. `hasCarriedFood`
// = the pack still holds edible food (auto-eat covers that case). PURE; env FOOD_SF_TRIGGER wins.
function inLoopFoodTrigger (food, hasCarriedFood, opts = {}) {
  const on = opts.foodSurvival != null ? opts.foodSurvival : (process.env.FOOD_SURVIVAL !== '0')
  const trig = opts.trigger != null ? opts.trigger : Number(process.env.FOOD_SF_TRIGGER || (on ? 12 : 6))
  return food != null && food <= trig && !hasCarriedFood
}

// F3.2 - the busy-job food-preempt bar (index.js SCHED_CRISIS_FOOD). A busy job is preempted for
// secureFood at food<=this: FOOD_SURVIVAL raises it 6 -> 10 (~2 min vs ~90s of margin). The
// LADDER entry (scheduler.isDegraded) stays at 6 - only the plain secureFood preempt moves early.
function busyPreemptFood (opts = {}) {
  const on = opts.foodSurvival != null ? opts.foodSurvival : (process.env.FOOD_SURVIVAL !== '0')
  return Number(process.env.SCHED_CRISIS_FOOD || (on ? 10 : 6))
}

// F4.1 - an OUTBOUND recovery rung (trek/tend/secureFood) may KEEP RUNNING only while hp is above
// the abort line; a bot burned to 1 hp mid-trek/tend/seed-gather bails to the next rung (-> the
// bounded hold) instead of farming grass at 1 hp for minutes. Default abort hp 6 = isDegraded's
// hp gate. FOOD_SURVIVAL=0 -> always admissible (today's behavior: only isStopped stops a rung).
function outboundRungAdmissible (hp, opts = {}) {
  const on = opts.foodSurvival != null ? opts.foodSurvival : (process.env.FOOD_SURVIVAL !== '0')
  if (!on) return true
  // FOOD_FLOOR (default on) carve-out: a genuinely-STARVING bot (food<=floorFood) MUST be allowed
  // to run the ONE bounded food-ACQUISITION rung (secureFood->fishing) even at 1 hp - sitting at
  // hp1/food0 forever (the 3.5h livelock) is strictly worse than one bounded fishing session
  // (240s cap + hostile reel-out). NARROW: fires ONLY when the caller passes the current food AND
  // it is <= floorFood. The ladder passes food ONLY for the secureFood rung, so the 70b trekFarm
  // trek still aborts at hp<=6 (the §5 invariant). FOOD_FLOOR=0 (or no food passed) -> today.
  const floorOn = opts.foodFloor != null ? opts.foodFloor : (process.env.FOOD_FLOOR !== '0')
  if (floorOn && opts.food != null) {
    const floorFood = opts.floorFood != null ? opts.floorFood : Number(process.env.FOOD_FLOOR_FOOD || 2)
    if (opts.food <= floorFood) return true
  }
  const abortHp = opts.abortHp != null ? opts.abortHp : Number(process.env.LADDER_HP_ABORT || 6)
  return !(hp != null && hp <= abortHp)
}

// F4.2 - a starving bot (food<=this) whose home stores came up dry must NOT begin a fresh OUTWARD
// farm/fish/scout excursion - it holds indoors (starvation stops at half-hearts; the excursion is
// what gets it killed). Default 4. FOOD_SURVIVAL=0 -> never skips (today's full outward chain).
function famineHoldFood (food, opts = {}) {
  const on = opts.foodSurvival != null ? opts.foodSurvival : (process.env.FOOD_SURVIVAL !== '0')
  if (!on) return false
  const floor = opts.floor != null ? opts.floor : Number(process.env.FOOD_FAMINE_HOLD || 4)
  return food != null && food <= floor
}

// F5 - the auto-eat reflex (index.js) eats carried, non-risky food whenever the food bar is
// at/below this. Exported to LOCK the number offline (F5 is verified/no-change - the reflex keeps
// its own inline `bot.food > 17` guard; this is a regression sentinel, not new wiring).
const AUTO_EAT_AT = 17

// FOOD_FLOOR F4 - the no-progress ESCALATION counter (PURE). The food floor re-running the
// identical failing sequence forever (§2.4) is the eternal loop; this advances a bounded counter
// every floor dispatch that gained NO food and RESETS it on any food gain. The FOOD_FLOOR gate +
// the food-gain measurement live at the call site (provision.js floor branch + the watchdog
// repeatFail hook); this is the pure, locked arithmetic. Capped so it never runs away.
function foodFloorEscalation (counter, gainedFood, opts = {}) {
  const cap = opts.cap != null ? opts.cap : Number(process.env.FOOD_FLOOR_ESC_CAP || 4)
  if (gainedFood) return 0
  return Math.min((counter || 0) + 1, cap)
}
// Has the floor stalled enough (>= N consecutive zero-food dispatches) to ESCALATE - widen the
// water scout one ring + let the floor's ACTIVE fishing outrank a passive outdoor hold? PURE.
function foodFloorEscalated (counter, opts = {}) {
  const n = opts.n != null ? opts.n : Number(process.env.FOOD_FLOOR_ESC_N || 2)
  return (counter || 0) >= n
}

// How many bread can we bake from N wheat (3 wheat -> 1 bread). PURE arithmetic, offline-tested.
function breadFromWheat (wheatCount) { return Math.max(0, Math.floor((wheatCount || 0) / 3)) }

// How much banked wheat to withdraw so a bake can top the banked reserve up to target.
// 3 wheat -> 1 bread -> 5 pts. Bounded by capWheat (default 33 = 11 loaves/pass).
function wheatWithdrawForBake ({ packWheat, bankWheat, bankFoodPts, bankTargetPts } = {}, opts = {}) {
  const cap = opts.capWheat != null ? opts.capWheat : 33
  const deficitPts = Math.max(0, (bankTargetPts || 0) - (bankFoodPts || 0))
  if (deficitPts <= 0) return 0
  const loaves = Math.ceil(deficitPts / 5)
  const need = Math.max(0, loaves * 3 - (packWheat || 0))
  return Math.max(0, Math.min(bankWheat || 0, need, cap))
}

module.exports = { DEFAULT_BUFFER, BAD_FOOD, RAW_COOKABLE_FOOD, foodTier, hasFoodSupply, needsFoodSupply, shouldSweepForFood, foodSupplyAction, shouldTrekHomeForFood, breadFromWheat, wheatWithdrawForBake, inLoopFoodTrigger, busyPreemptFood, outboundRungAdmissible, famineHoldFood, foodFloorEscalation, foodFloorEscalated, AUTO_EAT_AT }
