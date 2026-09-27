'use strict'
// bot2 - the lean runtime. Connection + body fixes, then three layers:
//   reflex.js   (200ms) survival - owns the body whenever it is in danger
//   director.js (loop)  one task at a time, chosen from the live world
//   skills             move / act / craft / gather / mining / smelt / food / shelter / base / build
const fs = require('fs')
const path = require('path')

const BOT_DIR = path.join(__dirname, '..', 'bot')
// share the old runtime's installed packages
module.paths.unshift(path.join(BOT_DIR, 'node_modules'))
process.env.NODE_PATH = [path.join(BOT_DIR, 'node_modules'), process.env.NODE_PATH || ''].join(path.delimiter)
require('module').Module._initPaths()

const { log } = require('./lib/log')
process.on('uncaughtException', e => { log('crash', 'uncaught: ' + (e.stack || e.message)); })
process.on('unhandledRejection', e => { log('crash', 'unhandled rejection: ' + (e && (e.stack || e.message))) })

// Paper 1.21.11 build 116+ collision fix: must patch before physics is created
try { const cm = require(path.join(BOT_DIR, 'collision-margin.js')).install(); log('boot', 'collision margin ' + JSON.stringify(cm)) } catch (e) { log('boot', 'collision margin failed: ' + e.message) }

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')

let cfg = {}
try { cfg = JSON.parse(fs.readFileSync(path.join(BOT_DIR, 'config.json'), 'utf8')) } catch {}
const host = process.env.MC_HOST || cfg.host || 'localhost'
const port = parseInt(process.env.MC_PORT || cfg.port || 25565, 10)
const username = process.env.MC_USERNAME || cfg.username || 'bot2'
const auth = process.env.MC_AUTH || cfg.auth || 'offline'
const version = process.env.MC_VERSION || cfg.version || '1.21.11'
const controlPort = parseInt(process.env.CONTROL_PORT || cfg.controlPort || 3001, 10)
const controlHost = process.env.CONTROL_HOST || cfg.controlHost || '127.0.0.1'
// Names compared EXACTLY (lowercase): the operator's Bedrock account comes through Geyser/Floodgate as ".Digital3093" and is
// listed as such in config.json - stripping the prefix instead let any Bedrock player whose gamertag matched the Java
// name be the operator ('!' commands included), since a Java name cannot hold a '.' (the audit, 2026-09-27)
const opName = s => String(s || '').toLowerCase()
const operators = (cfg.operators || []).map(opName)

log('boot', `bot2 connecting to ${host}:${port} as ${username} (${auth}, ${version})`)
const bot = mineflayer.createBot({ host, port, username, auth, version, disableChatSigning: true, checkTimeoutInterval: 60000 })
bot.loadPlugin(pathfinder)

const body = require(path.join(BOT_DIR, 'body.js'))
try { body.setNoteSink && body.setNoteSink(m => log('body', m)); body.install(bot) } catch (e) { log('boot', 'body.install failed: ' + e.message) }
// PINNED for good: the server moves us back every tick (body.pinned) because the client's copy of the world there
// is wrong - 2026-09-23 a glass pane connected to its new log neighbour round the bot's hitbox and the server
// corrected it 0.06b a tick for ten minutes; every walk out failed, a relog (fresh chunks) walked out in seconds.
// A player relogs: after 30s of unbroken pinning we do too (the supervisor restarts the process).
// (the server's corrections come in bursts ~3s apart: a pin is over only after 5s with none - reset on the first free
//  second, the 30s clock never ran out and a bot in its night bunker was held for 30 minutes, 2026-09-24)
let pinnedSince = 0
let freeSince = 0
setInterval(() => {
  try {
    // in a boat the physics is off by design (mineflayer stops it on mount; lib/boat.js drives the boat): no
    // physicsTick there is not paralysis, and body.js's "re-arm" (a dismount) would tip us out mid-crossing
    if (bot.vehicle && require('./lib/boat').inBoat(bot)) return
    body.check(bot)
    const pinned = body.pinned && body.pinned()
    if (!pinned) {
      if (!freeSince) freeSince = Date.now()
      if (Date.now() - freeSince > 5000) pinnedSince = 0
      return
    }
    freeSince = 0
    if (!pinnedSince) pinnedSince = Date.now()
    if (Date.now() - pinnedSince > 30000) { log('body', `pinned by the server for ${Math.round((Date.now() - pinnedSince) / 1000)}s at ${bot.entity && bot.entity.position.floored()} - relogging to fetch the world fresh`); pinnedSince = 0; bot.quit('pinned - relog') }
  } catch {}
}, 1000).unref()

