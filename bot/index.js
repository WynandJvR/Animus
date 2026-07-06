'use strict'
// The "body": connects to the Minecraft server and exposes a tiny local HTTP
// control API. Whatever drives the bot — Claude over curl, the local-model
// brain (brain-llm.js), or you by hand — all speak to the same API:
//
//   GET  /state           -> JSON world/self state
//   GET  /health          -> { ok: true }
//   POST /cmd  "<line>"    -> runs one command (see commands.js), returns text
//   GET  /log             -> recent in-game chat / events
//
// Nothing here is autonomous; the brain decides, the body acts.

const http = require('http')
const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const cfg = require('./config.json')
const commands = require('./commands.js')
const access = require('./access.js')

// short-term memory of chat addressed to the bot, surfaced in /state. Each
// message is offered for up to MAX_DELIVERIES ticks so the brain reliably gets a
// chance to respond (not dropped after one poll), yet bounded so it can't loop
// forever. A reply (say) clears all pending immediately.
const recentChat = []
// separate, noise-free record of ALL player chat (so it isn't flooded out of
// the main event log by the bot's own follow/scan commands). Seen via /chat.
const chatLog = []
function recordChatLog (line) { chatLog.push(line); if (chatLog.length > 40) chatLog.shift() }
const MAX_DELIVERIES = parseInt(process.env.CHAT_MAX_DELIVERIES || '6', 10)
let lastAddressedAt = 0 // when a player last addressed the bot (gates brain chatter)
let lastReplyAt = 0     // when the bot last spoke a reply
// gaze/attention state (see the gaze reflex below): who last spoke to us (eye
// contact while replying), and a window where a manual look/turn owns the head.
let gazeFocusPlayer = null
let gazeFocusAt = 0
let gazeSuppressUntil = 0
function noteManualLook (line) { // a deliberate look/turn should not be overridden by gaze
  if (/^(look|turn|lookbehind)\b/i.test(String(line).trim())) gazeSuppressUntil = Date.now() + 6000
}
function recordChat (from, text) {
  recentChat.push({ from, text, ts: Date.now(), deliveries: 0 })
  if (recentChat.length > 6) recentChat.shift()
  lastAddressedAt = Date.now()
  gazeFocusPlayer = from; gazeFocusAt = Date.now() // look at whoever just addressed us
}
function clearPendingChat () { recentChat.forEach(c => { c.deliveries = MAX_DELIVERIES }) }
// Outgoing-chat gate: a "say" is only actually sent if it isn't a duplicate and
// the cooldown elapsed — kills repeated/again-spam chat and server anti-spam
// kicks. Returns null to send, or a reason string to suppress.
// Brain chat comes in two kinds: a REPLY (a player addressed it since it last
// spoke) is always allowed; an UNPROMPTED quip ("vibe") is allowed at most once
// per VIBE_CHAT_MS so the bot feels alive without ever spamming itself into a
// kick. Set VIBE_CHAT_MS huge to restore the old hard-block on unprompted chat.
const CHAT_COOLDOWN_MS = parseInt(process.env.CHAT_COOLDOWN_MS || '2500', 10)
const VIBE_CHAT_MS = parseInt(process.env.VIBE_CHAT_MS || '90000', 10)
let lastSayAt = 0
let lastVibeAt = 0
function gateSay (line, fromBrain) {
  if (!/^say\b/i.test(String(line).trim())) return null // not a chat line — allow
  const now = Date.now()
  if (now - lastSayAt < CHAT_COOLDOWN_MS) return `cooldown ${CHAT_COOLDOWN_MS}ms`
  if (fromBrain && lastAddressedAt <= lastReplyAt) {
    // unprompted quip — budgeted, and it does NOT count as a reply (leaves
    // lastReplyAt/pending untouched so a real answer is still owed if asked)
    if (now - lastVibeAt < VIBE_CHAT_MS) return `vibe budget ${Math.ceil((VIBE_CHAT_MS - (now - lastVibeAt)) / 1000)}s`
    lastVibeAt = now; lastSayAt = now
    return null
  }
  lastSayAt = now; lastReplyAt = now
  clearPendingChat() // a reply resolves the pending request(s)
  return null
}

