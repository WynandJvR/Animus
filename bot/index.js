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
      provision.rememberBed(here)
      note(`(respawn) bed memory was empty - re-learned my bed at ${Math.round(here.x)},${Math.round(here.y)},${Math.round(here.z)}`)
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
      for (let attempt = 0; attempt < 3; attempt++) { // deferred = old build loop still unwinding
        const r = commands.resumeBuild && await commands.resumeBuild(bot)
        if (r && r.deferred) { note('(resume) old build still unwinding - retrying in 30s'); await new Promise(res => setTimeout(res, 30000)); continue }
        if (r) note(`(resume) build ${r.stopped ? 'STOPPED' : 'finished'} after respawn: ${r.placed}/${r.total} placed`)
        else note('(resume) nothing to resume')
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

// Night-shelter: a NAKED bot at night with a hostile closing digs into a sealed pit and waits
// it out - a creeper can't reach you underground (it died to one, unarmed, mid-build). Only
// when IDLE: during a build the gather loop does this itself (a reflex must not fight its
// pathfinder). Body-side because the brain is HELD during builds. Set NIGHT_SHELTER=0 to off.
let sheltering = false
if (process.env.NIGHT_SHELTER !== '0') {
  setInterval(async () => {
    if (sheltering || !bot.entity) return
    if (commands.isBusy && commands.isBusy()) return // the gather loop covers the build case
    if (provision.isSecuringFood && provision.isSecuringFood()) return // feeding run owns the body
    // Two triggers: VULNERABLE at night (naked - always rest, the death carousels were all
    // naked), or simply IDLE at night with a bed on the map - a player with nothing to do
    // goes to bed even in full iron (operator asked for exactly this). Armored + mid-task
    // keeps working the night; armored + idle sleeps.
    const idleNight = provision.isNight(bot) && !bot.pathfinder.goal && provision.knownBed && provision.knownBed()
    if (!provision.shelterNeeded(bot) && !idleNight) return
    sheltering = true
    try { if (await provision.nightRest(bot, { say: m => bot.chat(String(m).slice(0, 200)) })) note('(shelter) rested for the night' + (provision.underArmored(bot) ? ' (bed or pit) - no armor, mobs about' : ' - nothing better to do than sleep')) }
    catch (e) { /* transient */ } finally { sheltering = false }
  }, 5000).unref?.()
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
let lastChargeNoteAt = 0
const RANGED_RE = /skeleton|stray|bogged|pillager/i
if (process.env.AUTO_DEFEND !== '0') {
  setInterval(() => {
    if (!bot.entity) return
    // While digging UP out of a cave, don't let the flee reflex hijack the pathfinder
    // sideways - rising out of the hole IS the escape (fleeing horizontally just keeps us
    // in the mob-filled cave and pins us at depth).
    if (commands.isEscaping && commands.isEscaping()) return
    // Same rule while a navigation RECOVERY is maneuvering (pillaring out of a pit,
    // threading a doorway, hopping from water) - the recovery IS the escape.
    if (navigate.isRecovering()) return
    // While digging into a night bunker, the flee reflex must NOT drag us off - being sealed
    // underground IS the escape (a sealed pit beats fleeing a creeper). Yield to the shelter.
    if (provision.isSheltering && provision.isSheltering()) return
    try {
      const me = bot.entity.position
      const hp = bot.health == null ? 20 : bot.health
      if (hp < dfLastHp - 0.5) dfHurtAt = Date.now() // health dropped - we're being HIT
      dfLastHp = hp
      const underFire = Date.now() - dfHurtAt < 8000
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

// SURFACE REFLEX (survival tier, like auto-defend): head underwater for 8+ seconds
// means whatever flow is running is failing to keep the bot breathing - take the
// controls and swim ashore. The rest/shelter flows carry their own ashore guards, and
// navigation recoveries may be mid-maneuver, so those get right of way; everything
// else (a build placing river-bank cells, a stray goto, an idle bob) gets rescued.
// Disable with AUTO_SURFACE=0.
if (process.env.AUTO_SURFACE !== '0') {
  let wetTicks = 0
  let surfacing = false
  setInterval(async () => {
    if (surfacing || !bot.entity) return
    let headWet = false
    try { const h = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0)); headWet = !!(h && /water/.test(h.name)) } catch {}
    if (!headWet) { wetTicks = 0; return }
    wetTicks++
    if (wetTicks < 4) return // 4 ticks x 2s = 8s submerged before intervening
    if ((commands.isEscaping && commands.isEscaping()) || navigate.isRecovering() || (provision.isResting && provision.isResting())) return
    surfacing = true
    try {
      note('(surface) head underwater 8s+ - taking the controls and swimming ashore')
      try { bot.pathfinder.setGoal(null) } catch {}
      await navigate.swimToShore(bot, () => false)
    } catch {} finally { surfacing = false; wetTicks = 0 }
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
      if (bodyBusy && !/^(state|scan|find|block|entities|inventory|look|say)\b/i.test(String(line).trim())) {
        note(`(cmd) ${line}${rz} -> held (${commands.isBusy && commands.isBusy() ? 'busy building' : (provision.isSecuringFood && provision.isSecuringFood() ? 'securing food' : 'night-resting')}) - brain command suppressed`)
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
