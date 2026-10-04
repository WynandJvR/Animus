'use strict'
// SURVIVAL REFLEXES - a 200ms loop that owns the body whenever the body is in danger. While a
// reflex is active every skill pauses (move.goTo aborts and waits; skills call waitClear()).
// Order: air > lava/fire > creeper > melee/ranged threat > low-hp retreat > eat. A skill may hold a bounded DIVE
// (startDive/endDive): the one declared exception to the air reflex.
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const world = require('./world')
const inv = require('./inventory')
const { log } = require('./log')

const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'creeper', 'witch', 'slime', 'magma_cube', 'silverfish', 'endermite', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'phantom', 'zombie_villager', 'piglin_brute', 'hoglin', 'zoglin', 'blaze', 'ghast', 'wither_skeleton', 'guardian', 'elder_guardian', 'breeze', 'creaking'])
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'breeze'])
let creeperTrail = [] // (the creeper row's body samples, the last ~1s: see its stalled/hurtByOther tests)
let creeperSaid = { stall: false, hurt: false }
const CREEPER_FIGHT = true // (the stand-and-strike branch below - audited 2026-10-02)
let creeperMode = null // 'fight' | 'run': said once per change in an encounter
let creeperBackUntil = 0 // the step back after a strike
let creeperFight = null // {id, closest, since}: the stand's progress (a stand-off is let go)
let fightTarget = null // the creeper the physics-tick strike watches
let fightAt = 0 // when the row last stood to it: the strike acts only on a stand the row holds NOW
const creeperIgnore = new Map() // creeper id -> until: a stand-off let be
const NEVER_MELEE = new Set(['creeper', 'ghast', 'warden', 'wither', 'elder_guardian', 'ravager'])

let bot = null
let active = null // {kind, since, detail}
let busy = false // an async reflex action is running
let busySince = 0; let busySaid = false // (how long it has been running - said once past 3s)
// EVERY REFLEX ACTION HAS A DEADLINE: an action that never ends holds `busy` and every row waits on it - cornered by a
// pillager, the wall-off's two placings had no time limit and the bot stood 12s under fire, "flee" and no key, and died
// (2026-09-28). The action may run on; the rows go on at its deadline. (`kind`: its row, let go at the deadline too.)
// ...and at its deadline the action is STOPPED, not left running under the rows it held off (two intents on one body - the
// one-runner rule): `act` is started here as act(gen), long ones ask busyAborted(gen) between their steps, and `stop`
// ends what is under way (the dig, the bite, the planner's goal); audit 2026-09-28.
let busyGen = 0
const abortedGens = new Set()
function busyAborted (g) { return abortedGens.has(g) }
function runBusy (label, act, ms, kind = null, stop = null) {
  const my = ++busyGen
  busy = true
  let timer = null
  const p = typeof act === 'function' ? Promise.resolve().then(() => act(my)) : act
  const dl = new Promise(resolve => { timer = setTimeout(() => resolve('deadline'), ms) })
  return Promise.race([Promise.resolve(p).then(() => 'done', () => 'done'), dl]).then(res => {
    clearTimeout(timer)
    if (res === 'deadline') {
      abortedGens.add(my); if (abortedGens.size > 64) abortedGens.delete(abortedGens.values().next().value)
      try { if (stop) stop() } catch {}
      log('reflex', `busy ${label} ran out after ${ms}ms - stopped, the rows go on`)
      if (kind && active && active.kind === kind) clearActive()
    }
    if (busyGen === my) busy = false
  })
}
const stopDig = () => { try { bot.stopDigging() } catch {} }
const stopWalk = () => { try { bot.pathfinder.setGoal(null) } catch {} bot.clearControlStates() }
let dressFailed = null // the better-armour key a wear attempt left unchanged (cleared when the inventory changes)
let submergedSince = 0
let lastAttackAt = 0
let lastHurtAt = 0
let lastHurtBy = null
let lastEatFail = 0
let enabled = true
let fleeTarget = null
let diedAt = 0
let lastLogKey = ''

// OUR air clock. bot.oxygenLevel is not trusted: on this server it was seen stuck at 5 on dry land. A player has
// 300 ticks (15s) of air; under water it runs down a tick a tick, in air it comes back four a tick.
const AIR_MS = 15000
let airMs = AIR_MS
let airAt = 0
function trackAir (now) {
  const under = world.headInWater(bot)
  if (under) { if (!submergedSince) submergedSince = now } else submergedSince = 0
  const dt = airAt ? now - airAt : 0; airAt = now
  airMs = under ? Math.max(0, airMs - dt) : Math.min(AIR_MS, airMs + 4 * dt)
}

// A DIVE: a skill's declared, bounded exception to the air reflex (clay.js goes down to dig a river bed). While
// it holds, a head under water is not an emergency - until the underwater time passes its budget (never past
// DIVE_HARD_MS), the air left runs under a reserve, the body is hurt, a hostile (a drowned) comes within 8, or
// another reflex takes the body. Then the dive is BROKEN for good and the air reflex surfaces us as it always
// does. Every other reflex keeps its priority; the skill ends the dive itself (endDive) once its head is out.
const DIVE_HARD_MS = 11000
const AIR_RESERVE_MS = 4000
let dive = null // { maxMs, hp, broken }
function startDive (maxMs = DIVE_HARD_MS) { dive = { maxMs: Math.min(maxMs, DIVE_HARD_MS), hp: bot.health, broken: null } }
function endDive () { const d = dive; dive = null; return d ? d.broken : null }
function diveBroken () { return dive ? dive.broken : null }
function diveHolds (now) {
  if (!dive || dive.broken) return false
  const under = submergedSince ? now - submergedSince : 0
  if (bot.health > dive.hp) dive.hp = bot.health // (regeneration raises the mark; only a loss counts)
  const h = hostiles(8)[0]
  const why = under >= dive.maxMs ? `under ${Math.round(under / 100) / 10}s` : submergedSince && airMs < AIR_RESERVE_MS ? `air low (${Math.round(airMs / 100) / 10}s left)`
    : bot.health <= dive.hp - 1 ? `hurt (hp ${Math.round(bot.health)})` : h ? `${h.e.name} ${h.d.toFixed(1)}b` : active && active.kind !== 'air' ? `${active.kind} reflex` : null
  if (!why) return true
  dive.broken = why
  log('reflex', `dive broken: ${why} - surfacing`)
  try { if (bot.targetDigBlock) bot.stopDigging() } catch {} // (the body is ours now: no dig left running under water)
  return false
}

// NO FIGHT PICKED AGAIN THAT WAS JUST LOST: a flee straight out of a fight with that mob marks the hp the fight began at;
// no charge at it until the hp is back over that. Fight at 20, flee at 10, eat, fight again at 10, flee, fight at 5 -
// the pillager's death spiral (2026-09-28; audit)
const fledFrom = new Map() // entity id -> hp the lost fight began at
let fightStartHp = null; let fightTargetId = null
// (a fight is LOST when it ends - however it ends - more than 4 hp down: "fight done" when the pillager stepped out of
//  sight left no mark, and the bot charged it again at hp 11, 2026-09-28)
const LOST_FIGHT_HP = 4
function noteFightEnd () {
  if (fightTargetId != null && fightStartHp != null && bot.health < fightStartHp - LOST_FIGHT_HP) fledFrom.set(fightTargetId, Math.max(fledFrom.get(fightTargetId) || 0, fightStartHp))
}
function setActive (kind, detail) {
  // (the safehouse run ends whenever the body goes to anything else - its walk left driving against a creeper's flight; audit)
  if (safeRun && !(kind === 'flee' && /- to the safehouse$/.test(detail || ''))) { safeRun = null; try { bot.pathfinder.setGoal(null) } catch {} }
  if (kind !== 'shoot') endDraw(kind) // (the body is another reflex's now: the string goes)
  if (active && active.kind === 'fight' && kind !== 'fight') noteFightEnd()
  if (kind === 'fight' && (!active || active.kind !== 'fight')) fightStartHp = bot.health
  if (kind === 'flee' && active && active.kind === 'fight' && fleeTarget && fightStartHp != null) fledFrom.set(fleeTarget.id, Math.max(fledFrom.get(fleeTarget.id) || 0, fightStartHp))
  if (!active || active.kind !== kind) {
    active = { kind, since: Date.now(), detail }
    const key = kind + ':' + (detail || '')
    if (key !== lastLogKey) { lastLogKey = key; log('reflex', `${kind}${detail ? ' - ' + detail : ''} (hp ${Math.round(bot.health)} food ${bot.food})`) }
  } else active.detail = detail
}
let blocking = false
function shieldUp () { if (!blocking) { try { bot.activateItem(true); blocking = true } catch {} } }
function shieldDown () { if (blocking) { try { bot.deactivateItem() } catch {} blocking = false } }
function clearActive () {
  endDraw('released')
  shieldDown()
  riseY = null
  if (active && active.kind === 'fight') noteFightEnd()
  if (active) {
    log('reflex', `${active.kind} done after ${Math.round((Date.now() - active.since) / 100) / 10}s (hp ${Math.round(bot.health)})`)
    active = null; lastLogKey = ''
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  }
}

const provoked = new Map() // enderman id -> when it last hit us
let waterRun = null // { id, at, from }: the run to water from an enderman (one that does not move gives the water up)
const waterGaveUp = new Set() // enderman ids whose water did not work out
function hostiles (maxDist = 24) {
  const me = bot.entity.position
  const out = []
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || !e.name) continue
    // (and an enderman that has hit us lately: neutral until provoked, then the most dangerous thing about - left out, the
    //  eat row ate beside it and no row but a hit's 3s answer saw it; 2026-10-03, audit)
    if (!HOSTILE.has(e.name) && !(e.name === 'enderman' && Date.now() - (provoked.get(e.id) || 0) < 30000)) continue
    const d = e.position.distanceTo(me)
    if (d <= maxDist) out.push({ e, d })
  }
  out.sort((a, b) => a.d - b.d)
  return out
}

// A mob on the surface - at or over the top ground of its column (leaves and logs are not ground): what can walk to the
// door or shoot at it. One in the caves under the mountain is not: cave skeletons 17-24 blocks off kept the bot in the
// safehouse a whole morning, in daylight, the build standing still (2026-09-26). (Here, beside hostiles(), so the
// director's hideout and the safehouse door's seal ask the same question.)
function onSurface (e) {
  try {
    const p = e.position.floored()
    const g = world.groundY(bot, p.x, p.z, p.y + 24)
    return g == null || p.y >= g
  } catch { return true }
}
// Line of sight to e from `eye` (default our own eyes): no full block on the way.
function canSee (e, eye = null) {
  try {
    eye = eye || bot.entity.position.offset(0, 1.62, 0)
    const tgt = e.position.offset(0, (e.height || 1.6) * 0.8, 0)
    const dir = tgt.minus(eye)
    const len = dir.norm()
    if (len < 1) return true
    const step = dir.scaled(1 / len)
    for (let t = 0.5; t < len; t += 0.5) {
      const p = eye.plus(step.scaled(t))
      const b = bot.blockAt(p.floored())
      if (b && b.boundingBox === 'block') return false
    }
    return true
  } catch { return true }
}

// THE HURT LINE: the hp at which one more exchange can kill - two hits of this difficulty's zombie (vanilla 2 / 3 / 4.5
// on easy / normal / hard, the common melee; unknown difficulty counts as hard), after the worn armour's cut (vanilla:
// max(points/5, points - damage/2) out of 25). Unarmoured on hard that is 9, in full iron 4.4. The reflex breaks
// off a fight at it; the director ends a trip outside at it and heals (director.tooHurt). One number for both.
function hurtLine () {
  const hit = { peaceful: 0, easy: 2, normal: 3, hard: 4.5 }[bot && bot.game && bot.game.difficulty]
  const dmg = hit == null ? 4.5 : hit
  const pts = inv.armorPoints(bot)
  const cut = Math.min(20, Math.max(pts / 5, pts - dmg / 2)) / 25
  return 2 * dmg * (1 - cut)
}

// CAN WE AFFORD THE CHARGE: the arrows taken on the way in and while the fight lasts, from every shooter in sight -
// the charged one's mostly on the shield when there is one - must leave us above the hurt line. "A shield or two armour
// pieces" charged a pillager patrol 9-14b off: one on the shield, the others shooting from the side, 20 -> 8 hp in six
// seconds and dead at the safehouse door (2026-09-25).
const SHOOTER_DPS = { skeleton: 2.2, stray: 2.2, bogged: 2.2, pillager: 2.5, witch: 3.5, blaze: 3, breeze: 2, ghast: 2 } // (pillager: a crossbow bolt is 4-5 hp every 1.5-2.5s - it took 20 hp in 55s; audit 2026-09-28)
const MOB_HP = { skeleton: 20, stray: 20, bogged: 16, pillager: 24, witch: 40, blaze: 20, breeze: 30, ghast: 10 }
// (a witch's harm and poison are MAGIC: armour takes nothing off them. At dps 2, armour-discounted, iron armour made a
//  witch at 5.4b worth charging: hp 15 -> 1 in 11s, and the night's second death followed, 2026-09-28. 3.5 a second -
//  harming 6 a splash, poison on top - and 40 hp for the heals it drinks. A shield blocks none of it: the splash
//  shatters on it and the effect lands all the same; audit)
const MAGIC = new Set(['witch'])
// `hs`: every hostile in range, the never-melee ones too - a ghast's fireballs land on the way in as well as a
// skeleton's arrows; handed the melee list, the ghast was never counted and a charge under it read as free (2026-09-27)
// A TRIP THAT IS NOT WORTH A DEATH: the director marks an optional gathering trip cautious - a charge then wants hp 18
// and nothing else hostile in sight; the answer otherwise is cover. Coal was never worth the 250 items scattered in a
// valley under a skeleton, 2026-09-28; audit
let cautious = false
function setCautious (on) { cautious = !!on }
function chargeAffordable (shooter, hs, hp) {
  // (never with a creeper about: a charge walks into the fuse - a blast was 6.4 of the last death's 20; audit)
  if (hs.some(h => h.e.name === 'creeper' && h.d < 12 && canSee(h.e))) return false
  // (a shooter already in sword reach is no charge: the trip's caution and an earlier flight from it are for the run IN -
  //  at 2.4b, hp 17, iron sword and chestplate, a gather trip's caution took cover from a skeleton, the edge of a drop held
  //  the flight, and it shot the bot dead in 18s, 2026-10-03)
  const reachNow = shooter.d < 3.5 || (!!active && active.kind === 'fight' && fightTargetId === shooter.e.id && shooter.d < 5)
  const pinnedNow = !!pinnedCover && pinnedCover.id === shooter.e.id && Date.now() < pinnedCover.until // (takeCover: a flight that cannot move)
  if (!reachNow && !pinnedNow && cautious && (hp < 18 || hs.some(h => h.e !== shooter.e && h.d < 24 && canSee(h.e)))) return false
  for (const id of fledFrom.keys()) if (!bot.entities[id]) fledFrom.delete(id) // (gone from the world: gone from the list)
  { const f = fledFrom.get(shooter.e.id); if (!reachNow && !pinnedNow && f != null && hp < f) return false }
  // (EVERY shooter about, in sight or not - a patrol's others shoot round the corner: the charge counted one and three
  //  bolts landed 0.65-0.85s apart, 20 -> 8, 2026-10-02; audit)
  const shooters = hs.filter(h => RANGED.has(h.e.name) && h.d < 24 && Math.abs(h.e.position.y - bot.entity.position.y) < 6) // (not a skeleton in the cave under us)
  const w = inv.bestWeapon(bot)
  const dmg = w ? (/_axe$/.test(w.name) ? 7 : 5) : 1
  const cd = w ? (/_axe$/.test(w.name) ? 1050 : 650) : 400
  const secs = Math.max(0, shooter.d - 3) / 4.5 + (MOB_HP[shooter.e.name] || 20) / (dmg * 1000 / cd)
  const shield = inv.offhandShield(bot)
  // (the charged one by ENTITY: compared as list elements, the fight's own re-check - a fresh {e, d} - never matched,
  //  so the pick said charge and the fight said flee, every tick, shield up at hp 12-16 under a skeleton, 2026-09-27)
  const pts = inv.armorPoints(bot)
  const dps = shooters.reduce((a, h) => a + (SHOOTER_DPS[h.e.name] || 2) * (MAGIC.has(h.e.name) ? 1 : (shield && h.e === shooter.e ? 0.2 : 1) * (1 - Math.min(20, pts) / 25)), 0)
  // (and never thinner than the damage being taken NOW, and a whole hit to spare: a 0.03 margin charged a patrol, 2026-10-02)
  const now = Date.now(); const taken = hurtLog.filter(q => now - q.at < 5000).reduce((a, q) => a + q.d, 0) / 5
  // (the hit to spare is for the run IN: a shooter already in sword reach is no run - turning from a skeleton at 2.5b to take
  //  cover put its arrows in our back, 17 -> 11, while 2.6s of swings ended it, 2026-10-02)
  // (and held out to 5 once fighting it: a skeleton steps back as it is closed on - a fixed 3.5 flipped fight and cover each
  //  tick; audit)
  return hp - secs * Math.max(dps, taken) > hurtLine() + (reachNow ? 0 : 4)
}
const hurtLog = [] // { at, d }: hp lost, the last seconds (health events)