// Block spamming the same world-changing command — caps any single impactful
// command (give/build) to once per IMPACT_COOLDOWN_MS, so a fixated model can't
// dupe items or re-build the same thing on a loop. Returns a reason or null.
// World-edit/admin block list is shared from access.js so both bodies stay in sync.
const CHEAT_CMDS = access.CHEAT_CMDS
// Perception commands are PREPARATORY ("look first, then answer"): they don't
// resolve a player's request, so a pending message stays offered until the brain
// actually answers. Any OTHER command (follow/come/equip/say/...) IS the response,
// so it clears the pending request — stops one "follow me" from re-firing for
// every redelivery tick while still letting scan->say sequences complete.
const PREP_CMDS = /^(scan|find|entities|block|look|state|inventory)\b/i
const IMPACTFUL = /^(give|fill|setblock|clear|wall|tower|house|drop|toss)\b/i
const IMPACT_COOLDOWN_MS = parseInt(process.env.IMPACT_COOLDOWN_MS || '8000', 10)
let lastImpact = ''
let lastImpactAt = 0
function gateImpactful (line) {
  const l = String(line).trim()
  if (!IMPACTFUL.test(l)) return null
  const now = Date.now()
  if (l === lastImpact && now - lastImpactAt < IMPACT_COOLDOWN_MS) return `repeat blocked ${IMPACT_COOLDOWN_MS}ms`
  lastImpact = l; lastImpactAt = now
  return null
}

const log = []
function note (msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  log.push(line)
  if (log.length > 200) log.shift()
  console.log(line)
}

// Env overrides (so the same body can target the lab or a live server without
// editing config.json): MC_HOST / MC_PORT / MC_USERNAME / MC_AUTH / MC_VERSION.
// MC_VERSION=auto (or false) lets Mineflayer auto-detect the server version.
let version = process.env.MC_VERSION || cfg.version
if (version === 'auto' || version === 'false') version = false

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || cfg.host,
  port: parseInt(process.env.MC_PORT || cfg.port, 10),
  username: process.env.MC_USERNAME || cfg.username,
  auth: process.env.MC_AUTH || cfg.auth,
  version
})

bot.loadPlugin(pathfinder)

// DURABLE enchant-crash guard (replaces the fragile node_modules edit, see NOTES §4).
// mineflayer's digTime does `heldItem.enchants.concat(helmetEnchants)` and throws
// "enchantments.concat is not a function" on 1.21 enchanted tools when `enchants`
// isn't an array — crashing every dig while holding enchanted gear. A future
// `npm install` wipes the node_modules patch, so we re-apply it here by overriding
// bot.digTime (which bot.dig calls) with an Array.isArray-guarded version. Self-
// contained in the repo, so it can never be lost on reinstall.
function installDigTimeGuard (bot) {
  bot.digTime = function (block) {
    let type = null
    let enchantments = []
    const held = bot.heldItem
    if (held) {
      type = held.type
      enchantments = Array.isArray(held.enchants) ? held.enchants : []
    }
    const helmet = bot.inventory.slots[bot.getEquipmentDestSlot('head')]
    if (helmet) enchantments = enchantments.concat(Array.isArray(helmet.enchants) ? helmet.enchants : [])
    return block.digTime(
      type,
      bot.game.gameMode === 'creative',
      ['water', 'flowing_water'].includes(bot._getBlockAtEyeLevel()?.name),
      !bot.entity.onGround,
      enchantments,
      bot.entity.effects
    )
  }
}