const reflex = require('./lib/reflex')
const move = require('./lib/move')
const director = require('./lib/director')
const graves = require('./lib/graves')
const mem = require('./lib/memory')
const world = require('./lib/world')
move.bindReflex(reflex)
move.bindBot(bot)

const brainSettings = { model: process.env.LLM_MODEL || 'gemma4:12b', goal: 'Build the castle and stay alive.', enabled: true }
let pov = null
try { pov = require(path.join(BOT_DIR, 'pov.js')) } catch {}

// chat: operators can use "!" commands; everything is logged
// CONVERSATION (the old runtime's own pieces, dropped in the bot2 rewrite - its "pending" was a stub returning [], so the
// brain never saw a word a player said and only ever spoke unprompted, 2026-09-27): a message that names the bot (or an
// alias) is held for the brain for a few of its turns; its say (or any answer) marks it answered.
const access = require(path.join(BOT_DIR, 'access.js'))
const chatGate = require(path.join(BOT_DIR, 'chat-gate.js'))
// (the operator is always heard only when nobody else is on: with other players about, "im not talking to you" and
//  "when are we doing the ender dragon" - talk meant for them - each got a reply; the operator's call, 2026-09-27)
// (the whole tab list, deliberately - any player online anywhere is "someone else about", not a distance test)
const aloneWith = who => Object.keys(bot.players || {}).filter(n => n !== bot.username && n !== who).length === 0
let lastBotChatAt = 0 // (when the bot last spoke in chat: a reply to it within a minute is part of the conversation)
const chatLog = []
const chat = {
  pending: (brainPoll) => { const p = chatGate.pendingChat(); if (brainPoll) p.forEach(c => { c.deliveries++ }); return p.map(c => ({ from: c.from, text: c.text })) },
  answered: () => chatGate.clearPendingChat(),
  tail: () => chatLog.slice(-40)
}

let commands = null
let started = false

// THE SUPPORT GUARD: no dig - whoever asks, the builder, the pathfinder breaking its way, a reflex - takes out the block
// holding the bot up over a fall that hurts. act.dig's own check held, and the bot still fell 31 blocks twice off the
// floating north end of the Notre-Dame plaza with the dirt under its feet dug (2026-09-24): the one place every dig
// passes through is bot.dig. The last dig (where, and who asked) is kept for the death log.
let lastDig = null
function installSupportGuard () {
  const act = require('./lib/act')
  const world = require('./lib/world')
  const orig = bot.dig.bind(bot)
  bot.dig = async (block, ...rest) => {
    const caller = (new Error().stack || '').split('\n').slice(2, 5).map(s => s.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' <- ')
    if (block && block.position && bot.entity && act.holdsUsUp(bot, block.position)) {
      const fall = act.fallBelow(bot, block.position)
      if (fall > world.SAFE_DROP) {
        log('act', `refused to dig ${block.name} at ${move.fmt(block.position)}: it holds me up over a ${fall}-block drop (asked by ${caller})`)
        throw new Error('support guard: that block holds me up over a drop')
      }
    }
    lastDig = { at: Date.now(), name: block && block.name, pos: block && block.position && move.fmt(block.position), caller }
    return orig(block, ...rest)
  }
  bot.on('death', () => { if (lastDig && Date.now() - lastDig.at < 15000) log('death', `last dig ${Math.round((Date.now() - lastDig.at) / 100) / 10}s before: ${lastDig.name} at ${lastDig.pos} (asked by ${lastDig.caller})`) })
}