// THE BOW. A shooter at range was fought only by walking into its arrows with a stone sword (or not at all: hide, flee)
// while two bows and fifteen arrows sat in the chest - and a pillager patrol that never burns camped the safehouse
// (2026-09-25). A player shoots back: full draw (1s), the aim solved for the arrow's own flight - 3 blocks a tick,
// 1% drag a tick, 0.05 gravity - on where the target will be when it lands.
const ARROW_RE = /^(arrow|spectral_arrow|tipped_arrow)$/
function bowReady () { const its = bot.inventory.items(); return its.some(i => i.name === 'bow') && its.some(i => ARROW_RE.test(i.name)) }
// pitch (radians, up +) that puts a full-draw arrow at horizontal distance h and height dy; and its flight time in ticks
function bowPitch (h, dy) {
  const fly = th => {
    let x = 0; let y = 0; let vx = 3 * Math.cos(th); let vy = 3 * Math.sin(th)
    for (let t = 1; t <= 100; t++) { x += vx; y += vy; vx *= 0.99; vy = vy * 0.99 - 0.05; if (x >= h) return { y, t } }
    return { y: -Infinity, t: 100 }
  }
  let lo = -0.9; let hi = 0.8
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (fly(mid).y < dy) lo = mid; else hi = mid }
  return { pitch: (lo + hi) / 2, t: fly((lo + hi) / 2).t }
}
function aimBow (e) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  let tgt = e.position.offset(0, (e.height || 1.8) * 0.6, 0)
  const v = e.velocity || { x: 0, z: 0 }
  for (let k = 0; k < 2; k++) {
    const h = Math.hypot(tgt.x - eye.x, tgt.z - eye.z)
    const { t } = bowPitch(h, tgt.y - eye.y)
    tgt = e.position.offset((v.x || 0) * t, (e.height || 1.8) * 0.6, (v.z || 0) * t)
  }
  const dx = tgt.x - eye.x; const dz = tgt.z - eye.z
  const { pitch } = bowPitch(Math.hypot(dx, dz), tgt.y - eye.y)
  return bot.look(Math.atan2(-dx, -dz), pitch, true).catch(() => {})
}
let shots = 0
// THE DRAW is not `busy`: a busy tick returns before the air clock's reflex, the tread and every threat - a draw from
// the water sank the bot (clearControlStates let go of the swim stroke) and a zombie walking up from behind was
// ignored for the whole second (2026-09-27). While it holds, the tick runs on: any other reflex that takes the body
// (setActive) lets the string go at once, and so does a melee mob within 3 or the ground going from under us.
let draw = null // { e, abort } while the bow is drawn
function canDraw () { return !!bot.entity && bot.entity.onGround && !bot.vehicle && !world.feetInWater(bot) }
function endDraw (why) { if (draw && !draw.abort) { draw.abort = why; try { bot.deactivateItem() } catch {} } }
async function shootAt (e) {
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  if (!bow) return false
  const d = draw = { e, abort: null }
  try {
    try { if (!bot.heldItem || bot.heldItem.name !== 'bow') await bot.equip(bow, 'hand') } catch { return false }
    if (d.abort) return false
    shieldDown()
    try { bot.pathfinder.setGoal(null) } catch {}
    for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) bot.setControlState(k, false) // (sneak stays the edge guard's)
    bot.activateItem()
    const t0 = Date.now()
    // hold the draw, the aim kept on it; let go of it early if it came close (the sword then), went, or anything that
    // hits in melee is within 3 of us, whichever side
    while (Date.now() - t0 < 1100) {
      if (d.abort) return false
      if (!e.isValid || bot.health <= 0 || !canDraw() || e.position.distanceTo(bot.entity.position) < 3.5 ||
        hostiles(3).some(h => !NEVER_MELEE.has(h.e.name))) { endDraw('broke off'); return false }
      await aimBow(e)
      await new Promise(r => setTimeout(r, 50))
    }
    if (d.abort) return false
    await aimBow(e)
    if (d.abort) return false
    bot.deactivateItem()
    shots++
    return true
  } finally { if (draw === d) draw = null }
}

function attackCooldownMs () {
  const h = bot.heldItem ? bot.heldItem.name : ''
  if (h.endsWith('_sword')) return 650
  if (h.endsWith('_axe')) return 1050
  return 400
}

async function doEat () {
  const food = inv.foodItems(bot, { desperate: bot.food <= 6, hurt: bot.health < 20 })[0]
  if (!food) return false
  setActive('eat', food.name)
  let ok = false
  // (bot.consume has no limit of its own: 3s is a bite and a half)
  await runBusy('eat', () => (async () => {
    const before = bot.food
    await bot.equip(food, 'hand')
    await bot.consume()
    log('reflex', `ate ${food.name} -> food ${bot.food}`)
    // a consume that resolves without the hunger bar moving is a refused bite: back off, don't spin
    if (bot.food <= before) lastEatFail = Date.now()
    ok = true
  })().catch(() => { lastEatFail = Date.now() }), 3000, 'eat', () => { try { bot.deactivateItem() } catch {} })
  if (!ok) lastEatFail = Date.now()
  if (active && active.kind === 'eat') clearActive()
  return ok
}

// Nearest cell reachable by swimming whose head space is air (a place to breathe), or dry land. With `landOnly`,
// dry land only: once the head is out, the cell we float in is always the nearest air - steering to it held the
// bot in place in a river for 12 minutes (2026-09-22) - so the way out is toward land, a step up at most preferred.
function findAir (landOnly = false, { aside = false } = {}) {
  const me = bot.entity.position.floored()
  let best = null; let bestD = Infinity
  for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) for (let dy = -2; dy <= 6; dy++) {
    if (aside && Math.abs(dx) + Math.abs(dz) < 2) continue // (a way round what is over us: not our own column or the next)
    const x = me.x + dx; const y = me.y + dy; const z = me.z + dz
    const feet = world.at(bot, x, y, z); const head = world.at(bot, x, y + 1, z)
    if (!feet || !head) continue
    if (!(world.isAirish(head))) continue
    if (!(world.isAirish(feet) || world.isWaterBlock(feet))) continue
    const below = world.at(bot, x, y - 1, z)
    const land = below && world.isSolid(below) && world.isAirish(feet)
    if (landOnly && !land) continue
    const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 0.5 - (land ? 2 : 0) + (landOnly && dy > 1 ? 3 * (dy - 1) : 0)
    if (d < bestD) { bestD = d; best = { x, y, z, land } }
  }
  return best
}

// Air the body can SWIM to: a flood through water and air cells only, from where we are - findAir scored air behind
// solid rock as "nearest", and steering at it pressed the bot into a wall under water for twenty seconds, drowned
// (audit 2026-09-28). The nearest cell by strokes with air for the head (land preferred); null when none is reachable.
function findAirReachable (maxNodes = 400) {
  const me = bot.entity.position.floored()
  const k = (x, y, z) => `${x},${y},${z}`
  const pass = b => !!b && (world.isAirish(b) || (world.isWaterBlock(b) && b.boundingBox === 'empty'))
  const seen = new Set([k(me.x, me.y, me.z)]); const q = [{ x: me.x, y: me.y, z: me.z, d: 0 }]
  let best = null
  while (q.length && seen.size < maxNodes) {
    const c = q.shift()
    if (best && c.d > best.d + 2) break
    const feet = world.at(bot, c.x, c.y, c.z); const head = world.at(bot, c.x, c.y + 1, c.z)
    if (feet && head && world.isAirish(head) && (world.isAirish(feet) || world.isWaterBlock(feet))) {
      const below = world.at(bot, c.x, c.y - 1, c.z); const land = !!below && world.isSolid(below) && world.isAirish(feet)
      if (!best || (land && !best.land) || (land === best.land && c.d < best.d)) best = { x: c.x, y: c.y, z: c.z, land, d: c.d }
    }
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
      const x = c.x + dx; const y = c.y + dy; const z = c.z + dz; const key = k(x, y, z)
      if (seen.has(key) || Math.abs(x - me.x) > 8 || Math.abs(z - me.z) > 8 || y < me.y - 3 || y > me.y + 8) continue
      seen.add(key)
      if (pass(world.at(bot, x, y, z))) q.push({ x, y, z, d: c.d + 1 })
    }
  }
  return best
}

// Block the line of fire: the cells beside us toward the shooter, feet and head height.
async function wallOff (e, g = 0) {
  const me = bot.entity.position.floored()
  const dx = e.position.x - (me.x + 0.5); const dz = e.position.z - (me.z + 0.5)
  const step = Math.abs(dx) >= Math.abs(dz) ? { x: Math.sign(dx), z: 0 } : { x: 0, z: Math.sign(dz) }
  const filler = () => inv.shelterBlock(bot)
  const act = require('./act')
  let n = 0
  for (const dy of [0, 1]) {
    if (busyAborted(g)) return false // (its deadline passed: stopped - runBusy)
    const p = { x: me.x + step.x, y: me.y + dy, z: me.z + step.z }
    const b = world.at(bot, p.x, p.y, p.z)
    const f = filler()
    if (!f || !b || !world.isAirish(b)) continue
    try { if (await act.place(bot, p, f.name, { sneak: false, fromReflex: true, timeoutMs: 1500, faceHint: [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]] })) n++ } catch {} // (1.5s a block: cover placed under fire, not a wait; audit)
  }
  if (n) log('reflex', `walled off the ${e.name} (${n} block${n > 1 ? 's' : ''})`)
}

let floatSince = 0
let riseY = null; let riseAt = 0 // the air reflex: where the body was when it last made headway upward
// Out of water over a bank too high to jump: dig the bank's lower blocks so there is a one-block step,
// or fill the water cell beside us to stand on.
async function climbOut (g = 0) {
  const p = bot.entity.position.floored()
  const act = require('./act')
  const tryCol = async (x, z) => {
    for (const base of [p.y, p.y - 1]) {
      if (busyAborted(g)) return false // (its deadline passed: stopped - runBusy)
      const floor = world.at(bot, x, base, z); const c1 = world.at(bot, x, base + 1, z); const c2 = world.at(bot, x, base + 2, z)
      if (!floor || !c1 || !c2 || !world.isSolid(floor)) continue
      if (base + 1 > p.y + 1) continue
      // clear the two cells a body needs on top of that floor
      for (const c of [c1, c2]) {
        if (busyAborted(g)) return false // (its deadline passed: stopped - runBusy)
        if (world.isAirish(c)) continue
        if (!world.NATURAL_RE.test(c.name) || world.isWaterBlock(c) || world.isLavaBlock(c)) return false
        // (through act.digBlock: a finished build block is never cut into, reflex or not)
        if (!await act.digBlock(bot, c)) return false
      }
      const t0 = Date.now()
      while (Date.now() - t0 < 2500) {
        if (busyAborted(g)) return false // (its deadline passed: stopped - runBusy)
        steerTo({ x, y: base + 1, z }, { jump: true })
        await new Promise(r => setTimeout(r, 100))
        if (!world.feetInWater(bot) && bot.entity.onGround) break
      }
      bot.clearControlStates()
      return !world.feetInWater(bot)
    }
    return false
  }
  // the bank nearest to where land is
  const t = findAir(true)
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  if (t) dirs.sort((a, b) => Math.hypot(p.x + a[0] - t.x, p.z + a[1] - t.z) - Math.hypot(p.x + b[0] - t.x, p.z + b[1] - t.z))
  for (const [dx, dz] of dirs) {
    if (busyAborted(g)) return false // (its deadline passed: stopped - runBusy)
    if (await tryCol(p.x + dx, p.z + dz)) { log('reflex', `cut a step into the bank at ${p.x + dx},${p.z + dz} and climbed out`); return true }
  }
  // no diggable bank: stand on a block placed in the water beside us - only where the cell has a face to click
  // (open water all round has none: every direction answered "nothing solid to place against"), and then step onto
  // it (the block alone left the bot floating beside it for four more minutes)
  const filler = inv.shelterBlock(bot) // (sand placed in water sinks to the bed: nothing to stand on)
  if (!filler) return false
  const faced = c => [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([ox, oy, oz]) => world.isSolid(world.at(bot, c.x + ox, c.y + oy, c.z + oz)))
  for (const [dx, dz] of dirs) {
    if (busyAborted(g)) return false // (its deadline passed: stopped - runBusy)
    const c = { x: p.x + dx, y: p.y, z: p.z + dz }
    const b = world.at(bot, c.x, c.y, c.z)
    if (!b || !world.isWaterBlock(b) || !faced(c) || !world.isAirish(world.at(bot, c.x, c.y + 1, c.z)) || !world.isAirish(world.at(bot, c.x, c.y + 2, c.z))) continue
    bot.clearControlStates() // (the tick's steering still held: the click must not drift)
    // (a body left still in deep water sinks - and while this runs the tick is not watching the air: give up at once
    //  if the head goes under, the tick takes it from there)
    if (world.headInWater(bot)) return false
    try { await act.place(bot, c, filler.name, { sneak: false, fromReflex: true, timeoutMs: 3000 }) } catch {}
    if (!world.isSolid(world.at(bot, c.x, c.y, c.z))) continue
    log('reflex', `placed a block in the water at ${c.x},${c.y},${c.z} to climb out`)
    const t0 = Date.now()
    while (Date.now() - t0 < 2500) {
      if (busyAborted(g)) return false // (its deadline passed: stopped - runBusy)
      steerTo({ x: c.x, y: c.y + 1, z: c.z }, { jump: true })
      await new Promise(r => setTimeout(r, 100))
      if (!world.feetInWater(bot) && bot.entity.onGround) break
    }
    bot.clearControlStates()
    return !world.feetInWater(bot)
  }
  return false
}

function enclosed () {
  const p = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) {
    const b = world.at(bot, p.x + dx, p.y + dy, p.z + dz)
    if (!b || !world.isSolid(b)) return false
  }
  return true
}
function canDigInHere () {
  const p = bot.entity.position.floored()
  // not in our own ground: at home the safehouse IS the shelter. A dig-in on the door step at night (unarmed after a
  // respawn, a skeleton about) fought the director's walk to the door seven times in a minute, and the pit it left
  // was a 5-block drop in front of the door the edge guard rightly refused - two deaths outside it (2026-09-24)
  if (require('./move').inZone(p, 1)) return false
  // (never in POWDER SNOW: the body sinks and bobs in it, the hole holds nothing - dug in on a snowy mountain, the head rose
  //  over the rim every second and a pillager shot it 12 -> 0 in 10s, 2026-10-04)
  for (let dy = -3; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const b = world.at(bot, p.x + dx, p.y + dy, p.z + dz); if (b && b.name === 'powder_snow') return false }
  for (const dy of [1, 2, 3, 4]) {
    const b = world.at(bot, p.x, p.y - dy, p.z)
    if (!b || world.isWaterBlock(b) || world.isLavaBlock(b)) return false
    if (dy <= 3 && (!world.isSolid(b) || !world.NATURAL_RE.test(b.name) || b.hardness < 0 || b.hardness > 3)) return false
    // never into a finished build: a castle floor of cobblestone is "natural" to the regex above, and the
    // dig-in went through the finished castle wall (2026-09, 275,71,-253). Ask here, before choosing to dig
    // in at all - act.digBlock refuses the block anyway, which would leave us in a half-dug hole.
    if (dy <= 3 && require('./move').isProtected(b, 'dig')) return false
  }
  return !world.waterNear(bot, { x: p.x, y: p.y - 2, z: p.z }, 1, -1, 1) && !world.lavaNear(bot, { x: p.x, y: p.y - 2, z: p.z }, 1)
}
async function digIn (g = 0) {
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const p0 = bot.entity.position.floored()
  // centre on the cell so we drop in
  await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {})
  // three deep, so the plug goes in the ground layer with ground around it to place against
  for (const dy of [1, 2, 3]) {
    if (busyAborted(g)) return false // (its deadline passed: stopped - runBusy)
    const b = world.at(bot, p0.x, p0.y - dy, p0.z)
    if (!b || world.isAirish(b)) continue
    // (through act.digBlock: it refuses a finished build block - canDigInHere already chose ground without one)
    await require('./act').digBlock(bot, b)
    const t0 = Date.now()
    while (Date.now() - t0 < 1500 && Math.floor(bot.entity.position.y) > p0.y - dy) {
      if (busyAborted(g)) return false // (its deadline passed: stopped - runBusy)
      const pp = bot.entity.position
      bot.setControlState('forward', Math.hypot(pp.x - (p0.x + 0.5), pp.z - (p0.z + 0.5)) > 0.2)
      await bot.look(Math.atan2(-((p0.x + 0.5) - pp.x), -((p0.z + 0.5) - pp.z)), -Math.PI / 2, true).catch(() => {})
      await new Promise(r => setTimeout(r, 50))
    }
    bot.setControlState('forward', false)
  }
  // plug the hole above our head with whatever block we carry (the dirt we just dug)
  const top = { x: p0.x, y: Math.floor(bot.entity.position.y) + 2, z: p0.z }
  const filler = inv.shelterBlock(bot)
  if (filler) { try { await require('./act').place(bot, top, filler.name, { fromReflex: true, faceHint: [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] }) } catch {} }
  log('reflex', `dug in at ${p0.x},${p0.y - 3},${p0.z}${filler ? '' : ' (nothing to plug the hole with)'}`)
}

