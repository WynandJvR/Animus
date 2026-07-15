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

// How many bread can we bake from N wheat (3 wheat -> 1 bread). PURE arithmetic, offline-tested.
function breadFromWheat (wheatCount) { return Math.max(0, Math.floor((wheatCount || 0) / 3)) }

module.exports = { DEFAULT_BUFFER, BAD_FOOD, RAW_COOKABLE_FOOD, foodTier, hasFoodSupply, needsFoodSupply, shouldSweepForFood, foodSupplyAction, shouldTrekHomeForFood, breadFromWheat }