function installDigGuard () {
  // mineflayer's digTime assumes enchants is an array; 1.21 tools break it
  // and prismarine-block reads the tool speed from block.material, which for ores in 1.21 names no
  // tool ("incorrect_for_wooden_tool"): a stone pickaxe on iron ore was timed bare-handed x5 = 22.5s.
  // Vanilla's formula, with the tool judged by the harvest-tool list.
  const TIER_SPEED = { wooden: 2, stone: 4, copper: 5, iron: 6, diamond: 8, netherite: 9, golden: 12 }
  const inv = require('./lib/inventory')
  bot.digTime = function (block) {
    if (bot.game.gameMode === 'creative') return 0
    const held = bot.heldItem
    const hardness = block.hardness
    if (hardness == null || hardness < 0) return Infinity
    if (hardness === 0) return 0
    const kind = inv.toolKindFor(block)
    let speed = 1
    const m = held && held.name.match(/^([a-z]+)_(pickaxe|axe|shovel|hoe|sword)$/)
    if (m && ((kind && m[2] === kind) || (block.harvestTools && block.harvestTools[held.type]))) speed = TIER_SPEED[m[1]] || 1
    if (held && held.name === 'shears' && /_leaves$|cobweb|wool/.test(block.name)) speed = /cobweb/.test(block.name) ? 15 : /wool/.test(block.name) ? 5 : 15
    const canHarvest = !block.harvestTools || (held && block.harvestTools[held.type])
    let t = hardness * (canHarvest ? 1.5 : 5) / speed
    const eye = bot._getBlockAtEyeLevel && bot._getBlockAtEyeLevel()
    if (eye && /water/.test(eye.name)) t *= 5
    // off the ground: physics' onGround flickers on stairs/slab edges; a solid block right under
    // the feet counts as ground
    let grounded = bot.entity.onGround
    if (!grounded) {
      const p = bot.entity.position
      const under = bot.blockAt(p.offset(0, -0.05, 0))
      grounded = !!(under && under.boundingBox === 'block' && p.y - Math.floor(p.y) < 0.05)
    }
    if (!grounded) t *= 5
    return Math.ceil(t * 20) * 50
  }
}

// mineflayer's craft writes the result into slot 0 locally and grabs it at once; on Paper the
// server's result arrives a tick later, so the grab can click an empty slot and the item never
// exists server-side. Grab slot 0 of a crafting grid only after the SERVER has filled it.
function installCraftResultWait () {
  const orig = bot.putAway.bind(bot)
  bot.putAway = async (slot) => {
    const w = bot.currentWindow || bot.inventory
    const crafting = slot === 0 && (w === bot.inventory || /crafting/.test(String(w.type || '')))
    if (crafting) {
      await new Promise(resolve => {
        let done = false
        const fin = () => { if (!done) { done = true; clearTimeout(t); w.removeListener('updateSlot:0', fin); resolve() } }
        const t = setTimeout(fin, 1000)
        w.once('updateSlot:0', () => setTimeout(fin, 50))
      })
    }
    return orig(slot)
  }
}