// The way off a doomed leaf with nothing firm within 3 - it rots, and the fall comes anyway: held 58s over a 5-block drop
// at "nowhere firm within 3" until it did (2026-09-28). A drop the hp takes onto ground that holds - the leaf dug out
// from under us, straight down (the edge guards brake a walk or a jump off a ledge, not this); else a block of our own
// beside the leaf, clicked on its side (dirt does not rot), for the tick to step onto; else null - stranded.
let leafDigFailed = null
let leafWhy = null // the way off last said (said again only when it changes)
let leafFooting = null // the block put beside a rotting leaf to stand on - dug out from under us once the drop is taken
// (the drop chosen: the column dug out from under us to take it - the lip row stands aside there while it is taken. Its
//  "centre over a drop" steered the body back onto the rotting leaf as the footing broke, 41 times in two minutes, then
//  stranded on the crown, 2026-10-03)
let takingDrop = null // { x, y (the floor dug), z, until }
let centring = null // { x, z }: the drop run centres the body inside this column (supported - the footing under it)
const centreMiss = new Map() // key -> failed centrings: two, and the drop is not tried there again (leafDigFailed)
function leafWayOff (leaf, fx, fy, fz, ours = false) {
  const act = require('./act')
  const k = act.fallBelow(bot, { x: fx, y: fy, z: fz })
  const land = Number.isFinite(k) && k > 0 ? world.at(bot, fx, fy - k, fz) : null
  const key = `${fx},${fy},${fz}`
  const takes = bot.health - Math.max(0, k - 3) > hurtLine()
  if (land && leafDigFailed !== key && !/_leaves$/.test(land.name) && takes) {
    // (a dig that fails is not tried again on this leaf: the block beside it next, never the same dig every tick)
    return { why: `a ${k}-block drop onto ${land.name} I can take - digging ${ours ? 'my footing' : 'the leaf'} out`, run: async () => {
      // (centred on the column first: a steer stops near a cell, not in it, and the hitbox's 0.3 still rested on the leaf
      //  beside - the dug cell left the body hanging crouched on its corner; audit)
      const off = () => Math.hypot(bot.entity.position.x - (fx + 0.5), bot.entity.position.z - (fz + 0.5))
      const t1 = Date.now()
      centring = { x: fx, z: fz }
      try {
        while (off() > 0.15 && Date.now() - t1 < 1500) { const p = bot.entity.position; await bot.look(Math.atan2(-((fx + 0.5) - p.x), -((fz + 0.5) - p.z)), 0, true).catch(() => {}); origSet('forward', off() >= 0.2); await new Promise(r => setTimeout(r, 50)) }
      } finally { centring = null; origSet('forward', false) }
      // (not centred: no dig - the next tick asks again; twice, and this drop is given up for the leaf row's other ways)
      if (off() > 0.25) { if (centreMiss.size > 64) centreMiss.clear(); const n = (centreMiss.get(key) || 0) + 1; centreMiss.set(key, n); if (n >= 2) leafDigFailed = key; return false }
      takingDrop = { x: fx, y: fy, z: fz, until: Date.now() + 3000 }
      return act.digBlock(bot, leaf, { own: ours }).then(ok => { if (!ok) { leafDigFailed = key; takingDrop = null } else if (ours) leafFooting = null; return ok })
    } }
  }
  // (on our footing the drop only waits on the hp - eating and regen bring it; the rot no longer does)
  // (a drop more than full health takes never passes: said as stranded - a staircase down is for when one is seen)
  if (ours) return land && !/_leaves$/.test(land.name) && leafDigFailed !== key ? { why: 20 - Math.max(0, k - 3) > hurtLine() ? `waiting on my footing in the crown for the hp to take the ${k}-block drop` : `stranded on my footing in the crown - a ${k}-block drop is more than full health takes`, run: null } : null
  const filler = inv.shelterBlock(bot)
  if (!filler) return null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const c = { x: fx + dx, y: fy, z: fz + dz }
    if (![0, 1, 2].every(dy => world.isAirish(world.at(bot, c.x, c.y + dy, c.z))) || require('./move').inZone(c)) continue
    return { why: `a ${filler.name || filler} put beside it at ${c.x},${c.y},${c.z} to stand on`, run: () => act.place(bot, c, filler.name || filler, { sneak: false, fromReflex: true, timeoutMs: 3000, faceHint: [[-dx, 0, -dz]] }).then(ok => { if (ok) leafFooting = c; return ok }) }
  }
  return null
}
let pinned = false // this tick holds the body where it is (row 2c's hold): no row steers it
function steerTo (p, { jump = true, sprint = false } = {}) {
  if (pinned) { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(k, false); return }
  const me = bot.entity.position
  const yaw = Math.atan2(-(p.x + 0.5 - me.x), -(p.z + 0.5 - me.z))
  bot.look(yaw, 0, true).catch(() => {})
  bot.setControlState('forward', Math.hypot(p.x + 0.5 - me.x, p.z + 0.5 - me.z) > 0.4)
  bot.setControlState('jump', jump)
  bot.setControlState('sprint', sprint)
}

// The best open heading away from a threat: of 16 directions within 100 degrees of straight away,
// the most direct one whose next 3 cells are walkable ground (a step up or a drop of <=2, no water or
// lava). Returns a target cell 3 blocks out.
// (memoised: the flee's continuation asks every tick - the pick holds until the body has moved a block or the threat's
//  bearing has turned 30 degrees, as shoreHeading's does; audit 2026-09-28)
let fleeMemo = null
// A creeper's fuse: lit (true), not (false), or unknown (null) - its swell_dir (1 while swelling) or ignited flag (flint),
// read by name from the registry's metadata keys (the index moves between versions)
function creeperFusing (e) {
  try {
    const keys = (world.data(bot).entitiesByName.creeper || {}).metadataKeys || []
    const sw = e.metadata && e.metadata[keys.indexOf('swell_dir')]
    const ig = e.metadata && e.metadata[keys.indexOf('is_ignited')]
    if (ig === true) return true
    // (the server sends a value only once it differs from the default: unsent is the default - not swelling; audit)
    if (keys.indexOf('swell_dir') < 0) return null
    return typeof sw === 'number' ? sw > 0 : false
  } catch { return null }
}
function creeperPowered (e) {
  try { const keys = (world.data(bot).entitiesByName.creeper || {}).metadataKeys || []; const i = keys.indexOf('is_powered'); return i < 0 ? true : e.metadata && e.metadata[i] === true } catch { return true } // (unknown: treated as charged - never fought)
}
// THE STRIKE, every physics tick while standing to a creeper: the window between its reach and ours is a few hundredths
// of a block of its walk - at the 200ms tick it was a coin flip (audit). Eye to the nearest point of its hitbox within
// 2.9 (ours is 3), a full swing, standing still - then straight back, facing it.
function creeperStrike () {
  const t = fightTarget
  if (!CREEPER_FIGHT || !t || !t.isValid || creeperMode !== 'fight' || !bot.entity) return
  const now = Date.now()
  // (only while the creeper row holds the body this very moment - never under an air, lava or hot-floor row, a busy
  //  action or a hold: a stale stand pressed `back` into them; audit)
  if (now - fightAt > 400 || !active || active.kind !== 'creeper' || busy || pinned || !enabled) return
  const held = bot.heldItem
  if (!held || !/_(sword|axe)$/.test(held.name)) return
  if (now - lastAttackAt < (/_axe$/.test(held.name) ? 1000 : 600)) return
  if (creeperFusing(t) !== false) return
  const eye = bot.entity.position.offset(0, 1.62, 0); const p = t.position
  const cx = Math.max(p.x - 0.3, Math.min(eye.x, p.x + 0.3)); const cy = Math.max(p.y, Math.min(eye.y, p.y + 1.7)); const cz = Math.max(p.z - 0.3, Math.min(eye.z, p.z + 0.3))
  if (Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz) > 2.9) return
  bot.lookAt(p.offset(0, 1.2, 0), true).catch(() => {})
  bot.setControlState('forward', false); bot.setControlState('sprint', false)
  bot.attack(t); lastAttackAt = now; creeperBackUntil = now + 500
  bot.setControlState('back', !pinned)
  // (a strike is progress: the stand-off clock starts again - knocked back, its next approach never beat its closest)
  if (creeperFight) { creeperFight.closest = Infinity; creeperFight.since = now }
}
// TAKE COVER FROM A SHOOTER - the one answer for every flee from one (being shot, too weak, a charge not worth it): out of
// its sight already, stay; else a step to a cell it cannot see; else a wall put up - once a cell, and only with a block to
// put and room to put it; else away. Running straight off across the open slope took four bolts and the bot, twice, under
// a pillager patrol (2026-10-02; audit)
const wallTried = new Set()
function hungryNow () { return bot.food <= 14 || (bot.health < 20 && bot.food < inv.REGEN_FOOD) }
const coverTrail = [] // { t, x, z, id }: where a flight to cover has been, the last 2s
let pinnedCover = null // { id, until }: the shooter whose cover flight is pinned
// THE SAFEHOUSE FIRST: a shooter on us within a short run of the safehouse, outside it - the run goes for the door, opened
// on the way, shut behind us inside: a player runs indoors. Cover cells three steps out, a wall of two blocks and a dug hole
// were all the reflex knew, and the third pillager death of the night came 8 blocks from its door, shot 12 -> 0 in a hole,
// 2026-10-04 (the director's hideout rule could not run while the reflex held the body)
let safeRun = null // { inside, at, lastP, lastAt } while the run lasts
let safeDoorAt = 0
let safeRunRefused = 0 // (a run that stood still: the cover rows for a while instead of the same blocked run again; audit)
function safehouseRun (e, label) {
  if (safeRun) { const s = safeRunStep(); if (s === 'go') { fleeTarget = fleeTarget || e; setActive('flee', label + ' - to the safehouse'); return true } return false }
  const hm = require('./memory').get().hut; const mv = require('./move')
  if (!hm || !hm.box || !hm.door || busy || Date.now() - safeRunRefused < 20000) return false
  const me = bot.entity.position
  if (mv.insideHut(me.floored())) return false
  // (the recorded home cell when it lies in the hut - its centre may hold furniture; audit)
  const h0 = require('./memory').get().home
  const inside = h0 && mv.insideHut({ x: h0.x, y: h0.y, z: h0.z }) ? { x: h0.x, y: h0.y, z: h0.z } : { x: Math.floor((hm.box.x1 + hm.box.x2) / 2), y: hm.box.y1, z: Math.floor((hm.box.z1 + hm.box.z2) / 2) }
  const dd = Math.hypot(me.x - inside.x - 0.5, me.z - inside.z - 0.5)
  if (dd > 28 || Math.abs(me.y - inside.y) > 5) return false
  // (not past the shooters: one nearer the door than us and near the straight line to it - the run would pass by it; audit)
  const segDist = q => { const ax = inside.x + 0.5 - me.x; const az = inside.z + 0.5 - me.z; const L = ax * ax + az * az || 1; const t = Math.max(0, Math.min(1, ((q.x - me.x) * ax + (q.z - me.z) * az) / L)); return Math.hypot(me.x + t * ax - q.x, me.z + t * az - q.z) }
  if (!safeRun && shootersAbout(e).some(s => Math.hypot(s.position.x - inside.x - 0.5, s.position.z - inside.z - 0.5) < dd && segDist(s.position) < 6)) return false
  fleeTarget = e
  if (!safeRun) { log('reflex', `${label} - running for the safehouse ${Math.round(dd)}b off`); safeRun = { inside, at: Date.now(), lastP: me.clone(), lastAt: Date.now() } }
  setActive('flee', `${label} - to the safehouse`)
  shieldDown()
  const g = bot.pathfinder.goal
  if (!(g instanceof goals.GoalBlock) || g.x !== inside.x || g.z !== inside.z) {
    bot.pathfinder.setMovements(mv.movementsFor(bot, { dig: false, place: false }))
    bot.pathfinder.setGoal(new goals.GoalBlock(inside.x, inside.y, inside.z), true)
  }
  safeRunDoor()
  return true
}
// THE RUN'S ONE STEP, from both call sites - the shooter rows re-enter takeCover every tick under fire, and the stall and door
// checks living only in the tick's continuation never ran there (audit): 'go' = keep running, 'off' = no run (cover rows)
function safeRunStep () {
  if (!safeRun) return 'off'
  const me = bot.entity.position
  if (require('./move').insideHut(me.floored())) {
    const od = openDoorNear()
    if (od && Date.now() - safeDoorAt > 250) { safeDoorAt = Date.now(); bot.activateBlock(od).catch(() => {}) }
    if (od && Date.now() - safeRun.at < 35000) return 'go' // (held until the door is shut - takeCover must not take over first)
    try { bot.pathfinder.setGoal(null) } catch {}
    safeRun = null
    return 'off'
  }
  if (me.distanceTo(safeRun.lastP) > 0.5) { safeRun.lastP = me.clone(); safeRun.lastAt = Date.now() }
  if (Date.now() - safeRun.lastAt > 2000 || Date.now() - safeRun.at > 30000 || !fleeTarget || !fleeTarget.isValid) {
    safeRun = null; safeRunRefused = Date.now()
    try { bot.pathfinder.setGoal(null) } catch {}
    return 'off'
  }
  safeRunDoor()
  return 'go'
}
function openDoorNear () {
  const p = bot.entity.position
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, 1]) {
    const b = world.at(bot, p.x + dx, p.y + dy, p.z + dz)
    if (!b || !/_door$/.test(b.name) || /iron_door/.test(b.name)) continue
    let open = false; try { const o = b.getProperties().open; open = o === true || o === 'true' } catch {}
    if (open) return b
  }
  return null
}
// the run's own door: opened in the way, shut behind once inside (pillagers and skeletons do not open doors)
function safeRunDoor () {
  const mv = require('./move')
  if (Date.now() - safeDoorAt < 1000) return
  if (!mv.insideHut(bot.entity.position.floored())) { const d = mv.closedDoorAt(bot); if (d) { safeDoorAt = Date.now(); bot.activateBlock(d).catch(() => {}) } return }
  const p = bot.entity.position
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const b = world.at(bot, p.x + dx, p.y, p.z + dz)
    if (!b || !/_door$/.test(b.name) || /iron_door/.test(b.name)) continue
    let open = false; try { const o = b.getProperties().open; open = o === true || o === 'true' } catch {}
    if (open) { safeDoorAt = Date.now(); bot.activateBlock(b).catch(() => {}); return }
  }
}
function takeCover (e, label) {
  if (safehouseRun(e, label)) return
  // COVER THAT IS NOT: still hit under it - a cave's skeleton shot round each 1-2 block wall, 20 -> 0 in 27s, eight walls
  // and two meals, never more than cover (2026-10-03). Six hp lost in the last 8s under cover is the proof: sealed in
  // instead, the capped hole the night and the enderman already use (pickaxe and a block in hand; never at home)
  {
    const now = Date.now(); const lost = hurtLog.filter(q => now - q.at < 8000).reduce((a, q) => a + q.d, 0)
    // (a pocket that is one - its walls two and three down all solid, a side to cap against one down: a cave's hole open
    //  sideways lets the arrows in and each try digs three deeper; and nothing that bites within 6 - the hole's 30s hold
    //  blocks every row, the creeper's too; audit)
    const p0 = bot.entity.position.floored(); const solidAt = (x, y, z) => { const b = world.at(bot, x, y, z); return !!b && world.isSolid(b) }
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const pocket = [2, 3].every(dy => sides.every(([dx, dz]) => solidAt(p0.x + dx, p0.y - dy, p0.z + dz))) && sides.some(([dx, dz]) => solidAt(p0.x + dx, p0.y - 1, p0.z + dz))
    const biter = hostiles(6).some(h => !RANGED.has(h.e.name))
    if (lost >= 6 && !busy && pocket && !biter && inv.bestTool(bot, 'pickaxe', 4) && inv.shelterBlock(bot) && !require('./move').insideHut(bot.entity.position.floored()) && !enclosed() && canDigInHere()) {
      fleeTarget = e
      setActive('dig-in', `${e.name} - cover is not stopping it (${Math.round(lost)} hp in 8s): a capped hole`)
      // (and held there while the shooter is about: let go at once, the director walked out through the cap into the
      //  arrows and the next lap dug another hole - the flee's out-of-sight hold keeps it still till the shooter is gone; audit)
      runBusy('dig in', g => digIn(g), 30000, null, () => { stopDig(); stopWalk() }).then(() => {
        if (!active || active.kind !== 'dig-in') return
        if (enclosed() && fleeTarget && fleeTarget.isValid && RANGED.has(fleeTarget.name)) setActive('flee', `dug in - holding till the ${fleeTarget.name} is gone`)
        else clearActive()
      })
      return
    }
  }
  fleeTarget = e
  // (A FLIGHT TO COVER THAT DOES NOT MOVE - the edge guard holding every step at a drop - while the shooter still sees us: 78
  //  stopped steps and a skeleton's 18s of arrows, 2026-10-03. Pinned, the charge is weighed without the trip's caution or the
  //  earlier flight - chargeAffordable - as a shooter in reach is; the arithmetic still decides)
  { const now = Date.now(); const me = bot.entity.position
    coverTrail.push({ t: now, x: me.x, z: me.z, id: e.id }); while (coverTrail.length && (now - coverTrail[0].t > 2000 || coverTrail[0].id !== e.id)) coverTrail.shift()
    const old = coverTrail[0]
    if (old && now - old.t >= 1500 && Math.hypot(me.x - old.x, me.z - old.z) < 0.4 && canSee(e)) pinnedCover = { id: e.id, until: now + 3000 } }
  setActive('flee', label)
  shieldDown()
  try { bot.pathfinder.setGoal(null) } catch {}
  const still = () => { for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) bot.setControlState(k, false) }
  // (out of sight of EVERY shooter about, and nothing landing: a patrol is three to five crossbows - "out of its sight, stay"
  //  read the one picked, and the others shot the bot standing still, keys none, 16 -> 0 in 10s, twice in two minutes,
  //  2026-10-03)
  // (a SHOOTER's hit, not any hp lost: fire or a witch's poison tick every second and would never let the bot stay hidden;
  //  a shooter fires only with a line to us - its hit is the proof of being seen; audit A3)
  const hitNow = Date.now() - lastHurtAt < 2500 && !!lastHurtBy && RANGED.has(lastHurtBy.name)
  if (!hitNow && !shootersAbout(e).some(s => canSee(s))) return still()
  const h = fleeHeading(e)
  if (h && h.hidden) { bot.setControlState('back', false); return steerTo(h, { jump: h.jump, sprint: bot.food > 6 }) }
  const f = bot.entity.position.floored(); const ck = f.x + ',' + f.y + ',' + f.z
  if (!busy && !wallTried.has(ck) && inv.shelterBlock(bot) && e.position.distanceTo(bot.entity.position) >= 3) {
    wallTried.add(ck); if (wallTried.size > 64) wallTried.clear()
    return runBusy('wall off', g => wallOff(e, g), 3500, 'flee')
  }
  if (h) { bot.setControlState('back', false); return steerTo(h, { jump: h.jump, sprint: bot.food > 6 }) }
  still(); bot.setControlState('back', !pinned)
}
// every shooter about that can reach us - the one picked first: a patrol, never only the one the rows chose (2026-10-03)
function shootersAbout (t) {
  const me = bot.entity.position
  const out = t && RANGED.has(t.name) ? [t] : []
  for (const h of hostiles(24)) if (h.e !== t && RANGED.has(h.e.name) && Math.abs(h.e.position.y - me.y) < 12) out.push(h.e)
  return out
}
function fleeHeading (t) {
  const me = bot.entity.position
  // (from a shooter: away from the patrol's middle, not the one picked - fled from one, the bot ran along the others' line)
  const sh = RANGED.has(t.name) ? shootersAbout(t) : [t]
  const cx = sh.reduce((a, e) => a + e.position.x, 0) / sh.length; const cz = sh.reduce((a, e) => a + e.position.z, 0) / sh.length
  const away = Math.atan2(me.z - cz, me.x - cx)
  const ids = sh.map(e => e.id).sort((a, b) => a - b).join(',') // (stable: the distance order swaps each tick in a moving patrol)
  if (fleeMemo && fleeMemo.id === t.id && fleeMemo.ids === ids && fleeMemo.at.distanceTo(me) < 1 && Math.abs(((away - fleeMemo.away) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) < Math.PI / 6) return fleeMemo.best
  const pick = fleeHeadingPick(t, me, away, sh)
  fleeMemo = { id: t.id, ids, at: me.clone(), away, best: pick } // (a different mob is a different pick)
  return pick
}
function fleeHeadingPick (t, me, away, sh = [t]) {
  // afloat: no dry step within three blocks mid-river, and "back" drifted the bot in place while drowned hit it to death
  // (2026-09-27) - swim for the nearest bank that is not toward the threat
  if (world.feetInWater(bot) && !bot.vehicle) return shoreHeading(me, away)
  let best = null
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8
    let diff = Math.abs(((a - away) + 3 * Math.PI) % (2 * Math.PI) - Math.PI)
    if (diff > Math.PI * 0.56) continue
    let y = Math.floor(me.y); let ok = true; let jump = false; let cell = null
    for (let s = 1; s <= 3 && ok; s++) {
      const x = Math.floor(me.x + Math.cos(a) * s); const z = Math.floor(me.z + Math.sin(a) * s)
      const dy = [0, 1, -1, -2].find(k => world.standable(bot, x, y + k, z))
      if (dy == null) { ok = false; break }
      if (dy === 1) jump = true
      y += dy
      const floor = world.at(bot, x, y - 1, z)
      if (!floor || world.isWaterBlock(floor) || world.lavaNear(bot, { x, y, z }, 1)) { ok = false; break }
      cell = { x, y, z }
    }
    if (!ok || !cell) continue
    // SWEPT, not stepped: whole-block samples on a diagonal, or from a body near a cell's edge, skip the void corner the
    // line crosses between them - every flee round of a creeper chase steered onto a 23-block cliff's lip and the brake
    // caught it there, until it did not (2026-09-28). Every half block along the way, the hitbox's width either side
    // (each drop from the floor just walked - carried along the line: from the start's height a walkable slope read as
    //  one big drop and every downhill heading was refused; a real cliff still is - audit 2026-09-28)
    let swept = true; let yRun = Math.floor(me.y)
    const px = -Math.sin(a) * 0.3; const pz = Math.cos(a) * 0.3
    for (let d = 0.5; d <= 3 && swept; d += 0.5) {
      const cx = me.x + Math.cos(a) * d; const cz = me.z + Math.sin(a) * d
      for (const k of [0, 1, -1]) if (world.dropAt(bot, cx + px * k, yRun, cz + pz * k) > world.SAFE_DROP) { swept = false; break }
      if (!swept) break
      // (the floor under the line here: down the slope, or a step up onto it)
      const feet = world.at(bot, cx, yRun, cz)
      if (feet && world.isSolid(feet)) yRun++; else yRun -= world.dropAt(bot, cx, yRun, cz)
    }
    if (!swept) continue
    // (from a SHOOTER: a cell out of its sight first - cover beats distance; audit 2026-10-02)
    // (the body AND the head out of its sight: an overhang hides a head, not a chest; audit)
    // (from EVERY shooter about: a cell out of one crossbow's sight was in the next one's, 2026-10-03)
    const at = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5)
    const hidden = RANGED.has(t.name) ? sh.every(s => { const sEye = s.position.offset(0, (s.height || 1.9) * 0.85, 0); return !canSee({ position: at, height: 1.8 }, sEye) && !canSee({ position: at, height: 1.1 }, sEye) }) : false
    if (!best || (hidden && !best.hidden) || (hidden === best.hidden && diff < best.diff)) best = { x: cell.x, y: cell.y, z: cell.z, jump, diff, hidden }
  }
  return best
}
// The bank: rings outward from the body, the first ring with dry ground on it wins (the nearest bank is the way out), the
// most direct cell of that ring first; lava is asked of the winner only. The answer holds until the body has swum ~2
// blocks or the threat has swung round - the whole 25x25x4 box, with a 27-block lava probe per standable cell, ran every
// 200ms of a swim-flee (2026-09-27).
let shoreMemo = null // { x, z, away, res }
function shoreHeading (me, away) {
  if (shoreMemo && Math.hypot(me.x - shoreMemo.x, me.z - shoreMemo.z) < 2 &&
    Math.abs(((away - shoreMemo.away) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) < Math.PI / 4) return shoreMemo.res
  const fx = Math.floor(me.x); const fz = Math.floor(me.z); const fy = Math.floor(me.y)
  let res = null
  for (let r = 2; r <= 12 && !res; r++) {
    const ring = []
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
      const d = Math.hypot(dx, dz); if (d > 12) continue
      const diff = Math.abs(((Math.atan2(dz, dx) - away) + 3 * Math.PI) % (2 * Math.PI) - Math.PI)
      if (diff > Math.PI * 0.7) continue // (sideways is fine; back past the drowned is not)
      for (const dy of [0, 1, 2, -1]) {
        const x = fx + dx; const y = fy + dy; const z = fz + dz
        if (!world.standable(bot, x, y, z)) continue
        const floor = world.at(bot, x, y - 1, z)
        if (floor && !world.isWaterBlock(floor)) ring.push({ x, y, z, jump: true, diff, cost: d + diff * 3 })
        break
      }
    }
    ring.sort((a, b) => a.cost - b.cost)
    res = ring.find(c => !world.lavaNear(bot, { x: c.x, y: c.y, z: c.z }, 1)) || null
  }
  shoreMemo = { x: me.x, z: me.z, away, res }
  return res
}

