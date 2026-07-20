'use strict'
// OFFLINE unit test for #113 CRISIS_OUTRANKS_PEACETIME (DESIGN §3.4 D2, Root D).
//
// The tape this file locks down (live, 2026-07-19) - the brain diagnosed the emergency correctly
// and tried to act FOUR times; every attempt was eaten by a food-securing hold:
//
//   15:50:53 (drown-crisis) head underwater - taking the controls to get out of the water
//   15:50:54 (cmd) goto hut «need to get out of water» -> held (securing food) - brain command suppressed
//   15:51:11 (cmd) goto hut «get out of water»        -> held (securing food) - brain command suppressed
//   15:51:12 (cmd) goto hut «get out of water»        -> held (securing food) - brain command suppressed
//   15:51:15 (cmd) goto hut «get out of water»        -> held (securing food) - brain command suppressed
//   15:51:17 (death) at 429,52,-49
//   15:51:19 (cmd) say i'm stuck in water and can't move - help me out -> skipped (vibe budget 3s)
//   ...and every 4s throughout: (auto-eat) only risky food left - holding out   <- at hp 1
//
// Three peacetime rules with no crisis exemption. The fix is NOT a water special case: hold
// admissibility is a function of the arbiter's LIVE CRISIS TIER, so lava, fire and critical-hp
// are covered by construction. The tests below assert exactly that generality.
//
// Run: cd bot && node crisisholdtest.js

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// AMBIENT-PROOFING (mandatory): inherit nothing from the shell.
process.env.CHAT_COOLDOWN_MS = '0'
process.env.VIBE_CHAT_MS = '600000'
process.env.SAY_DUP_WINDOW_MS = '360000'
delete process.env.PROGRESS_FOOD_MIN
delete process.env.THREAT_LOS
delete process.env.THREAT_LOS_FLOOR

const arbiter = require('./arbiter.js')
const { PRIORITY } = arbiter