bot.once('spawn', () => {
  commands.setupMovements(bot)
  installDigTimeGuard(bot)
  note(`spawned as ${bot.username} at ${bot.entity.position}`)
  // Do NOT change gamemode by default — just join and idle. The lab can opt in
  // to creative (for /fill building) with AUTO_CREATIVE=1 or config.autoCreative.
  if (process.env.AUTO_CREATIVE === '1' || cfg.autoCreative) bot.chat('/gamemode creative')
})

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  note(`<${username}> ${message}`)
  recordChatLog(`<${username}> ${message}`)
  // "!<command>" drives the bot — but only for allowlisted operators
  if (message.startsWith('!')) {
    if (!access.isOperator(username, cfg)) {
      note(`(denied) ${username} is not an operator`)
      recordChatLog(`   ^ DENIED: ${username} is not an operator`)
      return
    }
    const line = message.slice(1)
    const drop = gateSay(line, false) // operators speak freely
    if (drop) { note(`(chat-cmd) ${line} -> skipped (${drop})`); return }
    noteManualLook(line)
    commands.handle(bot, line)
      .then(r => note(`(chat-cmd) ${r}`))
      .catch(e => note(`(chat-cmd error) ${e.message}`))
  } else if (access.isAddressed(message, bot.username, cfg)) {
    // chat aimed at the bot — surface it so the brain can reply conversationally
    recordChat(username, message)
  }
})

bot.on('kicked', (reason) => note(`KICKED: ${reason}`))
bot.on('error', (err) => note(`ERROR: ${err.message}`))
bot.on('end', (reason) => note(`disconnected: ${reason}`))

// Self-preservation: eat automatically when hungry, independent of the brain,
// so the bot never starves on a survival server. Natural health regen resumes
// once food is high. Set AUTO_EAT=0 to disable.
let eating = false
if (process.env.AUTO_EAT !== '0') {
  setInterval(async () => {
    if (eating || !bot.entity || bot.food == null || bot.food > 17) return
    eating = true
    try {
      const r = await commands.eatFood(bot)
      if (!/not hungry|no food/.test(r)) note(`(auto-eat) ${r}`)
    } catch (e) { /* transient eat errors are fine; retry next tick */ } finally { eating = false }
  }, 4000)
}

// Anti-AFK: a small hop + arm swing periodically so the server doesn't kick the
// bot for inactivity while it's idle (e.g. between brain restarts). The brain
// keeps it busy when running; this just covers the gaps. Disable with ANTI_AFK=0.
if (process.env.ANTI_AFK !== '0') {
  setInterval(() => {
    if (!bot.entity) return
    try {
      bot.swingArm('right')
      bot.setControlState('jump', true)
      setTimeout(() => { try { bot.setControlState('jump', false) } catch {} }, 250)
    } catch { /* not spawned yet */ }
  }, 20000)
}

// Self-defense: swing at any hostile mob that gets close, independent of the
// brain — so the bot fights back when attacked. Disable with AUTO_DEFEND=0.
const HOSTILE_RE = /zombie|skeleton|spider|creeper|enderman|witch|husk|drowned|pillager|vindicator|ravager|slime|magma_cube|blaze|piglin|hoglin|phantom|zoglin|stray|silverfish|guardian|vex|wither|warden|ghast|shulker|illusioner|evoker|breeze|bogged/i
// never AUTO-melee these: creepers explode point-blank, ghast/warden/wither are ranged/deadly
const NO_AUTO_MELEE = /creeper|ghast|warden|wither_boss|^wither$/i
let defendEquipped = false
let lastDefendTarget = null
let lastFleeAt = 0
if (process.env.AUTO_DEFEND !== '0') {
  setInterval(() => {
    if (!bot.entity) return
    try {
      const me = bot.entity.position
      // FLEE from a nearby creeper instead of meleeing it (melee = it explodes).
      // Runs even mid-chop, overriding the current goal so the bot backs off.
      let creeper = null; let cbest = 6
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
        if (!/creeper/.test(e.name || '')) continue
        const d = e.position.distanceTo(me); if (d < cbest) { cbest = d; creeper = e }
      }
      if (creeper) {
        const now = Date.now()
        // throttle re-pathing so the retreat doesn't stutter (recompute every ~1.2s
        // or when it's a newly-spotted creeper)
        if (creeper !== lastDefendTarget || now - lastFleeAt > 1200) {
          const away = me.minus(creeper.position)
          const dest = me.plus(away.scaled(8 / (away.norm() || 1)))
          bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(dest.x), Math.floor(me.y), Math.floor(dest.z), 1))
          lastFleeAt = now
          if (creeper !== lastDefendTarget) note(`(flee) creeper ${cbest.toFixed(1)}m`)
          lastDefendTarget = creeper
        }
        return
      }
      let target = null; let best = 4 // only fight what's right next to us
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || e === bot.entity) continue
        if (e.type !== 'mob' && e.type !== 'hostile') continue // never players / animals / objects
        const name = e.name || ''
        if (!HOSTILE_RE.test(name) || NO_AUTO_MELEE.test(name)) continue
        const d = e.position.distanceTo(me); if (d < best) { best = d; target = e }
      }
      if (!target) { defendEquipped = false; lastDefendTarget = null; return }
      if (!defendEquipped) {
        const w = (bot.inventory ? bot.inventory.items() : []).find(i => i.name.endsWith('_sword'))
        if (w) { defendEquipped = true; bot.equip(w, 'hand').catch(() => {}) }
      }
      bot.lookAt(target.position.offset(0, 1, 0)).catch(() => {})
      bot.attack(target)
      if (target !== lastDefendTarget) { note(`(auto-defend) ${target.name}`); lastDefendTarget = target } // log on change only
    } catch { /* not ready */ }
  }, 700)
}

