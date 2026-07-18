'use strict'
// OFFLINE unit test for the pure food-security decisions (bot/food.js). No bot, no I/O.
// Run:  cd bot && node foodtest.js

const assert = require('assert')
const F = require('./food.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

t('hasFoodSupply: a STANDING farm is supplied; else a buffer coasts', () => {
  assert.strictEqual(F.hasFoodSupply(true, 0, 0), true, 'a standing wheat farm = supplied even with 0 buffer')
  assert.strictEqual(F.hasFoodSupply(false, 8, 0), true, 'no farm but a full pack buffer -> coasting')
  assert.strictEqual(F.hasFoodSupply(false, 3, 6), true, 'no farm but pack+bank buffer -> coasting')
  assert.strictEqual(F.hasFoodSupply(false, 2, 0), false, 'no farm + low buffer -> NOT supplied, establish one')
  assert.strictEqual(F.hasFoodSupply(false, 5, 0, { buffer: 4 }), true, 'buffer target is tunable')
})

t('needsFoodSupply: a FED, SAFE bot with no farm + no buffer establishes one (the point)', () => {
  assert.strictEqual(F.needsFoodSupply(18, false, 0, 0, true), true, 'fed + safe + no farm + no buffer -> build the farm now')
  assert.strictEqual(F.needsFoodSupply(18, false, 2, 0, true), true, 'still below the buffer -> build it')
})

t('needsFoodSupply: a standing farm OR a buffer -> nothing to do', () => {
  assert.strictEqual(F.needsFoodSupply(18, true, 0, 0, true), false, 'a standing farm -> supplied, no re-establish churn')
  assert.strictEqual(F.needsFoodSupply(15, false, 3, 6, true), false, 'pack+bank buffer -> coasting, do not scramble')
})

t('needsFoodSupply: NOT while unsafe, NOT during a hunger crisis', () => {
  assert.strictEqual(F.needsFoodSupply(18, false, 0, 0, false), false, 'unsafe -> do not go farming')
  assert.strictEqual(F.needsFoodSupply(4, false, 0, 0, true), false, 'crisis (food<=6) -> reactive secureFood, not proactive')
  assert.strictEqual(F.needsFoodSupply(6, false, 0, 0, true), false, 'at the crisis threshold -> still reactive')
  assert.strictEqual(F.needsFoodSupply(7, false, 0, 0, true), true, 'just above crisis + safe + no supply -> build it')
})

t('shouldSweepForFood: sweep ONLY when no farm, no NEAR animal, no known water', () => {
  assert.strictEqual(F.shouldSweepForFood(false, false, false), true, 'nothing known -> sweep to discover (the whole point)')
  assert.strictEqual(F.shouldSweepForFood(true, false, false), false, 'a standing farm -> no need to sweep')
  assert.strictEqual(F.shouldSweepForFood(false, true, false), false, 'a NEAR animal -> hunt it, do not sweep')
  assert.strictEqual(F.shouldSweepForFood(false, false, true), false, 'a reachable remembered pond -> farm there, do not sweep')
  // the LIVE BUG: a far cow made seesAnimal (unbounded) true -> passing hasNearAnimal=false
  // (distance-bounded) now lets the sweep run
  assert.strictEqual(F.shouldSweepForFood(false, false, false), true)
})

t('foodTier: bad->2, raw meat->1, ready-to-eat (cooked/bread/veg)->0', () => {
  for (const bad of ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish']) assert.strictEqual(F.foodTier(bad), 2, bad + ' is bad (hold-out only)')
  for (const raw of ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon']) assert.strictEqual(F.foodTier(raw), 1, raw + ' is raw cookable')
  for (const ready of ['cooked_beef', 'cooked_cod', 'cooked_mutton', 'bread', 'baked_potato', 'golden_carrot', 'apple']) assert.strictEqual(F.foodTier(ready), 0, ready + ' is ready-to-eat')
  // anchored regexes: cooked_* must NOT be caught by the raw-meat pattern
  assert.strictEqual(F.RAW_COOKABLE_FOOD.test('cooked_beef'), false, 'cooked_beef is not raw')
  assert.strictEqual(F.BAD_FOOD.test('cooked_chicken'), false, 'cooked_chicken is not bad')
})

t('RAW_COOKABLE_FOOD matches provision.RAW_COOKABLE keys (single source of truth)', () => {
  let RAW_COOKABLE
  try { RAW_COOKABLE = require('./provision.js').RAW_COOKABLE } catch (e) { console.log('      (skip: provision.js not loadable offline: ' + e.message + ')'); return }
  for (const name of Object.keys(RAW_COOKABLE)) assert.strictEqual(F.RAW_COOKABLE_FOOD.test(name), true, name + ' (a provision raw-cookable) must be tier 1')
})

t('foodSupplyAction: the discovery->action handoff (the live idle bug)', () => {
  assert.strictEqual(F.foodSupplyAction(true, true, true), 'tend', 'a standing farm -> tend')
  assert.strictEqual(F.foodSupplyAction(false, true, false), 'buildFarm', 'FOUND WATER -> build the farm THERE (was idling)')
  assert.strictEqual(F.foodSupplyAction(false, true, true), 'buildFarm', 'water beats a near animal - farm is renewable')
  assert.strictEqual(F.foodSupplyAction(false, false, true), 'huntNear', 'no water but an animal here -> hunt it')
  assert.strictEqual(F.foodSupplyAction(false, false, false), 'sweep', 'nothing known -> sweep to discover')
})

t('shouldTrekHomeForFood: FAR + home has food => go; NEAR => no-go; FAR + dry => no-go', () => {
  // FAR (beyond withdraw range) + real banked food => trek home
  assert.strictEqual(F.shouldTrekHomeForFood({ distHome: 110, bankFoodPts: 12, wheatCount: 0, hasFarm: false }), true, 'far + banked food -> go home')
  // NEAR (in withdraw range) => never trek, the in-range steps handle it
  assert.strictEqual(F.shouldTrekHomeForFood({ distHome: 30, bankFoodPts: 20, wheatCount: 9, hasFarm: true }), false, 'in range -> no trek (the live no-op was BEYOND range)')
  assert.strictEqual(F.shouldTrekHomeForFood({ distHome: 48, bankFoodPts: 20, wheatCount: 9, hasFarm: true }), false, 'exactly at range -> still in range, no trek')
  // FAR + home truly dry => no-go (don't bounce home to nothing)
  assert.strictEqual(F.shouldTrekHomeForFood({ distHome: 110, bankFoodPts: 0, wheatCount: 0, hasFarm: false }), false, 'far + dry home -> fall through to today\'s chain')
  assert.strictEqual(F.shouldTrekHomeForFood({ distHome: 110, bankFoodPts: 2, wheatCount: 2, hasFarm: false }), false, 'a crumb (<=floor) + 2 wheat (<3) + no farm -> not worth the trek')
})

t('shouldTrekHomeForFood: >=3 wheat counts as food; a standing farm counts as food', () => {
  // the ACTUAL live rescue: bank wheat is raw/inedible (bankFoodPts=0) but 3 wheat -> 1 bread
  assert.strictEqual(F.shouldTrekHomeForFood({ distHome: 110, bankFoodPts: 0, wheatCount: 3, hasFarm: false }), true, '3 bakeable wheat -> usable, go home to bake')
  assert.strictEqual(F.shouldTrekHomeForFood({ distHome: 110, bankFoodPts: 0, wheatCount: 5, hasFarm: false }), true, '5 wheat -> usable')
  // a standing farm alone justifies the trek (harvest/tend it)
  assert.strictEqual(F.shouldTrekHomeForFood({ distHome: 110, bankFoodPts: 0, wheatCount: 0, hasFarm: true }), true, 'a standing farm -> go home to harvest')
  // tunable range: HOME_FOOD_RANGE via opts.range
  assert.strictEqual(F.shouldTrekHomeForFood({ distHome: 40, bankFoodPts: 20, wheatCount: 0, hasFarm: false }, { range: 24 }), true, 'range is tunable (env HOME_FOOD_RANGE)')
  // missing distHome => never trek (defensive)
  assert.strictEqual(F.shouldTrekHomeForFood({ bankFoodPts: 20, wheatCount: 9, hasFarm: true }), false, 'no distHome known -> do not trek')
})

t('breadFromWheat: 3 wheat -> 1 bread (floor), sub-3 -> 0, negative/garbage -> 0', () => {
  assert.strictEqual(F.breadFromWheat(0), 0, '0 wheat -> 0 bread')
  assert.strictEqual(F.breadFromWheat(2), 0, '2 wheat -> 0 bread (need 3)')
  assert.strictEqual(F.breadFromWheat(3), 1, '3 wheat -> 1 bread')
  assert.strictEqual(F.breadFromWheat(5), 1, '5 wheat -> 1 bread (floor)')
  assert.strictEqual(F.breadFromWheat(9), 3, '9 wheat -> 3 bread')
  assert.strictEqual(F.breadFromWheat(-4), 0, 'garbage/negative -> 0 (never negative)')
  assert.strictEqual(F.breadFromWheat(undefined), 0, 'undefined -> 0')
})

t('wheatWithdrawForBake: reserve at/over target -> withdraw 0 (quiescence)', () => {
  assert.strictEqual(F.wheatWithdrawForBake({ packWheat: 0, bankWheat: 30, bankFoodPts: 80, bankTargetPts: 80 }), 0, 'deficit 0 -> 0')
  assert.strictEqual(F.wheatWithdrawForBake({ packWheat: 0, bankWheat: 30, bankFoodPts: 90, bankTargetPts: 80 }), 0, 'over target -> 0')
})

t('wheatWithdrawForBake: withdraws banked wheat to cover the pts deficit (3 wheat -> 5 pts)', () => {
  // 80 pts deficit -> ceil(80/5)=16 loaves -> 48 wheat, but cap 33 binds -> 33.
  assert.strictEqual(F.wheatWithdrawForBake({ packWheat: 0, bankWheat: 100, bankFoodPts: 0, bankTargetPts: 80 }), 33, 'cap 33 binds on a large deficit')
  // 15 pts deficit -> ceil(15/5)=3 loaves -> 9 wheat; plenty banked, no pack wheat.
  assert.strictEqual(F.wheatWithdrawForBake({ packWheat: 0, bankWheat: 100, bankFoodPts: 65, bankTargetPts: 80 }), 9, '15-pt deficit -> 9 wheat')
})

t('wheatWithdrawForBake: pack wheat offsets the need', () => {
  // 15 pts deficit -> 9 wheat needed; 4 already in the pack -> withdraw only 5.
  assert.strictEqual(F.wheatWithdrawForBake({ packWheat: 4, bankWheat: 100, bankFoodPts: 65, bankTargetPts: 80 }), 5, '9 needed - 4 pack = 5')
  // pack already covers the loaves -> withdraw 0.
  assert.strictEqual(F.wheatWithdrawForBake({ packWheat: 9, bankWheat: 100, bankFoodPts: 65, bankTargetPts: 80 }), 0, 'pack covers it -> 0')
})

t('wheatWithdrawForBake: bankWheat binds when the bank is short', () => {
  // 15-pt deficit wants 9 wheat but only 4 banked -> withdraw 4.
  assert.strictEqual(F.wheatWithdrawForBake({ packWheat: 0, bankWheat: 4, bankFoodPts: 65, bankTargetPts: 80 }), 4, 'bankWheat 4 binds')
  assert.strictEqual(F.wheatWithdrawForBake({ packWheat: 0, bankWheat: 0, bankFoodPts: 0, bankTargetPts: 80 }), 0, 'no banked wheat -> 0')
})

t('wheatWithdrawForBake: null/absent fields -> 0 (defensive)', () => {
  assert.strictEqual(F.wheatWithdrawForBake(), 0, 'no args -> 0')
  assert.strictEqual(F.wheatWithdrawForBake({}), 0, 'empty snapshot -> 0 (no target)')
  assert.strictEqual(F.wheatWithdrawForBake({ bankWheat: 30, bankTargetPts: 80 }), 30, 'null packWheat/bankFoodPts treated as 0 (full 80-pt deficit -> 48 wheat wanted; bankWheat 30 binds)')
  // opts.capWheat is tunable
  assert.strictEqual(F.wheatWithdrawForBake({ packWheat: 0, bankWheat: 100, bankFoodPts: 0, bankTargetPts: 80 }, { capWheat: 12 }), 12, 'cap is tunable')
})

// ==== #40 (starve-despite-food) trigger predicates ========================================
// Each is FOOD_SURVIVAL-gated; opts.foodSurvival pins the regime so BOTH `node foodtest.js` and
// `FOOD_SURVIVAL=0 node foodtest.js` prove the on- AND off-regime numbers independent of ambient.
const ON = { foodSurvival: true }
const OFF = { foodSurvival: false }

t('#40 F3.1: inLoopFoodTrigger - busy packless bot breaks off at food<=12 (on) / <=6 (legacy)', () => {
  // the "in-loop secureFood" column of the trigger table, across food in {20,17,12,10,6,2}.
  // ON (FOOD_SURVIVAL): fires at food<=12 when the pack carries NO food.
  assert.strictEqual(F.inLoopFoodTrigger(20, false, ON), false, 'food 20 packless -> fed, no secure')
  assert.strictEqual(F.inLoopFoodTrigger(17, false, ON), false, 'food 17 packless -> auto-eat territory, not yet secure')
  assert.strictEqual(F.inLoopFoodTrigger(12, false, ON), true, 'food 12 packless -> in-loop secureFood (the earlier trigger)')
  assert.strictEqual(F.inLoopFoodTrigger(10, false, ON), true, 'food 10 packless -> secure')
  assert.strictEqual(F.inLoopFoodTrigger(6, false, ON), true, 'food 6 packless -> secure')
  assert.strictEqual(F.inLoopFoodTrigger(2, false, ON), true, 'food 2 packless -> secure')
  // carrying food -> auto-eat/pack cover it; the in-loop hunt does NOT fire (any food level)
  assert.strictEqual(F.inLoopFoodTrigger(6, true, ON), false, 'food 6 WITH pack food -> auto-eat has it, no secure')
  assert.strictEqual(F.inLoopFoodTrigger(12, true, ON), false, 'food 12 WITH pack food -> no secure')
  // OFF (FOOD_SURVIVAL=0): legacy needsFood threshold 6 exactly
  assert.strictEqual(F.inLoopFoodTrigger(12, false, OFF), false, 'legacy: food 12 packless -> NOT yet (threshold 6)')
  assert.strictEqual(F.inLoopFoodTrigger(6, false, OFF), true, 'legacy: food 6 packless -> secure')
  assert.strictEqual(F.inLoopFoodTrigger(7, false, OFF), false, 'legacy: food 7 packless -> not yet')
  // explicit trigger / env override wins
  assert.strictEqual(F.inLoopFoodTrigger(9, false, { trigger: 9 }), true, 'explicit trigger 9 -> fires at 9')
})

t('#40 F3.2: busyPreemptFood - busy job preempted for secureFood at food<=10 (on) / <=6 (legacy)', () => {
  assert.strictEqual(F.busyPreemptFood(ON), 10, 'FOOD_SURVIVAL -> busy-preempt at food<=10 (~2 min margin)')
  assert.strictEqual(F.busyPreemptFood(OFF), 6, 'FOOD_SURVIVAL=0 -> legacy food<=6 (byte-for-byte)')
})

t('#40 F4.1: outboundRungAdmissible - an outbound rung aborts at hp<=6 (on); never aborts (legacy)', () => {
  // admissibility at hp in {20,7,6,1}: keeps running above the abort line, bails at/below it.
  assert.strictEqual(F.outboundRungAdmissible(20, ON), true, 'hp 20 -> rung runs')
  assert.strictEqual(F.outboundRungAdmissible(7, ON), true, 'hp 7 -> still above abort, runs')
  assert.strictEqual(F.outboundRungAdmissible(6, ON), false, 'hp 6 -> abort (bail to the next rung)')
  assert.strictEqual(F.outboundRungAdmissible(1, ON), false, 'hp 1 -> abort (no death-march farming)')
  // FOOD_SURVIVAL=0: always admissible (today - only isStopped stops a rung)
  assert.strictEqual(F.outboundRungAdmissible(1, OFF), true, 'legacy: hp 1 rung is admissible (no hp-abort)')
  assert.strictEqual(F.outboundRungAdmissible(null, ON), true, 'unknown hp -> admissible (defensive)')
})

t('FOOD_FLOOR F1: outboundRungAdmissible - a STARVING bot (food<=floorFood) may run the fishing rung at 1 hp; a merely-scratched bot still aborts', () => {
  // THE livelock break: hp1/food0 must be ADMISSIBLE for the food-acquisition rung (carve-out).
  // foodSurvival/foodFloor:true pin both flags ON so the mechanism is asserted regardless of regime.
  const FF = { foodSurvival: true, foodFloor: true }
  assert.strictEqual(F.outboundRungAdmissible(1, { food: 0, floorFood: 2, ...FF }), true, 'hp1 food0 (<=floorFood) -> admit the fishing floor')
  assert.strictEqual(F.outboundRungAdmissible(1, { food: 2, floorFood: 2, ...FF }), true, 'hp1 food2 (==floorFood) -> admit')
  // NARROW: a merely-scratched, not-starving bot still aborts outbound at hp<=6 (the §5 invariant).
  assert.strictEqual(F.outboundRungAdmissible(1, { food: 12, ...FF }), false, 'hp1 food12 (>floorFood) -> still aborts (no death-march)')
  assert.strictEqual(F.outboundRungAdmissible(5, { food: 12, ...FF }), false, 'hp5 food12 -> still aborts as today')
  // #51 FOOD_FLOOR_HP: hp3/food3 is the dead-zone livelock - with the hp-crisis clause ON the fishing
  // rung is now ADMITTED (was: aborts). With FOOD_FLOOR_HP=0 it aborts exactly as before (byte-for-byte).
  assert.strictEqual(F.outboundRungAdmissible(3, { food: 3, ...FF, foodFloorHp: true }), true, '#51: hp3 food3 (hp-crisis, no food) -> admit the fishing rung')
  assert.strictEqual(F.outboundRungAdmissible(3, { food: 3, ...FF, foodFloorHp: false }), false, 'FOOD_FLOOR_HP=0 -> hp3 food3 aborts as today (byte-for-byte)')
  assert.strictEqual(F.outboundRungAdmissible(3, { food: 8, ...FF, foodFloorHp: true }), false, 'hp3 food8 (>dead-zone) -> still aborts (not a food-crisis)')
  // GUARDRAIL: no food passed (trekFarm rung) -> today's pure hp-abort, carve-out inert.
  assert.strictEqual(F.outboundRungAdmissible(1, FF), false, 'no food passed (trekFarm) -> hp1 aborts as today')
  assert.strictEqual(F.outboundRungAdmissible(7, { food: 0, ...FF }), true, 'hp7 -> admissible anyway (above the abort line)')
  // flag-off unchanged: FOOD_SURVIVAL off -> always admissible (today, only isStopped stops a rung).
  assert.strictEqual(F.outboundRungAdmissible(5, { food: 0, foodSurvival: false }), true, 'FOOD_SURVIVAL=0 -> admissible regardless (byte-for-byte)')
  assert.strictEqual(F.outboundRungAdmissible(1, { food: 0, foodSurvival: false }), true, 'FOOD_SURVIVAL=0 -> hp1 admissible')
  // FOOD_FLOOR=0: carve-out inert -> hp1 food0 aborts exactly like #40 today (FOOD_SURVIVAL still on).
  assert.strictEqual(F.outboundRungAdmissible(1, { food: 0, foodFloor: false, foodSurvival: true }), false, 'FOOD_FLOOR=0 -> hp1 food0 aborts (byte-for-byte #40)')
})

t('FOOD_FLOOR F4: foodFloorEscalation counter increments on no-progress, RESETS on food gain, and is capped', () => {
  assert.strictEqual(F.foodFloorEscalation(0, false), 1, 'no food gained -> +1')
  assert.strictEqual(F.foodFloorEscalation(1, false), 2, 'still no food -> +1')
  assert.strictEqual(F.foodFloorEscalation(3, true), 0, 'food GAINED -> reset to 0')
  assert.strictEqual(F.foodFloorEscalation(99, false, { cap: 4 }), 4, 'capped so it never runs away')
  // the escalate predicate flips at N consecutive zero-food dispatches (default 2).
  assert.strictEqual(F.foodFloorEscalated(0), false, '0 -> not yet escalated')
  assert.strictEqual(F.foodFloorEscalated(1), false, '1 -> not yet (default N=2)')
  assert.strictEqual(F.foodFloorEscalated(2), true, '2 -> ESCALATE (widen scout + active fishing)')
  assert.strictEqual(F.foodFloorEscalated(1, { n: 1 }), true, 'N override respected')
})

t('#40 F4.2: famineHoldFood - a starving bot (food<=4) holds instead of an outward excursion', () => {
  assert.strictEqual(F.famineHoldFood(4, ON), true, 'food 4 -> hold, do not trek out to fish/scout')
  assert.strictEqual(F.famineHoldFood(2, ON), true, 'food 2 -> hold')
  assert.strictEqual(F.famineHoldFood(5, ON), false, 'food 5 -> still allowed to try the outward chain')
  assert.strictEqual(F.famineHoldFood(4, OFF), false, 'FOOD_SURVIVAL=0 -> never skips the outward chain (byte-for-byte)')
})

t('#40 F5: auto-eat threshold locked at 17 + cooked_beef is tier-0 (verified, no behavior change)', () => {
  assert.strictEqual(F.AUTO_EAT_AT, 17, 'auto-eat (index.js) eats carried food at food<=17')
  assert.strictEqual(F.foodTier('cooked_beef'), 0, 'cooked_beef is tier-0 ready-to-eat - never held out by the tier gate')
})

t('ROD_SUPPLY: needStringForRod - seek string ONLY when rod-less, reserve-dry, and string-short', () => {
  // has a pack rod -> never seek string (the F1 pack-rod path covers it)
  assert.strictEqual(F.needStringForRod({ hasRod: true, packString: 0, bankRods: 0 }), false, 'a pack rod -> no string need')
  // a bank reserve rod -> F2 withdraw covers it, no string need
  assert.strictEqual(F.needStringForRod({ hasRod: false, packString: 0, bankRods: 1 }), false, 'a banked reserve rod -> withdraw it, do not hunt string')
  // already holds enough craft string
  assert.strictEqual(F.needStringForRod({ hasRod: false, packString: 2, bankRods: 0 }), false, 'string>=target -> craft is already reachable')
  // THE COLD-START CASE: no rod anywhere + 0 string -> seek string
  assert.strictEqual(F.needStringForRod({ hasRod: false, packString: 0, bankRods: 0 }), true, 'cold start: no rod, dry reserve, 0 string -> hunt string')
  // 1 string is still below the default target of 2
  assert.strictEqual(F.needStringForRod({ hasRod: false, packString: 1, bankRods: 0 }), true, '1 < 2 -> still short, keep seeking')
  // target is tunable (ROD_STRING_TARGET); 1 >= target 1 -> satisfied
  assert.strictEqual(F.needStringForRod({ hasRod: false, packString: 1, bankRods: 0, target: 1 }), false, 'target override respected')
  // defensive: missing counts default to 0 (rod-less, dry, 0 string) -> true
  assert.strictEqual(F.needStringForRod({ hasRod: false }), true, 'undefined counts default to 0 -> cold-start true')
})

t('#51 FOOD_FLOOR_HP: foodFloorTriggered - fish at food<=2 OR (hp<=6 & food<=6 & no pack food)', () => {
  const on = { foodFloor: true, foodFloorHp: true } // pin flags for determinism (avoid env)
  // existing starvation floor (food<=2, dry pack)
  assert.strictEqual(F.foodFloorTriggered({ food: 2, hasPackFood: false, ...on }), true, 'food<=2 dry -> fish (existing floor)')
  assert.strictEqual(F.foodFloorTriggered({ food: 2, hasPackFood: true, ...on }), false, 'food<=2 but carrying food -> eat, do not fish')
  // THE LIVELOCK CASE: hp4/food4, no pack food -> must fish (the new hp-crisis clause)
  assert.strictEqual(F.foodFloorTriggered({ food: 4, hp: 4, hasPackFood: false, ...on }), true, 'hp4/food4 dry -> fish (dead-zone livelock closed)')
  assert.strictEqual(F.foodFloorTriggered({ food: 6, hp: 6, hasPackFood: false, ...on }), true, 'hp6/food6 edge -> fish')
  // a healthy bot must NOT over-fish in the food 3-6 zone
  assert.strictEqual(F.foodFloorTriggered({ food: 4, hp: 20, hasPackFood: false, ...on }), false, 'hp20/food4 -> not an hp-crisis, no fish')
  // food above the dead-zone even at low hp -> no fish (regen zone / eat path)
  assert.strictEqual(F.foodFloorTriggered({ food: 8, hp: 4, hasPackFood: false, ...on }), false, 'food8 -> above the dead-zone, no fish')
  // carrying food -> eat, never fish
  assert.strictEqual(F.foodFloorTriggered({ food: 4, hp: 4, hasPackFood: true, ...on }), false, 'hp-crisis but carrying food -> eat')
  // FOOD_FLOOR_HP=0 -> only the food<=2 case (byte-for-byte today)
  assert.strictEqual(F.foodFloorTriggered({ food: 4, hp: 4, hasPackFood: false, foodFloor: true, foodFloorHp: false }), false, 'FOOD_FLOOR_HP=0 -> hp-clause off, food4 no fish')
  assert.strictEqual(F.foodFloorTriggered({ food: 2, hasPackFood: false, foodFloor: true, foodFloorHp: false }), true, 'FOOD_FLOOR_HP=0 still fires the food<=2 floor')
  // FOOD_FLOOR=0 -> whole feature off
  assert.strictEqual(F.foodFloorTriggered({ food: 1, hp: 1, hasPackFood: false, foodFloor: false }), false, 'FOOD_FLOOR=0 -> never triggers')
})

t('#51: outboundRungAdmissible admits the fishing rung during the hp-crisis (hp passed)', () => {
  const base = { foodSurvival: true, foodFloor: true }
  // hp4/food4: with the hp-crisis clause on, the secureFood/fishing outbound rung is admitted
  assert.strictEqual(F.outboundRungAdmissible(4, { food: 4, ...base, foodFloorHp: true }), true, 'hp4/food4 -> admit the fishing rung (dead-zone)')
  // FOOD_FLOOR_HP=0: hp4/food4 (food>2) is barred as today (hp<=abortHp)
  assert.strictEqual(F.outboundRungAdmissible(4, { food: 4, ...base, foodFloorHp: false }), false, 'FOOD_FLOOR_HP=0 -> hp4/food4 barred (byte-for-byte)')
  // food<=2 still admitted (existing carve-out), flag on or off
  assert.strictEqual(F.outboundRungAdmissible(1, { food: 2, ...base, foodFloorHp: false }), true, 'food<=2 -> admitted as today')
})

t('#51: famineHoldFood releases the indoor hold ONLY in the food 3-6 hp-crisis, not at food<=2', () => {
  const on = { foodFloor: true, foodFloorHp: true, foodSurvival: true }
  // hp4/food4 dead-zone -> release the hold so the bot can go fish
  assert.strictEqual(F.famineHoldFood(4, { hp: 4, hasPackFood: false, ...on }), false, 'hp4/food4 -> do NOT famine-hold (fish instead)')
  // food<=2 -> KEEP holding (the starvation floor + #40 own it; releasing re-opens the death-march)
  assert.strictEqual(F.famineHoldFood(2, { hp: 2, hasPackFood: false, ...on }), true, 'food<=2 -> still holds (byte-for-byte, #40 preserved)')
  // no hp passed (today's live caller) -> unchanged hold at food<=4
  assert.strictEqual(F.famineHoldFood(4, { foodSurvival: true }), true, 'no hp opt -> holds at food<=4 as today')
  // food>4 -> never a famine hold regardless
  assert.strictEqual(F.famineHoldFood(6, { hp: 4, ...on }), false, 'food>4 -> not a famine hold')
})

t('#52 FISH_FROM_BANK: isBankStand - dry standable cell WITH adjacent water is a bank; flooded/landlocked is not', () => {
  let P
  try { P = require('./provision.js') } catch (e) { console.log('      (skip: provision.js not loadable offline: ' + e.message + ')'); return }
  if (typeof P.isBankStand !== 'function') { console.log('      (skip: isBankStand not exported)'); return }
  const drySides = ['air', 'air', 'grass_block', 'dirt'] // dry feet-level neighbours (solid land + air, no fluid)
  // a genuinely dry standable pocket next to open water -> castable bank
  assert.strictEqual(P.isBankStand('air', 'air', drySides, true), true, 'dry 2-air pocket + adjacent water -> bank stand')
  // no water in reach -> cannot cast -> not a fishing bank (even if perfectly dry)
  assert.strictEqual(P.isBankStand('air', 'air', drySides, false), false, 'dry but landlocked -> not a fishing bank')
  // feet submerged -> feetCellDry false -> never a stand (the drowning cell we must avoid)
  assert.strictEqual(P.isBankStand('water', 'air', drySides, true), false, 'submerged feet -> not a stand')
  // a puddle laps at a feet-level side -> feetCellDry false -> reject (would flood the stand)
  assert.strictEqual(P.isBankStand('air', 'air', ['water', 'air', 'air', 'air'], true), false, 'water at a feet-level side -> not a stand')
  // head blocked (not 2 air) -> not standable
  assert.strictEqual(P.isBankStand('air', 'stone', drySides, true), false, 'head not air -> not standable')
})

t('#61 SKIP_DEAD_FISHING: shouldFish - the fishing gate is DEFAULT OFF, true ONLY at FISHING_ENABLED=1', () => {
  // DEFAULT OFF (the deliberate exception to the usual default-ON convention - fishing is dead).
  assert.strictEqual(F.shouldFish({}), false, 'unset FISHING_ENABLED -> fishing OFF (default)')
  assert.strictEqual(F.shouldFish({ FISHING_ENABLED: undefined }), false, 'undefined -> OFF')
  assert.strictEqual(F.shouldFish({ FISHING_ENABLED: '0' }), false, '=0 -> OFF')
  assert.strictEqual(F.shouldFish({ FISHING_ENABLED: 'true' }), false, 'only the exact string "1" enables it -> "true" is OFF')
  assert.strictEqual(F.shouldFish({ FISHING_ENABLED: 1 }), false, 'numeric 1 (not the string "1") -> OFF')
  // ON only at the exact string '1' -> restores today's fishing behavior byte-for-byte.
  assert.strictEqual(F.shouldFish({ FISHING_ENABLED: '1' }), true, '=1 -> fishing ON (today\'s behavior)')
  // no-arg defaults to process.env (the runtime path fishingEnabled() uses).
  const saved = process.env.FISHING_ENABLED
  try {
    delete process.env.FISHING_ENABLED
    assert.strictEqual(F.shouldFish(), false, 'no arg + env unset -> OFF (runtime default)')
    process.env.FISHING_ENABLED = '1'
    assert.strictEqual(F.shouldFish(), true, 'no arg + env=1 -> ON (runtime enable)')
  } finally { if (saved === undefined) delete process.env.FISHING_ENABLED; else process.env.FISHING_ENABLED = saved }
})

// ==== #62 FOOD_BUFFER pure helpers ==========================================================
t('#62 §A bankFoodWithdrawPts: shortfall to safeFood, capped by what the bank holds', () => {
  // bank rich, deep crisis -> withdraw the full shortfall (safe 14 - food 0 = 14)
  assert.strictEqual(F.bankFoodWithdrawPts(50, 0, 14), 14, 'rich bank, food0 -> pull the full 14-pt shortfall')
  // bank poor -> capped by the bank (only 5 pts banked, still helps partially)
  assert.strictEqual(F.bankFoodWithdrawPts(5, 0, 14), 5, 'poor bank -> capped by bank holdings (partial help)')
  // bank EMPTY -> 0 -> fall through to the farm/hold path
  assert.strictEqual(F.bankFoodWithdrawPts(0, 0, 14), 0, 'empty bank -> 0 -> fall through to farm/hold')
  // already at/above the safe level -> 0 (no needless withdraw, e.g. food 15 >= 14)
  assert.strictEqual(F.bankFoodWithdrawPts(50, 15, 14), 0, 'already fed past safe -> 0')
  assert.strictEqual(F.bankFoodWithdrawPts(50, 14, 14), 0, 'exactly at safe -> 0')
  // partial shortfall -> exact points, bank-capped
  assert.strictEqual(F.bankFoodWithdrawPts(50, 10, 14), 4, 'food10 -> 4-pt shortfall to safe 14')
  assert.strictEqual(F.bankFoodWithdrawPts(3, 10, 14), 3, 'food10, shortfall 4 but bank only 3 -> 3')
  // safeFood defaults to 14 when omitted; guards on null/undefined inputs
  assert.strictEqual(F.bankFoodWithdrawPts(50, 0), 14, 'safeFood default 14')
  assert.strictEqual(F.bankFoodWithdrawPts(undefined, undefined, 14), 0, 'null bank + null food -> 0 (no throw)')
})

t('#62 §B foodSurplusToBank: surplus beyond the small pack reserve is what ships to the bank', () => {
  // plenty on pack -> ship everything beyond the reserve (40 - 8 = 32)
  assert.strictEqual(F.foodSurplusToBank(40, 8), 32, 'pack 40, reserve 8 -> 32 surplus to the bank')
  // exactly the reserve -> nothing to ship
  assert.strictEqual(F.foodSurplusToBank(8, 8), 0, 'pack == reserve -> 0 surplus (keep it)')
  // below the reserve -> nothing to ship (hoard the last few for the excursion)
  assert.strictEqual(F.foodSurplusToBank(5, 8), 0, 'pack < reserve -> 0 surplus')
  // reserve defaults to 8 when omitted
  assert.strictEqual(F.foodSurplusToBank(20), 12, 'reserve default 8 -> 12 surplus')
  // guards
  assert.strictEqual(F.foodSurplusToBank(0, 8), 0, 'empty pack -> 0')
  assert.strictEqual(F.foodSurplusToBank(undefined, undefined), 0, 'null pack + default reserve -> 0 (no throw)')
})

t('#62 §C farmExpandGate: expands ONLY in a safe window; yields to survival + all guards', () => {
  const safe = { underTarget: true, crisisActive: false, hp: 20, fed: true, day: true, nearFarm: true }
  assert.strictEqual(F.farmExpandGate(safe), true, 'every guard holds -> proactively expand')
  // yields to survival (the HARD constraint)
  assert.strictEqual(F.farmExpandGate({ ...safe, crisisActive: true }), false, 'a survival crisis active -> yield, no expand')
  // each individual guard blocks
  assert.strictEqual(F.farmExpandGate({ ...safe, underTarget: false }), false, 'farm already at target -> nothing to expand')
  assert.strictEqual(F.farmExpandGate({ ...safe, hp: 13 }), false, 'hp below safeHp 14 -> no expand')
  assert.strictEqual(F.farmExpandGate({ ...safe, hp: null }), false, 'unknown hp -> no expand')
  assert.strictEqual(F.farmExpandGate({ ...safe, fed: false }), false, 'not fed (food crisis) -> no expand')
  assert.strictEqual(F.farmExpandGate({ ...safe, day: false }), false, 'night -> no expand')
  assert.strictEqual(F.farmExpandGate({ ...safe, nearFarm: false }), false, 'not near the farm -> no expand (no long trek)')
  // hp exactly at the safe line passes; safeHp is tunable via opts
  assert.strictEqual(F.farmExpandGate({ ...safe, hp: 14 }), true, 'hp exactly 14 -> passes the >=safeHp gate')
  assert.strictEqual(F.farmExpandGate({ ...safe, hp: 16 }, { safeHp: 18 }), false, 'safeHp opt raises the bar')
  assert.strictEqual(F.farmExpandGate(), false, 'no state -> false (no throw)')
})

// ==== #64 DYNAMIC_FOOD - foodNeedForPlan (pure, intent-aware ration) =========================
// ON = pin the flag on via opts so the dynamic-MODEL tests are independent of the ambient
// DYNAMIC_FOOD env (the suite runs in BOTH regimes; the =0 fallback has its own test below).
const DF_ON = { dynamicFood: true }
t('#64 foodNeedForPlan: home/near-bank -> the small DFOOD_HOME_PTS baseline', () => {
  const home = F.foodNeedForPlan({ activity: 'idle', distHome: 0, depth: 0, homeReachable: true }, DF_ON)
  assert.strictEqual(home, 8, 'idle at the bank -> ~DFOOD_HOME_PTS (8)')
  assert.strictEqual(F.foodNeedForPlan({ activity: 'idle', distHome: 20, depth: 0, homeReachable: true }, DF_ON), 8, 'near the bank (in range) -> still the home baseline')
  assert.strictEqual(F.foodNeedForPlan({ activity: 'build-at-home', distHome: 5, homeReachable: true }, DF_ON), 8, 'a build at home can withdraw anytime -> home baseline')
  assert.strictEqual(F.foodNeedForPlan({}, DF_ON), 8, 'no plan -> the home baseline (safe default), no throw')
})

t('#64 foodNeedForPlan: far-gather scales with distHome, clamps at DFOOD_MAX', () => {
  const near = F.foodNeedForPlan({ activity: 'far-gather', distHome: 30, homeReachable: false }, DF_ON)
  const mid = F.foodNeedForPlan({ activity: 'far-gather', distHome: 120, homeReachable: false }, DF_ON)
  const far = F.foodNeedForPlan({ activity: 'far-gather', distHome: 400, homeReachable: false }, DF_ON)
  assert.ok(near < mid, 'more distance -> more food (' + near + ' < ' + mid + ')')
  assert.strictEqual(far, 40, 'a very far trek clamps at DFOOD_MAX (40), never hoards past it')
  // monotonic non-decreasing in distHome
  let prev = -1
  for (const d of [0, 10, 25, 50, 100, 200, 300, 500]) {
    const n = F.foodNeedForPlan({ activity: 'far-trek', distHome: d, homeReachable: false }, DF_ON)
    assert.ok(n >= prev, 'monotonic in distHome (' + d + 'b -> ' + n + ' >= ' + prev + ')')
    prev = n
  }
})

t('#64 foodNeedForPlan: deep-mine is the BIGGEST bucket, monotonic + clamped in depth', () => {
  const gather = F.foodNeedForPlan({ activity: 'far-gather', distHome: 60, homeReachable: false }, DF_ON)
  const shallow = F.foodNeedForPlan({ activity: 'deep-mine', depth: 5, homeReachable: false }, DF_ON)
  const deep = F.foodNeedForPlan({ activity: 'deep-mine', depth: 50, homeReachable: false }, DF_ON)
  assert.ok(deep > gather, 'deep-mine >> far-gather (' + deep + ' > ' + gather + ') - you cannot pop home from y16')
  assert.ok(deep >= shallow, 'more depth -> at least as much food (' + deep + ' >= ' + shallow + ')')
  assert.strictEqual(deep, 40, 'a deep descent (2*depth + session) clamps at DFOOD_MAX (40)')
  // monotonic non-decreasing in depth
  let prev = -1
  for (const d of [0, 3, 8, 12, 20, 40, 60]) {
    const n = F.foodNeedForPlan({ activity: 'deep-mine', depth: d, homeReachable: false }, DF_ON)
    assert.ok(n >= prev, 'monotonic in depth (' + d + ' -> ' + n + ' >= ' + prev + ')')
    prev = n
  }
  // deep-mine at a comparable-scale depth beats a comparable-distance gather (biggest bucket)
  const dm = F.foodNeedForPlan({ activity: 'deep-mine', depth: 10, homeReachable: false }, DF_ON)
  const fg = F.foodNeedForPlan({ activity: 'far-gather', distHome: 10, homeReachable: false }, DF_ON)
  assert.ok(dm > fg, 'at the same magnitude deep-mine outweighs far-gather (' + dm + ' > ' + fg + ')')
})

t('#64 foodNeedForPlan: every excursion result >= home baseline + return margin', () => {
  const HOME = 8, MARGIN = 4
  for (const plan of [
    { activity: 'far-gather', distHome: 1, homeReachable: false },
    { activity: 'far-trek', distHome: 40, homeReachable: false },
    { activity: 'deep-mine', depth: 1, homeReachable: false },
    { activity: 'deep-mine', depth: 30, homeReachable: false }
  ]) {
    const n = F.foodNeedForPlan(plan, DF_ON)
    assert.ok(n >= HOME + MARGIN, plan.activity + ' carries at least home+margin (' + n + ' >= ' + (HOME + MARGIN) + ')')
  }
  // always clamped within [HOME, MAX] for arbitrary inputs
  for (const plan of [
    { activity: 'idle' }, { activity: 'deep-mine', depth: 9999 }, { activity: 'far-gather', distHome: 9999 },
    { activity: 'weird', distHome: -5, depth: -3 }
  ]) {
    const n = F.foodNeedForPlan(plan, DF_ON)
    assert.ok(n >= 8 && n <= 40, 'clamped to [8,40] (' + JSON.stringify(plan) + ' -> ' + n + ')')
  }
})

t('#64 foodNeedForPlan: !homeReachable never leaves with less than a real buffer', () => {
  // an "idle"-classified plan but the bank is out of reach -> bumped to at least BASE+margin (16)
  const stranded = F.foodNeedForPlan({ activity: 'idle', distHome: 10, homeReachable: false }, DF_ON)
  assert.ok(stranded >= 16, 'stranded from the bank -> a real buffer, not the home 8 (' + stranded + ')')
  // homeReachable idle stays at the small baseline (the bank is right there)
  assert.strictEqual(F.foodNeedForPlan({ activity: 'idle', distHome: 10, homeReachable: true }, DF_ON), 8, 'bank reachable -> home baseline')
})

t('#64 foodNeedForPlan: DYNAMIC_FOOD=0 -> the fixed FOOD_PACK_RESERVE (byte-for-byte #62)', () => {
  // via opts (offline, no env mutation): the flag off returns the flat reserve regardless of plan
  for (const plan of [
    { activity: 'deep-mine', depth: 50 }, { activity: 'far-gather', distHome: 300 }, { activity: 'idle' }
  ]) {
    assert.strictEqual(F.foodNeedForPlan(plan, { dynamicFood: false }), 8, 'flag off -> fixed reserve 8 (' + plan.activity + ')')
    assert.strictEqual(F.foodNeedForPlan(plan, { dynamicFood: false, reserve: 12 }), 12, 'flag off -> the configured FOOD_PACK_RESERVE')
  }
  // tunables are honoured when on
  assert.strictEqual(F.foodNeedForPlan({ activity: 'idle' }, { dynamicFood: true, homePts: 6 }), 6, 'DFOOD_HOME_PTS opt honoured')
  assert.strictEqual(F.foodNeedForPlan({ activity: 'deep-mine', depth: 100 }, { dynamicFood: true, max: 25 }), 25, 'DFOOD_MAX opt caps the ration')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall food-security tests passed')
process.exit(failures ? 1 : 0)
