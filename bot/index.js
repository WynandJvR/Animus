'use strict'
// The "body": connects to the Minecraft server and exposes a tiny local HTTP
// control API. Whatever drives the bot - Claude over curl, the local-model
// brain (brain-llm.js), or you by hand - all speak to the same API:
//
//   GET  /state           -> JSON world/self state
//   GET  /health          -> { ok: true }
//   POST /cmd  "<line>"    -> runs one command (see commands.js), returns text
//   GET  /log             -> recent in-game chat / events
//
// Nothing here is autonomous; the brain decides, the body acts.

const http = require('http')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
// config.json is UNTRACKED (it holds the real server address). Fresh clones get the
// sanitized example copied into place automatically on first run.
try { require('fs').accessSync(require('path').join(__dirname, 'config.json')) } catch { require('fs').copyFileSync(require('path').join(__dirname, 'config.example.json'), require('path').join(__dirname, 'config.json')) }
const cfg = require('./config.json')
const commands = require('./commands.js')
const provision = require('./provision.js') // for the body-side survival-hunt reflex
const resources = require('./resources.js') // unified pack+chest resource model (food withdraw)
const navigate = require('./navigate.js') // unified navigation (isRecovering gates the reflexes)
const arbiter = require('./arbiter.js') // priority body-ownership: reflexes defer to a running navigation maneuver
const access = require('./access.js')
const schematic = require('./schematic.js')

// Live brain settings the dashboard can change on the fly; brain-llm.js polls
// GET /brain each tick and switches model / goal / on-off without a restart.
const brainSettings = {
  model: process.env.LLM_MODEL || 'qwen3:14b',
  goal: process.env.GOAL || 'Stay near players, help when asked, and behave like a normal survival player.',
  enabled: true
}
// Cached `ollama list` so the UI can offer a model dropdown (refreshed periodically).
let ollamaModels = []
function refreshOllamaModels () {
  execFile('ollama', ['list'], { timeout: 5000 }, (err, stdout) => {
    if (err) return
    ollamaModels = stdout.split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean)
  })
}
refreshOllamaModels(); setInterval(refreshOllamaModels, 30000).unref?.()
// (The old browser dashboard is gone - the Animus GUI is the control surface now.
// It uses the same local API: /state, /log, /brain, /config, /op/cmd.)

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
// Resolve the OLDEST still-pending message - one fulfilling action answers one
// request. Clearing ALL of them dropped a second player's message unanswered when
// two people spoke in the same window; now each message gets its own turn.
function clearPendingChat () {
  const pending = recentChat.filter(c => c.deliveries < MAX_DELIVERIES)
  if (pending.length) pending[0].deliveries = MAX_DELIVERIES
}
// Outgoing-chat gate: a "say" is only actually sent if it isn't a duplicate and
// the cooldown elapsed - kills repeated/again-spam chat and server anti-spam
// kicks. Returns null to send, or a reason string to suppress.
// Brain chat comes in two kinds: a REPLY (a player addressed it since it last
// spoke) is always allowed; an UNPROMPTED quip ("vibe") is allowed at most once
// per VIBE_CHAT_MS so the bot feels alive without ever spamming itself into a
// kick. Set VIBE_CHAT_MS huge to restore the old hard-block on unprompted chat.
const CHAT_COOLDOWN_MS = parseInt(process.env.CHAT_COOLDOWN_MS || '2500', 10)
// Budget for UNPROMPTED quips (a direct reply is never throttled). 90s felt spammy,
// 150s STILL felt spammy on the live server ("i see a bunch of wolves..." every couple
// of minutes) - a real player idles quietly. One ambient line per ~10 min feels alive.
const VIBE_CHAT_MS = parseInt(process.env.VIBE_CHAT_MS || '600000', 10)
// The spam is characteristically NARRATION - announcing what it sees or that it's
// waiting. Those lines carry zero information for players; block the genre outright
// for unprompted chat (replies are never filtered - if you ASK what it sees, it answers).
const NARRATION_RE = /^(i (see|spot|notice|hear|found) |i'?m (still here|just|waiting|around|chilling)|just (waiting|hanging|chilling)|let me know if|anyone (need|want)|nothing (going on|happening)|all quiet)/i
let lastSayAt = 0
let lastVibeAt = 0
let lastBusyReplyAt = 0 // rate-limits the body's own "can't right now - busy" replies
// Content de-dupe. A fixated model re-emits near-identical lines ("why are there so
// many wolves here") every tick; the timing gates alone let one identical copy through
// each window, so players see the same message on repeat. Track the last few sent
// lines and suppress near-duplicates of UNPROMPTED chatter (a direct reply is never
// blocked, but is recorded so the next quip can't just echo it).
const RECENT_SAY_MAX = 10
const SAY_DUP_WINDOW_MS = parseInt(process.env.SAY_DUP_WINDOW_MS || '360000', 10)
const recentSaid = [] // { norm, at }
function normSay (line) {
  return String(line).replace(/^\s*say\b/i, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}
function tooSimilar (a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (a.length > 6 && (a.includes(b) || b.includes(a))) return true // one contains the other
  const A = new Set(a.split(' ')), B = new Set(b.split(' '))
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  const uni = new Set([...A, ...B]).size
  return uni > 0 && inter / uni >= 0.5 // Jaccard: mostly the same words (0.5 catches more rephrasings)
}
function isDupSay (norm) {
  const now = Date.now()
  for (const s of recentSaid) if (now - s.at < SAY_DUP_WINDOW_MS && tooSimilar(norm, s.norm)) return true
  return false
}
function recordSaid (norm) {
  if (!norm) return
  recentSaid.push({ norm, at: Date.now() })
  while (recentSaid.length > RECENT_SAY_MAX) recentSaid.shift()
}
function gateSay (line, fromBrain) {
  if (!/^say\b/i.test(String(line).trim())) return null // not a chat line - allow
  const now = Date.now()
  if (now - lastSayAt < CHAT_COOLDOWN_MS) return `cooldown ${CHAT_COOLDOWN_MS}ms`
  const norm = normSay(line)
  // Block near-duplicates of anything said recently - covers BOTH unprompted quips and
  // replies (the model kept answering different messages with the same sentence). Short
  // reactions ("lol", "ok bro") are exempt so natural interjections can still repeat.
  // A blocked reply does NOT clear the pending request, so the brain must answer again
  // with something new instead of parroting.
  const substantial = norm.split(' ').filter(Boolean).length >= 3
  if (substantial && isDupSay(norm)) return 'duplicate (already said that - say something new)'
  if (fromBrain && lastAddressedAt <= lastReplyAt) {
    // UNPROMPTED quip (nobody addressed it). This is the ONLY chatter we throttle -
    // replies below are always free so conversation feels natural. Stay SILENT while
    // busy working (building/gathering - it should focus, not narrate), and otherwise
    // only an occasional line per VIBE_CHAT_MS.
    if (commands.isBusy && commands.isBusy()) return 'busy - no idle chatter'
    if (NARRATION_RE.test(norm)) return 'narration - players can see the world themselves, say something worth saying or nothing'
    if (now - lastVibeAt < VIBE_CHAT_MS) return `vibe budget ${Math.ceil((VIBE_CHAT_MS - (now - lastVibeAt)) / 1000)}s`
    lastVibeAt = now; lastSayAt = now
    recordSaid(norm)
    return null
  }
  // a REPLY (someone addressed it) - always allowed, natural conversation
  lastSayAt = now; lastReplyAt = now
  clearPendingChat() // a reply resolves the pending request(s)
  recordSaid(norm)
  return null
}

// Block spamming the same world-changing command - caps any single impactful
// command (give/build) to once per IMPACT_COOLDOWN_MS, so a fixated model can't
// dupe items or re-build the same thing on a loop. Returns a reason or null.
// World-edit/admin block list is shared from access.js so both bodies stay in sync.
const CHEAT_CMDS = access.CHEAT_CMDS
// Perception commands are PREPARATORY ("look first, then answer"): they don't
// resolve a player's request, so a pending message stays offered until the brain
// actually answers. Any OTHER command (follow/come/equip/say/...) IS the response,
// so it clears the pending request - stops one "follow me" from re-firing for
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
// Persistent event log: the in-memory buffer dies on restart and the console dies
// with its window - for post-mortems everything also lands in logs/bot-events.log
// (rotated at ~5 MB so it can run for weeks). One file for body events, commands,
// build progress, deaths - the first place to look when asking "what happened?".
const EVENTS_LOG = process.env.EVENTS_LOG || path.join(__dirname, '..', 'logs', 'bot-events.log') // env-overridable so a test instance doesn't interleave into the live flight recorder
try { fs.mkdirSync(path.dirname(EVENTS_LOG), { recursive: true }) } catch {}
function fileLog (line) {
  try {
    try { if (fs.statSync(EVENTS_LOG).size > 5 * 1024 * 1024) fs.renameSync(EVENTS_LOG, EVENTS_LOG + '.old') } catch {}
    fs.appendFileSync(EVENTS_LOG, line + String.fromCharCode(10))
  } catch {}
}
function note (msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  log.push(line)
  if (log.length > 200) log.shift()
  console.log(line)
  fileLog(line)
}
commands.setLogger(note) // build/provision progress lands in /log (GUI live panel), not chat
// Debug traces ([prov]/[build]) always persist to the FILE (not the GUI ring buffer,
// which they'd flood) - no more relaunching with BUILD_DEBUG=1 to see what happened.
function noteDebug (msg) { fileLog(`[${new Date().toISOString()}] ${msg}`) }
commands.setDebugSink(noteDebug)
provision.setDebugSink(noteDebug)
resources.setDebugSink(noteDebug)
navigate.setDebugSink(noteDebug)
require('./pathfix.js').setDebugSink(noteDebug) // [verify] place/dig world-recheck traces
require('./scaffold.js').setDebugSink(noteDebug) // [scaffold] registry/teardown traces
require('./planner.js').setDebugSink(noteDebug) // [plan] re-planning goal-driver traces (rounds/strikes/relocates)
arbiter.setDebugSink(noteDebug) // [arb] maneuver begin/end/expire + reflex deferrals
// A build job saved to disk survived a process restart - let the operator know it's resumable.
try {
  const rj = commands.persistedResume && commands.persistedResume()
  if (rj) {
    note(`(resume) saved build found: "${rj.name}" at ${rj.at.x},${rj.at.y},${rj.at.z}`)
    // AUTO-RESUME on boot (AUTO_RESUME=0 to disable): a saved job means the last process
    // died/restarted mid-build - continue it unattended so the operator can walk away.
    if (process.env.AUTO_RESUME !== '0') {
      setTimeout(async () => {
        try {
          if (commands.isBusy && commands.isBusy()) return // something else already driving
          const r = await commands.handle(bot, 'resumebuild')
          note(`(resume) auto: ${String(r).split(String.fromCharCode(10))[0]}`)
        } catch (e) { note(`(resume) auto failed: ${e.message}`) }
      }, 25000) // let spawn/chunks settle first
    }
  }
} catch {}
// RE-ARM: the boot auto-resume is one-shot, and a resume whose travel retries all fail
// ends SILENTLY with the job still on disk - the bot then idles forever while the brain
// gets bored (verified live: 3 blocked travels at 19:09-19:14, then nothing for good).
// Every 2 minutes: saved job + idle bot + not resting = try the resume again. (Was 5 -
// with brain side-trips held while a job waits, a long idle gap has no upside.)
if (process.env.AUTO_RESUME !== '0') {
  setInterval(async () => {
    try {
      if (!bot.entity) return
      if (!(commands.persistedResume && commands.persistedResume())) return
      if (commands.isBusy && commands.isBusy()) return
      if (provision.isResting && provision.isResting()) return
      const r = await commands.handle(bot, 'resumebuild')
      note(`(resume) re-arm: ${String(r).split(String.fromCharCode(10))[0]}`)
    } catch (e) { note(`(resume) re-arm failed: ${e.message}`) }
  }, 120000).unref?.()
}

// Env overrides (so the same body can target the lab or a live server without
// editing config.json): MC_HOST / MC_PORT / MC_USERNAME / MC_AUTH / MC_VERSION.
// MC_VERSION=auto (or false) lets Mineflayer auto-detect the server version.
let version = process.env.MC_VERSION || cfg.version
if (version === 'auto' || version === 'false') version = false

const auth = process.env.MC_AUTH || cfg.auth
// If no username is set: for a Microsoft login the real account name is used
// anyway (mineflayer sets bot.username from the signed-in profile - the value
// here is just a token-cache label), so any stable label is fine. Offline mode
// has no account, so it needs a literal name; fall back to a placeholder.
let username = (process.env.MC_USERNAME || cfg.username || '').trim()
if (!username) username = auth === 'microsoft' ? 'Animus' : 'Player'

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || cfg.host,
  port: parseInt(process.env.MC_PORT || cfg.port, 10),
  username,
  auth,
  version,
  // Send chat UNSIGNED: the chatty persona kept getting kicked with
  // "chat_validation_failed" (signed-chat acknowledgement races in the protocol
  // layer). Paper accepts unsigned chat; the supervisor reconnected after each
  // kick but every kick dropped whatever the bot was doing mid-action.
  disableChatSigning: true
})