// Auto-collect: when idle (no active pathfinder goal) and a dropped item is close
// by, walk over and pick it up — so the bot tidies up after a chop/hunt without the
// brain micromanaging it. Skipped whenever it already has a goal (following / going
// somewhere) so it never yanks itself off-task. Disable with AUTO_COLLECT=0.
let collecting = false
if (process.env.AUTO_COLLECT !== '0') {
  setInterval(async () => {
    if (collecting || !bot.entity || !bot.pathfinder || bot.pathfinder.goal) return
    try {
      const me = bot.entity.position
      let best = null; let bestD = 8
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position) continue
        if (e.name !== 'item') continue // real drops only (the 'item' entity type)
        const d = e.position.distanceTo(me); if (d > 1.3 && d < bestD) { bestD = d; best = e }
      }
      if (!best) return
      collecting = true
      // range 0: actually walk ONTO the item's block — range 1 can count as "arrived"
      // a block short, so the bot never touches the drop and never picks it up.
      await bot.pathfinder.goto(new goals.GoalNear(best.position.x, best.position.y, best.position.z, 0))
    } catch { /* item vanished / unreachable — retry next tick */ } finally { collecting = false }
  }, 3000)
}

// Auto-torch (OPT-IN, default OFF — set AUTO_TORCH=1): a companion that lights the
// way at night. Deliberately conservative because it's an autonomous block-placer:
// only at night, only on natural ground (placeTorchNearby), throttled, and skipped
// if a torch/lantern is already close — so it never spams or decorates builds.
let lastTorchAt = 0
let _torchIds = null
function torchBlockIds (bot) {
  if (_torchIds) return _torchIds
  try {
    const md = require('minecraft-data')(bot.version)
    const ids = Object.values(md.blocksByName).filter(b => /torch|lantern/.test(b.name)).map(b => b.id)
    if (ids.length) _torchIds = ids // cache only on success; leave null to retry if mcData wasn't ready
    return ids
  } catch { return [] } // don't cache a failure — a permanently-empty list would disable the dedup guard
}
const AUTO_TORCH_MS = parseInt(process.env.AUTO_TORCH_MS || '8000', 10)
if (process.env.AUTO_TORCH === '1') {
  setInterval(async () => {
    if (!bot.entity || !bot.time || bot.time.timeOfDay < 13000) return // daytime — skip
    if (Date.now() - lastTorchAt < AUTO_TORCH_MS) return
    try {
      const ids = torchBlockIds(bot)
      if (ids.length && bot.findBlock({ matching: ids, maxDistance: 6 })) return // already lit nearby
      const r = await commands.placeTorchNearby(bot)
      if (/placed torch/.test(r)) { lastTorchAt = Date.now(); note(`(auto-torch) ${r}`) }
    } catch { /* not ready / placement raced — retry next tick */ }
  }, 3000)
}