let n = 0
async function main () {
const ok = (cond, what) => { assert.ok(cond, what); n++; console.log('  ok  ' + what) }
const eq = (a, b, what) => { assert.deepStrictEqual(a, b, what + ` (got ${JSON.stringify(a)})`); n++; console.log('  ok  ' + what) }

const crisis = (need, reason) => ({ tier: PRIORITY.SURVIVE, need, reason: reason || need })

console.log('\n#113 A. the live failure: a food hold may not outrank drowning')
{
  // The exact 15:50:54 state: securing food (holdNeed 'food') while the head is underwater.
  const r = arbiter.holdAdmissible(crisis('drowning', 'head underwater'), 'food')
  eq(r.ok, false, 'drowning vs the securing-food hold: hold INADMISSIBLE (was: held, then a corpse)')
  ok(/drowning/.test(r.reason) && /food/.test(r.reason), 'the reason names both the crisis and the hold it overrode')
}

console.log('\n#113 B. it generalises - NOT a water special case')
{
  // If any of these regress to admissible, someone has re-introduced a per-hazard branch.
  for (const need of ['lava', 'fire', 'drowning', 'heal']) {
    eq(arbiter.holdAdmissible(crisis(need), 'food').ok, false, `${need} outranks the food hold`)
    eq(arbiter.holdAdmissible(crisis(need), 'shelter').ok, false, `${need} outranks the night-rest hold`)
    eq(arbiter.holdAdmissible(crisis(need), null).ok, false, `${need} outranks peacetime work (busy building)`)
  }
  // Suffocation and burning have no dedicated verdict in jobSurvivalNeed - they arrive as damage,
  // i.e. as 'heal' once hp crosses the critical floor. That path is covered by the 'heal' rows
  // above; this asserts the coupling so a future suffocation verdict cannot land unranked.
  ok(arbiter.needRank('heal') < arbiter.needRank('food'), 'critical-hp (how suffocation/burning surface) outranks food')
  eq(arbiter.NEED_ORDER.every(x => arbiter.needRank(x) < Infinity), true, 'every ranked need has a finite rank')
  eq(arbiter.needRank('some-future-need'), Infinity, 'an UNRANKED need is treated as least urgent, never as most')
}

console.log('\n#113 C. peacetime is untouched, and a hold is never made to fight itself')
{
  eq(arbiter.holdAdmissible(null, 'food').ok, true, 'no crisis: the food hold stands exactly as today')
  eq(arbiter.holdAdmissible({ tier: PRIORITY.PROGRESS, need: 'x' }, 'food').ok, true, 'a sub-SURVIVE need does not break holds')
  // THE regression that a naive "all holds are inadmissible at SURVIVE tier" would cause: food<14
  // IS a SURVIVE need, so securing food would be interrupted by the very crisis it is resolving.
  eq(arbiter.holdAdmissible(crisis('food', 'food 9 < 14'), 'food').ok, true, 'the food hold survives the FOOD crisis it exists to fix')
  eq(arbiter.holdAdmissible(crisis('shelter'), 'shelter').ok, true, 'the night-rest hold survives the shelter need')
  eq(arbiter.holdAdmissible(crisis('food'), 'heal').ok, true, 'a hold serving a MORE urgent need than the crisis stands')
  eq(arbiter.holdAdmissible(crisis('food'), null).ok, false, 'but peacetime work never outranks a live crisis')
}

console.log('\n#113 D. mortalDanger: the narrower class (rules that must void when death is seconds away)')
{
  for (const need of ['lava', 'fire', 'drowning', 'heal']) eq(arbiter.mortalDanger(crisis(need)), true, `mortalDanger(${need})`)
  for (const need of ['threat', 'creeper', 'food', 'shelter']) eq(arbiter.mortalDanger(crisis(need)), false, `NOT mortalDanger(${need}) - dangerous, but peacetime policy still applies`)
  eq(arbiter.mortalDanger(null), false, 'mortalDanger(null)')
  eq(arbiter.mortalDanger({ tier: PRIORITY.PRESERVE, need: 'drowning' }), false, 'sub-SURVIVE tier is not mortal danger')
}

console.log('\n#113 E. the arbiter really does report these needs (the ranking is not a dead vocabulary)')
{
  // Guards against NEED_ORDER drifting away from jobSurvivalNeed's branches.
  const cases = [
    [{ inLava: true }, 'lava'], [{ onFire: true }, 'fire'], [{ drowning: true }, 'drowning'],
    [{ hp: 4 }, 'heal'], [{ threatDist: 3 }, 'threat'], [{ creeperDist: 8 }, 'creeper'],
    [{ food: 9 }, 'food'], [{ isNight: true, underArmored: true }, 'shelter']
  ]
  for (const [state, need] of cases) {
    const got = arbiter.jobSurvivalNeed(state)
    eq(got && got.need, need, `jobSurvivalNeed reports '${need}'`)
    ok(arbiter.needRank(got.need) < Infinity, `'${need}' is ranked in NEED_ORDER`)
  }
}

console.log('\n#113 F. risky food: rotten flesh beats dying, and is still refused at peace')
{
  // Stub survival-snapshot BEFORE provision-food lazily requires it, so this stays fully offline.
  const snapPath = require.resolve('./survival-snapshot.js')
  let fakeNeed = null
  require.cache[snapPath] = { id: snapPath, filename: snapPath, loaded: true, exports: { survivalNeed: () => fakeNeed } }

  const provFood = require('./provision-food.js')
  const mkBot = (food, hp) => {
    let consumed = null
    return {
      version: '1.21.1', food, health: hp,
      inventory: { items: () => [{ name: 'rotten_flesh', count: 5 }] },
      equip: async () => {}, consume: async () => { consumed = 'rotten_flesh' },
      _consumed: () => consumed
    }
  }
  // PEACETIME: food 12, full hp, nothing trying to kill it -> hold out (unchanged behavior).
  fakeNeed = null
  {
    const bot = mkBot(12, 20)
    const r = await provFood.eatBestFood(bot)
    eq(r, 'only risky food left - holding out', 'peace: rotten flesh REFUSED (peacetime rule intact)')
    eq(bot._consumed(), null, 'peace: nothing was eaten')
  }
  // DROWNING at hp 1 - the live 15:51 state. The old rule looped "holding out" here every 4s.
  for (const need of ['drowning', 'lava', 'fire', 'heal']) {
    fakeNeed = crisis(need)
    const bot = mkBot(12, 1)
    const r = await provFood.eatBestFood(bot)
    ok(/^ate rotten_flesh/.test(r), `${need}: rotten flesh EATEN (was: "only risky food left - holding out" at hp 1)`)
    eq(bot._consumed(), 'rotten_flesh', `${need}: the item was actually consumed`)
  }
  // A mob nearby is NOT a reason to poison yourself - the narrow class matters.
  fakeNeed = crisis('threat')
  {
    const bot = mkBot(12, 20)
    eq(await provFood.eatBestFood(bot), 'only risky food left - holding out', 'threat: still refused (not mortal danger)')
  }
  delete require.cache[snapPath]
}

console.log('\n#113 G. a distress call is not a vibe')
{
  const chatGate = require('./chat-gate.js')
  let inCrisis = false
  let busy = true
  const say = l => chatGate.gateSay(l, true, { isBusy: () => busy, inCrisis: () => inCrisis })
  eq(say('say hey folks how is everyone doing today'), 'busy - no idle chatter', 'peace + busy: idle chatter is silenced (unchanged)')
  inCrisis = true
  eq(say('say im stuck in water and cant move help me out'), null, 'crisis: the distress call passes the busy-silence AND the vibe budget')
  // The distress line still SPENT the budget, so this is not an open spam channel.
  inCrisis = false; busy = false
  eq(say('say another totally different idle remark here'), `vibe budget ${Math.ceil(600000 / 1000)}s`, 'peace again: the vibe budget is back (the crisis line spent it, so this is not a spam channel)')
  inCrisis = true
  inCrisis = true
  ok(/^duplicate/.test(say('say im stuck in water and cant move help me out')), 'crisis does NOT disable the duplicate guard')
}

console.log('\n#113 H. source assertion: no timer, cooldown or wall-clock hold was introduced')
{
  // memory rule no-blanket-time-holds is ABSOLUTE. Everything above is condition-gated.
  const src = fs.readFileSync(path.join(__dirname, 'arbiter.js'), 'utf8')
  const added = src.slice(src.indexOf('#113 CRISIS_OUTRANKS_PEACETIME'), src.indexOf('function mineThreatDecision'))
  ok(added.length > 0, 'the #113 block is present in arbiter.js')
  for (const bad of ['setTimeout', 'setInterval', 'Date.now', 'Until', 'CooldownMs', 'cooldown']) {
    ok(!added.includes(bad), `arbiter.js #113 block contains no '${bad}'`)
  }
  const gate = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
  const idx = gate.indexOf('#113 CRISIS_OUTRANKS_PEACETIME (DESIGN §3.4 D2): what the hold IS FOR')
  ok(idx > 0, 'the #113 hold-need computation is present in index.js')
  ok(!gate.slice(idx, idx + 1400).includes('setTimeout'), 'the index.js #113 gate arms no timer')
}

  console.log(`\n#113 crisisholdtest: ${n} assertions passed\n`)
}

main().catch(e => { console.error((e && e.stack) || e); process.exit(1) })