bot.once('spawn', async () => {
  installDigGuard()
  installSupportGuard()
  // (installCraftResultWait is NOT installed: on 2x2 inventory crafts the server answers before
  // mineflayer listens, so waiting swallowed the update and every stick craft timed out. Crafts are
  // verified against the inventory in craft.js instead.)
  void installCraftResultWait
  bot.pathfinder.thinkTimeout = 8000
  bot.pathfinder.tickTimeout = 30
  log('boot', `spawned at ${move.fmt(bot.entity.position)} hp ${bot.health} food ${bot.food} tod ${world.tod(bot)} difficulty ${bot.game && bot.game.difficulty}`)
  if (started) return
  started = true
  reflex.install(bot)
  graves.install(bot)
  commands = require('./lib/commands').make(bot, director)
  require('./lib/api').start({ bot, port: controlPort, host: controlHost, director, commands, brainSettings, pov, chat })
  // wait for chunks around us before deciding anything
  try { await bot.waitForChunksToLoad() } catch {}
  await new Promise(r => setTimeout(r, 2000))
  // an operator stop survives restarts: the flag file is written by pause/stop, removed by resume
  if (fs.existsSync(path.join(__dirname, 'paused.flag'))) { director.setPaused(true); log('boot', 'starting paused (operator stop is in effect - "resume" to continue)') }
  director.start(bot)
})

bot.on('respawn', () => log('boot', 'respawned'))
bot.on('spawn', () => { if (started) log('boot', `spawn at ${bot.entity ? move.fmt(bot.entity.position) : '?'} hp ${bot.health}`) })
bot.on('death', () => { move.stopMoving(bot); try { require('./lib/control').abort() } catch {} }) // a death ends the task it interrupted (a mine task walked the respawn straight back to the mine face)
// a big hit says what it was: the trek lost 14 hp above y100 with nothing in the log to say how (2026-09-27)
let lastHp = null
bot.on('health', () => {
  const drop = lastHp == null ? 0 : lastHp - bot.health; lastHp = bot.health
  if (drop >= 4 && bot.entity) {
    const me = bot.entity.position
    const foe = Object.values(bot.entities).filter(e => e !== bot.entity && e.position && (e.type === 'hostile' || /zombie|skeleton|creeper|spider|drowned|husk|stray|witch|pillager/.test(e.name || ''))).map(e => ({ n: e.name, d: e.position.distanceTo(me) })).sort((a, b) => a.d - b.d)[0]
    log('vital', `hit for ${drop.toFixed(1)} -> hp ${Math.round(bot.health)} at ${Math.floor(me.x)},${Math.floor(me.y)},${Math.floor(me.z)}: onGround ${bot.entity.onGround}, vy ${bot.entity.velocity.y.toFixed(2)}, in water ${!!bot.entity.isInWater}, nearest hostile ${foe ? foe.n + ' ' + foe.d.toFixed(1) + 'b' : 'none'}`)
  }
  if (bot.health <= 6) log('vital', `hp ${Math.round(bot.health)} food ${bot.food}`)
})

bot.on('messagestr', (msg, position) => {
  if (position === 'game_info') return
  chatLog.push(msg); if (chatLog.length > 200) chatLog.shift()
  try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'bot2-chat.log'), `[${new Date().toISOString()}] ${msg}\n`) } catch {}
})
bot.on('chat', async (from, message) => {
  if (from === bot.username) { lastBotChatAt = Date.now(); return }
  if (!commands) return
  // heard: a message that names the bot; any word from the operator; and a reply within a minute of the bot's own
  // (a conversation carries on without the name every line - "why aren't you answering" was dropped, the audit)
  if (!/^!/.test(message) && (access.isAddressed(message, bot.username, cfg) || (operators.includes(opName(from)) && aloneWith(from)) || (Date.now() - lastBotChatAt < 60000 && from === chatGate.gazeState().player && Date.now() - chatGate.gazeState().at < 5 * 60000))) chatGate.recordChat(from, message) // (the continuation is the player it was talking WITH - not two others chatting after a bot line)
  if (!operators.includes(opName(from))) return
  if (!/^!/.test(message)) return
  const out = await commands.handle(message.slice(1), { source: 'operator' }).catch(e => 'error: ' + e.message)
  bot.chat(String(out).slice(0, 200))
})