// TREADING WATER. A player in deep water holds jump whenever nothing else is steering - let go and the body sinks.
// The pathfinder holds it only while it has a path: every replan, every gap between legs and walks (clearControlStates)
// left the body still in the water, and the head went under for 2s+ at a time mid-ocean - the air reflex took the body
// again and again (2026-09-23). Not a reflex (nothing is preempted): while the body is afloat, unsteered, not diving,
// jump is held; it is let go as the body leaves the water.
let treading = false
function tread () {
  const p = bot.entity.position
  const afloat = !bot.vehicle && !bot.entity.onGround && (world.feetInWater(bot) || world.isWaterBlock(world.at(bot, p.x, p.y - 0.3, p.z))) &&
    !world.isSolid(world.at(bot, p.x, p.y - 1, p.z))
  const steered = bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()
  if (afloat && !active && !dive && !steered) {
    if (!treading || !bot.getControlState || !bot.getControlState('jump')) bot.setControlState('jump', true)
    treading = true
  } else if (treading) {
    treading = false
    if (!active && !steered) bot.setControlState('jump', false)
  }
}

// THE EDGE. The body never walks toward a drop that hurts - whoever drives (the pathfinder's own maxDropDown is the same
// SAFE_DROP, so it never plans one; this catches its overshoots too). Two deaths on 2026-09-23 (y16 -> y-14 in a cave, y78 -> y55 into a ravine) began
// mid creeper-flee: the flee steers by hand, and with no open heading it held 'back' without looking. A veto on the
// keys, not a steering rule: whatever pressed forward/back (a reflex, a door crossing, a skill's nudge), the step is
// judged against the ground it leads onto, every physics tick, and cut - with sneak held to brake the momentum (the
// physics stops a sneaking body at an edge) - before the body goes over.
let edgeHeld = null // { x, z, drop } while the guard is braking
let jumpHeld = null // the last jump let go of near a drop (its log line once)
// A JUMP carries the body a block or more through the air, and nothing steers it there: a jump on the plaza's lip
// (the next node level with us, nothing to climb) sailed off the south cliff, 51 blocks; a climb-out's jump beside a
// drop another 20 (2026-09-25). A jump that isn't a climb onto a block ahead is refused when there is a drop that hurts
// within its reach - checked as jump is PRESSED, whoever presses it (the planner's keys are set inside the physics
// tick, but a tower, a swim float or a flee steer press it between ticks, and the jump went off before any check).
function jumpHurts (c) {
  if (!bot.entity || !bot.entity.onGround || bot.vehicle || world.feetInWater(bot)) return null
  const p = bot.entity.position; const v = bot.entity.velocity
  // the planner stepping up onto the block beside us is a climb, whatever the slope round it: judged by the velocity's
  // heading, every step up a hillside with a drop somewhere near was refused - the builder could not climb the slope
  // under the nave to its y127 cells, 2 hours of "no jump toward a 4-block drop", 2026-09-26. (Its node straight
  // overhead is a tower: that one still answers to the drop under our corners.)
  if (plannedClimb(Math.floor(p.y + 0.01))) return null
  // THE HEADINGS A JUMP GOES: the held keys summed in the body's own frame - forward and back along the look, left and
  // right across it (a strafe was never read: a random strafe and a jump at the castle rim fell 5 blocks twice, 2026-09-28)
  // - and the way the body is already sliding. A jump that hurts along either is refused.
  const speed = Math.hypot(v.x, v.z)
  const fx = -Math.sin(bot.entity.yaw); const fz = -Math.cos(bot.entity.yaw)
  let kx = 0; let kz = 0
  if (c.forward) { kx += fx; kz += fz }
  if (c.back) { kx -= fx; kz -= fz }
  if (c.left) { kx += fz; kz -= fx }
  if (c.right) { kx -= fz; kz += fx }
  const heads = []
  const kl = Math.hypot(kx, kz)
  if (kl > 0.01) heads.push([kx / kl, kz / kl])
  if (speed > 0.03) heads.push([v.x / speed, v.z / speed])
  let jx, jz
  if (heads.length) { [jx, jz] = heads[0] }
  if (jx == null) {
    // a standing jump comes down where it went up - unless we stand half over a drop already: the planner towered at
    // a wall top's lip, drifted a few hundredths a tick and fell 43 blocks (2026-09-26). Any corner of the hitbox over
    // a fall that hurts: no jump.
    const fy0 = Math.floor(p.y + 0.01)
    // (a tower on our own block, centred on it, is how a scaffold pillar climbs - 1 wide, every corner over air: refusing
    //  those left the builder short of every cell over y125 for an evening, 2026-09-26. The fall came off-centre, half
    //  over a ledge.)
    const cx = p.x - Math.floor(p.x) - 0.5; const cz = p.z - Math.floor(p.z) - 0.5
    // (0.4: the walk to a pillar's foot stops up to 0.35 off the centre - 0.25 refused every tower from there)
    if (Math.abs(cx) < 0.4 && Math.abs(cz) < 0.4 && world.isSolid(world.at(bot, Math.floor(p.x), fy0 - 1, Math.floor(p.z)))) return null
    const over = [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]].map(([dx, dz]) => world.dropAt(bot, p.x + dx, fy0, p.z + dz)).find(d => d > world.SAFE_DROP)
    return over == null ? null : { x: Math.floor(p.x), y: fy0, z: Math.floor(p.z), drop: over }
  }
  const fy = Math.floor(p.y + 0.01)
  for (const [hx, hz] of heads) {
    const ax = Math.floor(p.x + hx * 0.8); const az = Math.floor(p.z + hz * 0.8)
    const climb = world.isSolid(world.at(bot, ax, fy, az)) && !world.isSolid(world.at(bot, ax, fy + 1, az)) && !world.isSolid(world.at(bot, ax, fy + 2, az))
    if (climb) continue
    const drop = [0.8, 1.6, 2.4].map(r => world.dropAt(bot, p.x + hx * r, fy, p.z + hz * r)).find(d => d > world.SAFE_DROP)
    if (drop != null) return { x: Math.floor(p.x + hx * 1.6), y: fy, z: Math.floor(p.z + hz * 1.6), drop }
  }
  return null
}
let lastJumpCut = null // (who pressed a jump the guard let go of - the physics may already have jumped: the fall line's witness)
function noteJump (cell, who) {
  lastJumpCut = { at: Date.now(), who: who || '?' }
  if (!cell.x && cell.x !== 0) return
  if (!jumpHeld || jumpHeld.x !== cell.x || jumpHeld.z !== cell.z || Date.now() - jumpHeld.at > 5000) log('reflex', `edge: no jump toward a ${cell.drop === Infinity ? 'bottomless' : cell.drop + '-block'} drop at ${cell.x},${cell.y},${cell.z}${who ? ' (' + who + ')' : ''}`)
  jumpHeld = Object.assign({}, cell, { at: Date.now() })
}
let origSet = (k, v) => bot.setControlState(k, v)
// THE PLANNER'S STEPPING STONES ARE SCAFFOLD. mineflayer-pathfinder equips a scaffold block, then places what is in
// the hand - and the builder, equipping glass for its next window meanwhile, had the planner lay glass: 15 glass, 4
// slabs and 2 stairs stood round the cathedral walls as stepping stones, the build's own blocks (2026-09-26). Every
// place the planner asks for goes with a scaffold block in hand (re-equipped if something swapped it), or not at all.
const PLANNER_SCAFFOLD = /^(dirt|coarse_dirt|rooted_dirt|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|cobblestone)$/
function installPlaceGuard () {
  if (typeof bot.placeBlock !== 'function') return
  const orig = bot.placeBlock.bind(bot)
  bot.placeBlock = async (ref, face, ...rest) => {
    // (no block into someone else's place, whoever asks - the planner's stepping stones, a tower, a fill: foreign.js)
    const caller = new Error().stack
    try {
      const p = ref.position.plus(face)
      if (require('./move').inForeign(p)) {
        const fg = require('./foreign')
        // (the planner's own scaffold, climbing out over their wall, is let through - and remembered; nothing else)
        if (!(fg.climbingOut() && /mineflayer-pathfinder/.test(caller))) throw Object.assign(new Error("place guard: someone else's place"), { foreign: true })
        fg.notePlaced({ x: p.x, y: p.y, z: p.z })
      }
    } catch (e) { if (e.foreign) throw e }
    if (/mineflayer-pathfinder/.test(caller)) {
      const held = bot.heldItem
      if (!held || !PLANNER_SCAFFOLD.test(held.name)) {
        const s = bot.inventory.items().find(i => PLANNER_SCAFFOLD.test(i.name))
        if (!s) throw new Error('place guard: no scaffold block for the planner')
        await bot.equip(s, 'hand')
        log('act', `place guard: the planner held ${held ? held.name : 'nothing'} - placing ${s.name} instead`)
      }
      // (every block the planner puts down, remembered: its own stepping stones up a tree were never taken away - two
      //  cobblestone posts where the orchard's saplings stood, 2026-09-28. A caller takes back what its walk raised)
      const r = await orig(ref, face, ...rest)
      try { const p = ref.position.plus(face); const b = bot.blockAt(p); if (b) require('./foreign').noteOwn(p, b.name) } catch {}
      // (and into the one litter ledger, outside the build: taken down by the tidy task whoever forgets it - litter.js)
      try { const p = ref.position.plus(face); plannerPlaced.push({ x: p.x, y: p.y, z: p.z, at: Date.now() }); if (plannerPlaced.length > 200) plannerPlaced.shift(); require('./litter').note(bot, p) } catch {}
      return r
    }
    return orig(ref, face, ...rest)
  }
}
const plannerPlaced = []
function plannerPlacedSince (t) { return plannerPlaced.filter(q => q.at >= t) }
function jumpGuard () {
  const set = bot.setControlState.bind(bot)
  origSet = set
  bot.setControlState = (k, v) => {
    if (k === 'jump' && v) {
      const h = jumpHurts(Object.assign({}, bot.controlState || {}, { jump: true }))
      // (who pressed it: the caller's frame, for the log)
      if (h) { noteJump(h, (new Error().stack.split(/\r?\n/)[2] || '').trim().replace(/^at /, '').split(' ')[0]); return set('jump', false) }
    }
    // anyone else's sneak - pressed or let go - is theirs from now on: a skill that pressed it over the ledge crouch (a
    // place from the edge) had it let go under it the tick the ledge was no longer wanted (2026-09-27). The guard
    // releases only a press still its own; it presses again next tick if it still wants one.
    if (k === 'sneak') guardSneak = false
    return set(k, v)
  }
}
const FALL_HAZARD_MS = 24 * 3600000 // (a fall's takeoff cell, avoided a day: the next trip comes back the same way - only a cost; audit)
let takeoff = null
// (the last block dug, for a fall's line: two falls of 6-8 blocks left their floor gone with no dig logged, 2026-09-29)
let lastDig = null; let wasGround = true; let fell = null; let lastPath = null; let lastPathStatus = null
let roofDug = null // (the roof block the air reflex last dug - its log line once a block)
let lastServerVel = 0 // (when the server last set our velocity - knockback, a push: the fall line's witness)
// the pathfinder's next step as planned (where to, what it meant to break and place to get there)
function plannedStep () {
  if (!lastPath || !lastPath.length || !bot.entity) return ''
  const n = lastPath[0]
  const b = x => x.map(q => `${q.x},${q.y},${q.z}`).join(' ')
  // (the path's size and status too: a node 12 below was planned twice on the grave run - a stale crater, or a partial
  //  path's last node at the goal; this line tells them apart; audit 2026-09-28)
  return ` next node ${n.x},${n.y},${n.z}${n.toBreak && n.toBreak.length ? ' break ' + b(n.toBreak) : ''}${n.toPlace && n.toPlace.length ? ' place ' + b(n.toPlace) : ''}${n.parkour ? ' parkour' : ''} (path ${lastPath.length} node${lastPath.length > 1 ? 's' : ''}, ${lastPathStatus || '?'})`
}
const recentKeys = [] // (the keys held over the last 3 ticks: a press let go on the takeoff tick itself read "-")
function noteTakeoff () {
  if (!bot.entity) return
  { const c0 = bot.controlState || {}; recentKeys.push(Object.keys(c0).filter(k => c0[k])); if (recentKeys.length > 3) recentKeys.shift() }
  const g = bot.entity.onGround
  // landed: a fall that hurts keeps its takeoff (the death's own bounce is a takeoff too, and overwrote it)
  if (!wasGround && g && takeoff && takeoff.y - bot.entity.position.y > world.SAFE_DROP) {
    fell = Object.assign({}, takeoff, { fall: Math.round(takeoff.y - bot.entity.position.y) })
    // (a fall that hurts and did not kill left no trace of what walked us off - a 17-block drop the edge guard had just
    //  refused, hp 20 -> 6, 2026-09-28: the takeoff, said on landing)
    const t = fell
    // (a fall that hurt, on the home grounds: the column is a hole there to fill - two falls into one stray shaft by the
    //  orchard in an hour; a player fills it after the first. The director's fillShaft caps it flush; audit 2026-09-28)
    try {
      const lp = bot.entity.position
      const lx = Math.floor(lp.x); const lz = Math.floor(lp.z); const ly = Math.floor(lp.y)
      // (the grounds, or anywhere the daily walks go - within 48 of home at home's level: an 11-deep hole by the orchard,
      //  outside the "grounds" (hut, bank, farm), dropped the bot 8 hp and was never capped, 2026-09-29)
      const hm = require('./memory').get().home
      // (at ANY depth under home's grounds: our own pathfinder's shaft from a deepslate trip opened into a cave pocket at y96
      //  and was never capped - a fall from y45 inside it was "not the grounds"; two days later a zombie knocked the bot down
      //  it, 71 blocks, 2026-10-02; audit)
      const walked = !!hm && Math.hypot(lx - hm.x, lz - hm.z) <= 48
      if (t.fall > world.SAFE_DROP && (walked || require('./gather').onGrounds({ x: lx, y: t.fy, z: lz }))) {
        // (a SHAFT only - walled round: at least two levels between the landing and the floor it left with 3+ of the 4
        //  sides solid (a pit up to 2 wide). Off a ledge into open ground is an edge: a cap there is a dirt stub in the
        //  air over our own base; audit 2026-09-28)
        let walled = 0
        for (let y = ly + 1; y < t.fy; y++) { const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => world.isSolid(world.at(bot, lx + dx, y, lz + dz))).length; if (n >= 3) walled++ }
        const mine = (require('./memory').get().mine || {}).entrance
        const nearMine = mine && Math.abs(mine.x - lx) <= 2 && Math.abs(mine.z - lz) <= 2 // (never our own stairwell: the mine's mouth)
        const cellB = world.at(bot, lx, t.fy - 1, lz)
        const guarded = cellB && require('./move').isProtected(cellB, 'fill')
        if (walled >= 2 && !nearMine && !guarded) {
          const cell = { x: lx, y: t.fy - 1, z: lz }
          require('./memory').update(m => { const l = m.shaftsToFill = m.shaftsToFill || []; if (!l.some(q => q.x === cell.x && q.z === cell.z)) { l.push(cell); if (l.length > 8) l.shift() } })
          log('vital', `the hole at ${lx},${t.fy - 1},${lz} is a shaft on the grounds - it will be capped`)
        } else log('vital', `fell ${nearMine ? 'into the mouth of the mine' : guarded ? 'onto protected ground' : 'off an edge, not into a shaft'} at ${lx},${ly},${lz} - nothing to fill`)
      }
    } catch {}
    // (a fall is remembered where it began: the grave run took the same 13-block drop twice in a minute - a stale crater,
    //  a partial path's goal, or real ground, the planner walks round it now; move.js's fall-hazard step cost; audit)
    if (t.fall > world.SAFE_DROP && t.cx != null) require('./memory').update(m => { const l = (m.fallHazards || []).filter(q => Date.now() - q.at < FALL_HAZARD_MS); l.push({ x: t.cx, y: t.fy, z: t.cz, at: Date.now() }); m.fallHazards = l.slice(-200) })
    // (the hp at takeoff: a 4-8 fall costs up to 5 - harmless at 20, the death at 8 or less; that case is flagged, the
    //  landing brake's evidence; audit 2026-09-30)
    if (t.fall > world.SAFE_DROP) log('vital', `${t.hp != null && t.hp <= 8 && t.fall >= 4 ? 'LOW-HP FALL: ' : ''}fell ${t.fall} blocks at hp ${t.hp} from ${t.pos} (floor y${t.fy}, drop there ${t.drop}${t.dug ? ', last dig: ' + t.dug : ''}) v=${t.v} (${t.hs} b/t across${t.near ? ', beside ' + t.near : ''}${t.vel != null && t.vel < 2000 ? ', pushed by the server ' + t.vel + 'ms before' : ''}${t.cut ? ', a jump by ' + t.cut + ' cut just before' : ''}) keys=${t.keys || '-'} ${t.steered ? 'pathfinder steering' : 'no pathfinder'}${t.step}${t.active ? ', reflex ' + t.active : ''}${t.hurt ? ', hurt ' + t.hurt + 'ms before' : ''}`)
  }
  if (wasGround && !g) {
    const p = bot.entity.position; const v = bot.entity.velocity; const c = bot.controlState || {}
    const fy = Math.floor(p.y + 0.01)
    const near = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && e.position.distanceTo(p) < 1.5).map(e => e.name || e.type)
    takeoff = { at: Date.now(), hp: Math.round(bot.health), y: p.y, cx: Math.floor(p.x), cz: Math.floor(p.z), hs: Math.hypot(v.x, v.z).toFixed(2), near: near.join('+'), vel: lastServerVel ? Date.now() - lastServerVel : null, cut: lastJumpCut && Date.now() - lastJumpCut.at < 500 ? lastJumpCut.who : null, step: plannedStep(), pos: `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`, fy, drop: world.dropAt(bot, p.x, fy, p.z), v: `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`, keys: [...new Set(recentKeys.flat().concat(Object.keys(c).filter(k => c[k])))].join('+'), steered: !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()), active: active && active.kind, hurt: lastHurtAt && Date.now() - lastHurtAt < 2000 ? Date.now() - lastHurtAt : 0, dug: lastDig && Date.now() - lastDig.at < 3000 ? `${lastDig.name} at ${lastDig.pos} ${Date.now() - lastDig.at}ms before` : null }
  }
  wasGround = g
}
// LEDGE CROUCH: on a block with a fall that hurts beside it, crouch - as a player walks a wall top. The planner walked the
// cathedral's 1-wide wall tops at y126 and slid off the lip, 31 blocks (the fourth such fall, gear lost with the
// grave, 2026-09-27); crouched, the body stops at the edge. Slower along the ledges; nothing else is touched.
// ...except on the planner's own way down: the physics refuses a sneaking body every move into a column with nothing
// within a step under it - a planned step down too - so a builder stepping off a wall top onto its scaffold, or a walk
// down a hillside past a cliff, was clipped every tick until the move timed out (2026-09-27). The planner's next node
// below our floor, no further down than SAFE_DROP, is a descent it chose: no crouch while it takes it (the brake in
// edgeGuard still catches an overshoot past it).
// ...and on its way UP: the planner's next node one up, a side step over (one or two cells), solid under it. Crouched, the
// pathfinder's own simulation of the step up fails and it stands still - frozen beside a pit at 40,67,4 and 43,67,4, the
// walk to the mine "stuck x3" again and again, 2026-10-03. ONE test with jumpHurts' climb exemption, so the two cannot drift
function plannedClimb (fy) {
  const n = lastPath && lastPath[0]
  if (!n || !bot.pathfinder || !bot.pathfinder.isMoving || !bot.pathfinder.isMoving()) return false
  const p = bot.entity.position; const nx = Math.floor(n.x); const nz = Math.floor(n.z)
  // (the next cell or the diagonal one - never two over in a line, where the cell between could be the drop; audit)
  const ax = Math.abs(nx - Math.floor(p.x)); const az = Math.abs(nz - Math.floor(p.z))
  return n.y > fy && (ax + az === 1 || (ax === 1 && az === 1)) && world.isSolid(world.at(bot, nx, Math.floor(n.y) - 1, nz))
}
// ...and LEVEL: the planner's next node on our floor's level, a cell over or the diagonal, solid under it, the straight line
// to its centre over no drop that hurts. Crouched, the pathfinder's own simulation of that step stops at the pit's edge and
// it lets go of every key with a good path in hand - "sneak true, keys none, success 19 nodes" beside the pit by the mine,
// a 40s stall a mine walk, 2026-10-03. (The brake's overshoot cut still holds the lip: steered, it judges the hitbox)
function plannedLevel (fy) {
  const n = lastPath && lastPath[0]
  if (!n || !bot.pathfinder || !bot.pathfinder.isMoving || !bot.pathfinder.isMoving()) return false
  const p = bot.entity.position; const nx = Math.floor(n.x); const nz = Math.floor(n.z)
  const ax = Math.abs(nx - Math.floor(p.x)); const az = Math.abs(nz - Math.floor(p.z))
  if (Math.floor(n.y) !== fy || ax > 1 || az > 1 || !world.isSolid(world.at(bot, nx, fy - 1, nz))) return false
  const tx = nx + 0.5; const tz = nz + 0.5; const len = Math.hypot(tx - p.x, tz - p.z); const steps = Math.max(1, Math.ceil(len / 0.1))
  for (let i = 1; i <= steps; i++) { const t = i / steps; if (world.dropAt(bot, p.x + (tx - p.x) * t, fy, p.z + (tz - p.z) * t, world.SAFE_DROP + 1) > world.SAFE_DROP) return false }
  return true
}
function plannedDescent (fy) {
  const n = lastPath && lastPath[0]
  if (!n || !bot.pathfinder || !bot.pathfinder.isMoving || !bot.pathfinder.isMoving()) return false
  const down = fy - Math.floor(n.y)
  return down >= 1 && down <= world.SAFE_DROP
}
let lipActive = false // (the lip row's word to the one sneak owner: crouch while the centre is over the drop)
function ledgeWanted () {
  if (lipActive) return true
  const e = bot.entity
  if (!e || bot.vehicle || !e.onGround || world.feetInWater(bot)) return false
  const p = e.position; const fy = Math.floor(p.y + 0.01)
  // (the drop first, the planner's exemptions only beside one: asked every physics tick of every walk; audit)
  let near = false
  for (const [dx, dz] of [[0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) if (world.dropAt(bot, p.x + dx, fy, p.z + dz, world.SAFE_DROP + 1) > world.SAFE_DROP) { near = true; break }
  if (!near) return false
  return !(plannedDescent(fy) || plannedClimb(fy) || plannedLevel(fy))
}
// ONE OWNER OF SNEAK among the guards: the edge brake and the ledge crouch each pressed and let go of it on their own,
// the brake's release undoing the crouch every tick it ran. Both are asked each physics tick and sneak is set once from
// the answer; only a press of ours is ever let go (a skill's own sneak - a place from the edge - stays its own).
let guardSneak = false
// NO CROUCH WHILE WE CLICK - a declared hold. A right-click sent sneaking is a different click (a placing beside, no
// use): act.useOn/pour/fill/place(sneak:false) each let go of sneak themselves, and the ledge crouch pressed it again
// during their look + two ticks - shears on a pumpkin/nest and a composter's layer came to "+0" at any ledge, and a
// chest on a wall top never paired (2026-09-27). The boat's mount the same: seated, sneak is the dismount key, and
// until bot.vehicle is set the guard's on-ground branch pressed it again. The clicker DECLARES the hold (a token,
// counted: nested holds compose); while any is held the guard's want is false. (The brake still cuts the keys; only
// its crouch waits - a click is made standing still.)
let noSneakHolds = 0
function holdNoSneak () {
  noSneakHolds++
  if (bot) setGuardSneak(false)
  let done = false
  return () => { if (!done) { done = true; noSneakHolds-- } }
}
function setGuardSneak (want) {
  if (noSneakHolds > 0) want = false
  const held = !!(bot.controlState && bot.controlState.sneak)
  if (want) { if (!held) { origSet('sneak', true); guardSneak = true } } else if (guardSneak) { guardSneak = false; if (held) origSet('sneak', false) }
}
function edgeGuard () {
  if (!bot.entity || bot.vehicle || bot.health <= 0) { edgeHeld = null; setGuardSneak(false); return }
  const braking = edgeBrake()
  setGuardSneak(braking || ledgeWanted())
}
// the brake: true when it cut the keys this tick (sneak held to stop the momentum at the lip)
function edgeBrake () {
  // (the pathfinder too: every step it plans drops SAFE_DROP at most, so a bigger drop ahead of it is an overshoot - it
  //  walked the bot off the unrailed edge of the Notre-Dame plaza, 21 blocks, 2026-09-24. Cut, and it replans.)
  const steered = bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()
  const c = bot.controlState || {}
  const p = bot.entity.position
  const v = bot.entity.velocity
  const dir = c.forward ? 1 : c.back ? -1 : 0
  const speed = Math.hypot(v.x, v.z)
  // a jump held when this tick's keys were set by the planner (anything else is caught as it is pressed: jumpGuard)
  if (c.jump && jumpHurts(c)) { origSet('jump', false); noteJump(jumpHurts(c) || {}, steered ? 'pathfinder' : active && active.kind) }
  if (world.feetInWater(bot) || !bot.entity.onGround || (!dir && speed < 0.05)) { release(); return false }
  // where the body is headed: the keys it holds, else the way it is sliding
  let hx, hz
  if (dir) { hx = -Math.sin(bot.entity.yaw) * dir; hz = -Math.cos(bot.entity.yaw) * dir } else { hx = v.x / speed; hz = v.z / speed }
  // far enough ahead to cover this tick's motion and the slide after the keys let go (~3 ticks of it)
  const reach = 0.45 + Math.max(speed, 0.15) * 3
  const y = Math.floor(p.y + 0.01)
  const here = world.dropAt(bot, p.x, y, p.z)
  if (steered) {
    // The pathfinder only overshoots: cut when, a few ticks on at this speed, NO part of the hitbox would still rest on
    // ground and the fall there hurts. A probe along the heading clipped the corner of a stairwell beside a diagonal
    // path and stopped the walk home ten times in a night (the bed 21 blocks off, the bot left in the open); looking a
    // stride ahead past a ledge it stepped down onto cut a sound way down 111 times (2026-09-25).
    // (one tick on: three ticks ahead ran past a one-block ledge the planner was stepping onto to turn - the bot stood
    //  trapped in a pocket of the cathedral wall for ten minutes, 2026-09-25. The sneak brake holds a real overshoot at
    //  the lip; a tick at sprint is ~0.28 of a block)
    const t = 1; const nx = p.x + v.x * t; const nz = p.z + v.z * t
    const hull = (cx, cz) => Math.min(...[[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]].map(([dx, dz]) => world.dropAt(bot, Math.floor(cx + dx), y, Math.floor(cz + dz))))
    // supported now (some corner over ground), and a tick on nothing under the hitbox but a fall that hurts
    const least = hull(nx, nz)
    if (least > world.SAFE_DROP && hull(p.x, p.z) <= world.SAFE_DROP) {
      for (const k of ['forward', 'back', 'sprint', 'jump']) if (c[k]) bot.setControlState(k, false)
      const cell = { x: Math.floor(nx), z: Math.floor(nz), drop: least }
      if (!edgeHeld || edgeHeld.x !== cell.x || edgeHeld.z !== cell.z) { edgeStopCount++; log('reflex', `edge: stopped short of a ${least === Infinity ? 'bottomless' : least + '-block'} drop at ${cell.x},${y},${cell.z} (the pathfinder ran on)`) }
      edgeHeld = cell
      return true
    }
    release()
    return false
  }
  // (the drop run centring the body inside its own supported column - the footing under it: the probe a stride ahead found
  //  the drop past the footing and cut every nudge; audit)
  if (centring && Math.floor(p.x) === centring.x && Math.floor(p.z) === centring.z && here <= world.SAFE_DROP) { release(); return false }
  for (const r of [0.45, reach]) {
    const x = p.x + hx * r; const z = p.z + hz * r
    if (Math.floor(x) === Math.floor(p.x) && Math.floor(z) === Math.floor(p.z)) continue
    const drop = world.dropAt(bot, x, y, z)
    // (a column no deeper than the one we stand over is no new edge - a ledge walked along is not a cliff stepped off)
    if (drop <= world.SAFE_DROP || drop <= here) continue
    for (const k of ['forward', 'back', 'sprint', 'jump']) if (c[k]) bot.setControlState(k, false)
    const cell = { x: Math.floor(x), z: Math.floor(z), drop }
    if (!edgeHeld || edgeHeld.x !== cell.x || edgeHeld.z !== cell.z) { edgeStopCount++; log('reflex', `edge: stopped short of a ${drop === Infinity ? 'bottomless' : drop + '-block'} drop at ${cell.x},${y},${cell.z}${active ? ' (' + active.kind + ')' : ''}`) }
    edgeHeld = cell
    return true
  }
  release()
  return false
}
function release () { edgeHeld = null } // (the sneak itself: setGuardSneak)
// (a count of edge stops, for the walker: a leg that ends against a drop is the ground saying "not this way")
let edgeStopCount = 0
function edgeStops () { return edgeStopCount }
function edgeAhead () { return edgeHeld }

function tick () {
  if (!bot || !bot.entity || bot.health <= 0) return
  const now = Date.now()
  trackAir(now) // (always: an async reflex or a disabled loop still spends air)
  // (a reflex action that never ends freezes every row - no flee, no eat, no fight: said once past 3s, with what it was.
  //  At 13:20 the bot stood 12s in one cell under a pillager, "flee" active and no key pressed, and died, 2026-09-28)
  if (busy) { if (!busySince) busySince = now; if (now - busySince > 3000 && !busySaid) { busySaid = true; log('reflex', `busy for ${((now - busySince) / 1000).toFixed(1)}s in ${active ? active.kind : 'no row'} (hp ${Math.round(bot.health)}) - every row waits on it`) } } else { busySince = 0; busySaid = false }
  if (!enabled || busy) return
  pinned = false
  const me = bot.entity.position
  tread()

  // 1. AIR
  const underFor = submergedSince ? now - submergedSince : 0
  const diving = dive ? diveHolds(now) : false
  const broken = !!(dive && dive.broken && submergedSince)
  // (short of air = our own clock under 70% of a breath; bot.oxygenLevel stuck at 5 fired this the instant the
  //  head dipped - a bob while swimming at the surface was an emergency)
  if (!diving && (underFor > 2000 || broken || (submergedSince && airMs < AIR_MS * 0.7) || (active && active.kind === 'air'))) {
    if (!submergedSince && active && active.kind === 'air') {
      // head is out: finish standing on something - dry land, or a solid floor under shallow water (a clay pier one
      // below the surface, a river's shelf): the head is out and the body can't sink. Only floating is unfinished.
      const under = world.at(bot, me.x, me.y - 0.2, me.z)
      if (bot.entity.onGround && under && world.isSolid(under)) { floatSince = 0; return clearActive() }
      if (!floatSince) floatSince = now
      // open water - no bank within a few strokes to climb onto: the emergency ended when the head came out. Holding
      // the body afloat here for the full 60s froze an ocean crossing (55 blocks in ten minutes, night fell mid-sea,
      // 2026-09-23); the walk that was interrupted swims on (or boats), and tread() keeps the head up meanwhile.
      const shore = findAir(true)
      if (!shore || Math.abs(shore.x - Math.floor(me.x)) + Math.abs(shore.z - Math.floor(me.z)) > 4) {
        bot.setControlState('jump', true); bot.setControlState('forward', false)
        if (now - floatSince > 1000) { floatSince = 0; return clearActive() }
        return
      }
      // floating for 3s without making land: the bank is too high to climb from the water (a pond
      // with 2-high sides drowned the bot at 4 hp) - cut a step into it
      if (now - floatSince > 3000 && !busy) {
        runBusy('climb out', g => climbOut(g), 15000, null, stopWalk).then(() => { floatSince = now })
        return
      }
      if (now - active.since > 60000) { floatSince = 0; return clearActive() }
      steerTo(shore, { jump: true })
      return
    }
    setActive('air', `under ${Math.round(underFor / 100) / 10}s air ${Math.round(airMs / 100) / 10}s`)
    try { bot.pathfinder.setGoal(null) } catch {}
    // straight up to open air (water then air within 6)? Then only UP: steering toward the nearest air cell - the air
    // over the bank - pressed the bot into the bank under water; it drifted sideways and down and drowned in 30s with
    // open water overhead (2026-09-23). Sideways only when something blocks the way up.
    // (water a swimmer rises through: liquid, kelp, seagrass - not a waterlogged stair or slab, which holds water and
    //  a head all the same: read as "water", a waterlogged roof counted as open sky, 2026-09-27)
    const swimThrough = b => world.isWaterBlock(b) && b.boundingBox === 'empty'
    let open = false
    for (let dy = 2; dy <= 7; dy++) { const b = world.at(bot, me.x, me.y + dy, me.z); if (!b || (!swimThrough(b) && !world.isAirish(b))) break; if (world.isAirish(b)) { open = true; break } }
    // ...unless UP makes no headway: falling water in a one-wide pit (dug for sand under the water line) pushes a
    // swimmer down, and jumping in place drowned the bot a step from dry sand (2026-09-23). After 1.5s without
    // rising, climb out sideways to land.
    if (riseY == null || me.y > riseY + 0.25) { riseY = me.y; riseAt = now }
    const stalled = now - riseAt > 1500
    const land = open && stalled ? findAir(true) : null
    // ...and with no land in reach, an entity over the column (our own boat: a paused bot floating under it drowned
    // jumping into its hull, 2026-09-23) is swum round: open air a couple of strokes to the side
    const aside = open && stalled && !land ? findAir(false, { aside: true }) : null
    // ROOFED OVER: no way up and no rising - dig the roof. Steering at the nearest air cell (past solid rock) and jumping
    // held the body in one cell for twenty seconds: the pathfinder stepped it down into a water pocket under a stone
    // roof 170 blocks from home, and it drowned with 390 items (2026-09-28). A player breaks the block over their head.
    const reach = !open ? findAirReachable() : null
    if (!open && stalled && !busy && !reach) {
      // WHICH WAY: up, or sideways toward the nearest air (behind the rock) - the fewer solid cells between. A 3-thick
      // ceiling under a lake against one block of stone into an air-filled cave is a breath lived or not (audit)
      const solidsUp = () => { let n = 0; for (let dy = 2; dy <= 6; dy++) { const b = world.at(bot, me.x, me.y + dy, me.z); if (!b) return 99; if (world.isAirish(b)) return n; if (!swimThrough(b)) n++ } return 99 }
      const side = (() => {
        const t = findAir(false); if (!t) return null
        const dx = t.x - Math.floor(me.x); const dz = t.z - Math.floor(me.z)
        if (Math.abs(t.y - Math.floor(me.y)) > 1) return null
        const sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0; const sz = sx ? 0 : Math.sign(dz)
        // (a way through is two cells high - head and feet; a step counts as solid while either is, and the head's goes first)
        let n = 0; let first = null
        for (let i = 1; i <= 5; i++) {
          const x = Math.floor(me.x) + sx * i; const z = Math.floor(me.z) + sz * i
          const hb = world.at(bot, x, Math.floor(me.y) + 1, z); const fb = world.at(bot, x, Math.floor(me.y), z)
          if (!hb || !fb) return null
          const open2 = [hb, fb].every(c => world.isAirish(c) || swimThrough(c))
          if (open2 && world.isAirish(hb)) return first ? { n, first } : null
          if (!open2) { n++; if (!first) first = !(world.isAirish(hb) || swimThrough(hb)) ? hb : fb }
        }
        return null
      })()
      const up = solidsUp()
      let roof = null
      const sideways = !!(side && side.n < up)
      if (sideways) roof = side.first
      else for (let dy = 2; dy <= 4; dy++) { const b = world.at(bot, me.x, me.y + dy, me.z); if (!b) break; if (swimThrough(b) || world.isAirish(b)) continue; roof = b; break }
      // (no roof of someone else's place: the dig is refused, and chosen again every tick it kept the swim branches below
      //  from ever running - the way up is swum, not dug; foreign.js, audit)
      if (roof && require('./move').inForeign(roof.position)) roof = null
      // (never a roof whose dig kills: a falling block drops the column above into the head cell through the water, and a
      //  roof holding back lava pours it in - act.dig's own lava rule; audit 2026-09-28)
      const FALLS = /(^|_)(gravel|sand|concrete_powder)$|^suspicious_/
      // (a side dig: the block resting on the dug cell falls into the opening too - our head cell, head dug first)
      const falls = roof && (FALLS.test(roof.name) || (sideways && FALLS.test((world.at(bot, roof.position.x, roof.position.y + 1, roof.position.z) || {}).name || '')))
      const lava = roof && world.holdsBackLava(bot, roof.position)
      if (roof && (falls || lava) && (!roofDug || roofDug.x !== roof.position.x || roofDug.y !== roof.position.y || roofDug.z !== roof.position.z)) { roofDug = roof.position; log('reflex', `air: roofed over by ${roof.name} but ${falls ? 'it would fall in on me' : 'lava beyond'} - not digging`) }
      if (roof && !falls && !lava && roof.diggable !== false && !/^(bedrock|obsidian|crying_obsidian|reinforced_deepslate)$/.test(roof.name)) {
        if (!roofDug || roofDug.x !== roof.position.x || roofDug.y !== roof.position.y || roofDug.z !== roof.position.z) log('reflex', sideways ? `air: walled in - digging SIDEWAYS through ${roof.name} at ${roof.position.x},${roof.position.y},${roof.position.z} toward air (${side.n} solid vs ${up === 99 ? 'no way' : up} up; air ${Math.round(airMs / 100) / 10}s)` : `air: roofed over - digging UP through ${roof.name} at ${roof.position.x},${roof.position.y},${roof.position.z} (${up === 99 ? '?' : up} solid to air; air ${Math.round(airMs / 100) / 10}s)`)
        roofDug = roof.position
        // (standing, not floating: a dig off the ground under water is 25x slow - a stone roof from a float outlasts a
        //  breath; let go of jump and the body settles on the pocket's floor, 5x)
        for (const k of ['jump', 'forward', 'back', 'left', 'right']) bot.setControlState(k, false)
        runBusy('dig to air', () => require('./act').digBlock(bot, roof).catch(() => false), 12000, null, stopDig).then(() => { riseAt = Date.now() })
        return
      }
    }
    if (aside) {
      steerTo(aside, { jump: true })
    } else if (open && !land) {
      bot.setControlState('jump', true)
      for (const k of ['forward', 'back', 'left', 'right', 'sneak']) bot.setControlState(k, false)
    } else if (land) {
      steerTo(land, { jump: true })
    } else {
      // (roofed over: swim to air that can be reached, never at air behind rock)
      const t = reach || (open ? findAir() : null)
      if (t) steerTo(t, { jump: true }); else { bot.setControlState('jump', true); bot.setControlState('back', true) }
    }
    return
  }

  // 2. LAVA / FIRE
  if (world.inLava(bot)) {
    setActive('lava')
    try { bot.pathfinder.setGoal(null) } catch {}
    let best = null; let bd = Infinity
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -1; dy <= 2; dy++) {
      const x = Math.floor(me.x) + dx; const y = Math.floor(me.y) + dy; const z = Math.floor(me.z) + dz
      if (!world.standable(bot, x, y, z) || world.lavaNear(bot, { x, y, z }, 0)) continue
      const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy)
      if (d < bd) { bd = d; best = { x, y, z } }
    }
    if (best) steerTo(best, { jump: true, sprint: true }); else { bot.setControlState('jump', true); bot.setControlState('back', true) }
    return
  } else if (active && active.kind === 'lava') return clearActive()

  // 2b. POWDER SNOW: no collision box - a grove's snow patch the bot sinks into, freezing (a slowdown, then 1 hp every 2s)
  //  and hard to jump out of. The planner avoids it, the walk can still slip in (a drop, a shove). Out: the powder at
  //  feet and head is broken - it breaks at once by hand and drops nothing - and the body settles on the ground under it
  //  and walks on (2026-09-28, before the first expedition into a grove)
  {
    // (every column the 0.6-wide hitbox overlaps - a body straddling into the next cell freezes too; audit 2026-09-28)
    const cells = []; const seen = new Set()
    for (const [ox, oz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
      for (const dy of [0, 1]) {
        const x = Math.floor(me.x + ox); const y = Math.floor(me.y + dy); const z = Math.floor(me.z + oz); const k = `${x},${y},${z}`
        if (seen.has(k)) continue; seen.add(k)
        const b = world.at(bot, x, y, z); if (b && b.name === 'powder_snow') cells.push(b)
      }
    }
    if (cells.length) {
      if (!active || active.kind !== 'powder') { setActive('powder', 'breaking out of powder snow'); log('reflex', `in powder snow at ${Math.floor(me.x)},${Math.floor(me.y)},${Math.floor(me.z)} (hp ${Math.round(bot.health)}) - breaking out`) }
      try { bot.pathfinder.setGoal(null) } catch {}
      runBusy('powder snow', async g => { for (const b of cells.sort((p, q) => q.position.y - p.position.y)) { if (busyAborted(g)) break; await require('./act').digBlock(bot, b).catch(() => false) } }, 8000, null, stopDig)
      return
    } else if (active && active.kind === 'powder') return clearActive()
  }

  // 2b'. ON THE LIP: on the ground with the centre over a drop that kills - held up by a corner of the hitbox only. The
  //  edge brake stops the walk AT the lip, not back from it: a creeper chase braked eight times on a 23-block cliff's edge,
  //  the flee ended, a drift of 0.03 a tick took the corner away and the bot fell to its death with 60 items (2026-09-28).
  //  Back onto ground under the middle - before any fight or flee (a creeper may miss; that fall does not)
  {
    const fx = Math.floor(me.x); const fy = Math.floor(me.y - 0.01) + 1; const fz = Math.floor(me.z)
    const dropChosen = !!takingDrop && Date.now() < takingDrop.until && takingDrop.x === fx && takingDrop.z === fz && fy === takingDrop.y + 1 // (the feet over the dug floor - never after the landing; audit)
    if (bot.entity.onGround && !world.feetInWater(bot) && !bot.vehicle && !dropChosen && world.dropAt(bot, me.x, fy, me.z) > world.SAFE_DROP) {
      let best = null; let bd = Infinity
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        const x = fx + dx; const z = fz + dz
        if (!world.standable(bot, x, fy, z) || world.dropAt(bot, x + 0.5, fy, z + 0.5) > 0) continue
        const d = Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z)
        if (d < bd) { bd = d; best = { x, y: fy, z } }
      }
      if (!active || active.kind !== 'lip') { setActive('lip', 'centre over a drop'); log('reflex', `on the lip at ${fx},${fy},${fz} over a ${world.dropAt(bot, me.x, fy, me.z)}-block drop - ${best ? 'back onto ' + best.x + ',' + best.y + ',' + best.z : 'nothing firm within 2, crouched still'}`) }
      try { bot.pathfinder.setGoal(null) } catch {}
      // (the crouch is the edge guard's - one owner of sneak: lipActive feeds its ledgeWanted; this row only steers)
      lipActive = true
      if (best) steerTo(best, { jump: false }); else for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(k, false)
      return
    } else { lipActive = false; if (active && active.kind === 'lip') return clearActive() }
  }

  // 2c. A DOOMED FLOOR: natural leaves at distance 7 - no log left within reach, they decay. Stood on the crown of a tree
  //  it had just felled, the leaf under the bot rotted away and it fell 7 blocks (2026-09-28). Off onto ground that holds.
  {
    const fx = Math.floor(me.x); const fy = Math.floor(me.y - 0.01); const fz = Math.floor(me.z)
    const floor = bot.entity.onGround ? world.at(bot, fx, fy, fz) : null
    const doomed = b => { if (!b || !/_leaves$/.test(b.name)) return false; let pr = {}; try { pr = b.getProperties() || {} } catch {} return (pr.persistent === false || pr.persistent === 'false') && Number(pr.distance) >= 7 }
    // (our own footing put in the crown - leafWayOff - is no way down either: a block over the same drop, and the
    //  pathfinder has no move down it; stood on it, the row goes on until the drop is taken - audit 2026-09-28)
    const isFooting = (x, y, z) => !!leafFooting && leafFooting.x === x && leafFooting.y === y && leafFooting.z === z
    if (leafFooting && !isFooting(fx, fy, fz) && !world.isSolid(world.at(bot, leafFooting.x, leafFooting.y, leafFooting.z))) leafFooting = null
    const ours = !!floor && isFooting(fx, fy, fz)
    if ((ours || doomed(floor)) && require('./act').fallBelow(bot, { x: fx, y: fy, z: fz }) > world.SAFE_DROP) {
      let best = null; let bd = Infinity
      const dropCol = new Map(); const colDrop = (cx, cz) => { const k = cx + ',' + cz; if (!dropCol.has(k)) dropCol.set(k, world.dropAt(bot, cx + 0.5, fy + 1, cz + 0.5)); return dropCol.get(k) }
      const crossesDrop = (x, z) => { const n = Math.ceil(Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) / 0.1); for (let i = 1; i < n; i++) { const t = i / n; const cx = Math.floor(me.x + (x + 0.5 - me.x) * t); const cz = Math.floor(me.z + (z + 0.5 - me.z) * t); if (cx === fx && cz === fz) continue; if (colDrop(cx, cz) > world.SAFE_DROP) return true } return false }
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 1; dy++) {
        const x = fx + dx; const y = fy + 1 + dy; const z = fz + dz
        if (!world.standable(bot, x, y, z) || doomed(world.at(bot, x, y - 1, z)) || (ours && isFooting(x, y - 1, z))) continue
        const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy)
        if (d >= bd) continue
        // (and only one the straight steer reaches without crossing a drop: the edge brake stops that steer at the lip, the
        //  row steers again - 27 times in 26s on a felled crown beside a 5-block drop, 2026-10-03. Sampled every 0.1 - a
        //  diagonal clips a drop's corner in less than 0.4 - and each column's drop read once a tick; audit)
        if (crossesDrop(x, z)) continue
        bd = d; best = { x, y, z }
      }
      const way = best ? null : leafWayOff(floor, fx, fy, fz, ours)
      const why = best ? `stepping off to ${best.x},${best.y},${best.z}` : way ? way.why : 'stranded: nowhere firm within 3, no drop I would take, no block to stand on'
      // (said when it changes - onto the footing, the hp come back for the drop - not each time a fight row takes over)
      if (why !== leafWhy) log('reflex', `standing on ${ours ? 'my footing in the crown' : 'decaying leaves'} at ${fx},${fy},${fz} over a ${require('./act').fallBelow(bot, { x: fx, y: fy, z: fz })}-block drop - ${why}`)
      leafWhy = why
      try { bot.pathfinder.setGoal(null) } catch {}
      for (const k of ['forward', 'back', 'left', 'right', 'jump']) bot.setControlState(k, false)
      if (best || (way && way.run)) {
        if (!active || active.kind !== 'floor') setActive('floor', 'off a decaying leaf')
        if (best) steerTo(best, { jump: best.y > fy + 1 }); else runBusy('off the leaves', () => way.run().catch(() => false), 6000, null, stopDig)
        return
      }
      // A HOLD - waiting on the hp, or stranded - is no reason to starve or be shot: the tick goes on PINNED. Eating
      // (the regen the drop waits on) and fighting run, but nothing moves the body - steerTo and the fight's follow
      // stand still, and no flee: a flee off a crown footing is the fall (audit 2026-09-28)
      pinned = true
      if (!active) setActive('floor', 'held on a crown')
    } else { leafWhy = null; if (active && active.kind === 'floor') return clearActive() }
  }

  // 2d. A FLOOR THAT BURNS: a lit campfire (the castle's own, lit as placed), magma, fire - in the feet's cell (a campfire is
  //  a slab-high block: stood on, the feet are in its cell) or the one under it. The walk never plans a step onto one and a
  //  stand never counts it as a floor, but the body got onto a castle campfire all the same and stood there burning for 15s,
  //  hp 19 to 0, while the planner worked a partial path - dead with 302 items, 2026-09-30. Off it to the nearest firm
  //  cell at once, whatever put it there
  {
    const fx = Math.floor(me.x); const fy = Math.floor(me.y + 0.01); const fz = Math.floor(me.z)
    const hot = b => !!b && world.HOT_RE.test(b.name) // (world's one list - the diagonal step reads its twin)
    const here = world.at(bot, fx, fy, fz); const under = world.at(bot, fx, fy - 1, fz)
    if (!bot.vehicle && (hot(here) || (bot.entity.onGround && hot(under)))) {
      let best = null; let bd = Infinity
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, 1, -1]) {
        if (!dx && !dz) continue
        const x = fx + dx; const y = fy + dy; const z = fz + dz
        if (!world.standable(bot, x, y, z) || hot(world.at(bot, x, y, z)) || world.dropAt(bot, x + 0.5, y, z + 0.5) > world.SAFE_DROP) continue
        // (the way there at the body's OWN height too: stood on a campfire's top (y+0.44) the body passes at that level - a
        //  cell a step down with a wall at the body's height was picked, steered into for 14s, and the bot burned on the
        //  castle's second campfire, 2026-09-30)
        { let blocked = false; for (let yy = Math.min(y, fy); yy <= fy + 2 && !blocked; yy++) { const c = world.at(bot, x, yy, z); if (c && c.boundingBox === 'block' && !(yy < y)) blocked = true } if (blocked) continue }
        if (Math.abs(dx) + Math.abs(dz) > 1) { const a = world.at(bot, fx + dx, fy + 1, fz); const b2 = world.at(bot, fx, fy + 1, fz + dz); if ((a && a.boundingBox === 'block') || (b2 && b2.boundingBox === 'block')) continue } // (a diagonal needs its corners open at the head)
        const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy)
        if (d < bd) { bd = d; best = { x, y, z } }
      }
      // (nothing firm within 2 at a safe drop - the way off in order of the damage it costs: a fall out to 3 with a drop of 3
      //  at most (none); the fire itself broken - the body settles onto its floor, the builder puts it back (none); a longer
      //  drop, 4-6, only when the fall damage (drop - 3) leaves 3 hp. Stood on the castle's campfire high on its walls with
      //  drops all round, a blind jump landed back on it for 26s and the bot burned to death, 2026-09-30; audit)
      const fallTo = maxDrop => {
        let f = null; let fd = Infinity
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
          if (!dx && !dz) continue
          const x = fx + dx; const z = fz + dz
          const c = world.at(bot, x, fy, z); const c2 = world.at(bot, x, fy + 1, z)
          if (!c || !c2 || !world.isAirish(c) || !world.isAirish(c2)) continue
          const drop = world.dropAt(bot, x + 0.5, fy, z + 0.5)
          const land = world.at(bot, x, fy - drop, z)
          if (drop > maxDrop || !land || hot(land) || world.isLavaBlock(land)) continue
          const d = Math.abs(dx) + Math.abs(dz) + drop
          if (d < fd) { fd = d; f = { x, y: fy, z, drop } }
        }
        return f
      }
      const hb = hot(here) ? here : under
      const shortFall = best ? null : fallTo(world.SAFE_DROP)
      // (never their campfire: refused, it was chosen again every tick and the jump-off below never ran - foreign.js, audit)
      const breakIt = !best && !shortFall && !!hb && hb.hardness != null && hb.hardness >= 0 && !require('./move').inForeign(hb.position)
      const longFall = !best && !shortFall && !breakIt ? fallTo(Math.min(6, Math.floor(bot.health) - 3 + world.SAFE_DROP)) : null
      const how = best ? 'off to ' + best.x + ',' + best.y + ',' + best.z : shortFall ? 'nothing firm within 2: a short drop off to ' + shortFall.x + ',' + shortFall.z : breakIt ? 'nothing firm within 2: breaking the ' + hb.name : longFall ? 'nothing firm within 2: a ' + longFall.drop + '-block drop off to ' + longFall.x + ',' + longFall.z : 'nowhere to go: jumping'
      // (and what put us there - the mover: the row before, the planner's goal and step, the body's speed, a hit just taken;
      //  a campfire touch with no placement and no planned step onto it went unexplained, 2026-09-30; audit)
      if (!active || active.kind !== 'hot') {
        let mover = ''
        try { const v = bot.entity.velocity; const st = plannedStep(); mover = ` [was: ${active ? active.kind : 'no reflex'}, planner ${bot.pathfinder && bot.pathfinder.goal ? 'goal set' : 'no goal'}${bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving() ? ' moving' : ''}, step ${st ? JSON.stringify(st).slice(0, 80) : 'none'}, v ${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}${lastHurtAt && Date.now() - lastHurtAt < 1000 ? ', hit ' + (Date.now() - lastHurtAt) + 'ms before' : ''}]` } catch {}
        setActive('hot', 'off a burning floor'); log('reflex', `standing on ${hb.name} at ${fx},${fy},${fz} - ${how}${mover}`)
      }
      try { bot.pathfinder.setGoal(null) } catch {}
      // (always a jump: off the campfire's lip, out of its box - steered flat, the body stood pinned on it)
      const to = best || shortFall || longFall
      if (to) steerTo(to, { jump: true })
      else if (breakIt) { if (!busy) runBusy('break the fire', () => require('./act').digBlock(bot, hb, { own: true }).catch(() => false), 4000, null, stopDig) }
      else { bot.setControlState('jump', true); bot.setControlState('forward', true) }
      return
    } else if (active && active.kind === 'hot') return clearActive()
  }

  const hs = hostiles(24)
  const hp = bot.health
  const armed = !!inv.bestWeapon(bot)
  const armor = inv.armorPieces(bot)

  // 3. CREEPER - run straight away, steering by hand. A creeper tracks a player out to 16 blocks,
  // so the run lasts until it is past that; the pathfinder's invert-goal replans too slowly (two
  // deaths: flee "done" at 11b, the creeper closed again, boom). Behind walls it is not a threat.
  // (only one we can see, or one right beside us: a creeper beyond rock can't reach us, and fleeing it every 2s
  //  froze a whole night of mining)
  // a creeper lights its fuse within 3 blocks and gives up beyond 7: keep out of that ring, no further - running
  // until 16 let one creeper drag the bot 60 blocks across the map, a flee every few seconds
  const creeper = hs.find(h => h.e.name === 'creeper' && h.d < 5 && (canSee(h.e) || h.d < 3) && !((creeperIgnore.get(h.e.id) || 0) > now && h.d >= 3.5))
  // (still running only from a creeper that threatens NOW - seen, or within its blast reach: one behind rock round a bend
  //  held the body 16s, every other row locked out, while a zombie beside the bot took it down, 2026-09-29; audit)
  const stillRunning = active && active.kind === 'creeper' && fleeTarget && fleeTarget.isValid && fleeTarget.position.distanceTo(me) < 9 && now - active.since < 30000 && (canSee(fleeTarget) || fleeTarget.position.distanceTo(me) < 4.5)
  if (creeper || stillRunning) {
    const t = creeper ? creeper.e : fleeTarget
    fleeTarget = t
    const d = t.position.distanceTo(me)
    if (!active || active.kind !== 'creeper') { creeperTrail = []; creeperSaid = { stall: false, hurt: false }; creeperMode = null }
    setActive('creeper', `${d.toFixed(1)}b`)
    // (the body over the last second while this row steers: a flee that goes nowhere, and hurt that is not the creeper's)
    creeperTrail.push({ t: now, x: me.x, z: me.z, hp: bot.health }); creeperTrail = creeperTrail.filter(q => now - q.t <= 1200)
    shieldDown()
    try { bot.pathfinder.setGoal(null) } catch {}
    // FIGHT IT, DON'T DANCE WITH IT. A creeper chases out to 16 and lights only within 3: fled to 5-9 and let go, it came
    // straight back - run, stop, run, a whole night of it at hp 8 until a zombie finished the bot (2026-10-02). A player
    // with a blade stands, lets it walk in and strikes it at reach, before it is close enough to light; the sprint-hit
    // knocks it back out, a step back, again - four stone-sword hits. Only a LIT fuse is run from (past 7 the fuse winds
    // down: its own swell_dir says which); no blade, hurt, in water or with something else at us: the run below.
    const fusing = creeperFusing(t)
    const blade = inv.bestWeapon(bot)
    // (nothing else at us: a mob at our side, a shooter in sight - a stand is a target for both; a hit taken lately is
    //  someone else's work, the run below answers it; audit)
    const company = hs.some(o => o.e !== t && canSee(o.e) && ((o.d < 8 && !NEVER_MELEE.has(o.e.name)) || (RANGED.has(o.e.name) && o.d < 16)))
    // (life enough for a missed window: a blast at 3 is ~10-17 unarmoured; audit)
    const hpNeed = inv.armorPoints(bot) >= 10 ? 12 : 16
    if (CREEPER_FIGHT && blade && fusing === false && !creeperPowered(t) && canSee(t) && bot.health >= hpNeed && !company && now - lastHurtAt > 3000 && !world.feetInWater(bot) && !bot.vehicle) {
      if (creeperMode !== 'fight' || !creeperFight || creeperFight.id !== t.id) { creeperMode = 'fight'; creeperFight = { id: t.id, closest: d, since: now }; log('reflex', `creeper ${d.toFixed(1)}b, fuse not lit - standing with the ${blade.name}, striking it as it comes into reach`) }
      fightTarget = t; fightAt = now
      if (!bot.heldItem || bot.heldItem.name !== blade.name) inv.equipWeapon(bot).catch(() => {}) // (in hand before it is in reach)
      bot.lookAt(t.position.offset(0, 1.2, 0), true).catch(() => {})
      // (a stand-off - no closer in 3s: across a gap, behind a fence, on a ledge - is let be for 20s, not stood over for ever)
      if (d < creeperFight.closest - 0.3) { creeperFight.closest = d; creeperFight.since = now }
      if (now - creeperFight.since > 3000 && now >= creeperBackUntil) { creeperIgnore.set(t.id, now + 20000); log('reflex', `creeper ${d.toFixed(1)}b not coming closer - letting it be`); fightTarget = null; creeperFight = null; return clearActive() }
      // the step back after a strike: straight back, still facing it (forward on a flee heading turned the body to it)
      if (now < creeperBackUntil) { bot.setControlState('forward', false); bot.setControlState('sprint', false); bot.setControlState('back', !pinned); return }
      // standing: it walks into the blade - the strike itself is timed every physics tick (creeperStrike)
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(k, false)
      return
    }
    fightTarget = null
    if (fusing && creeperMode !== 'run') { creeperMode = 'run'; log('reflex', `creeper ${d.toFixed(1)}b, fuse LIT - backing out past its reach`) }
    // too close to outrun the fuse: knock it back first (knockback pushes it out of blast range)
    if (d < 3.2 && inv.bestWeapon(bot) && now - lastAttackAt > 500 && canSee(t)) {
      bot.lookAt(t.position.offset(0, 1.2, 0), true).catch(() => {})
      bot.attack(t); lastAttackAt = now
      return
    }
    let h = fleeHeading(t)
    // (A FLEE THAT DOES NOT MOVE IS NO FLEE: a heading on paper, the body pinned in one cell 9.6s while a zombie took it
    //  from 20 to 5 - dead, 2026-09-30. Under 0.4 in the last second, no heading this tick: the branches below answer)
    const old = creeperTrail[0]
    const stalled = !!old && now - old.t >= 800 && Math.hypot(me.x - old.x, me.z - old.z) < 0.4
    // (and HURT while the creeper is out of its reach is someone else's work - a creeper does not bite: answered first)
    const hurtByOther = !!old && now - old.t >= 300 && bot.health < old.hp - 0.5 && d >= 3.2
    // (a mob that can be fought, at our side while we run - it is the one hurting us NOW: with no way to run or the
    //  creeper not yet close, a swing at it (the knockback clears the way too). The flee held the body in a dead-end
    //  tunnel while a zombie took 20 hp, iron armour and all, 2026-09-29)
    const biter = hs.find(o => o.e !== t && !NEVER_MELEE.has(o.e.name) && o.d < 3.2 && canSee(o.e))
    if (stalled && h) { h = null; if (!creeperSaid.stall) { creeperSaid.stall = true; log('reflex', `flee not moving - answering ${biter ? 'the ' + biter.e.name : 'from here'}`) } }
    if (biter && hurtByOther && !creeperSaid.hurt) { creeperSaid.hurt = true; log('reflex', `hurt by the ${biter.e.name} while fleeing the creeper - answering it`) }
    if (biter && inv.bestWeapon(bot) && now - lastAttackAt > 500 && (!h || d > 4 || hurtByOther)) {
      bot.lookAt(biter.e.position.offset(0, biter.e.height ? biter.e.height * 0.8 : 1.2, 0), true).catch(() => {})
      bot.attack(biter.e); lastAttackAt = now
      return
    }
    if (h) { bot.setControlState('back', false); steerTo(h, { jump: h.jump, sprint: bot.food > 6 }) }
    // (nowhere to run - a dead-end tunnel - and it is past knockback reach: a wall between us, as the shooter's cover
    //  does; standing there backing into rock was the wait before the death of 2026-09-29; audit)
    else if (d >= 3.2 && !busy) runBusy('wall off', g => wallOff(t, g), 3500, 'creeper')
    else { bot.setControlState('forward', false); bot.setControlState('back', !pinned); bot.setControlState('sprint', false) }
    return
  } else if (active && active.kind === 'creeper') { fightTarget = null; creeperFight = null; return clearActive() }

  // 4. THREAT - fight what can be fought, flee what cannot
  const melee = hs.filter(h => !NEVER_MELEE.has(h.e.name))
  // only what we can actually see (a mob behind the bunker wall is not a fight)
  const close = melee.find(h => h.d < 4.5 && (h.e.name !== 'spider' || !bot.time.isDay || h.d < 3) && canSee(h.e))
  const shooter = melee.find(h => RANGED.has(h.e.name) && h.d < 14 && canSee(h.e))
  const recentlyHurt = now - lastHurtAt < 3000
  const hurtByMelee = recentlyHurt && lastHurtBy && lastHurtBy.isValid && !NEVER_MELEE.has(lastHurtBy.name) && lastHurtBy.position.distanceTo(me) < 6 ? lastHurtBy : null
  let target = close ? close.e : (hurtByMelee || null)
  // charge a shooter only with a shield or armour to take the arrows, or when it is already close - an
  // unarmoured run at a skeleton 11b away lost 9 hp before the first swing, and the next one killed the bot
  // (with a bow ready, anything past 5 blocks is shot, not charged)
  // (above the hurt line - the same line `weak` below flees at: a fixed hp 12 beside it picked fights the flee rule
  //  then broke off, and never moved with the armour worn)
  if (!target && shooter && armed && hp > hurtLine() && ((!bowReady() || shooter.d < 4) && chargeAffordable(shooter, hs, hp))) target = shooter.e
  // nothing to hit in reach and a bow in the pack: shoot what shoots us (out to 24, in sight), and a creeper before it
  // walks up - standing on the ground only (a draw afloat lets the body sink; the flee swims for the bank instead)
  if (!target && draw) return // (the draw in hand holds the body; anything above took it with setActive)
  if (!target && bowReady() && hp > hurtLine() && canDraw()) {
    const mark = hs.find(h => (RANGED.has(h.e.name) || h.e.name === 'creeper') && h.d >= 4 && h.d < 24 && canSee(h.e))
    if (mark) {
      setActive('shoot', `${mark.e.name} ${mark.d.toFixed(1)}b`)
      shootAt(mark.e).catch(() => false).finally(() => { if (active && active.kind === 'shoot') clearActive() })
      return
    }
  }
  if (!target && shooter && recentlyHurt) {
    // being shot and not going to fight it: out of its line of sight
    takeCover(shooter.e, `cover from ${shooter.e.name} ${shooter.d.toFixed(1)}b`)
    return
  }
  // bare fists do 1 damage against 20 hp: without a weapon, back off (and let the shelter logic dig
  // in) unless it is a weak mob we can finish or we have nowhere to go
  // (the hurt line: two hits from death - without armour a zombie on hard takes 4.5 a hit)
  const weak = hp <= hurtLine() || (!armed && !(target && /^(silverfish|endermite)$/.test(target.name)))
  // at night, unable to fight: running across open ground in the dark gets you surrounded - dig
  // straight down on the spot and plug the hole (a player's respawn-at-night move)
  const nightThreat = !armed && world.phase(bot) !== 'day' ? hs.find(h => h.d < 16 && h.e.name !== 'creeper') : null
  // digging in takes seconds: never with a mob about to hit us, never through the safehouse floor
  const nearest = hs.length ? hs[0].d : Infinity
  const inHut = require('./move').insideHut(bot.entity.position.floored())
  // AN ANGRY ENDERMAN is not out-run (it teleports beside us) nor out-fought with a stone blade (40 hp, 5-6 a hit on us) - it
  // took the bot 14 -> 0 in 16s, 2026-10-03. A player steps into WATER (it burns there and teleports off), else digs a capped
  // hole (three tall, it cannot reach in) with a pickaxe and a block to cap it, else fights. An iron blade at hp 18+ fights
  const enderOn = target && target.name === 'enderman' && !(hp >= 18 && /^(iron|diamond|netherite)_(sword|axe)$/.test((inv.bestWeapon(bot) || {}).name || ''))
  // (water it can REACH and that keeps it off: level with us (+-1), not our farm's or base's, two from any dry stand - from a
  //  puddle's edge it hits us from the bank; and a run there that does not move gives the water up for this one; audit)
  const enderNear = hs.find(h => h.e.name === 'enderman' && h.d < 8)
  if (enderNear && world.feetInWater(bot)) { fleeTarget = enderNear.e; for (const k of ['forward', 'back', 'left', 'right', 'sprint']) bot.setControlState(k, false); setActive('flee', 'enderman - holding in the water'); return }
  if (enderOn && !world.feetInWater(bot)) {
    const mvd = waterRun && waterRun.id === target.id && now - waterRun.at > 1000 && bot.entity.position.distanceTo(waterRun.from) < 0.4
    if (mvd) { waterGaveUp.add(target.id); waterRun = null }
    const dryNear = q => [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]].some(([dx, dz]) => world.standable(bot, q.x + dx, q.y, q.z + dz) || world.standable(bot, q.x + dx, q.y + 1, q.z + dz))
    const wet = waterGaveUp.has(target.id) ? null : world.findBlocks(bot, /^water$/, { maxDistance: 6, count: 16 }).find(b => Math.abs(b.position.y - Math.floor(me.y)) <= 1 && world.isAirish(world.at(bot, b.position.x, b.position.y + 1, b.position.z)) && !require('./move').inZone(b.position) && !dryNear(b.position))
    if (wet) {
      if (!waterRun || waterRun.id !== target.id || now - waterRun.at > 1000) waterRun = { id: target.id, at: now, from: bot.entity.position.clone() }
      fleeTarget = target; setActive('flee', `enderman - into the water at ${wet.position.x},${wet.position.y},${wet.position.z}`); try { bot.pathfinder.setGoal(null) } catch {}; steerTo(wet.position, { jump: true, sprint: bot.food > 6 }); return
    }
    const pick = inv.bestTool(bot, 'pickaxe', 4); const cap = inv.shelterBlock(bot)
    if (pick && cap && !busy && !inHut && !enclosed() && canDigInHere()) {
      setActive('dig-in', `enderman ${target.position.distanceTo(me).toFixed(1)}b - no blade for it, a capped hole`)
      runBusy('dig in', g => digIn(g), 30000, null, () => { stopDig(); stopWalk() }).then(() => { if (active && active.kind === 'dig-in') clearActive() })
      return
    }
  }
  if (((target && weak) || nightThreat) && world.phase(bot) !== 'day' && nearest >= 6 && !inHut && !enclosed() && canDigInHere()) {
    const t = target || nightThreat.e
    setActive('dig-in', `${t.name} ${t.position.distanceTo(me).toFixed(1)}b, can't fight`)
    runBusy('dig in', g => digIn(g), 30000, null, () => { stopDig(); stopWalk() }).then(() => { if (active && active.kind === 'dig-in') clearActive() })
    return
  }
  if (target && weak && hs.filter(h => h.d < 10).length) {
    if (RANGED.has(target.name)) { takeCover(target, `hp ${Math.round(hp)} - cover from ${target.name}`); return }
    fleeTarget = target
    setActive('flee', `hp ${Math.round(hp)} - ${target.name}`)
    shieldDown()
    try { bot.pathfinder.setGoal(null) } catch {}
    const h = fleeHeading(target)
    if (h) { bot.setControlState('back', false); steerTo(h, { jump: h.jump, sprint: bot.food > 6 }) }
    else { bot.setControlState('forward', false); bot.setControlState('back', !pinned) }
    return
  }
  if (target && target.isValid) {
    const d = target.position.distanceTo(me)
    const why = target === (close && close.e) ? 'close' : target === hurtByMelee ? 'hit me' : 'shooter'
    // whatever picked it: never chase a shooter across open ground the arrows on the way in would make a losing trade
    // (the charge rule's own reckoning - "no shield and under two pieces" contradicted it: the bot picked the fight and
    // fled it on the same tick, flee/fight every half second under a pillager patrol, 2026-09-25)
    // (at ANY distance, every tick, whatever picked it - under 5 blocks no row weighed the trade again and the fight ran to
    //  the hurt line under a patrol, 2026-10-02; audit)
    if (RANGED.has(target.name) && !chargeAffordable({ e: target, d }, hs, hp)) {
      takeCover(target, `cover from ${target.name} ${d.toFixed(1)}b (${why})`)
      return
    }
    if (!active || active.kind !== 'fight') fightTargetId = target.id
    setActive('fight', `${target.name} ${d.toFixed(1)}b (${why})`)
    if (armed && (!bot.heldItem || !/_(sword|axe)$/.test(bot.heldItem.name))) { runBusy('equip a weapon', () => inv.equipWeapon(bot), 1500); return }
    if (d > 2.8 && !pinned) {
      bot.pathfinder.setMovements(require('./move').movementsFor(bot, { dig: false, place: false }))
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.5), true)
    } else {
      try { bot.pathfinder.setGoal(null) } catch {}
    }
    bot.lookAt(target.position.offset(0, (target.height || 1.6) * 0.85, 0), true).catch(() => {})
    const swingReady = d < 3.4 && now - lastAttackAt > attackCooldownMs() && canSee(target)
    if (inv.offhandShield(bot)) {
      // shield up between swings (arrows and zombie hits land on it); down for the swing itself
      if (swingReady) { shieldDown(); bot.attack(target); lastAttackAt = now } else if (now - lastAttackAt > 150) shieldUp()
    } else if (swingReady) { bot.attack(target); lastAttackAt = now }
    return
  }
  // the safehouse run carries on by itself: the planner walks it, the door opens and shuts - no steer away, no freeze; inside,
  // the door shut, the ordinary out-of-sight hold takes over
  if (safeRun && active && active.kind === 'flee') {
    if (safeRunStep() === 'go') return
    return clearActive()
  }
  if (safeRun && (!active || active.kind !== 'flee')) safeRun = null
  if (active && (active.kind === 'fight' || active.kind === 'flee')) {
    // hold the fight a moment after the last target vanishes, then release - except a flee from a shooter that still sees
    // us within its range: nothing within 8 is the point of that flee, not its end (the cover flee was cleared the tick
    // after it began and re-armed the tick after that, every 200ms; audit B3)
    // A SHOOTER THAT CAN'T SEE US is not escaped while it is still about - out of its sight is the place to be: held there,
    // still. Released, the director walked the bot back into its sight and the next bolt began it all again (audit
    // 2026-10-02). Gone (dead, past 24, down a cave) is escaped; hungry, the eat row below has its turn (out of sight)
    if (active.kind === 'flee' && fleeTarget && RANGED.has(fleeTarget.name) && !canSee(fleeTarget)) {
      const about = fleeTarget.isValid && fleeTarget.position.distanceTo(me) < 24 && Math.abs(fleeTarget.position.y - me.y) < 6
      // (hungry WITH something to eat: the eat row has its turn - hungry with nothing in the pack let go and took cover again
      //  every 0.2s, hp 4 under a skeleton, 2026-10-02)
      if (!about || (hungryNow() && inv.foodPoints(bot) > 0)) return clearActive() // (the eat row's own hunger: one rule - audit)
      for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) bot.setControlState(k, false)
      return
    }
    const coverFlee = active.kind === 'flee' && fleeTarget && fleeTarget.isValid && RANGED.has(fleeTarget.name) && fleeTarget.position.distanceTo(me) < 24 && canSee(fleeTarget)
    if (!coverFlee && !hs.some(h => h.d < 8)) return clearActive()
    // (a shooter still in sight is not escaped by distance - the cover flee runs until the sight is lost: B3)
    if (active.kind === 'flee' && (!fleeTarget || !fleeTarget.isValid || (fleeTarget.position.distanceTo(me) > 14 && !(RANGED.has(fleeTarget.name) && fleeTarget.position.distanceTo(me) < 24 && canSee(fleeTarget))))) return clearActive()
    if (active.kind === 'fight') return clearActive()
    // still running: keep steering (held controls alone would carry us off a cliff)
    const h = fleeHeading(fleeTarget)
    if (h) steerTo(h, { jump: h.jump, sprint: bot.food > 6 }); else return clearActive()
    return
  }

  // 5. EAT - when hungry and nothing is attacking
  // (hurt: eat up to the food bar regeneration needs - below it the hp never comes back)
  const hungry = hungryNow()
  // (not while swimming - a bite lets go of the stroke - but a boat is a seat: eat in it)
  // (and not in a shooter's sight: standing 1.6s to eat in the open, the bot took a skeleton's arrows bite after bite,
  //  17 -> 3 hp in 25s at the site, 2026-09-27 - out of its sight first, then eat)
  // ...unless it cannot be got away from - hunger at the sprint line (starving comes next) or no way out of the shooter's
  //  sight (fleeHeading has nowhere): eating is then the better of two bad trades (the audit: never a veto to starve by)
  // (worked out only when a meal is due - the sight ray and the flee scan every 200ms whenever a shooter was in view cost
  //  the body for nothing; audit B3)
  if (hungry && !hs.some(h => h.d < 8) && now - lastEatFail > 10000 && (!world.feetInWater(bot) || bot.vehicle) && inv.foodItems(bot, { desperate: bot.food <= 6, hurt: bot.health < 20 }).length) {
    const eatShooter = hs.find(h => RANGED.has(h.e.name) && h.d < 24 && canSee(h.e))
    const cover = eatShooter && bot.food > 6 && !pinned ? fleeHeading(eatShooter.e) : null
    // in its sight with a way out: get out of sight FIRST (the cover flee - it ends when the sight is lost, and then this
    // eats); the veto alone left the bot standing in the open at hp 3, neither eating nor moving (audit B3)
    if (cover && !bot.vehicle) {
      fleeTarget = eatShooter.e
      setActive('flee', `cover from ${eatShooter.e.name} ${eatShooter.d.toFixed(1)}b to eat`)
      shieldDown()
      try { bot.pathfinder.setGoal(null) } catch {}
      bot.setControlState('back', false); steerTo(cover, { jump: cover.jump, sprint: bot.food > 6 })
      return
    }
    doEat(); return
  }

  // 6. DRESS - armour in the pack better than what is worn goes on, whoever put it there (a grave, a chest, a pickup).
  // Wearing used to follow only a craft or a grave recovery: an iron helmet rode in the pack while skeletons shot the
  // bare-headed bot dead four times in an hour (2026-09-25). (Not with a window open; a piece the server refused
  // waits for the inventory to change.)
  if (!bot.currentWindow && !hs.some(h => h.d < 8)) {
    const k = inv.betterArmorInPack(bot)
    if (k && k !== dressFailed) {
      runBusy('dress', () => inv.wearBestArmor(bot).then(() => { if (inv.betterArmorInPack(bot) === k) dressFailed = k }).catch(() => { dressFailed = k }), 5000)
    }
  }
}