bot.loadPlugin(pathfinder)

// DURABLE enchant-crash guard (replaces the fragile node_modules edit, see NOTES §4).
// mineflayer's digTime does `heldItem.enchants.concat(helmetEnchants)` and throws
// "enchantments.concat is not a function" on 1.21 enchanted tools when `enchants`
// isn't an array - crashing every dig while holding enchanted gear. A future
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
  require('./pathfix.js').installPathfinderTuning(bot) // patch layer over the pathfinder (self-scaffold guard etc.)
  note(`spawned as ${bot.username} at ${bot.entity.position}`)
  // Do NOT change gamemode by default - just join and idle. The lab can opt in
  // to creative (for /fill building) with AUTO_CREATIVE=1 or config.autoCreative.
  if (process.env.AUTO_CREATIVE === '1' || cfg.autoCreative) bot.chat('/gamemode creative')
})

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  note(`<${username}> ${message}`)
  recordChatLog(`<${username}> ${message}`)
  // "!<command>" drives the bot - but only for allowlisted operators
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
    return
  }
  // Natural-language build: an OPERATOR can just SAY "can you build <name>" in
  // plain chat (no "!") and the bot loads that saved schematic and builds it -
  // same power as !schematic, without the command syntax. Operator-gated because
  // building edits the world (identical gate to the !schematic command). Checked
  // before isAddressed so the build request is acted on, not sent to the brain.
  const buildReq = access.parseBuildRequest(message, bot.username, cfg)
  if (buildReq) {
    if (!access.isOperator(username, cfg)) {
      note(`(build-req denied) ${username} is not an operator`)
      recordChatLog(`   ^ DENIED build: ${username} is not an operator`)
      return
    }
    startNaturalBuild(username, buildReq)
    return
  }
  if (access.isAddressed(message, bot.username, cfg)) {
    // A direct ORDER from an operator must be OBEYED deterministically - the brain used
    // to "decide" whether to comply and would argue back ("bro you're 27 blocks away...")
    // instead of stopping. Pull a recognized imperative out of the addressed message and
    // run it straight through the body, bypassing the brain entirely. `stop` above all -
    // it's the safety override the operator relies on.
    const direct = directCommand(message, username)
    if (direct && access.isOperator(username, cfg)) {
      note(`(direct-cmd) ${username}: "${message}" -> ${direct}`)
      commands.handle(bot, direct)
        .then(r => note(`(direct-cmd) ${r}`))
        .catch(e => note(`(direct-cmd error) ${e.message}`))
      recordChat(username, message) // still let the brain see it (so it can ack in chat)
      return
    }
    // chat aimed at the bot - surface it so the brain can reply conversationally
    recordChat(username, message)
  }
})

// Extract a deterministic command from a message an operator addressed to the bot, for
// orders the brain must never second-guess. Returns a command string for commands.handle
// or null. Deliberately conservative - only unambiguous imperatives, and never on a
// negation ("don't stop", "keep going").
function directCommand (message, username) {
  const m = String(message).toLowerCase()
  if (/\bdon'?t\s+stop\b|\bdo\s*n[o']?t\s+stop\b|\bkeep\s+going\b|\bnever\s+stop\b/.test(m)) return null
  if (/\b(stop|halt|freeze|abort|cancel|hold on|hold up|cut it out|knock it off|quit it|stand down|stop it|stop moving|stop building|wait|stay|stay there|stay put|hold position)\b/.test(m)) return 'stop'
  // A recognized OPERATOR ordering the bot around must be obeyed deterministically, not
  // argued with by the brain (operator: "IM TELLING IT SHIT WHY IS IT NOT LISTENING").
  if (username) {
    if (/\b(follow me|follow us|come with me|stick with me|stay with me)\b/.test(m)) return `follow ${username}`
    if (/\b(come here|come to me|get over here|over here|come to my|to me|get here|come)\b/.test(m)) return `goto ${username}`
    if (/\b(go home|head home|return home|back to base|go to base)\b/.test(m)) return 'goto home'
  }
  // OPERATOR POINTS IT AT A RESOURCE (fastest path to food when the operator can see it):
  // "there are animals at 335 63 47" / "hunt at 335 63 47" / "there's water at <x y z>" ->
  // trek there and hunt / record the water. Coords parsed like the travel command (space or
  // comma separated). Checked BEFORE the generic "get food" so a coord order wins.
  const coord = m.match(/(-?\d+)[ ,]+(-?\d+)[ ,]+(-?\d+)/)
  if (coord && !/\bdon'?t\b/.test(m)) {
    if (/\b(animals?|sheep|pigs?|cows?|chickens?|hunt|meat|food)\b/.test(m) && /\b(at|near|by|around)\b|@/.test(m)) return `huntat ${coord[1]} ${coord[2]} ${coord[3]}`
    if (/\b(water|river|pond|lake|farm)\b/.test(m) && /\b(at|near|by|around)\b|@/.test(m)) return `waterat ${coord[1]} ${coord[2]} ${coord[3]}`
  }
  // FOOD/CHEST instruction (the LLM understood "there's food in your chest" but had no lever
  // to pull - chest access was an autonomous reflex, not in the brain's vocabulary). Map it to
  // a deterministic bank-check-and-eat that FRESH-opens the bank, withdraws, cooks raw, eats.
  if (!/\bdon'?t\b/.test(m) && (/\b(go eat|eat something|eat now|get food|grab food|feed yourself|food in (your|the) chest|get food from (your|the) chest|check (your|the) chest|open (your|the) chest|you (have|got) food|there'?s food)\b/.test(m) || /^\s*eat\s*!*\s*$/.test(m))) return 'getfood'
  return null
}

// Look up a player's current position by (fuzzy) name, for "build it here" =
// centre on where THEY are standing. Exact match first, then prefix-insensitive
// (so "Steve" finds a Floodgate ".Steve"). null if they're not in view.
function playerPos (name) {
  const p = bot.players[name] && bot.players[name].entity
  if (p && p.position) return p.position
  const want = String(name || '').toLowerCase().replace(/^[^a-z0-9_]+/i, '')
  for (const q of Object.values(bot.players || {})) {
    if (q.entity && q.entity.position && q.username.toLowerCase().replace(/^[^a-z0-9_]+/i, '') === want) return q.entity.position
  }
  return null
}

// Load and build a saved schematic from a spoken request. Resolves the name to a
// local .schem, picks the build origin (explicit coords, else the requesting
// player's own spot for "here"), then runs the same load + centred-build pipeline
// the !command path uses, relaying each step in chat. Operator-gated by caller.
async function startNaturalBuild (username, req) {
  const file = schematic.findLocal(req.name)
  if (!file) {
    const have = schematic.listLocal()
    bot.chat((have.length
      ? `I don't have a schematic called "${req.name}". I've got: ${have.slice(0, 8).join(', ')}`
      : `I don't have any schematics saved yet - drop a .schem in ${path.basename(schematic.SCHEM_DIR)}/ first`).slice(0, 256))
    note(`(build-req) ${username} asked for "${req.name}" - no match`)
    return
  }
  // Where to build, always CENTRED on the reference point:
  //  - explicit coords from the request ("build castle at 100 64 -30"), else
  //  - the requesting operator's own position ("build it here" = where they stand),
  //  - falling back to the bot's own feet if the player isn't in view.
  let point = req.at
  if (!point) {
    const pp = playerPos(username)
    if (pp) point = { x: Math.floor(pp.x), y: Math.floor(pp.y), z: Math.floor(pp.z) }
  }
  const where = point ? `${point.x} ${point.y} ${point.z}` : 'here'
  note(`(build-req) ${username} -> building "${file}" centred at ${where}${req.clear ? ' (clear site)' : ''}`)
  // Mark the WHOLE request busy (travel-to-site + build) so the autonomous brain can't
  // stop it partway - it kept stopping the walk to the site (busy only turned on at the
  // build step) and stranding the bot hundreds of blocks out. A real operator's "stop"
  // still works (it goes through the directCommand path, which bypasses the brain gate).
  commands.setBuildReqActive(true)
  try {
    const loadRes = await commands.handle(bot, `schematic load ${file}`)
    bot.chat(String(loadRes).slice(0, 256))
    // Set the resume job NOW (approximate origin = the requested point) so a death during the
    // trek to the site resumes the build instead of being forgotten. autoBuild refines `at`.
    if (point) commands.setResumeJob(point)
    // If the site is far off, WALK there first (staged) - the placer can't path to a
    // footprint hundreds of blocks away (unloaded chunks), so it must arrive on-site.
    if (point) {
      const me = bot.entity && bot.entity.position
      const far = me && Math.hypot(point.x - me.x, point.z - me.z) > 80
      if (far) {
        // SURVIVAL PREP before the long naked trek: secure a sword + tools + food + (if cows
        // are near) armor RIGHT HERE first, so the bot travels equipped instead of dying
        // starving/unarmed on the way. Bounded - makes what it can and heads out regardless.
        try { const prep = await commands.survivalPrep(bot, { say: m => bot.chat(String(m).slice(0, 200)) }); note(`(build-req) prep -> armed=${prep.armed} fed=${prep.fed} armored=${prep.armored}`) }
        catch (e) { note(`(build-req) prep skipped: ${e.message}`) }
        bot.chat(`that's a fair way off - heading to ${where} first...`)
        const tr = await commands.handle(bot, `travel ${point.x} ${point.y} ${point.z}`)
        note(`(build-req) travel -> ${tr}`)
        if (/^couldn't get to/.test(tr)) { bot.chat(tr.slice(0, 256)); return } // never reached - don't churn
      }
    }
    // autobuild = build from inventory if we have the materials, else gather/craft
    // the whole bill of materials (stashing in a chest) first, then build.
    const buildRes = await commands.handle(bot, `autobuild center ${where}${req.clear ? ' clear' : ''}`)
    bot.chat(String(buildRes).slice(0, 256))
  } catch (e) {
    note(`(build-req error) ${e.message}`)
    bot.chat(`couldn't start that build: ${e.message}`.slice(0, 256))
  } finally {
    commands.setBuildReqActive(false)
  }
}

bot.on('kicked', (reason) => {
  // the kick reason is usually a chat-component object; stringify it so the REAL reason
  // (e.g. "kicked for spamming") is captured instead of a useless "[object Object]".
  let r = reason
  try { r = typeof reason === 'string' ? reason : JSON.stringify(reason) } catch {}
  note(`KICKED: ${r}`)
})
bot.on('error', (err) => note(`ERROR: ${err.message}`))
bot.on('end', (reason) => note(`disconnected: ${reason}`))

// Death recovery: remember WHERE we died (last known spot) and whether it's DANGEROUS
// to return to (lava/fire/void nearby - going back would just re-kill us and the items
// are gone). Surfaced in /state as `died` so the BRAIN can choose to `recover`. We track
// a slightly-stale "last alive" spot because by the death event the body may already be
// respawning elsewhere.
let lastAlivePos = null
setInterval(() => { if (bot.entity && bot.health > 0) lastAlivePos = bot.entity.position.clone() }, 1000).unref?.()
// Feed the stuck-detector: samples position + evaluates "trying but not progressing".
// Surfaced in /state.stuck so the brain can change approach instead of re-wedging.
setInterval(() => { try { commands.trackTick(bot) } catch {} }, 1000).unref?.()
bot.on('death', () => {
  const p = (bot.entity && bot.entity.position) || lastAlivePos
  if (!p) return
  let dangerous = p.y < -60 // void / deep
  try {
    for (let dx = -1; dx <= 1 && !dangerous; dx++) {
      for (let dy = -1; dy <= 2 && !dangerous; dy++) {
        for (let dz = -1; dz <= 1 && !dangerous; dz++) {
          const b = bot.blockAt(p.offset(dx, dy, dz))
          if (b && /lava|fire|magma/.test(b.name)) dangerous = true
        }
      }
    }
  } catch {}
  const info = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dangerous, at: Date.now(), retrieved: false }
  commands.recordDeath(info)
  commands.markBuildInterrupted && commands.markBuildInterrupted() // keep the build to resume
  deathPending = true
  note(`(death) at ${info.x},${info.y},${info.z}${dangerous ? ' - LAVA/FIRE/VOID, risky to return' : ' - can go recover'}`)
})