// Gaze / attention reflex: make the bot's head behave like a real player's instead
// of staring into space. Priority each tick: (1) face an attacker just after being
// hurt, (2) yield to auto-defend when a hostile is in melee range, (3) make eye
// contact with whoever just spoke to us, (4) otherwise watch the nearest player or
// glance at nearby motion. While walking, the pathfinder already aims the head
// toward travel, so we yield to it. A manual look/turn also owns the head briefly.
// LLM-free and smooth (lookAt force=false tracks targets without snapping). GAZE=0 off.
let lastHealth = null
let lastHurtAt = 0
bot.on('health', () => {
  if (lastHealth != null && bot.health < lastHealth) lastHurtAt = Date.now()
  lastHealth = bot.health
})
function gazeNearest (pred, maxDist) {
  if (!bot.entity) return null
  const me = bot.entity.position
  let best = null; let bestD = maxDist
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e === bot.entity) continue
    if (!pred(e)) continue
    const d = e.position.distanceTo(me); if (d < bestD) { bestD = d; best = e }
  }
  return best
}
const gazeIsHostile = e => (e.type === 'mob' || e.type === 'hostile') && HOSTILE_RE.test(e.name || '')
const gazeMoving = e => e.velocity && (Math.abs(e.velocity.x) + Math.abs(e.velocity.z)) > 0.03
function gazeLookAt (e) { bot.lookAt(e.position.offset(0, (e.height || 1.6) * 0.9, 0), false).catch(() => {}) }
if (process.env.GAZE !== '0') {
  setInterval(() => {
    if (!bot.entity) return
    try {
      if (Date.now() < gazeSuppressUntil) return            // a manual look/turn owns the head
      if (bot.pathfinder && bot.pathfinder.isMoving()) return // pathfinder aims toward travel
      const now = Date.now()
      // 1) just hurt -> face the attacker (a hostile at any range, or a close player)
      if (now - lastHurtAt < 2500) {
        const attacker = gazeNearest(gazeIsHostile, 16) || gazeNearest(e => e.type === 'player', 5)
        if (attacker) { gazeLookAt(attacker); return }
      }
      // 2) hostile in melee range -> auto-defend owns the head, don't fight it
      if (gazeNearest(gazeIsHostile, 4.5)) return
      // 3) someone just spoke to us -> eye contact while it's fresh
      if (gazeFocusPlayer && now - gazeFocusAt < 5000) {
        const p = bot.players[gazeFocusPlayer] && bot.players[gazeFocusPlayer].entity
        if (p) { gazeLookAt(p); return }
      }
      // 4) otherwise attend to the nearest player, or glance at nearby motion
      const focus = gazeNearest(e => e.type === 'player', 12) ||
                    gazeNearest(e => (e.type === 'mob' || e.type === 'animal') && gazeMoving(e), 10)
      if (focus) gazeLookAt(focus)
      // 5) nothing to attend to -> hold (no fidget)
    } catch { /* not ready */ }
  }, 500)
}

