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

module.exports = { DEFAULT_BUFFER, hasFoodSupply, needsFoodSupply, shouldSweepForFood, foodSupplyAction }