// After a DEATH -> RESPAWN, auto-resume any interrupted build. The build survives losing
// everything: resumeBuild re-provisions from scratch (or the build's chest) and only
// places the still-missing blocks. 'spawn' also fires on first join, so gate on a death.
let deathPending = false
let autoRecoverTries = 0 // consecutive auto death-drop recovery attempts (capped so recovery can't death-loop)
let recoveringHome = false // trekking home after a far respawn - holds the idle gear-up reflex off (go home > re-arm in the wild)
bot.on('spawn', () => {
  if (!deathPending) return // initial join is handled by the once('spawn') above
  deathPending = false
  note('(respawn) back alive - checking for a build to resume')
  // RE-TEACH the bed from the respawn itself: a bed-set spawn proves a bed is here even
  // when the memory got lost (live: bot respawned at its bed all morning with m.bed
  // EMPTY, so every nightRest pitted instead of walking to a real bed). World spawn is
  // excluded - only a respawn far from it can be a bed/anchor.
  try {
    const ws = bot.spawnPoint
    const here = bot.entity && bot.entity.position
    if (here && ws && Math.hypot(here.x - ws.x, here.z - ws.z) > 12 &&
        !(provision.knownBed && provision.knownBed())) {
      // Only trust a bed that actually STANDS here: blind re-learning adopted a stale
      // far-from-home bed during the overnight carousel, and every later "assert" then
      // targeted the WRONG bed. No bed block within 6 = no re-learn.
      let bedBlk = null
      try {
        const md = require('minecraft-data')(bot.version)
        const ids = Object.values(md.blocksByName).filter(b => /_bed$/.test(b.name)).map(b => b.id)
        bedBlk = bot.findBlock({ matching: ids, maxDistance: 6 })
      } catch {}
      if (bedBlk) {
        provision.rememberBed(bedBlk.position)
        note(`(respawn) bed memory was empty - re-learned my bed at ${bedBlk.position.x},${bedBlk.position.y},${bedBlk.position.z} (bed verified standing)`)
      } else {
        note('(respawn) landed away from world spawn with NO bed standing here - not re-learning a phantom bed')
      }
    }
    // SPAWN-WRONGNESS DETECTOR: respawning far from the remembered bed means the server-
    // side anchor is LOST (bed broken/obstructed/moved without a re-assert) - the world-
    // spawn death-carousel failure (live crisis, ~11:30Z). Flag it; the resume flow
    // force-re-asserts the hut bed the moment the bot is back home.
    const kb = provision.knownBed && provision.knownBed()
    if (kb && here) {
      const d = Math.hypot(here.x - kb.x, here.z - kb.z)
      if (d > 24) {
        note(`(respawn) landed ${Math.round(d)}b from my bed at ${kb.x},${kb.z} - spawn anchor is WRONG, re-asserting when home`)
        commands.flagSpawnSuspect && commands.flagSpawnSuspect()
      }
    }
  } catch {}
  setTimeout(async () => { // let the world/chunks settle first
    try {
      // SURVIVAL-FIRST respawn order (fixes the overnight DEATH SPIRAL): on a far respawn the
      // bed got creeper-destroyed, so the server dumped the bot at WORLD SPAWN ~380b from home,
      // NAKED with an empty pack. The old order chased the dropped-gear grave FIRST and ungated
      // - it sent that starving bot on a long trek, it hit food 0 + got beaten to death, then
      // respawned and did it again, bleeding gear each loop. RECOVER-HOME NOW RUNS FIRST (getting
      // home + rebuilding the bed + re-asserting spawn is what STOPS the world-spawn carousel:
      // future deaths then return HOME, safe), and the grave chase is survival-gated behind it.

      // 1) GO HOME FIRST. Getting home OUTRANKS both gear-up and the grave chase. Bounded +
      // honest (can't wedge); auto-eat + nav recovery keep survival applied en route. Home
      // anchor = hut > remembered bed > persisted build site. recoveringHome holds the idle
      // gear-up reflex off meanwhile. RECOVER_HOME=0 disables. On arrival the bed is rebuilt +
      // the spawn re-asserted, so the NEXT death lands HOME instead of world spawn.
      let homeAnchor = null
      if (process.env.RECOVER_HOME !== '0') {
        const pr = commands.persistedResume && commands.persistedResume()
        recoveringHome = true
        try {
          const rh = await provision.recoverHome(bot, { say: (m) => note('(respawn) ' + m), resumeAt: pr && pr.at })
          homeAnchor = rh && rh.anchor
          if (rh.far) note(`(respawn) ${rh.arrived ? 'arrived home - bed ' + (rh.bedOk ? 'rebuilt + spawn re-asserted (future deaths return here)' : 'could NOT be re-asserted, will retry next respawn') : 'could not reach home this time (' + Math.round(rh.dist) + 'b) - will retry next respawn'}`)
        } catch (e) { note(`(respawn) recover-home failed: ${e.message}`) } finally { recoveringHome = false }
      }
      // 2) ESTABLISH THE SPAWN BED as its own survival priority whenever the anchor is still
      // suspect after the go-home step (creeper-broken bed near home, or recoverHome fell short
      // of re-asserting). This is what actually ENDS the carousel, so it must NOT wait for a
      // rare idle camp pass or a build to resume. If recoverHome already re-anchored, rememberBed
      // cleared the suspect flag and this no-ops (no double trek).
      if (provision.isSpawnSuspect && provision.isSpawnSuspect()) {
        note('(respawn) spawn anchor still WRONG after go-home - fixing the bed/spawn as a survival priority')
        try {
          const ok = await provision.recoverSpawnAnchor(bot, { say: (m) => note('(respawn) ' + m) })
          note(`(respawn) spawn anchor ${ok ? 'RESTORED at the bed (future deaths return here)' : 'not fixed this time - will retry on the next respawn'}`)
        } catch (e) { note(`(respawn) spawn recovery failed: ${e.message}`) }
      }
      // 3) DEATH-DROP GRAVE RECOVERY, now SURVIVAL-GATED. Only chase the grave when the bot is
      // SAFE + FED and the grave is reasonably reachable (shouldChaseGrave). A naked/starving
      // bot, or a grave far across hostile ground, DEFERS - never trek to it while it would
      // starve/die. Still capped (autoRecoverTries) so recovery itself can't death-loop.
      // RECOVER_ON_RESPAWN=0 disables. AxGraves persist on the live server, so a deferred grave
      // is still there to fetch once the bot is safe + geared.
      if (process.env.RECOVER_ON_RESPAWN !== '0' && commands.worthwhileGrave) {
        const g = commands.worthwhileGrave()
        if (g) {
          const st = commands.state(bot)
          const gate = commands.shouldChaseGrave({
            grave: g, pos: st.pos, food: st.food, threat: st.threat,
            escaping: (commands.isEscaping && commands.isEscaping()) || false,
            home: homeAnchor
          })
          if (!gate.chase) {
            note(`(respawn) grave at ${g.x},${g.y},${g.z} DEFERRED - ${gate.reason}`)
          } else if (autoRecoverTries < 3) {
            autoRecoverTries++
            note(`(respawn) safe to recover: grave at ${g.x},${g.y},${g.z} (${g.items.slice(0, 4).join(', ') || 'value ' + g.value}) - ${gate.reason} (try ${autoRecoverTries}/3)`)
            try {
              const r = await commands.handle(bot, 'recover')
              note(`(respawn) recover -> ${r}`)
              if (!commands.worthwhileGrave()) autoRecoverTries = 0 // got it (or it's gone) - reset
            } catch (e) { note(`(respawn) recover failed: ${e.message}`) }
          } else {
            note(`(respawn) worthwhile grave at ${g.x},${g.y},${g.z} but already tried ${autoRecoverTries}x - writing it off to avoid a death-loop`)
          }
        } else {
          autoRecoverTries = 0 // nothing worthwhile pending - reset the cap
        }
      }
      for (let attempt = 0; attempt < 3; attempt++) { // deferred = old build loop still unwinding
        const r = commands.resumeBuild && await commands.resumeBuild(bot)
        if (r && r.deferred) { note('(resume) old build still unwinding - retrying in 30s'); await new Promise(res => setTimeout(res, 30000)); continue }
        if (r) note(`(resume) build ${r.stopped ? 'STOPPED' : 'finished'} after respawn: ${r.placed}/${r.total} placed`)
        else note('(resume) nothing to resume')
        // (spawn-anchor repair is handled ABOVE as an unconditional survival priority - step 2
        // of the respawn order - so it no longer waits for "no build to resume".)
        return
      }
      note('(resume) gave up waiting for the old build loop - will try on the next respawn')
    } catch (e) { note(`(resume) failed: ${e.message}`) }
  }, 7000)
})

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

// Cook reflex: idle near a furnace with raw meat in the pack -> cook it, like a player
// tidying up after a hunt. Opportunistic (existing furnace + pack fuel only; provision
// runs also cook right after each smelt while the furnace is hot). Only when IDLE so it
// never fights a build's pathfinder. Set AUTO_COOK=0 to disable.
let cookingMeat = false
if (process.env.AUTO_COOK !== '0') {
  setInterval(async () => {
    if (cookingMeat || !bot.entity || commands.isBusy() || (commands.isEscaping && commands.isEscaping())) return
    if (arbiter.maneuverActive()) return // a navigation owns the body - don't detour to a furnace mid-approach
    cookingMeat = true
    try {
      const n = await provision.cookRawMeat(bot, {})
      if (n > 0) note(`(auto-cook) cooked ${n} raw meat at the furnace`)
    } catch { /* best-effort */ } finally { cookingMeat = false }
  }, 30000).unref?.()
}