function install (b) {
  bot = b
  // (the server setting our velocity - knockback, an explosion, a push: noted for the fall line)
  try { bot._client.on('entity_velocity', p => { if (bot.entity && p && p.entityId === bot.entity.id) lastServerVel = Date.now() }) } catch {}
  if (bot.inventory && bot.inventory.on) bot.inventory.on('updateSlot', () => { dressFailed = null })
  { let hp0 = bot.health; bot.on('health', () => { const d = (hp0 || 0) - (bot.health || 0); if (d > 0) { hurtLog.push({ at: Date.now(), d }); while (hurtLog.length > 20) hurtLog.shift() } hp0 = bot.health }) }
  bot.on('entityHurt', (e, source) => {
    if (e !== bot.entity) return
    lastHurtAt = Date.now()
    // the server names who hurt us (damage_event's source entity - the skeleton, not its arrow); none for a fall,
    // drowning, a cactus. (It used to be the nearest hostile: a fall beside a zombie was "hit by the zombie".)
    lastHurtBy = source && source !== bot.entity ? source : null
    if (lastHurtBy && lastHurtBy.name === 'enderman') { provoked.set(lastHurtBy.id, Date.now()); if (provoked.size > 20) provoked.clear() }
  })
  bot.on('diggingCompleted', b => { try { lastDig = { at: Date.now(), name: b.name, pos: `${b.position.x},${b.position.y},${b.position.z}` } } catch {} })
  bot.on('death', () => { active = null; busy = false; blocking = false; floatSince = 0; submergedSince = 0; airMs = AIR_MS; if (dive) dive.broken = 'died'; fleeTarget = null; diedAt = Date.now() })
  // respawned into the dark: dig in on the spot before anything finds us
  bot.on('spawn', () => {
    if (!diedAt || Date.now() - diedAt > 15000) return
    diedAt = 0
    setTimeout(() => {
      try {
        // respawning at our bed means respawning in the safehouse: that IS the shelter - no hole in its floor
        if (!bot.entity || busy || world.phase(bot) === 'day' || enclosed() || require('./move').insideHut(bot.entity.position.floored()) || !canDigInHere()) return
        setActive('dig-in', 'respawned at night')
        runBusy('dig in', g => digIn(g), 30000, null, () => { stopDig(); stopWalk() }).then(() => { if (active && active.kind === 'dig-in') clearActive() })
      } catch {}
    }, 1500)
  })
  setInterval(() => { try { tick() } catch (e) { log('reflex', 'tick error: ' + e.message) } }, 200)
  jumpGuard()
  installPlaceGuard()
  bot.on('path_update', r => { lastPath = r && r.path; lastPathStatus = r && r.status })
  // (a TRIPWIRE: lava appearing beside us within moments of a lava bucket in the hand is a placing some path let through -
  //  named at once, loudly; the lava fuel only ever scoops; audit 2026-09-28)
  let lavaHeldAt = 0
  bot.on('heldItemChanged', it => { if (it && it.name === 'lava_bucket') lavaHeldAt = Date.now() })
  bot.on('blockUpdate', (o, n) => {
    if (!n || n.name !== 'lava' || !bot.entity || (o && o.name === 'lava')) return
    const held = bot.heldItem && bot.heldItem.name === 'lava_bucket'
    if (!held && Date.now() - lavaHeldAt > 1500) return
    if (n.position.distanceTo(bot.entity.position) > 3.5) return
    log('vital', `LAVA appeared at ${n.position.x},${n.position.y},${n.position.z} beside me with a lava bucket in hand${active ? ' (reflex ' + active.kind + ')' : ''} - a placing that must never happen`)
  })
  bot.on('goal_reached', () => { lastPath = null })
  bot.on('physicsTick', () => { try { noteTakeoff(); creeperStrike(); edgeGuard() } catch (e) { log('reflex', 'edge guard error: ' + e.message) } })
  // a fall's death names what took the body off the ground (the trail is 1/s: it can't - a fall off the cathedral's
  // north edge left no edge-guard line and no way to tell who was steering, 2026-09-25)
  bot.on('death', () => {
    const t = fell && Date.now() - fell.at < 10000 ? fell : takeoff
    if (!t || Date.now() - t.at > 10000) return
    log('death', `left the ground ${((Date.now() - t.at) / 1000).toFixed(1)}s before at ${t.pos}${t.fall ? ' (fell ' + t.fall + ')' : ''} (floor y${t.fy}, drop there ${t.drop}) v=${t.v} keys=${t.keys || '-'} ${t.steered ? 'pathfinder steering' : 'no pathfinder'}${t.step}${t.active ? ', reflex ' + t.active : ''}${t.hurt ? ', hurt ' + t.hurt + 'ms before' : ''}`)
  })
}