// Leash / stuck-recovery reflex: while FOLLOWING a player, if the bot stops making
// progress but the target is still far (e.g. the player climbed somewhere the bot
// can't path with canDig off), kick the pathfinder by re-issuing the follow goal.
// If it stays stuck, note it once and stop hammering — the dynamic follow will pick
// back up on its own once the target moves somewhere reachable. Off with LEASH=0.
let leashLastPos = null
let leashStuckSince = 0
let leashLastKick = 0
let leashGaveUp = null
if (process.env.LEASH !== '0') {
  setInterval(() => {
    if (!bot.entity || !bot.pathfinder) return
    try {
      const goal = bot.pathfinder.goal
      const target = goal && goal.entity // only entity-follows (not goto-to-coords)
      if (!target || !target.position) { leashLastPos = null; leashStuckSince = 0; leashGaveUp = null; return }
      const me = bot.entity.position
      const dist = target.position.distanceTo(me)
      if (dist <= 6) { leashLastPos = me.clone(); leashStuckSince = 0; leashGaveUp = null; return } // following fine
      const moved = leashLastPos ? me.distanceTo(leashLastPos) : Infinity
      leashLastPos = me.clone()
      if (moved > 0.6) { leashStuckSince = 0; leashGaveUp = null; return } // making progress toward them
      if (!leashStuckSince) { leashStuckSince = Date.now(); leashLastKick = 0; return } // just stalled — start the clock
      const stuck = Date.now() - leashStuckSince
      const who = target.username || target.name || 'target'
      if (stuck < 12000) {
        if (Date.now() - leashLastKick > 3000) { // re-path at most every ~3s
          const range = Math.max(1, Math.round(Math.sqrt(goal.rangeSq || 9)))
          bot.pathfinder.setGoal(new goals.GoalFollow(target, range), true)
          leashLastKick = Date.now()
          note(`(leash) re-pathing to ${who} (${dist.toFixed(0)}m, stuck ${(stuck / 1000).toFixed(0)}s)`)
        }
      } else if (leashGaveUp !== target) { // genuinely blocked -> note once, stop kicking
        note(`(leash) can't reach ${who} (${dist.toFixed(0)}m) — blocked, holding`)
        leashGaveUp = target
      }
    } catch { /* not ready */ }
  }, 1500)
}

// ---- control API -----------------------------------------------------------

function send (res, code, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' })
  res.end(payload)
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, spawned: !!bot.entity })
  if (req.method === 'GET' && req.url === '/state') {
    // guard like /cmd: the brain polls this constantly; a state-assembly throw
    // must never become an uncaught exception that kills the process
    try {
      const s = commands.state(bot)
      // Offer each addressed message to the brain up to MAX_DELIVERIES times so
      // it reliably gets a chance to act, but bounded so it can't loop forever.
      // Any fulfilling response clears it early (a say, or any non-PREP_CMDS command
      // via /cmd -> clearPendingChat); a PREPARATORY perception command keeps it
      // offered so a "look first, then answer" sequence can still complete.
      const pending = recentChat.filter(c => c.deliveries < MAX_DELIVERIES)
      s.unanswered = pending.map(c => ({ from: c.from, text: c.text }))
      pending.forEach(c => { c.deliveries++ })
      return send(res, 200, s)
    } catch (e) { return send(res, 500, `error: ${e.message}`) }
  }
  if (req.method === 'GET' && req.url === '/log') return send(res, 200, log.slice(-40).join('\n'))
  if (req.method === 'GET' && req.url === '/chat') return send(res, 200, chatLog.slice(-40).join('\n'))
  if (req.method === 'POST' && req.url === '/cmd') {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', async () => {
      let line = data
      try { const j = JSON.parse(data); if (j && typeof j.command === 'string') line = j.command } catch {}
      // BRAIN CONFINEMENT: block world-editing/admin commands on the API path so
      // the autonomous brain can't grief or dupe. Operators use in-game !commands.
      if (process.env.BRAIN_ALLOW_CHEATS !== '1' && CHEAT_CMDS.test(String(line).trim())) {
        note(`(cmd) ${line} -> BLOCKED (world-edit/admin is operator-only)`)
        return send(res, 200, 'blocked: world-editing/admin commands are operator-only')
      }
      const drop = gateSay(line, true) || gateImpactful(line) // brain: gated chat + repeat-guard
      if (drop) { note(`(cmd) ${line} -> skipped (${drop})`); return send(res, 200, `skipped: ${drop}`) }
      noteManualLook(line)
      try {
        const result = await commands.handle(bot, line)
        // A non-perception command is the brain's response to any waiting player,
        // so consider the request answered (perception commands keep it pending).
        if (!PREP_CMDS.test(String(line).trim())) clearPendingChat()
        note(`(cmd) ${line} -> ${result.split('\n')[0]}`)
        send(res, 200, result)
      } catch (e) {
        note(`(cmd error) ${line} -> ${e.message}`)
        send(res, 500, `error: ${e.message}`)
      }
    })
    return
  }
  send(res, 404, 'not found')
})

server.listen(cfg.controlPort, cfg.controlHost, () => {
  note(`control API on http://${cfg.controlHost}:${cfg.controlPort}`)
})