bot.on('kicked', r => log('conn', 'kicked: ' + (typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 300)))
bot.on('error', e => log('conn', 'error: ' + e.message))
bot.on('end', r => { log('conn', 'disconnected: ' + r + ' - exiting so the supervisor restarts us'); setTimeout(() => process.exit(0), 1000) })

// event-loop lag: a stall here is a disconnect waiting to happen (keep-alives stop) - make it loud
// ...and say WHAT stalled it: the heavy synchronous calls, timed (an async one up to its first await - the part that
// holds the loop). Two 4.5s stalls in castle work named nothing but the task (2026-09-27)
;(function timeHeavy () {
  if (global.__timeHeavyOn) return; global.__timeHeavyOn = true // (once: a reload never wraps twice)
  const wrap = (mod, label, names, extra) => {
    for (const n of names) {
      const f = mod[n]; if (typeof f !== 'function') continue
      mod[n] = function (...a) { const t = Date.now(); try { return f.apply(this, a) } finally { const d = Date.now() - t; if (d > 300) log('lag', `slow ${label}.${n}: ${d}ms synchronous${extra ? extra() : ''}`) } }
    }
  }
  // the whole memory file is stringified and written synchronously on every change: its size says why it is slow
  try { const mem = require('./lib/memory'); wrap(mem, 'memory', ['set', 'update', 'save'], () => { try { return ` (memory ${Math.round(JSON.stringify(mem.get()).length / 1024)} KB)` } catch { return '' } }) } catch {}
  try { wrap(require('./lib/act'), 'act', ['place', 'dig']) } catch {}
  try { wrap(require('./lib/move'), 'move', ['movementsFor']) } catch {}
  // a major GC pause looks like a stall too: event-driven, free while nothing collects
  try { const { PerformanceObserver } = require('perf_hooks'); new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.duration > 200) log('lag', `GC pause ${Math.round(e.duration)}ms (kind ${e.detail ? e.detail.kind : e.kind})`) }).observe({ entryTypes: ['gc'] }) } catch {}
  try { wrap(require('./lib/build'), 'build', ['status', 'nextNeeds', 'obstructions', 'strayBuildBlocks', 'cellsDone', 'buildStep', 'clearSite', 'removeScaffold', 'setJob']) } catch {}
  try { wrap(require('./lib/materials'), 'materials', ['planFor', 'wantedSet', 'makeCrafts', 'unsourced']) } catch {}
  try { wrap(require('./lib/hut'), 'hut', ['status', 'shellComplete', 'buildHut']) } catch {}
  try { wrap(require('./lib/craft'), 'craft', ['chooseRecipe', 'ensure']) } catch {}
  try { wrap(require('./lib/world'), 'world', ['scanBlocks', 'findBlocks']) } catch {}
})()
// ...and when a stall runs past 1.5s, the stack it is caught in (stallwatch: a worker pauses us in the debugger)
let stallBeat = () => {}
try { stallBeat = require('./lib/stallwatch').start(1500, st => log('lag', `stalled in: ${st.join(' < ')}`)) } catch (e) { log('lag', 'stallwatch off: ' + e.message) }
let lagLast = Date.now()
setInterval(() => {
  stallBeat()
  const now = Date.now(); const lag = now - lagLast - 500
  if (lag > 2000) log('lag', `event loop stalled ${Math.round(lag / 100) / 10}s (director task: ${JSON.stringify(director.info())})`)
  lagLast = now
}, 500).unref()

// heartbeat for run.js's supervisor (same file/shape the old runtime wrote)
setInterval(() => {
  try {
    const p = bot.entity ? bot.entity.position : null
    const hb = { t: Date.now(), connected: !!bot.entity, pos: p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null, activity: null, hp: bot.health, food: bot.food, runtime: 'bot2' }
    fs.writeFileSync(path.join(BOT_DIR, 'heartbeat.json'), JSON.stringify(hb))
  } catch {}
}, 5000).unref()

void mem