// Survival hunt: auto-eat can only eat food you HAVE. When the bot runs OUT of food and is
// getting hungry, go kill a nearby animal so auto-eat has something to eat - otherwise it
// starves to 1 hp and stalls (seen live: 0 food / 1 hp mid-build). Only when IDLE: during
// a build the gather loop does this itself, and a reflex must not fight its pathfinder.
// Body-side on purpose - the brain is HELD during builds and (verified via the decision
// log) misreads its own hunger as a nearby player's. Set SURVIVAL_HUNT=0 to disable.
let survivalHunting = false
if (process.env.SURVIVAL_HUNT !== '0') {
  setInterval(async () => {
    if (survivalHunting || !bot.entity) return
    if (commands.isBusy && commands.isBusy()) return // the gather loop covers the build case
    if (provision.isResting && provision.isResting()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return
    if (arbiter.maneuverActive()) return // don't chase an animal while a navigation drives the body
    if (!provision.needsFood(bot)) return
    survivalHunting = true
    try {
      // ONE food policy: eat -> bank -> cook -> hunt -> farm -> fish -> scout -> hold
      // (provision.secureFood; it starved at 1hp with cooked food in its own chest, and
      // later starved through hunt-only fallbacks in an animal-free region - both live).
      const home = (provision.knownBed && provision.knownBed()) || undefined
      if (await provision.secureFood(bot, { home, canHold: true, say: m => bot.chat(String(m).slice(0, 200)) })) note('(survival) food secured - was starving with an empty pack')
    } catch (e) { /* transient - retry next tick */ } finally { survivalHunting = false }
  }, 6000).unref?.()
}

// PROACTIVE TOP-UP: idle food decayed 20 -> 1 with NO refill until near-starvation (live) -
// auto-eat only eats the PACK, and nothing WITHDREW from the bank until the food=2 crisis. When
// IDLE and food dips below 14, top up to comfortable from the pack AND the bank (secureFood
// eats pack -> withdraws banked food -> cooks -> eats), so it never coasts down to 1. (This
// still spends finite bank food - which is exactly why the renewable wheat farm matters.)
// Set FOOD_TOPUP=0 to disable.
let toppingUpFood = false
if (process.env.FOOD_TOPUP !== '0') {
  setInterval(async () => {
    if (toppingUpFood || !bot.entity || bot.food == null || bot.food >= 14) return
    if (commands.isBusy && commands.isBusy()) return // busy jobs run their own secureFood
    if (provision.isResting && provision.isResting()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return
    if (arbiter.maneuverActive && arbiter.maneuverActive()) return
    toppingUpFood = true
    try {
      const home = (provision.knownBed && provision.knownBed()) || undefined
      const before = bot.food
      await provision.secureFood(bot, { home, threshold: 14, say: m => bot.chat(String(m).slice(0, 200)) })
      if ((bot.food ?? 0) > before) note(`(food-topup) topped up ${before} -> ${bot.food} (bank/pack) - not waiting for starvation`)
    } catch (e) { /* transient - retry next tick */ } finally { toppingUpFood = false }
  }, 20000).unref?.()
}

// FOOD CRISIS (survival tier, fires EVEN WHILE BUSY): every work loop carries its own
// hunger checks, but a wedged loop can starve the bot at 1hp for 20 minutes (live:
// 0 food / 0.9hp mid-"gathering" at the hut). At food <= 2 with an empty pack, being
// fed outranks the job - survival is the one legal interrupt (operator rule). The
// running loop sees 'goal was changed' and recovers, same as any reflex interruption.
// Disable with FOOD_CRISIS=0.
let foodCrisis = false
if (process.env.FOOD_CRISIS !== '0') {
  setInterval(async () => {
    if (foodCrisis || !bot.entity || bot.food == null || bot.food > 2) return
    if (provision.hasFood(bot)) return // auto-eat has it covered
    if (provision.isResting && provision.isResting()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return
    if (commands.isEscaping && commands.isEscaping()) return
    if (navigate.isRecovering()) return
    foodCrisis = true
    try {
      note(`(food-crisis) food=${bot.food} hp=${(bot.health || 0).toFixed(1)} with an empty pack - dropping everything to feed`)
      try { bot.pathfinder.setGoal(null) } catch {}
      const home = (provision.knownBed && provision.knownBed()) || undefined
      const ok = await provision.secureFood(bot, { home, canHold: true, threshold: 10, say: m => bot.chat(String(m).slice(0, 200)) })
      note(`(food-crisis) ${ok ? 'fed (or safely holding)' : 'still starving - will retry'}`)
    } catch (e) { note(`(food-crisis) failed: ${e.message}`) } finally { foodCrisis = false }
  }, 15000).unref?.()
}

// HP CRISIS (survival tier, fires EVEN WHILE BUSY): a hurt bot that is still endangered (dark
// night or a mob in range) keeps grinding its job and whittles to death - live: an armored
// far-gather went hp 18.7->11.7->0.77->DEAD, then lost its armor to a naked death-spiral. No
// consumer acted on the arbiter's 'heal' need (build/gather bailed only on creeper/threat; the
// one hp<=8 rest branch sat behind a "bail to safety" that fired first). This is that missing
// consumer: when survivalNeed surfaces 'heal', STOP the job and shelter-and-heal. Firing while
// busy IS the override (no isBusy gate on purpose). A live creeper/threat makes the need
// 'creeper'/'threat' (not 'heal') so this waits for the flee to back off, THEN shelters. Disable
// with HP_CRISIS=0.
let hpCrisis = false
let hpCrisisCooldownUntil = 0
if (process.env.HP_CRISIS !== '0') {
  setInterval(async () => {
    if (hpCrisis || !bot.entity || bot.health == null) return
    if (Date.now() < hpCrisisCooldownUntil) return
    const n = provision.survivalNeed(bot)
    if (!n || n.need !== 'heal') return
    if (commands.isEscaping && commands.isEscaping()) return
    if (navigate.isRecovering() || navigate.isForceUnsticking()) return
    if (provision.isResting()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return
    if (bot.isSleeping) return
    hpCrisis = true
    try {
      note(`(hp-crisis) ${n.reason} - stopping the job to shelter and heal`)
      const ok = await provision.recoverHp(bot, { say: m => bot.chat(String(m).slice(0, 200)) })
      note(`(hp-crisis) ${ok ? 'recovered - the job can resume' : 'not fully recovered - resuming carefully'}`)
    } catch (e) { note(`(hp-crisis) failed: ${e.message}`) } finally { hpCrisis = false; hpCrisisCooldownUntil = Date.now() + 60000 }
  }, 8000).unref?.()
}

// PROACTIVE FOOD SUPPLY (base-setup goal, like the hut): a FED, SAFE, IDLE bot that lacks a
// standing renewable food source ESTABLISHES one BEFORE the next hunger crisis - on a
// no-animal, water-rich site that's a WHEAT FARM at the remembered pond. secureFood only
// fired reactively at food<=12 and by food=1 it was too late to set up a multi-step source,
// so it starved (live). This builds the farm while there's still time. Set FOOD_SUPPLY=0 off.
let buildingFoodSupply = false
if (process.env.FOOD_SUPPLY !== '0') {
  setInterval(async () => {
    if (buildingFoodSupply || !bot.entity) return
    if (commands.isBusy && commands.isBusy()) return // a job owns the body
    if (provision.isResting && provision.isResting()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return
    if (arbiter.maneuverActive()) return
    if (bot.pathfinder && bot.pathfinder.goal) return // idle only - don't yank an active goal
    if (!provision.needFoodSupply || !provision.needFoodSupply(bot)) return // fed + safe + no standing farm
    buildingFoodSupply = true
    try {
      note('(food-supply) fed + idle but no standing food source - setting up the wheat farm at the remembered pond')
      const home = (provision.knownBed && provision.knownBed()) || undefined
      const r = await provision.ensureFoodSupply(bot, { home, say: m => bot.chat(String(m).slice(0, 200)) })
      note('(food-supply) ' + (r && r.ok ? (r.reason || 'food supply set up') : 'deferred: ' + ((r && r.reason) || 'unknown')))
    } catch (e) { note('(food-supply) failed: ' + e.message) } finally { buildingFoodSupply = false }
  }, 45000).unref?.()
}

// Night-shelter: a NAKED bot at night with a hostile closing digs into a sealed pit and waits
// it out - a creeper can't reach you underground (it died to one, unarmed, mid-build). Only
// when IDLE: during a build the gather loop does this itself (a reflex must not fight its
// pathfinder). Body-side because the brain is HELD during builds. Set NIGHT_SHELTER=0 to off.
let sheltering = false
let lastRestNote = 0
if (process.env.NIGHT_SHELTER !== '0') {
  setInterval(async () => {
    if (sheltering || !bot.entity) return
    if (commands.isBusy && commands.isBusy()) return // the gather loop covers the build case
    // A wedge-escape / nav recovery owns the body: re-entering the bunker now would stomp its
    // manual step-out (ONE BODY, ONE ROUTE) - the live "step-out no progress" at the shallow
    // bunker was the shelter reflex re-sealing the pit under the escape. Let the escape finish.
    if (navigate.isForceUnsticking() || navigate.isRecovering()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return // feeding run owns the body
    // Two triggers: VULNERABLE at night (naked - always rest, the death carousels were all
    // naked), or simply IDLE at night with a bed on the map - a player with nothing to do
    // goes to bed even in full iron (operator asked for exactly this). Armored + mid-task
    // keeps working the night; armored + idle sleeps.
    const idleNight = provision.isNight(bot) && !bot.pathfinder.goal && provision.knownBed && provision.knownBed()
    if (!provision.shelterNeeded(bot) && !idleNight) return
    // ETERNAL/FROZEN NIGHT: after the brief initial shelter, STOP re-bunkering (and stop
    // idle-sleeping toward a dawn that won't come) - stand down so gearup/progress can run.
    // Re-arming near the bunker is the real fix for "no armor, mobs about", not hiding forever
    // (live 379,62,40, pinned 25+ min). flee/defend still guard acute threats; a normal night
    // never trips nightStuck, so this is a no-op there.
    if (provision.nightStuck && provision.nightStuck(bot)) return
    sheltering = true
    // note at most once per 2 min: a rest that resolves instantly (dusk head-start, can't
    // sleep yet) used to print "rested for the night" every 5s - the log spam (live 07-13)
    try { if (await provision.nightRest(bot, { say: m => bot.chat(String(m).slice(0, 200)) }) && Date.now() - lastRestNote > 120000) { lastRestNote = Date.now(); note('(shelter) rested for the night' + (provision.underArmored(bot) ? ' (bed or pit) - no armor, mobs about' : ' - nothing better to do than sleep')) } }
    catch (e) { /* transient */ } finally { sheltering = false }
  }, 5000).unref?.()
}

// GEAR-UP: a naked IDLE bot re-arms itself - body-side and brain-independent (the brain's
// "leather from the wandering trader" fixation left it naked at the hut for hours while
// iron sat mineable nearby - live 07-13). Morning + idle + fed + safe -> `armorup`, which
// wears what it has, hunts cows only if cows actually exist, and otherwise runs the IRON
// bootstrap (mine -> smelt -> craft -> wear). The persisted gearup back-off inside the
// bootstrap keeps this from churning on a fruitless site. Set GEAR_REFLEX=0 to off.
let gearing = false
if (process.env.GEAR_REFLEX !== '0') {
  setInterval(async () => {
    if (gearing || !bot.entity) return
    if (recoveringHome) return // respawned far from base - GO HOME outranks re-arming in the wild
    if (commands.isBusy && commands.isBusy()) return // a job owns the body (its camp flow gears)
    if (arbiter.maneuverActive()) return // a navigation is driving - don't start the iron grind mid-walk
    if (provision.isResting && provision.isResting()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return
    if (commands.isEscaping && commands.isEscaping()) return
    if (!provision.underArmored(bot)) return
    const tod = bot.time ? bot.time.timeOfDay : 0
    // dusk/night belong to the shelter reflex; mornings to the grind - UNLESS the night is
    // frozen/eternal (dawn never comes, live). Then re-arming near the bunker is the ONLY way
    // out of "no armor, mobs about", so gear up at night too. mayDoProgress (below) still holds
    // for a live threat / hunger, keeping it careful; and the shelter reflex stands down for
    // nightStuck so it won't fight this. Normal nights: tod<23500 so this still defers to shelter.
    if (tod >= 11000 && !(provision.nightStuck && provision.nightStuck(bot))) return
    // JOB ARBITER: gear-up is a PROGRESS job - don't start it while a SURVIVE need is unmet
    // (food/hp/threat/shelter). The ONE authority replaces the old scattered food<X/hp<Y checks;
    // the survive reflexes (feed/heal/shelter) resolve the need first, then gearup runs.
    if (!provision.mayDoProgress(bot)) { const n = provision.survivalNeed(bot); if (n) note(`(gearup) holding - survival need first: ${n.need} (${n.reason})`); return }
    const backoff = provision.gearupState && provision.gearupState()
    if (backoff && backoff.until > Date.now()) return // recent fruitless grind - let it cool
    gearing = true
    try {
      note('(gearup) under-armored and idle - going to get armor (iron if there are no cows)')
      const r = await commands.handle(bot, 'armorup')
      note('(gearup) ' + r)
    } catch (e) { note('(gearup) failed: ' + e.message) } finally { gearing = false }
  }, 60000).unref?.()
}

// HOME REPAIR: an idle bot standing AT a creeper-damaged base self-heals it as a SURVIVAL
// reflex - not only inside the camp job. Home upkeep used to run ONLY in autoBuild's camp pass,
// gated on a huge total BOM (~>=500), so ordinary creeper damage silently rotted the base for
// hours. This shares the camp pass's exact chain via provision.maintainHome (apron -> bed ->
// bank double-heal -> spawn re-assert -> structural repair + tidy -> consolidate). Fires only
// when idle, already home (<=24b), and survival needs are met - repair is a PROGRESS job, so
// food/hp/threat/shelter come first (won't stand still patching walls under attack). It does
// NOT trek: crossing the world back to a far base is recover-home's job. Cooled down 5 min
// after a pass so it can't churn. Set HOME_REPAIR=0 to disable.
let repairingHome = false
let lastHomeRepair = 0
if (process.env.HOME_REPAIR !== '0') {
  setInterval(async () => {
    if (repairingHome || !bot.entity) return
    if (recoveringHome) return // respawned far from base - GO HOME outranks patching the base
    if (commands.isBusy && commands.isBusy()) return // a job owns the body (its camp pass repairs)
    if (arbiter.maneuverActive()) return // a navigation is driving - don't start a repair mid-walk
    if (provision.isResting && provision.isResting()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return
    if (commands.isEscaping && commands.isEscaping()) return
    if (navigate.isForceUnsticking() || navigate.isRecovering()) return
    // JOB ARBITER: home repair is a PROGRESS job - never run it while a SURVIVE need is unmet
    // (food/hp/threat/shelter). This is how the base won't get patched while under attack.
    if (!provision.mayDoProgress(bot)) return
    if (Date.now() - lastHomeRepair < 300000) return // 5-min cooldown after a pass - don't churn
    const hut = provision.hutAnchor(); if (!hut) return
    // AT-HOME gate: only repair when actually near home. This reflex must NOT trek across the
    // world - that's recover-home's job; repair only when already standing at the base.
    if (bot.entity.position.distanceTo(hut) > 24) return
    repairingHome = true
    try {
      const r = await provision.maintainHome(bot, hut, { isStopped: () => false, say: m => bot.chat(String(m).slice(0, 200)) })
      lastHomeRepair = Date.now()
      if (r && r.damaged) note('(home-repair) patched the base - ' + JSON.stringify({ bed: r.bed, chest: r.chestFixed, repair: r.repair && r.repair.missing, consolidated: r.consolidated }))
      else note('(home-repair) base intact - nothing to fix')
    } catch (e) { note('(home-repair) failed: ' + e.message) } finally { repairingHome = false }
  }, 60000).unref?.()
}

// Anti-AFK: keep the connection alive during genuine idle gaps (e.g. between brain
// restarts) so the server doesn't kick the bot. ONLY when truly idle - if it's
// pathing/gathering/building it's already active, and a hop mid-task just reads as
// random jumping (user report). Keep-alive is a small arm swing + a tiny turn, NOT
// a jump. Disable with ANTI_AFK=0.
if (process.env.ANTI_AFK !== '0') {
  setInterval(() => {
    if (!bot.entity) return
    try {
      const moving = bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()
      if (moving || (commands.isBusy && commands.isBusy())) return // already active - no nudge needed
      bot.swingArm('right')
      const yaw = bot.entity.yaw + (Math.PI / 16) * (bot.entity.position.x % 2 < 1 ? 1 : -1) // tiny look shift, no hop
      bot.look(yaw, bot.entity.pitch, false).catch(() => {})
    } catch { /* not spawned yet */ }
  }, 20000)
}

// Self-defense: swing at any hostile mob that gets close, independent of the
// brain - so the bot fights back when attacked. Disable with AUTO_DEFEND=0.
const HOSTILE_RE = /zombie|skeleton|spider|creeper|enderman|witch|husk|drowned|pillager|vindicator|ravager|slime|magma_cube|blaze|piglin|hoglin|phantom|zoglin|stray|silverfish|guardian|vex|wither|warden|ghast|shulker|illusioner|evoker|breeze|bogged/i
// never AUTO-melee these: creepers explode point-blank, ghast/warden/wither are ranged/deadly
const NO_AUTO_MELEE = /creeper|ghast|warden|wither_boss|^wither$/i
// below this health, DISENGAGE from any hostile (retreat) instead of trading hits -
// how it survived to death overnight was by fighting a skeleton while low. Tunable.
const RETREAT_HP = parseInt(process.env.RETREAT_HP || '8', 10)
let defendEquipped = false
let lastDefendTarget = null
let lastFleeAt = 0
let dfLastHp = 20
let dfHurtAt = 0 // when health last DROPPED - "someone is shooting me" detector
// FLEE STANDOFF detector: fleeing the same threat for 12s+ without moving AND without
// taking a hit means we CAN'T move (wedged) and it CAN'T reach us. Re-setting the flee
// goal every second just steals the pathfinder from the nav/recovery that could free us
// (live: a 2h+ creeper standoff in a cave pocket - every chest read / night-rest trek
// died "goal taken by a reflex" while the creeper sat 8m away unable to close). Stand
// down per-threat for 90s; a real hit re-arms flee instantly.
let fleeEp = null // { id, start, pos } - the current flee episode
const fleeFutileUntil = new Map() // entity id -> epoch ms until which flee is suppressed
// CREEPER AVOID: a creeper is a walking bomb, so it gets a COMMITTED one-shot latched
// maneuver (near home: run INTO the sealed hut - a closed wooden door stops a creeper cold,
// live: the crippled bot kited in circles until one detonated on the hut; away from home:
// back off 20b past the creeper's 16m follow range so it deaggros). One maneuver at a time
// (the latch), so the reflex can't re-issue a fresh goal every tick and thrash the approach
// (the door-loop). avoidHist is the ping-pong breaker: two failed back-offs in 60s -> a
// can't-shake standoff -> stop churning and mark the creeper futile.
let creeperAvoidLatch = false
const avoidHist = new Map() // creeper entity id -> [timestamps] of recent avoid attempts
let lastChargeNoteAt = 0
const RANGED_RE = /skeleton|stray|bogged|pillager/i
if (process.env.AUTO_DEFEND !== '0') {
  setInterval(() => {
    if (!bot.entity) return
    // Track being-HIT first, so the shelter gate below can tell "safely holed up" from
    // "under attack" (health dropped in the last 8s).
    const hpNow = bot.health == null ? 20 : bot.health
    if (hpNow < dfLastHp - 0.5) dfHurtAt = Date.now()
    dfLastHp = hpNow
    const beingHit = Date.now() - dfHurtAt < 8000
    // While digging UP out of a cave, don't let the flee reflex hijack the pathfinder
    // sideways - rising out of the hole IS the escape (fleeing horizontally just keeps us
    // in the mob-filled cave and pins us at depth).
    if (commands.isEscaping && commands.isEscaping()) return
    // Same rule while a navigation RECOVERY is maneuvering (pillaring out of a pit,
    // threading a doorway, hopping from water) - the recovery IS the escape.
    if (navigate.isRecovering()) return
    // While sheltering (sealed bunker / hut night-wait) stand down - UNLESS something is
    // actually HITTING us. A sealed pit takes no hits (the mob can't reach), so this still
    // yields there; but an enderman teleported into the hut, or a leaky pit, must be FOUGHT
    // - we're armored and win - not passively absorbed to death (live: 'attack enderman
    // suppressed' then died). The moment we take damage, defense/flee re-engages.
    if (provision.isSheltering && provision.isSheltering() && !beingHit) return
    try {
      const me = bot.entity.position
      const hp = hpNow
      const underFire = beingHit
      // FLEE from a nearby creeper (melee = it explodes) from 12 out - it died twice
      // tonight to creepers first seen at 5-8m: they SPRINT the last stretch and 8m of
      // walking-flee isn't enough head start. And when we're HURT, flee ANY hostile:
      // trading blows with a skeleton at low HP is how it got whittled down overnight.
      let flee = null; let fbest = 12; let why = 'creeper'
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
        if (!/creeper/.test(e.name || '')) continue
        const d = e.position.distanceTo(me); if (d < fbest) { fbest = d; flee = e }
      }
      if (!flee && hp <= RETREAT_HP) { // low health -> disengage from whatever's hunting us
        let best = 13
        for (const e of Object.values(bot.entities || {})) {
          if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
          if (!HOSTILE_RE.test(e.name || '')) continue
          const d = e.position.distanceTo(me); if (d < best) { best = d; flee = e; why = `low hp (${Math.round(hp)})` }
        }
        if (flee) fbest = flee.position.distanceTo(me)
      }
      if (flee) {
        const now = Date.now()
        const isCreeper = why === 'creeper'
        // A TRUE emergency - actively being hit, or a creeper close enough to detonate (<=6m).
        // Only an emergency preempts a live PROGRESS maneuver's raw radial flee (below).
        const fleeEmergency = beingHit || (isCreeper && fbest <= 6)
        // 1) INSIDE OWN WALLS and untouched: checked FIRST (above the PROGRESS deferral AND the
        // avoid maneuver) so a bot safe inside its hut never walks back OUT the door into a
        // creeper's blast radius. The creeper can't reach; hold position. A real hit re-arms.
        if (isCreeper && !beingHit) {
          try { if (provision.insideOwnStructure && provision.insideOwnStructure(bot)) return } catch {}
        }
        // 2) COMMITTED CREEPER AVOID - runs BEFORE the PROGRESS deferral, so a creeper at 6-12m
        // is backed off from even mid-build/mid-mine (the incompleteness that got the bot blown
        // up: a preventive creeper reaction used to defer to any progress maneuver). ONE latched
        // maneuver at a time (no per-tick goal re-issue -> no door-loop goal-thrash); near home
        // it retreats into the sealed hut, else it backs off 20b past the 16m follow range so the
        // creeper deaggros. A can't-shake creeper is capped by the ping-pong breaker + futility.
        if (isCreeper && !fleeEmergency) {
          if (creeperAvoidLatch) return // a retreat/back-off is already driving - don't stack
          if ((fleeFutileUntil.get(flee.id) || 0) > now) return // standoff-suppressed this creeper
          // PING-PONG BREAKER: two back-offs against this creeper in the last 60s and it's still
          // on us -> a can't-shake standoff (fenced/faster terrain). Stop churning; mark futile 90s.
          const hist = (avoidHist.get(flee.id) || []).filter(t => now - t < 60000)
          if (hist.length >= 2) {
            fleeFutileUntil.set(flee.id, now + 90000); avoidHist.delete(flee.id)
            for (const [id, t] of fleeFutileUntil) { if (t <= now) fleeFutileUntil.delete(id) } // prune
            note(`(flee) can't shake creeper ${fbest.toFixed(1)}m after 2 back-offs - standing down 90s`)
            return
          }
          hist.push(now); avoidHist.set(flee.id, hist)
          creeperAvoidLatch = true
          const startPos = me.clone()
          const hut = (() => { try { return (provision.listInfra ? provision.listInfra('hut') : [])[0] } catch { return null } })()
          const nearHut = hut && Math.hypot(hut.x + 2 - me.x, hut.z + 2 - me.z) <= 24
          ;(async () => {
            let ok = false
            try {
              if (nearHut) {
                // Already inside our own walls? The creeper can't reach - just hold/re-seal,
                // never re-navigate to a fixed interior cell (that furniture-blind goto was
                // unsatisfiable when a table/bed sat on hut+2,+2 -> looped to the 40s deadline).
                if (provision.insideOwnStructure && provision.insideOwnStructure(bot)) {
                  note('(flee) creeper near home but already inside the hut - holding, door stays sealed')
                } else {
                  note(`(flee) creeper ${fbest.toFixed(1)}m near home - retreating INTO the hut`)
                  // Target a FREE interior floor cell (furniture-aware), not the fixed hut+2,+2;
                  // the nav's door pre-flight crosses the doorway to reach it. Fallback to center.
                  const cell = (() => { try { return provision.freeInteriorCell ? provision.freeInteriorCell(bot, hut) : null } catch { return null } })()
                  const gx = cell ? cell.x : hut.x + 2; const gy = cell ? cell.y : hut.y + 1; const gz = cell ? cell.z : hut.z + 2
                  await navigate.navigateToPreempt(bot, new goals.GoalNear(gx, gy, gz, 1),
                    { timeoutMs: 15000, deadlineMs: 40000, climb: false, priority: arbiter.PRIORITY.SURVIVE, budgets: { door: 3, pit: 0, water: 0, nudge: 1, stepout: 1 }, label: 'hut-retreat' })
                  note('(flee) inside the hut - door-assist sealed the door behind me')
                }
              } else {
                const away = me.minus(flee.position)
                const dest = me.plus(away.scaled(20 / (away.norm() || 1))) // 20b -> past the creeper's 16m follow range -> deaggro (no boundary jitter)
                note(`(flee) creeper ${fbest.toFixed(1)}m - backing off 20b to deaggro`)
                await navigate.navigateToPreempt(bot, new goals.GoalNear(Math.floor(dest.x), Math.floor(me.y), Math.floor(dest.z), 2),
                  { timeoutMs: 15000, deadlineMs: 40000, priority: arbiter.PRIORITY.SURVIVE, label: 'creeper-backoff' })
              }
              ok = true
            } catch (e) { note(`(flee) creeper avoid failed (${e.message})`) }
            // FUTILITY: the maneuver failed OR we barely moved (fenced/wedged) -> can't reach
            // safety; suppress re-fleeing THIS creeper for 90s so job/reflex don't ping-pong and
            // a can't-reach creeper doesn't freeze the body forever (the wedge watchdog case).
            let netMove = 0; try { netMove = Math.hypot(bot.entity.position.x - startPos.x, bot.entity.position.z - startPos.z) } catch {}
            if (!ok || netMove < 2.5) {
              fleeFutileUntil.set(flee.id, Date.now() + 90000)
              note(`(flee) creeper avoid netted only ${netMove.toFixed(1)}b - standing down 90s`)
            }
            setTimeout(() => { creeperAvoidLatch = false }, 5000) // release the latch after it settles
          })()
          return
        }
        // 3) The PROGRESS deferral now guards ONLY the raw radial flee below (emergencies /
        // low-hp melee flee). A non-emergency at 6-12m already committed above; this keeps a
        // preventive melee flee from thrashing a deliberate navigation's approach (door-loop).
        if (!fleeEmergency && arbiter.maneuverActive(arbiter.PRIORITY.PROGRESS)) return
        // standoff suppression (see fleeFutileUntil above) - a hit always re-arms
        if (!beingHit && (fleeFutileUntil.get(flee.id) || 0) > now) return
        if (!fleeEp || fleeEp.id !== flee.id) fleeEp = { id: flee.id, start: now, pos: me.clone() }
        // rolling window: any real movement re-bases the episode, so only a sustained
        // freeze (not a flee that ran 20 blocks then paused) reads as a standoff
        if (Math.hypot(me.x - fleeEp.pos.x, me.z - fleeEp.pos.z) >= 2.5) { fleeEp.start = now; fleeEp.pos = me.clone() }
        else if (!beingHit && now - fleeEp.start > 12000) {
          fleeFutileUntil.set(flee.id, now + 90000)
          for (const [id, t] of fleeFutileUntil) { if (t <= now) fleeFutileUntil.delete(id) } // prune
          fleeEp = null
          try { bot.pathfinder.setGoal(null) } catch {} // release the pathfinder we've been hogging
          bot.setControlState('sprint', false)
          note(`(flee) STANDOFF with ${flee.name || why} ${fbest.toFixed(1)}m - can't move and it can't reach me; standing down 90s so nav/recovery can work`)
          return
        }
        if (flee !== lastDefendTarget || now - lastFleeAt > 1000) {
          const away = me.minus(flee.position)
          const dest = me.plus(away.scaled(16 / (away.norm() || 1))) // back off ~16 blocks (past creeper aggro range)
          bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(dest.x), Math.floor(me.y), Math.floor(dest.z), 1))
          bot.setControlState('sprint', true) // RUN - creepers sprint the last stretch; a walking flee lost twice tonight
          lastFleeAt = now
          if (flee !== lastDefendTarget) note(`(flee) ${why} ${fbest.toFixed(1)}m`)
          lastDefendTarget = flee
        }
        return
      }
      // Mid-DIG with healthy hp AND nobody actually hitting us: don't break off a
      // 7-second dig to punch a zombie the armor can tank. Being SHOT overrides this.
      if (bot.targetDigBlock && hp > 12 && !underFire) return
      // BEING SHOT from range: melee-only defense ignored a skeleton sniping from 10+
      // blocks - the bot just stood there taking arrows (operator report). Armored and
      // healthy -> CHARGE the shooter (iron vs skeleton is a one-sided fight); naked ->
      // break the line and get away.
      if (underFire && hp > 10) {
        let shooter = null; let sd = 20
        for (const e of Object.values(bot.entities || {})) {
          if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
          if (!RANGED_RE.test(e.name || '')) continue
          const d = e.position.distanceTo(me); if (d < sd) { sd = d; shooter = e }
        }
        if (shooter && sd > 3.5) {
          const armored = !provision.underArmored(bot)
          if (armored) {
            bot.pathfinder.setGoal(new goals.GoalNear(shooter.position.x, shooter.position.y, shooter.position.z, 2))
            if (Date.now() - lastChargeNoteAt > 5000) { lastChargeNoteAt = Date.now(); note(`(defend) being shot - charging the ${shooter.name} ${sd.toFixed(1)}m`) }
          } else {
            const away = me.minus(shooter.position)
            const dest = me.plus(away.scaled(20 / (away.norm() || 1)))
            bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(dest.x), Math.floor(me.y), Math.floor(dest.z), 2))
            bot.setControlState('sprint', true)
            if (Date.now() - lastChargeNoteAt > 5000) { lastChargeNoteAt = Date.now(); note(`(defend) being shot with no armor - breaking away from the ${shooter.name}`) }
          }
          return // next ticks melee it when close / keep running
        }
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

// PROACTIVE SPAWN KEEPALIVE: re-assert the bed spawn whenever we're NEAR the bed and the
// assert is stale (or the anchor is flagged suspect) - not only during resume passes.
// Overnight the anchor silently reverted to world spawn and the bot only discovered it by
// DYING 430 blocks out. Near-bed + idle = a 2-second bed activation; suspect overrides
// the idle gate (survival tier beats the build). Disable with SPAWN_KEEPALIVE=0.
if (process.env.SPAWN_KEEPALIVE !== '0') {
  let spawnKeep = false
  setInterval(async () => {
    if (spawnKeep || !bot.entity || bot.health <= 0) return
    try {
      const suspect = !!(provision.isSpawnSuspect && provision.isSpawnSuspect())
      const kb = provision.knownBed && provision.knownBed()
      if (!kb) return
      const d = Math.hypot(kb.x - bot.entity.position.x, kb.z - bot.entity.position.z)
      if (d > 24) return // keepalive is a NEAR-bed reflex; far-anchor repair is recoverSpawnAnchor's job
      if (bot.isSleeping || navigate.isRecovering() || navigate.isForceUnsticking() || (commands.isEscaping && commands.isEscaping())) return
      if (!suspect) {
        if (bot.pathfinder && bot.pathfinder.goal) return // someone is driving - don't hijack
        if (navigate.isNavigating()) return
        if (commands.isBusy && commands.isBusy()) return  // builds re-assert on their own passes
      }
      spawnKeep = true
      const ok = await provision.ensureSpawnBed(bot, { force: suspect, maxTrek: 40 })
      if (suspect && ok) note('(spawn) suspect anchor re-asserted at the bed - back to normal')
    } catch { /* transient */ } finally { spawnKeep = false }
  }, 45000).unref?.()
}

// HARD-WEDGE WATCHDOG: the last line of defense against multi-minute position freezes.
// If the body has been TRYING to move (pathfinder goal set / a navigation active) but
// the position hasn't budged for 2.5 minutes, force an escape through the recovery
// ladder directly (navigate.forceUnstick: hop, step-out, pillar/climb - all manual
// controls + natural-terrain digs only). Catches the cases the per-nav ladder can't:
// reflex storms that eat every nav's deadline, and isBusy() builds where the normal
// stuck detector is deliberately blind (live: a 2h creeper-standoff freeze in a cave
// pocket showed stuck:null the whole time). Disable with WEDGE_WATCHDOG=0.
if (process.env.WEDGE_WATCHDOG !== '0') {
  let wdHist = [] // ring of {x,y,z,t}
  let wdBusy = false
  let wdLastFire = 0
  setInterval(async () => {
    if (wdBusy || !bot.entity || bot.health <= 0) return
    const now = Date.now()
    const p = bot.entity.position
    wdHist.push({ x: p.x, y: p.y, z: p.z, t: now })
    while (wdHist.length && now - wdHist[0].t > 200000) wdHist.shift()
    // "trying to move" = someone is steering; a bot smelting/sleeping/digging in place is fine
    const trying = !!(bot.pathfinder && bot.pathfinder.goal) || navigate.isNavigating()
    if (!trying) return
    // Deliberate stillness is NOT a wedge. While SHELTERING/RESTING (bunker night-wait, bed
    // sleep) - or asleep / mid-dig - the bot is MEANT to sit still: firing the force-escape
    // here just fought the night-shelter reflex, pit-escaping the very bunker the shelter
    // re-sealed 5s later (live 379,62,40: 20+ min of watchdog-vs-shelter, farm cells never
    // advanced). Reset the freeze clock so a fresh 2.5-min window starts once we truly leave.
    if (bot.isSleeping || bot.targetDigBlock || (provision.isResting && provision.isResting())) { wdHist = []; return }
    // Only stand down for our OWN force-escape. A regular recovery/escape that has the
    // position FROZEN for 2.5 minutes is by definition failing (live: the ladder looped
    // door/nudge/stepout "no progress" for 4+ minutes at 433,62,112 and the old
    // isRecovering() gate kept this watchdog silent the whole time).
    if (navigate.isForceUnsticking()) return
    const old = wdHist.find(h => now - h.t >= 150000)
    if (!old) return // not enough history yet
    const moved = Math.hypot(p.x - old.x, p.y - old.y, p.z - old.z)
    if (moved >= 1.5) return
    if (now - wdLastFire < 240000) return // one forced escape per 4 min - never a tight loop
    wdLastFire = now
    wdBusy = true
    try {
      note(`(watchdog) position FROZEN ~${Math.round((now - old.t) / 1000)}s at ${p.floored()} while trying to move - forcing an escape`)
      const ok = await navigate.forceUnstick(bot)
      note(`(watchdog) force-escape ${ok ? 'MOVED me to ' + bot.entity.position.floored() : 'could not move me - will retry in 4 min'}`)
      if (ok) wdHist = []
    } catch (e) { note(`(watchdog) force-escape failed: ${e.message}`) } finally { wdBusy = false }
  }, 5000).unref?.()
}

// Auto-collect: when idle (no active pathfinder goal) and a dropped item is close
// by, walk over and pick it up - so the bot tidies up after a chop/hunt without the
// brain micromanaging it. Skipped whenever it already has a goal (following / going
// somewhere) so it never yanks itself off-task. Disable with AUTO_COLLECT=0.
let collecting = false
if (process.env.AUTO_COLLECT !== '0') {
  setInterval(async () => {
    if (collecting || !bot.entity || !bot.pathfinder || bot.pathfinder.goal) return
    // never wander off mid-provision/build - those flows manage their own
    // movement and pickups, and surprise walks force inventory desyncs
    if (commands.isBusy && commands.isBusy()) return
    if (arbiter.maneuverActive()) return // a navigation owns the body (e.g. entering the hut) - don't grab drops mid-approach
    try {
      const me = bot.entity.position
      let best = null; let bestD = 8
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position) continue
        if (e.name !== 'item') continue // real drops only (the 'item' entity type)
        // NEVER dive for drops: items sunk in water lured the idle bot to the river
        // bottom and it drowned reclaiming its own death-drops (test server, verified
        // by the server log). Submerged junk isn't worth a corpse-run either way.
        try {
          const at = bot.blockAt(e.position.floored()); const above = bot.blockAt(e.position.floored().offset(0, 1, 0))
          if ((at && /water/.test(at.name)) || (above && /water/.test(above.name))) continue
        } catch {}
        const d = e.position.distanceTo(me); if (d > 1.3 && d < bestD) { bestD = d; best = e }
      }
      if (!best) return
      collecting = true
      // range 0: actually walk ONTO the item's block - range 1 can count as "arrived"
      // a block short, so the bot never touches the drop and never picks it up.
      await bot.pathfinder.goto(new goals.GoalNear(best.position.x, best.position.y, best.position.z, 0))
    } catch { /* item vanished / unreachable - retry next tick */ } finally { collecting = false }
  }, 3000)
}

// IDLE SCAFFOLD SWEEP: orphaned towers (a death or restart mid-harvest abandons them;
// the operator kept finding dirt/cobble columns all over the forest) get torn down
// whenever the bot idles near one - the registry persists, so restarts can't orphan.
// Only registry entries older than 2 min (never yank scaffold a flow just placed).
if (process.env.AUTO_SCAFFOLD_SWEEP !== '0') {
  let sweeping = false
  setInterval(async () => {
    if (sweeping || !bot.entity || !bot.pathfinder || bot.pathfinder.goal) return
    if ((commands.isBusy && commands.isBusy()) || (provision.isResting && provision.isResting())) return
    if (navigate.isNavigating() || navigate.isRecovering()) return
    try {
      const scaffold = require('./scaffold.js')
      const stale = scaffold.near(bot.entity.position, 20).filter(e => Date.now() - e.t > 120000)
      if (!stale.length) return
      sweeping = true
      const n = await scaffold.teardown(bot, bot.entity.position, { radius: 20, max: 12 })
      if (n) note(`(scaffold) idle sweep tore down ${n} orphaned block(s)`)
    } catch {} finally { sweeping = false }
  }, 45000)
}

// DROWN CRISIS (survival tier, fires EVEN WHILE BUSY): the arbiter emits a 'drowning' need
// (head underwater) but NOTHING consumed it - the bot drowned gear-mining into a pond aquifer.
// This is that missing consumer, replacing the old parallel AUTO_SURFACE (which lost because a
// still-running job's goto kept stomping swimToShore's manual controls). It triggers off the ONE
// authority (survivalNeed==='drowning'; lava/fire outrank it, and it shadows 'heal' so an hp
// crisis waits until the bot can breathe), takes the controls via navigate.escapeWater (a SURVIVE
// maneuver span the lower reflexes defer to), and NEVER gates on isBusy - firing while busy IS
// the override, exactly like the hp-crisis reflex above. Disable with AUTO_SURFACE=0.
if (process.env.AUTO_SURFACE !== '0') {
  let wetHist = 0        // decaying persistence: +1 wet / -1 dry, clamped 0..4 (bobbing between digs still accumulates - NOT a hard reset on one dry poll)
  let drownStart = 0     // when this drowning episode began (for the gate-starvation override)
  let drownCooldownUntil = 0
  let drowning = false
  setInterval(async () => {
    if (drowning || !bot.entity) return
    if (Date.now() < drownCooldownUntil) return
    const n = provision.survivalNeed(bot)
    const isDrown = !!(n && n.need === 'drowning')
    if (isDrown) { wetHist = Math.min(4, wetHist + 1); if (!drownStart) drownStart = Date.now() }
    else { wetHist = Math.max(0, wetHist - 1); if (wetHist === 0) drownStart = 0; return }
    if (wetHist < 3) return // ~3 of the last 4 polls wet (2s cadence ~= 6s submerged) before intervening
    const persistedMs = drownStart ? Date.now() - drownStart : 0
    // Defer to an escape/recovery/rest already in progress - UNLESS drowning has persisted
    // >=16s: a recovery not producing air in 16s is failing and drowning kills in ~25s, so
    // fire ANYWAY (closes gate-starvation). bot.isSleeping is always respected.
    if (persistedMs < 16000) {
      if (commands.isEscaping && commands.isEscaping()) return
      if (navigate.isRecovering() || navigate.isForceUnsticking()) return
      if (provision.isResting && provision.isResting()) return
    }
    if (bot.isSleeping) return
    drowning = true
    try {
      note('(drown-crisis) head underwater - taking the controls to get out of the water')
      const ok = await navigate.escapeWater(bot, { isStopped: () => false })
      note(`(drown-crisis) ${ok ? 'out of the water' : 'still wet - will retry after a cooldown'}`)
      if (!ok) drownCooldownUntil = Date.now() + 10000
    } catch (e) { note(`(drown-crisis) failed: ${e.message}`); drownCooldownUntil = Date.now() + 10000 } finally { drowning = false; wetHist = 0; drownStart = 0 }
  }, 2000)
}

// Auto-torch (OPT-IN, default OFF - set AUTO_TORCH=1): a companion that lights the
// way at night. Deliberately conservative because it's an autonomous block-placer:
// only at night, only on natural ground (placeTorchNearby), throttled, and skipped
// if a torch/lantern is already close - so it never spams or decorates builds.
let lastTorchAt = 0
let _torchIds = null
function torchBlockIds (bot) {
  if (_torchIds) return _torchIds
  try {
    const md = require('minecraft-data')(bot.version)
    const ids = Object.values(md.blocksByName).filter(b => /torch|lantern/.test(b.name)).map(b => b.id)
    if (ids.length) _torchIds = ids // cache only on success; leave null to retry if mcData wasn't ready
    return ids
  } catch { return [] } // don't cache a failure - a permanently-empty list would disable the dedup guard
}
const AUTO_TORCH_MS = parseInt(process.env.AUTO_TORCH_MS || '8000', 10)
if (process.env.AUTO_TORCH === '1') {
  setInterval(async () => {
    if (!bot.entity || !bot.time || bot.time.timeOfDay < 13000) return // daytime - skip
    if (bot.targetDigBlock) return // never interrupt a dig to decorate (aborts reset break progress)
    if (Date.now() - lastTorchAt < AUTO_TORCH_MS) return
    try {
      const ids = torchBlockIds(bot)
      if (ids.length && bot.findBlock({ matching: ids, maxDistance: 6 })) return // already lit nearby
      const r = await commands.placeTorchNearby(bot)
      if (/placed torch/.test(r)) { lastTorchAt = Date.now(); note(`(auto-torch) ${r}`) }
    } catch { /* not ready / placement raced - retry next tick */ }
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
// If it stays stuck, note it once and stop hammering - the dynamic follow will pick
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
      // ONLY leash a PLAYER-follow. A GoalFollow on a MOB (the survival/armor cow-hunt uses
      // one) would otherwise trip this reflex: it re-paths to a fleeing cow every 3s, fighting
      // the hunt loop and dragging the bot hundreds of blocks off the build (seen live).
      if (!target || !target.position || target.type !== 'player') { leashLastPos = null; leashStuckSince = 0; leashGaveUp = null; return }
      const me = bot.entity.position
      const dist = target.position.distanceTo(me)
      if (dist <= 6) { leashLastPos = me.clone(); leashStuckSince = 0; leashGaveUp = null; return } // following fine
      const moved = leashLastPos ? me.distanceTo(leashLastPos) : Infinity
      leashLastPos = me.clone()
      if (moved > 0.6) { leashStuckSince = 0; leashGaveUp = null; return } // making progress toward them
      if (!leashStuckSince) { leashStuckSince = Date.now(); leashLastKick = 0; return } // just stalled - start the clock
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
        note(`(leash) can't reach ${who} (${dist.toFixed(0)}m) - blocked, holding`)
        commands.recordOutcome && commands.recordOutcome('follow', false, `can't reach ${who} - blocked (${dist.toFixed(0)}m)`)
        leashGaveUp = target
      }
    } catch { /* not ready */ }
  }, 1500)
}

// Sticky-follow reflex: keep trailing whoever you told the bot to follow, even after
// the autonomous brain briefly switches tasks (attack a mob / goto a spot / scan) -
// those replace the follow goal, and previously the bot just stopped once they
// finished ("why did it stop following me"). This re-issues the follow goal whenever
// the body goes idle, until you say "stop". Complements the leash reflex (which only
// fires while a follow goal is STILL active but stuck). Disable with STICKY_FOLLOW=0.
let stickyFollowLogged = null
if (process.env.STICKY_FOLLOW !== '0') {
  setInterval(() => {
    try {
      const r = commands.maybeResumeFollow && commands.maybeResumeFollow(bot)
      if (r) { // note only when the target changes, so we don't spam the log on each resume
        if (stickyFollowLogged !== r) { note(`(sticky-follow) ${r}`); stickyFollowLogged = r }
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

// S1 HOTFIX (REDESIGN §3.3 I1 / §3.4): is an incoming SURVIVAL command admissible RIGHT NOW,
// i.e. may it preempt a body hold instead of being muzzled by it? True when arbiter (the survival
// authority) reports a real unmet need, OR a worthwhile non-dangerous grave is within GRAVE_NEAR
// - at 3 blocks the grave IS the survival move (free armor + often food, zero trek risk). Pure
// read; no side effects. Pre-scheduler this stands in for scheduler.admissible('survival', s).
function survivalAdmissible (bot) {
  try { const need = provision.survivalNeed && provision.survivalNeed(bot); if (need) return { allow: true, reason: need.reason || need.need || 'survival need' } } catch {}
  try {
    const g = commands.worthwhileGrave && commands.worthwhileGrave() // already non-dangerous + worth it
    const st = commands.state(bot)
    if (g && st && st.pos && !st.threat) {
      const GRAVE_NEAR = Number(process.env.GRAVE_NEAR || 16)
      const d = Math.hypot(g.x - st.pos.x, g.z - st.pos.z)
      if (d <= GRAVE_NEAR) return { allow: true, reason: `grave ${Math.round(d)}b away - free gear` }
    }
  } catch {}
  return { allow: false, reason: 'no survival need and no grave in reach' }
}
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, spawned: !!bot.entity })
  if (req.method === 'GET' && (req.url === '/state' || req.url.startsWith('/state?'))) {
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
      // Only the BRAIN's poll (?brain=1) spends the delivery budget. A generic
      // /state read (the dashboard polls every ~1s) must NOT drain it, or a
      // player's message expires before the brain gets its MAX_DELIVERIES turns.
      if (/[?&]brain=1(?:&|$)/.test(req.url)) pending.forEach(c => { c.deliveries++ })
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
      let why = '' // the brain's stated motive for this command, if it sent one
      try { const j = JSON.parse(data); if (j && typeof j.command === 'string') line = j.command; if (j && typeof j.reason === 'string') why = j.reason } catch {}
      const rz = why ? ` «${String(why).slice(0, 80)}»` : '' // shown in /log so "why did it do X" is answerable
      // BRAIN CONFINEMENT: block world-editing/admin commands on the API path so
      // the autonomous brain can't grief or dupe. Operators use in-game !commands.
      if (process.env.BRAIN_ALLOW_CHEATS !== '1' && CHEAT_CMDS.test(String(line).trim())) {
        note(`(cmd) ${line}${rz} -> BLOCKED (world-edit/admin is operator-only)`)
        return send(res, 200, 'blocked: world-editing/admin commands are operator-only')
      }
      // While an operator-triggered build/provision is driving the body, don't let
      // the brain's own commands fight it - allow only perception + chat so the brain
      // holds (and can still talk) until the build finishes. NOTE: `stop` is deliberately
      // NOT whitelisted here - the autonomous brain must not be able to cancel an
      // operator's build on a heartbeat whim (it did, repeatedly, stranding the bot far
      // from the site). A real OPERATOR's "stop" still works: it comes through the
      // bot.on('chat') directCommand path, which calls commands.handle directly and
      // bypasses this gate entirely. So only the brain's self-issued stop is suppressed.
      // Also held while NIGHT-RESTING: the brain's goto/attack was yanking the pathfinder
      // out from under the shelter dig / bed trek - it must not fight the body for the
      // controls in the exact moments survival depends on them (death carousels, verified
      // on test server). Same read-only whitelist applies.
      // The busy-gap loophole: between build phases isBusy() is briefly false, and the
      // brain's `stop` slipped through and CLEARED the persisted castle job ("can't
      // recover, stuck in maze" -> stopped, live). While a saved build job exists on
      // disk, the brain's stop is always suppressed - that file is operator intent.
      if (/^stop\b/i.test(String(line).trim()) && commands.persistedResume && commands.persistedResume()) {
        note(`(cmd) ${line}${rz} -> held (a saved build job exists - the brain may not cancel it)`)
        return send(res, 200, "held: there's a build to finish - i shouldn't stop it")
      }
      const bodyBusy = (commands.isBusy && commands.isBusy()) || (provision.isResting && provision.isResting()) || (provision.isSecuringFood && provision.isSecuringFood())
      const trimmedLine = String(line).trim()
      const readOnly = /^(state|scan|find|block|entities|inventory|look|say)\b/i.test(trimmedLine)
      if (bodyBusy && !readOnly) {
        // S1 HOTFIX (REDESIGN §3.4): survival-class commands are no longer muzzled by the body's
        // own hold - they PREEMPT it. The live freeze: `recover`/`eat`/`wear` suppressed for 8+
        // minutes at 1hp/food 0 while famineHold sat inside `_securingFood` with iron in a grave
        // 3b away. When a real survival need exists (or a grave is at arm's reach) the command
        // sets the stop latch (the failing hold unwinds; any build resumes via persistedResume)
        // and falls through to run. Progress-class commands keep exactly today's suppression.
        // S1_HOTFIX=0 restores the old blanket hold. `stop`-suppression + the persisted-build
        // hold above are UNTOUCHED (they guard operator intent, orthogonal to survival).
        const survivalCmd = process.env.S1_HOTFIX !== '0' && /^(recover|getstuff|eat|wear|armorup|sleep)\b/i.test(trimmedLine)
        const adm = survivalCmd ? survivalAdmissible(bot) : null
        if (survivalCmd && adm.allow) {
          note(`(cmd) ${line}${rz} -> PREEMPT (${adm.reason}) - survival outranks the current hold`)
          if (commands.preemptForSurvival) commands.preemptForSurvival() // set the stop latch; a build resumes via persistedResume
          // fall through: the survival command runs and owns the body
        } else {
          const label = commands.isBusy && commands.isBusy() ? 'busy building' : (provision.isSecuringFood && provision.isSecuringFood() ? 'securing food' : 'night-resting')
          note(`(cmd) ${line}${rz} -> held (${survivalCmd ? 'no survival need: ' + adm.reason : label}) - brain command suppressed`)
          // If a PLAYER just asked for this (the held command is the brain answering them),
          // don't leave them on read - the BODY replies once with what it's doing. Verified
          // live: "digital go sleep" -> six silent holds and the player heard nothing.
          if (Date.now() - lastAddressedAt < 20000 && Date.now() - lastBusyReplyAt > 30000) {
            lastBusyReplyAt = Date.now()
            let doing = 'working'
            try { const a = commands.state(bot).activity; if (a && a.name) doing = a.name + (a.detail ? ' (' + a.detail + ')' : '') } catch {}
            bot.chat(`can't right now - busy with ${doing}. say "stop" first if you need me to drop it`.slice(0, 200))
            clearPendingChat() // that IS the answer - stop the brain re-trying the same order
          }
          return send(res, 200, "busy building right now - I'll hold until it's done")
        }
      }
      // ONE JOB AT A TIME (operator order): while a saved build job exists, the brain may
      // not wander the body off on side-trips in the idle gap before the resume re-arms -
      // it walked 240 blocks from the site that way (live). Survival (eat/fish/farm/sleep/
      // flee/recover), perception, and chat stay allowed; everything that MOVES is held.
      if (!bodyBusy && commands.persistedResume && commands.persistedResume() &&
          /^(goto|travel|explore|collect|gather|mine|chop|dig|follow|come|build)\b/i.test(String(line).trim())) {
        note(`(cmd) ${line}${rz} -> held (a build job is waiting - one job at a time)`)
        return send(res, 200, "held: i have a build to get back to - no side trips")
      }
      const drop = gateSay(line, true) || gateImpactful(line) // brain: gated chat + repeat-guard
      if (drop) { note(`(cmd) ${line}${rz} -> skipped (${drop})`); return send(res, 200, `skipped: ${drop}`) }
      noteManualLook(line)
      try {
        const result = await commands.handle(bot, line)
        // A non-perception command is the brain's response to any waiting player,
        // so consider the request answered (perception commands keep it pending).
        if (!PREP_CMDS.test(String(line).trim())) clearPendingChat()
        note(`(cmd) ${line}${rz} -> ${result.split('\n')[0]}`)
        send(res, 200, result)
      } catch (e) {
        note(`(cmd error) ${line} -> ${e.message}`)
        send(res, 500, `error: ${e.message}`)
      }
    })
    return
  }
  // ---- dashboard UI ---------------------------------------------------------
  if (req.method === 'GET' && (req.url === '/' || req.url === '/ui' || req.url === '/ui.html')) {
    // the browser dashboard is retired - the Animus GUI talks to this same API
    return send(res, 200, 'Animus control API. Use the Animus GUI (Animus.exe).')
  }
  // Live brain settings (model / goal / on-off) for the dashboard + the brain.
  if (req.method === 'GET' && req.url === '/brain') {
    return send(res, 200, { settings: brainSettings, models: ollamaModels })
  }
  if (req.method === 'POST' && req.url === '/brain') {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => {
      try {
        const j = JSON.parse(data)
        if (j.model != null) brainSettings.model = String(j.model)
        if (j.goal != null) brainSettings.goal = String(j.goal)
        if (j.enabled != null) brainSettings.enabled = !!j.enabled
        note(`(brain) settings -> model=${brainSettings.model} enabled=${brainSettings.enabled}`)
      } catch { return send(res, 400, 'bad json') }
      send(res, 200, brainSettings)
    })
    return
  }
  // ---- connection config (server + account) the dashboard can edit ----------
  if (req.method === 'GET' && req.url === '/config') {
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) } catch {}
    return send(res, 200, {
      host: saved.host, port: saved.port, version: saved.version, auth: saved.auth,
      username: saved.username, operators: saved.operators || [],
      aliases: saved.aliases || [], bedrockPort: saved.bedrockPort,
      floodgatePrefix: saved.floodgatePrefix, controlHost: saved.controlHost, controlPort: saved.controlPort,
      connected: !!bot.entity, // is it actually in-world right now?
      liveHost: process.env.MC_HOST || saved.host, livePort: process.env.MC_PORT || saved.port
    })
  }
  if (req.method === 'POST' && req.url === '/config') {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => {
      let j
      try { j = JSON.parse(data) } catch { return send(res, 400, 'bad json') }
      const file = path.join(__dirname, 'config.json')
      let saved = {}
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
      // merge only the connection fields; validate lightly
      if (j.host != null) saved.host = String(j.host).trim()
      if (j.port != null) { const p = parseInt(j.port, 10); if (Number.isFinite(p)) saved.port = p }
      if (j.version != null) saved.version = String(j.version).trim()
      if (j.auth != null && ['offline', 'microsoft'].includes(j.auth)) saved.auth = j.auth
      if (j.username != null) saved.username = String(j.username).trim()
      if (Array.isArray(j.operators)) saved.operators = j.operators.map(s => String(s).trim()).filter(Boolean)
      if (Array.isArray(j.aliases)) saved.aliases = j.aliases.map(s => String(s).trim()).filter(Boolean)
      if (j.bedrockPort != null) { const p = parseInt(j.bedrockPort, 10); if (Number.isFinite(p)) saved.bedrockPort = p }
      if (j.floodgatePrefix != null) saved.floodgatePrefix = String(j.floodgatePrefix).trim()
      if (j.controlHost != null && String(j.controlHost).trim()) saved.controlHost = String(j.controlHost).trim()
      if (j.controlPort != null) { const p = parseInt(j.controlPort, 10); if (Number.isFinite(p)) saved.controlPort = p }
      try { fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n') } catch (e) { return send(res, 500, `couldn't save: ${e.message}`) }
      note(`(config) saved -> ${saved.host}:${saved.port} auth=${saved.auth}${j.reconnect ? ' (reconnecting)' : ''}`)
      send(res, 200, { ok: true, reconnect: !!j.reconnect })
      // Reconnect = restart the process so mineflayer makes a fresh connection with
      // the new settings. The supervisor (run.js) brings it right back up. NOTE:
      // env vars (MC_HOST/...) override config.json, so this only takes effect if
      // the bot was launched WITHOUT those overrides (which the launcher does).
      if (j.reconnect) setTimeout(() => { note('(config) restarting to apply new connection...'); process.exit(0) }, 400)
    })
    return
  }
  // OPERATOR command path for the LOCAL dashboard - full power, NOT brain-confined
  // (you're the human at the console; the autonomous brain still uses /cmd).
  if (req.method === 'POST' && req.url === '/op/cmd') {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', async () => {
      let line = data
      try { const j = JSON.parse(data); if (j && typeof j.command === 'string') line = j.command } catch {}
      noteManualLook(line)
      try {
        const result = await commands.handle(bot, line)
        clearPendingChat()
        note(`(ui-cmd) ${line} -> ${result.split('\n')[0]}`)
        // TRAINING DATA (human demonstrations): operator commands are gold-standard
        // corrections - "in this exact state, the human chose THIS". Logged alongside
        // the brain's decisions with source stamped for curation.
        try {
          fs.appendFile(path.join(__dirname, 'brain-decisions.jsonl'), JSON.stringify({
            t: Date.now(), source: 'operator', command: String(line).slice(0, 120),
            result: String(result).slice(0, 160), state: commands.state(bot)
          }) + '\n', () => {})
        } catch {}
        send(res, 200, result)
      } catch (e) { note(`(ui-cmd error) ${line} -> ${e.message}`); send(res, 500, `error: ${e.message}`) }
    })
    return
  }
  send(res, 404, 'not found')
})

// CONTROL_PORT/CONTROL_HOST env overrides let a second (test) instance run its
// control API on a free port alongside a live bot that already holds cfg.controlPort.
const controlPort = parseInt(process.env.CONTROL_PORT || cfg.controlPort, 10)
const controlHost = process.env.CONTROL_HOST || cfg.controlHost
server.listen(controlPort, controlHost, () => {
  note(`control API on http://${controlHost}:${controlPort}`)
})