function isActive () { return active ? active.kind : null }
function info () { return active ? { kind: active.kind, detail: active.detail, forSec: Math.round((Date.now() - active.since) / 1000) } : null }
function lastHurt () { return lastHurtAt ? { at: lastHurtAt, by: lastHurtBy ? lastHurtBy.name || lastHurtBy.type : null } : null }
function nearestThreat () {
  if (!bot || !bot.entity) return null
  const h = hostiles(16)[0]
  return h ? { type: h.e.name, dist: Math.round(h.d * 10) / 10 } : null
}
async function waitClear (maxMs = 120000) {
  const t0 = Date.now()
  while (active && Date.now() - t0 < maxMs) await new Promise(r => setTimeout(r, 250))
}
function setEnabled (on) { enabled = !!on; if (!on) clearActive() }

// The skill's view of the air clock: time with the head under (since the last breath) and the air left.
function underMs () { return submergedSince ? Date.now() - submergedSince : 0 }
function airLeftMs () { return airMs }

module.exports = { plannedStep: () => plannedStep(), plannedNode: () => (lastPath && lastPath[0]) || null, plannedPath: () => lastPath || [], resetPlannedPath: () => { lastPath = null }, setCautious, plannerPlacedSince, findAirReachable, _bindForTest: b => { bot = b }, _leafWayOff: (...a) => leafWayOff(...a), _jumpHurts: c => jumpHurts(c), _leafFooting: () => leafFooting, edgeStops, install, holdNoSneak, active: isActive, info, nearestThreat, lastHurt, hurtLine, edgeAhead, hostiles, onSurface, canSee, NEVER_MELEE, waitClear, setEnabled, findAir, HOSTILE, RANGED, bowReady, startDive, endDive, diveBroken, underMs, airLeftMs, AIR_MS, DIVE_HARD_MS }
