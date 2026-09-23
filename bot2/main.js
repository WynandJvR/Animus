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
const operators = (cfg.operators || []).map(s => s.toLowerCase())

log('boot', `bot2 connecting to ${host}:${port} as ${username} (${auth}, ${version})`)
const bot = mineflayer.createBot({ host, port, username, auth, version, disableChatSigning: true, checkTimeoutInterval: 60000 })
bot.loadPlugin(pathfinder)

const body = require(path.join(BOT_DIR, 'body.js'))
try { body.setNoteSink && body.setNoteSink(m => log('body', m)); body.install(bot) } catch (e) { log('boot', 'body.install failed: ' + e.message) }
// PINNED for good: the server moves us back every tick (body.pinned) because the client's copy of the world there
// is wrong - 2026-09-23 a glass pane connected to its new log neighbour round the bot's hitbox and the server
// corrected it 0.06b a tick for ten minutes; every walk out failed, a relog (fresh chunks) walked out in seconds.
// A player relogs: after 30s of unbroken pinning we do too (the supervisor restarts the process).
let pinnedSince = 0
setInterval(() => {
  try {
    body.check(bot)
    const pinned = body.pinned && body.pinned()
    if (!pinned) { pinnedSince = 0; return }
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
const chatLog = []
const chat = {
  pending: () => [],
  tail: () => chatLog.slice(-40)
}

let commands = null
let started = false

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
bot.on('health', () => { if (bot.health <= 6) log('vital', `hp ${Math.round(bot.health)} food ${bot.food}`) })

bot.on('messagestr', (msg, position) => {
  if (position === 'game_info') return
  chatLog.push(msg); if (chatLog.length > 200) chatLog.shift()
  try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'bot2-chat.log'), `[${new Date().toISOString()}] ${msg}\n`) } catch {}
})
bot.on('chat', async (from, message) => {
  if (!commands || from === bot.username) return
  if (!operators.includes(String(from).toLowerCase())) return
  if (!/^!/.test(message)) return
  const out = await commands.handle(message.slice(1), { source: 'operator' }).catch(e => 'error: ' + e.message)
  bot.chat(String(out).slice(0, 200))
})

bot.on('kicked', r => log('conn', 'kicked: ' + (typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 300)))
bot.on('error', e => log('conn', 'error: ' + e.message))
bot.on('end', r => { log('conn', 'disconnected: ' + r + ' - exiting so the supervisor restarts us'); setTimeout(() => process.exit(0), 1000) })

// event-loop lag: a stall here is a disconnect waiting to happen (keep-alives stop) - make it loud
let lagLast = Date.now()
setInterval(() => {
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
