'use strict'
// OFFLINE unit test for the modules split out of commands.js (grave-policy, gear,
// op-build, perception) - no bot, no world. Run: cd bot && node splitmodulestest.js
//
// WHY this exists: the split moved these out of a 3795-line file specifically so they
// could be exercised without standing up the whole command layer. Until something
// actually imports them DIRECTLY, that benefit is theoretical - the existing suite
// reaches them only through commands.js re-exports, which would keep passing even if a
// module were quietly broken and shadowed.
//
// It also pins the two contracts the split depends on:
//   (1) commands.js re-exports every moved name (so no call site had to change), and
//   (2) the re-export is the SAME function object, not a copy that could drift.

const fs = require('fs')
const path = require('path')
const gravePolicy = require('./grave-policy.js')
const gear = require('./gear.js')
const opBuild = require('./op-build.js')
const perception = require('./perception.js')
const commands = require('./commands.js')

let failures = 0
function eq (got, want, label) {
  const ok = got === want
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`))
}

// ---- grave-policy: the pure decisions ------------------------------------------------------
{
  const gear1 = { items: { count: 1, notable: ['iron_pickaxe'] } }
  const junk = { items: { count: 1, notable: [] } }
  const bulk = { items: { count: 12, notable: [] } }
  const wood = { items: { count: 2, notable: [], build: 8 } }
  eq(gravePolicy.graveWorthIt(gear1), true, 'worthIt: real gear (iron) is worth a corpse run')
  eq(gravePolicy.graveWorthIt(junk), false, 'worthIt: 1 junk item is NOT worth the trek')
  eq(gravePolicy.graveWorthIt(bulk), true, 'worthIt: a genuine bulk pile (>=10) qualifies')
  eq(gravePolicy.graveWorthIt(wood), true, 'worthIt: FIX #16 build materials (8 logs) qualify')
  // value ordering drives bestGrave's sort
  eq(gravePolicy.graveValue(gear1) > gravePolicy.graveValue(junk), true, 'value: gear outranks junk')

  // urgency is inert unless a despawn clock is configured (fail-safe)
  const saved = process.env.GRAVE_DESPAWN_S
  delete process.env.GRAVE_DESPAWN_S
  eq(gravePolicy.graveUrgency({ at: Date.now() - 60000 }, Date.now()).tier, 'safe', 'urgency: no clock configured -> always safe')
  process.env.GRAVE_DESPAWN_S = '600' // 10 min window
  const now = Date.now()
  eq(gravePolicy.graveUrgency({ at: now - 30000 }, now).tier, 'safe', 'urgency: 30s into a 600s window -> safe')
  eq(gravePolicy.graveUrgency({ at: now - 560000 }, now).tier, 'critical', 'urgency: 40s left of a 600s window -> critical')
  eq(gravePolicy.graveUrgency({ at: now - 950000 }, now).tier, 'expired', 'urgency: past 1.5x the window -> expired')
  if (saved != null) process.env.GRAVE_DESPAWN_S = saved; else delete process.env.GRAVE_DESPAWN_S
}

// ---- grave-policy: the loot verdict rungs --------------------------------------------------
{
  const V = gravePolicy.graveLootVerdict
  eq(V({ gotNotable: false }).mark, false, 'loot: nothing notable recovered -> never mark done')
  eq(V({ gotNotable: true, sawWindow: true, gained: 5, emptied: true, gravePresent: false }).kind, 'full', 'loot: emptied + grave gone -> full')
  eq(V({ gotNotable: true, sawWindow: true, gained: 5, emptied: false, freeSlots: 0 }).kind, 'capacity', 'loot: pack full -> capacity stop, not a write-off')
  eq(V({ gotNotable: true, sawWindow: true, gained: 5, emptied: false, freeSlots: 4, remaining: [{ name: 'iron_ingot', count: 1 }] }).mark, false,
    'loot: gear left behind is NEVER written off')
  eq(V({ gotNotable: true, sawWindow: true, gained: 5, emptied: false, freeSlots: 4, exhausted: true, remaining: [{ name: 'dirt', count: 2 }] }).kind, 'writeoff-junk',
    'loot: retries exhausted + only junk left -> bounded write-off')
}

// ---- gear: the picks -----------------------------------------------------------------------
{
  const bot = { inventory: { items: () => [{ name: 'wooden_pickaxe' }, { name: 'iron_pickaxe' }, { name: 'stone_axe' }] } }
  eq(gear.bestTool(bot, 'stone').name, 'iron_pickaxe', 'bestTool: stone -> best pickaxe carried')
  eq(gear.bestTool(bot, 'oak_log').name, 'stone_axe', 'bestTool: log -> axe')
  eq(gear.bestTool(bot, 'white_wool'), null, 'bestTool: no tool kind applies -> null')
  eq(gear.armorSlot('iron_boots'), 'feet', 'armorSlot: boots -> feet')
  eq(gear.armorSlot('elytra'), 'torso', 'armorSlot: elytra -> torso')
  eq(gear.armorSlot('bread'), null, 'armorSlot: non-armor -> null')
  eq(gear.armorRank('diamond_helmet') > gear.armorRank('iron_helmet'), true, 'armorRank: diamond outranks iron')
  eq(gear.armorRank('carved_pumpkin'), 0, 'armorRank: non-standard piece ranks 0 (never a downgrade target)')
  eq(gear.bestArmor([{ name: 'leather_helmet' }, { name: 'diamond_helmet' }]).name, 'diamond_helmet', 'bestArmor: strongest material wins')
}

// ---- op-build: the legacy operator primitives ----------------------------------------------
{
  const sent = []
  const bot = { chat: s => sent.push(s), entity: { position: { x: 10.9, y: 64, z: 20.2 }, yaw: 0 }, players: {}, username: 'Claudebot' }
  eq(JSON.stringify(opBuild.blockPos(bot)), JSON.stringify({ x: 10, y: 64, z: 20 }), 'blockPos: floors the entity position')
  eq(JSON.stringify(opBuild.anchorInFront(bot, 3)), JSON.stringify({ x: 10, y: 64, z: 23 }), 'anchorInFront: yaw 0 -> +z, 3 blocks out')
  opBuild.buildWall(bot, 'stone', 3, 2, { x: 0, y: 64, z: 0 })
  eq(sent[0], '/fill 0 64 0 2 65 0 stone', 'buildWall: emits the expected /fill span')
  eq(opBuild.normName('.PlayerName'), 'playername', 'normName: strips the Floodgate prefix + lowercases')
  eq(opBuild.findPlayer(bot, 'Claudebot'), null, 'findPlayer: never targets itself')
}

// ---- perception: observation over a stub world ----------------------------------------------
{
  eq(perception.facing(0), 'south', 'facing: yaw 0 -> south')
  eq(perception.facing(Math.PI), 'north', 'facing: yaw PI -> north')
  eq(perception.HOSTILE.test('creeper'), true, 'HOSTILE: matches a creeper')
  eq(perception.HOSTILE.test('Zombie'), true, 'HOSTILE: case-insensitive')
  eq(perception.HOSTILE.test('cow'), false, 'HOSTILE: a cow is not hostile')
  eq(perception.isWaterlogged({ name: 'water' }), true, 'isWaterlogged: plain water')
  eq(perception.isWaterlogged({ name: 'kelp' }), true, 'isWaterlogged: kelp only grows submerged')
  eq(perception.isWaterlogged({ name: 'oak_stairs', getProperties: () => ({ waterlogged: 'true' }) }), true, 'isWaterlogged: waterlogged stairs (string prop)')
  eq(perception.isWaterlogged({ name: 'stone' }), false, 'isWaterlogged: dry stone')
  eq(perception.isWaterlogged(null), false, 'isWaterlogged: missing block is not water')

  // nearestThreat must ignore passive mobs and respect maxDist
  const at = (x, z, name, type) => ({ name, type: type || 'mob', position: { x, y: 64, z, distanceTo (o) { return Math.hypot(this.x - o.x, this.z - o.z) } } })
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, entities: { 1: at(3, 0, 'cow'), 2: at(5, 0, 'zombie'), 3: at(40, 0, 'creeper') } }
  const t = perception.nearestThreat(bot, 16)
  eq(t && t.type, 'zombie', 'nearestThreat: picks the hostile, not the closer cow')
  eq(t && t.flee, false, 'nearestThreat: a zombie is not a flee-on-sight target')
  eq(perception.nearestThreat({ entity: { position: { x: 0, y: 64, z: 0 } }, entities: { 1: at(3, 0, 'cow') } }, 16), null, 'nearestThreat: passive-only -> null')
}

// ---- telemetry: the progress latch, outcome ring and stuck detector ------------------------
{
  const telemetry = require('./telemetry.js')
  telemetry._resetProgress()
  eq(telemetry.progressInfo().by, 'reset', 'telemetry: _resetProgress stamps the reason')
  eq(telemetry.progressInfo().workCount, 0, 'telemetry: reset zeroes workCount')

  // only WORK tags bump workCount - movement and dispatch must not
  telemetry.touchProgress('moved8b')
  eq(telemetry.progressInfo().workCount, 0, 'telemetry: movement is progress but NOT work')
  telemetry.touchProgress('placed')
  eq(telemetry.progressInfo().workCount, 1, 'telemetry: a placed block IS work')
  telemetry.touchProgress('begin:gather')
  eq(telemetry.progressInfo().workCount, 1, 'telemetry: a fresh dispatch is not work')

  // stalled is set by the nudge and cleared by ANY touch
  telemetry.markStalled()
  eq(telemetry.progressInfo().stalled, true, 'telemetry: markStalled latches')
  telemetry.touchProgress('regen')
  eq(telemetry.progressInfo().stalled, false, 'telemetry: any touch clears stalled')

  // failClass strips coords so repeats of the same failure match
  eq(telemetry.cycleFailClass('door at 433,62,112'), 'door at #,#,#', 'telemetry: failClass strips coordinates')
  eq(telemetry.cycleFailClass('Door  At  433'), 'door at #', 'telemetry: failClass lowercases + collapses whitespace')

  // activity lifecycle
  telemetry.beginActivity('gather', 'oak_log')
  const a = telemetry.activityInfo()
  eq(a && a.name, 'gather', 'telemetry: activityInfo reports the running op')
  eq(a && a.detail, 'oak_log', 'telemetry: activityInfo carries the detail')
  telemetry.endActivity(true, 'done')
  eq(telemetry.activityInfo(), null, 'telemetry: endActivity clears the activity')

  // the outcome ring is bounded
  for (let i = 0; i < 25; i++) telemetry.recordOutcome('op' + i, false, 'failed at ' + i)
  eq(telemetry.recentOutcomes().length, 16, 'telemetry: outcome ring is capped at 16')
}

// ---- grave: the abortLongOp contract the split introduced ----------------------------------
{
  // Isolate the ledger file - this test must never touch the live last-death.json.
  const os = require('os')
  const isolated = path.join(os.tmpdir(), 'splitmodules-death-' + process.pid + '.json')
  const savedEnv = process.env.DEATH_FILE
  process.env.DEATH_FILE = isolated
  delete require.cache[require.resolve('./grave.js')]
  const grave = require('./grave.js')
  const telemetry = require('./telemetry.js')

  telemetry.endActivity(true, 'clear') // ensure no activity is running
  eq(grave.recordDeath({ x: 1, y: 64, z: 1, at: Date.now() }).abortLongOp, false,
    'grave: no activity running -> nothing to abort')

  telemetry.beginActivity('gather', 'iron_ore')
  eq(grave.recordDeath({ x: 2, y: 64, z: 2, at: Date.now() }).abortLongOp, true,
    'grave: a death during gather aborts the long op')

  telemetry.endActivity(true, 'done')
  telemetry.beginActivity('build', 'hut')
  eq(grave.recordDeath({ x: 3, y: 64, z: 3, at: Date.now() }).abortLongOp, false,
    'grave: a death during BUILD does not abort (resume handles it)')
  telemetry.endActivity(true, 'done')

  // gravesSnapshot over an injected fixture (the offline seam)
  const now = Date.now()
  const snap = grave.gravesSnapshot({
    pos: { x: 0, y: 64, z: 0 },
    home: null,
    now,
    ledger: [{ x: 30, y: 64, z: 40, at: now - 1000, items: { count: 2, notable: ['iron_pickaxe'] } }]
  })
  eq(snap.graves.length, 1, 'grave: snapshot includes a worthwhile grave')
  eq(snap.graves[0].hasGear, true, 'grave: snapshot flags real gear')
  eq(Math.round(snap.graves[0].dist), 50, 'grave: snapshot dist is XZ hypot (30,40 -> 50)')
  eq(snap.deathsRecent, 1, 'grave: deathsRecent counts recent deaths')

  try { fs.unlinkSync(isolated) } catch {}
  if (savedEnv != null) process.env.DEATH_FILE = savedEnv; else delete process.env.DEATH_FILE
}

// ---- resume-store: the pure timing + disposition rules -------------------------------------
{
  const rs = require('./resume-store.js')
  eq(rs.finishDisposition(undefined), 'keep', 'resume: a throw never deletes the saved job')
  eq(rs.finishDisposition({ deferred: true }), 'keep', 'resume: deferred keeps the job')
  eq(rs.finishDisposition({ stopped: true }), 'keep', 'resume: aborted is not finished')
  eq(rs.finishDisposition({ skipped: 3 }), 'pause', 'resume: shortfall pauses rather than clears')
  eq(rs.finishDisposition({ skipped: 0 }), 'clear', 'resume: a genuine finish clears')

  const now = Date.now()
  eq(rs.resumeHoldRemaining(null, now), 0, 'resume: no saved file -> fail OPEN (resume now)')
  eq(rs.resumeHoldRemaining({}, now), 0, 'resume: no pausedAt -> fail OPEN')
  eq(rs.resumeHoldRemaining({ pausedAt: 'nonsense' }, now), 0, 'resume: malformed pausedAt -> fail OPEN')
  eq(rs.resumeHoldRemaining({ pausedAt: now - 1000, pauseHoldMs: 60000 }, now), 59000, 'resume: per-pause hold honoured')
  eq(rs.resumeHoldRemaining({ pausedAt: now - 99999999, pauseHoldMs: 1000 }, now), 0, 'resume: an expired hold is over')
}

// ---- the split's own contract: commands.js still re-exports, and by IDENTITY ---------------
{
  const moved = {
    shouldChaseGrave: gravePolicy, graveLootVerdict: gravePolicy, graveUrgency: gravePolicy, graveCompare: gravePolicy
  }
  for (const [name, mod] of Object.entries(moved)) {
    eq(typeof commands[name], 'function', `re-export: commands.${name} is still callable`)
    eq(commands[name] === mod[name], true, `re-export: commands.${name} IS the module's function (not a drifting copy)`)
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
