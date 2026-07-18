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
const loghistory = require('./loghistory.js') // compact rolling state time-series + heartbeat (observability)
const scheduler = require('./scheduler.js') // S4: pure survival-tier decision core (commandClass/admissible/pickJob) - wires the busy-gate + the tick
const maintain = require('./maintain.js') // #40 F2: pure buffer needs() - to detect a pending food (pack/bank) need when an opp window is abandoned
const foodSec = require('./food.js') // #40 F3.2: pure busy-preempt food threshold (FOOD_SURVIVAL raises it 6 -> 10)
const cycleDetect = require('./cycle-detect.js') // task #34: pure behavioral cycle/oscillation detector - fed into the S7 watchdog's existing ladder (no new subsystem)
const SCHED_ON = process.env.SCHEDULER !== '0' // master flag: SCHEDULER=0 restores the S1-hotfix wiring byte-for-byte (gate takes the survivalAdmissible path, the tick never registers, the 3 reflexes run as today)
const LADDER_ON = SCHED_ON && process.env.RECOVERY_LADDER !== '0' // S5: RECOVERY_LADDER=0 restores S4's recoveryLadder DOWNGRADE + the one-shot respawn grave gating byte-for-byte
const MAINTAIN_ON = SCHED_ON && process.env.MAINTAIN !== '0' // S6: MAINTAIN=0 restores the defer-note + the four proactive reflexes on their old timers byte-for-byte
const WATCHDOG_ON = SCHED_ON && process.env.WATCHDOG !== '0' // S7: the in-process forward-progress watchdog. WATCHDOG=0 -> no interval, no heartbeat merge, no wdPhase call; the touchProgress hooks remain as inert timestamps nobody reads (behaviorally byte-identical)
const CYCLE_DETECT_ON = WATCHDOG_ON && process.env.CYCLE_DETECT !== '0' // task #34: the behavioral cycle detector. An S7 ORGAN (not a peer) - lives inside the wdTimer, so WATCHDOG=0 kills it too. CYCLE_DETECT=0 -> no sampling, no verdict override, no ring read: byte-identical to today.
const OPP_ON = MAINTAIN_ON && process.env.OPPORTUNISTIC_MAINTAIN !== '0' // opportunistic at-hut maintenance during the build era; OPPORTUNISTIC_MAINTAIN=0 restores S6 byte-for-byte
const CYCLE_SELFABORT_EXEMPT = process.env.CYCLE_SELFABORT_EXEMPT !== '0' // #49: exempt watchdog/preempt-induced "(stopped)" self-aborts from repeatFail eligibility. Default ON; =0 restores today byte-for-byte (the selfAbort ring field goes unread)
const RESILIENT_ON = SCHED_ON && process.env.RESILIENT_RECOVERY !== '0' // #41: invert build-vs-recovery priority after a death (postDeathRecovery latch + bank re-arm). RESILIENT_RECOVERY=0 restores today byte-for-byte (deathsRecent>=2 preempt gate, un-suppressed respawn ladder, no latch)

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
let _logDrops = 0 // consecutive event-log writes lost (transient Windows file lock / EMFILE / ENOSPC / vanished dir)
function fileLog (line) {
  const write = () => {
    try { if (fs.statSync(EVENTS_LOG).size > 5 * 1024 * 1024) fs.renameSync(EVENTS_LOG, EVENTS_LOG + '.old') } catch {}
    fs.appendFileSync(EVENTS_LOG, line + String.fromCharCode(10))
  }
  try { write() } catch {
    // The sink threw - almost always a transient Windows lock (an editor/tail/AV
    // holding the file with no share-write), EMFILE, or the logs/ dir was removed.
    // ROOT of the old "went stale for hours" bug: the previous empty `catch {}`
    // swallowed this and every subsequent line silently. Recreate the dir + retry
    // ONCE; if it still fails, count the drop rather than crash the caller.
    try { fs.mkdirSync(path.dirname(EVENTS_LOG), { recursive: true }); write() } catch { _logDrops++; return }
  }
  // Recovered after a stall: surface the gap IN the log so a post-mortem sees the
  // hole instead of a silent multi-hour jump.
  if (_logDrops > 0) {
    const n = _logDrops; _logDrops = 0
    try { fs.appendFileSync(EVENTS_LOG, `[${new Date().toISOString()}] (logsink) recovered after ${n} dropped line(s)` + String.fromCharCode(10)) } catch {}
  }
}
function note (msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  log.push(line)
  if (log.length > 200) log.shift()
  // Isolate console.log: a broken supervisor stdout pipe (EPIPE, e.g. its window
  // closed) throwing here must NOT abort note() before fileLog runs - that would
  // stall the FILE while the in-memory /log ring stays current (the exact split
  // symptom seen live). The file sink is the flight recorder; protect it.
  try { console.log(line) } catch {}
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
require('./pathfix.js').setProgressSink(commands.touchProgress) // [S7] a pathfix-VERIFIED place/break -> the forward-progress heartbeat
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
          const hold = commands.resumeHoldRemaining ? commands.resumeHoldRemaining(commands.persistedResume(), Date.now()) : 0
          if (hold > 0) { note(`(resume) held (paused, ${Math.round(hold / 1000)}s left - "resumebuild" overrides)`); return }
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
  let resumeHeldLogged = false // log the pause-hold once per state change, not every tick
  setInterval(async () => {
    try {
      if (!bot.entity) return
      const saved = commands.persistedResume && commands.persistedResume()
      if (!saved) return
      if (commands.isBusy && commands.isBusy()) return
      if (provision.isResting && provision.isResting()) return
      if (provision.isMaintaining && provision.isMaintaining()) return // an opp/idle maintenance pass owns the body - resume right after it
      // Don't fight the scheduler: while a survival need is active IT owns the body (actively
      // preempting the build for recovery), so re-issuing `resumebuild` every 2min just churns -
      // the body gets yanked toward the site, then bumped straight back to survival, spamming
      // "back online". Hold until progress is admissible again (mayDoProgress == no survival need).
      if (provision.mayDoProgress && !provision.mayDoProgress(bot)) { if (!resumeHeldLogged) { note('(resume) held (survival need active - the scheduler owns the body)'); resumeHeldLogged = true }; return }
      const hold = commands.resumeHoldRemaining ? commands.resumeHoldRemaining(saved, Date.now()) : 0
      if (hold > 0) {
        if (!resumeHeldLogged) { note(`(resume) held (paused, ${Math.round(hold / 1000)}s left - "resumebuild" overrides)`); resumeHeldLogged = true }
        return
      }
      resumeHeldLogged = false
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
    commands.handle(bot, line, { source: 'operator' })
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
      // S6: an operator's deterministic order STOPS a running maintenance pass so the body is free.
      if (provision.isMaintaining && provision.isMaintaining()) { try { const dcls = scheduler.commandClass(direct); if (dcls !== 'perception' && dcls !== 'chat') provision.stopMaintenance() } catch {} }
      note(`(direct-cmd) ${username}: "${message}" -> ${direct}`)
      commands.handle(bot, direct, { source: 'operator' })
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
    const loadRes = await commands.handle(bot, `schematic load ${file}`, { source: 'operator' })
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
        const tr = await commands.handle(bot, `travel ${point.x} ${point.y} ${point.z}`, { source: 'operator' })
        note(`(build-req) travel -> ${tr}`)
        if (/^couldn't get to/.test(tr)) { bot.chat(tr.slice(0, 256)); return } // never reached - don't churn
      }
    }
    // autobuild = build from inventory if we have the materials, else gather/craft
    // the whole bill of materials (stashing in a chest) first, then build.
    const buildRes = await commands.handle(bot, `autobuild center ${where}${req.clear ? ' clear' : ''}`, { source: 'operator' })
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
  // #41 P0: set the post-death recovery LATCH - recovery now OWNS the bot and OUTRANKS build-resume
  // until recoveryReady (P4). Cleared by provision.recoveryReadyNow / the scheduler tick. Reads are
  // flag-gated (isPostDeathRecovery), so RESILIENT_RECOVERY=0 leaves this inert = today byte-for-byte.
  commands.setPostDeathRecovery && commands.setPostDeathRecovery(true)
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
      // RECOVER_ON_RESPAWN=0 disables. NOTE (task #18): AxGraves graves DESPAWN on the server's
      // timer - a deferred grave is NOT guaranteed to keep; the ~15s tick re-evaluates every pass and
      // recover now prioritizes urgent graves + shortens the post-partial cooldown to race the timer.
      if (LADDER_ON) {
        // S5: route the grave/degraded step through the recovery ladder, so a deferral is
        // re-evaluated by the ~15s tick (pickJob graveSweep/recoveryLadder) instead of only on the
        // NEXT death. The home -> spawn-anchor order above and the autoRecoverTries cap are unchanged.
        if (process.env.RECOVER_ON_RESPAWN !== '0') {
          const g = commands.worthwhileGrave && commands.worthwhileGrave()
          let degraded = false
          try { degraded = scheduler.isDegraded(await provision.schedulerState(bot)) } catch {}
          if (RESILIENT_ON && (g || degraded)) {
            // #41 P1: SINGLE LADDER DRIVER. Don't fire the respawn handler's own recoverFromDegraded -
            // it raced the ~15s tick ladder on the mutex and logged the misleading "(no rung ran)"
            // NO-OP (RC-B). Instead SET the latch (already set by the death handler) and let the tick
            // own the ladder, kept alive until recoveryReady. The tick's pickJob sees degraded/grave.
            commands.setPostDeathRecovery && commands.setPostDeathRecovery(true)
            note('(respawn) degraded/grave after death - recovery latch set; the scheduler ladder owns recovery until fully re-armed (single driver)')
            autoRecoverTries = 0
          } else if ((g || degraded) && autoRecoverTries < 3) {
            autoRecoverTries++
            note(`(respawn) degraded/grave after death - running the recovery ladder (try ${autoRecoverTries}/3)`)
            try {
              const r = await provision.recoverFromDegraded(bot, { say: m => note('(respawn) ' + m), reason: 'respawn' })
              note(`(respawn) ladder -> ${r.done ? 'recovered' : 'not fully recovered'} via ${r.rungs.join(' > ') || '(no rung ran)'}`)
              if (r.done || !(commands.worthwhileGrave && commands.worthwhileGrave())) autoRecoverTries = 0
            } catch (e) { note(`(respawn) ladder failed: ${e.message}`) }
          } else if (!g) autoRecoverTries = 0
          // NO one-shot deferral note: whatever this pass could not finish, the ~15s tick's pickJob
          // sees (graveSweep <=16b / recoveryLadder on the degraded signature) and re-dispatches -
          // deferral is re-evaluated every tick, not once per death (REDESIGN §5 end, §7 S1).
        }
      } else if (process.env.RECOVER_ON_RESPAWN !== '0' && commands.worthwhileGrave) {
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

// FIX #19: wear better armor already in the pack even while BUSY. After a respawn or grave-loot the
// bot can carry armor it isn't wearing because equipping only happened in the busy-gated gearup path
// - so it built naked with iron in the pack. Equipping is an instant inventory op (no move/dig/nav/
// grief), so this reflex is DELIBERATELY NOT muzzled by isBusy (mirroring auto-eat). Carried-only:
// commands.equipCarriedArmor never treks/gathers/crafts (that's armorup). Set EQUIP_CARRIED_ARMOR=0.
let equippingArmor = false
if (process.env.EQUIP_CARRIED_ARMOR !== '0') {
  setInterval(async () => {
    if (equippingArmor || !bot.entity || bot.health <= 0) return
    equippingArmor = true
    try {
      const wore = await commands.equipCarriedArmor(bot)
      if (wore && wore.length) note(`(auto-equip) put on carried armor: ${wore.join(', ')}`)
    } catch { /* transient - retry next tick */ } finally { equippingArmor = false }
  }, 5000).unref?.()
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
    if (SCHED_ON) return // S4: the scheduler tick owns survival dispatch
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
      if ((await provision.secureFood(bot, { home, canHold: true, say: m => bot.chat(String(m).slice(0, 200)) })).fed) note('(survival) food secured - was starving with an empty pack')
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
    if (MAINTAIN_ON) return // S6: food<14 is a survival need (secureFood dispatch owns it); the pack-points buffer is maintain step 1. FOOD_TOPUP=0 still disables step 1.
    if (toppingUpFood || !bot.entity || bot.food == null || bot.food >= 14) return
    if (commands.isBusy && commands.isBusy()) return // busy jobs run their own secureFood
    if (provision.isResting && provision.isResting()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return
    if (provision.isRecoveringDegraded && provision.isRecoveringDegraded()) return // S5: the ladder owns the body between rungs
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
    if (SCHED_ON) return // S4: the scheduler tick owns survival dispatch
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
      note(`(food-crisis) ${ok.fed ? 'fed (or safely holding)' : 'still starving - will retry'}`)
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
    if (SCHED_ON) return // S4: the scheduler tick owns survival dispatch
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
    try { provision.noteWaterCrossing(bot) } catch {} // FARM_EXPAND passive river-crossing note (self-throttled <=1/60s, O(1), never navigates) - runs before the MAINTAIN gate so it ticks in every era
    if (MAINTAIN_ON) return // S6: farm tend/expand is maintain step 2. FOOD_SUPPLY=0 still disables step 2.
    if (buildingFoodSupply || !bot.entity) return
    if (commands.isBusy && commands.isBusy()) return // a job owns the body
    if (provision.isResting && provision.isResting()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return
    if (provision.isRecoveringDegraded && provision.isRecoveringDegraded()) return // S5: the ladder owns the body between rungs
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
    if (provision.isRecoveringDegraded && provision.isRecoveringDegraded()) return // S5: the ladder owns the body between rungs
    // Two triggers: VULNERABLE at night (naked - always rest, the death carousels were all
    // naked), or simply IDLE at night with a bed on the map - a player with nothing to do
    // goes to bed even in full iron (operator asked for exactly this). Armored + mid-task
    // keeps working the night; armored + idle sleeps.
    const idleNight = provision.isNight(bot) && !bot.pathfinder.goal && provision.knownBed && provision.knownBed()
    if (!provision.shelterNeeded(bot) && !idleNight) return
    // S6: don't yank a night indoor cook/courier into bed mid-deposit. shelterNeeded (a naked bot
    // at dusk) still WINS - this only holds the idle-sleep while a maintain pass is running safe.
    if (provision.isMaintaining && provision.isMaintaining() && !provision.shelterNeeded(bot)) return
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
    if (MAINTAIN_ON) return // S6: gear-up is maintain step 6 (same executor, back-off, nightStuck exception). GEAR_REFLEX=0 still disables step 6.
    if (gearing || !bot.entity) return
    if (recoveringHome) return // respawned far from base - GO HOME outranks re-arming in the wild
    if (commands.isBusy && commands.isBusy()) return // a job owns the body (its camp flow gears)
    if (arbiter.maneuverActive()) return // a navigation is driving - don't start the iron grind mid-walk
    if (provision.isResting && provision.isResting()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return
    if (provision.isRecoveringDegraded && provision.isRecoveringDegraded()) return // S5: the ladder owns the body between rungs
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
    if (MAINTAIN_ON) return // S6: home repair is maintain step 9 (same gates). HOME_REPAIR=0 still disables step 9.
    if (repairingHome || !bot.entity) return
    if (recoveringHome) return // respawned far from base - GO HOME outranks patching the base
    if (commands.isBusy && commands.isBusy()) return // a job owns the body (its camp pass repairs)
    if (arbiter.maneuverActive()) return // a navigation is driving - don't start a repair mid-walk
    if (provision.isResting && provision.isResting()) return
    if (provision.isSecuringFood && provision.isSecuringFood()) return
    if (provision.isRecoveringDegraded && provision.isRecoveringDegraded()) return // S5: the ladder owns the body between rungs
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

// SCHEDULER TICK (S4, REDESIGN §3.2/§10): ONE dispatcher for the survival tier. Replaces the three
// ad-hoc crisis timers above (SURVIVAL_HUNT/FOOD_CRISIS/HP_CRISIS early-return while SCHEDULER is
// on). Builds a snapshot, asks the pure pickJob which ONE job should own the body, and dispatches
// ONLY survival-class jobs to the existing executors (graveSweep->recover, secureFood, recoverHp),
// preempting a busy body only on a crisis-grade need or a near grave. SCHEDULER=0 removes it entirely.
let schedJob = null             // the single job-latch (I4): one scheduler dispatch at a time
let schedLastLog = ''           // decision-change log throttle
let schedHeldLog = ''           // busy-held note throttle (separate so it never clobbers the decision key)
let schedGraveCooldownUntil = 0 // failed grave recovery -> don't hammer an unreachable grave
let schedLadderCooldownUntil = 0 // S5: honest ladder non-completion -> don't re-run every 15s
let schedHpCooldownUntil = 0    // mirror of hpCrisisCooldownUntil (index.js hp-crisis)
let schedMaintainCooldownUntil = 0 // S6: 10 min after a completed pass, 5 min after a no-op/bail (mirrors schedLadderCooldownUntil)
let schedOppLastWindowAt = 0 // last opportunistic window CLOSE (drives the checkupDue bit)
let schedDeferNoted = ''        // one note per deferred job kind (nightShelter/maintain/degraded/ladder-reflex)
let schedLastPick = null        // S7 idle-with-work: the tick's last pickJob decision
let schedLastPickAt = 0
let schedLastTickAt = 0          // S7 tick-liveness: last time the tick body entered (the watchdog re-arms if this goes >90s stale)
let tickGen = 0                 // S7 generation guard: a resurrected tick chain can never coexist with the live one
if (SCHED_ON) {
  const GRAVE_NEAR_LADDER = Number(process.env.GRAVE_NEAR_LADDER || 32)
  const schedSay = m => bot.chat(String(m).slice(0, 200))
  const runJob = async (name, executor) => {
    schedJob = { name, startedAt: Date.now() }
    commands.touchProgress('dispatch:' + name) // S7 (d): a just-dispatched job is at zero idle (same t0 rule as beginActivity/H5c)
    try { const r = await executor(); note('(sched) ' + name + ' -> ' + (r === false ? 'no-op/deferred' : (typeof r === 'string' ? r.split('\n')[0] : 'done'))) }
    catch (e) { note('(sched) ' + name + ' failed: ' + e.message); if (CYCLE_DETECT_ON) { try { commands.recordOutcome('sched:' + name, false, e.message) } catch {} } } // task #34: today this only note()s+forgets; feed the outcome ring so a re-dispatch loop (gather held x8) is SEEN. Flag-gated so CYCLE_DETECT=0 leaves lastOutcome byte-identical.
    finally { schedJob = null }
  }
  const tick = async () => {
    const myGen = tickGen // S7 tick-liveness: capture this chain's generation; the finally only reschedules if still current
    schedLastTickAt = Date.now() // S7: liveness stamp - the watchdog re-arms the chain if this goes >90s stale
    try {
      // 1. GUARDS (cheap; mirror the crisis reflexes). NOT gated on arbiter.maneuverActive() - a
      //    survival preempt must be able to interrupt a nav leg (same as FOOD_CRISIS today).
      if (!bot.entity || schedJob) return
      if (commands.isEscaping && commands.isEscaping()) return
      if (navigate.isRecovering() || navigate.isForceUnsticking()) return
      if (bot.isSleeping) return
      // 2. SNAPSHOT + decision.
      const s = await provision.schedulerState(bot)
      // #41 P4: the SINGLE place the post-death latch clears on a regular cadence - the moment the
      // world reports recoveryReady (hp/food/armor/tools restored, or the best-affordable escape),
      // release the build. Runs even when there's no build to resume, so the latch never sticks.
      if (RESILIENT_ON && commands.isPostDeathRecovery && commands.isPostDeathRecovery()) {
        try { if (scheduler.recoveryReady(s).ready) { commands.clearPostDeathRecovery(); note('(sched) recovery complete - post-death latch cleared, the build may resume') } } catch {}
      }
      const pick = scheduler.pickJob(s)
      // 3. OBSERVABILITY: log on CHANGE (not every tick). Dispatches/outcomes always log (rare).
      const nearest = (s.graves || []).filter(g => g && !g.dangerous && g.value > 0 && g.dist != null).sort((a, b) => a.dist - b.dist)[0]
      const key = pick ? (pick.job + '|' + pick.preempt) : 'idle'
      if (key !== schedLastLog) {
        schedLastLog = key
        note(`(sched) pick=${pick ? pick.job : 'idle'}${pick && pick.preempt ? ' PREEMPT' : ''} reason="${pick ? pick.reason : 'idle'}" | hp=${s.hp} food=${s.food} packPts=${s.packFoodPts} armor=${s.armorPieces} graves=${(s.graves || []).length}${nearest ? '(near ' + Math.round(nearest.dist) + 'b)' : ''} home=${s.homeDist == null ? '?' : Math.round(s.homeDist) + 'b'}`)
      }
      schedLastPick = pick; schedLastPickAt = Date.now() // S7: expose the last decision to the idle-with-work watchdog
      // 4. Non-survival results are IGNORED (progress = body/resume already owns the goal; maintain
      //    dispatch is S6).
      if (!pick || pick.cls !== 'survival') {
        if (pick && pick.job === 'maintenancePass') {
          if (!MAINTAIN_ON) {
            if (schedDeferNoted !== 'maintain') { schedDeferNoted = 'maintain'; note('(sched) maintain needed - deferred to S6') }
            return
          }
          // S6 DISPATCH: admission gates (cheap, mirror the reflexes it replaces) - idle body +
          // idle pathfinder + fed + cooldown clear; at night restrict to indoor sub-steps AND
          // only when already near home. runJob's single schedJob latch keeps one dispatch at a time.
          if (schedJob || Date.now() < schedMaintainCooldownUntil) return
          const busy = (commands.isBusy && commands.isBusy()) || (provision.isResting && provision.isResting()) || (provision.isSecuringFood && provision.isSecuringFood()) || (provision.isRecoveringDegraded && provision.isRecoveringDegraded())
          if (busy) return
          if (bot.pathfinder && bot.pathfinder.goal) return
          if (!provision.mayDoProgress(bot)) return
          const night = !!(provision.isNight && provision.isNight(bot))
          if (night && (s.homeDist == null || s.homeDist > 48)) return // night: indoor-only, and only if already <=48b of home
          if (provision.isMaintaining && provision.isMaintaining()) return
          schedDeferNoted = ''
          await runJob('maintenancePass', async () => {
            const r = await provision.maintenancePass(bot, { say: schedSay, nightIndoorOnly: night })
            const worked = !!(r && r.steps && r.steps.length && !/^bail/.test(r.reason || ''))
            schedMaintainCooldownUntil = Date.now() + (worked ? 600000 : 300000) // 10 min after a real pass, 5 min after a no-op/bail
            return r && r.steps && r.steps.length ? r.steps.join('+') : (r && r.reason) || 'nothing due'
          })
          return
        }
        // OPPORTUNISTIC MAINTENANCE (design-docs/DESIGN-opportunistic-maintenance.md):
        // during the build era pickJob can never pick maintenancePass (persistedBuild
        // shadows it, scheduler.js:196) - so when the build's own life has the bot ALREADY
        // at the hut, open a brief bounded chore window: pause (never cancel) the build,
        // run the home-only maintenancePass, cool down, and let the 2-min re-arm resume it.
        if (!OPP_ON) return
        if (schedJob || Date.now() < schedMaintainCooldownUntil) return
        const checkupDue = Date.now() - schedOppLastWindowAt >= Number(process.env.OPP_CHECKUP_MS || 1800000)
        const elig = scheduler.oppMaintain(s, { checkupDue })
        if (!elig.ok) return
        // live re-checks the snapshot can't carry (mirror the S6 dispatch gates 1076-1082,
        // minus the busy gate - busy is the POINT when preempting):
        if (!provision.mayDoProgress(bot)) return
        if ((provision.isMaintaining && provision.isMaintaining()) || (provision.isResting && provision.isResting()) ||
            (provision.isSecuringFood && provision.isSecuringFood()) || (provision.isRecoveringDegraded && provision.isRecoveringDegraded())) return
        const wasBusy = commands.isBusy && commands.isBusy()
        if (elig.preempt && !wasBusy) return // activity says autobuild but the latch dropped - next tick re-reads
        if (!elig.preempt && (wasBusy || (bot.pathfinder && bot.pathfinder.goal))) return // idle path must be TRULY idle
        note('(sched) OPPORTUNISTIC MAINTAIN - ' + elig.reason + (elig.preempt ? ' (pausing the build; it resumes via re-arm)' : ''))
        await runJob('maintenancePass', async () => {
          if (elig.preempt) {
            commands.preemptForSurvival() // sets ONLY buildAbort; persistedResume intact (I-3)
            // #40 F2: if this windfall-deposit window is abandoned WHILE a pack/bank food need is
            // pending, retry in OPP_CRISIS_RETRY_MS (60s) instead of 300s - the only banking window
            // in the incident died to a 1s threat abort + a 300s cooldown, so the larder was never
            // stocked and R2 had nothing to withdraw. FOOD_SURVIVAL=0 -> foodNeedPending is false
            // -> the 300s cooldown byte-for-byte.
            const foodNeedPending = process.env.FOOD_SURVIVAL !== '0' && (() => { try { return maintain.needs(s).some(n => n.key === 'packFood' || n.key === 'bankFood') } catch { return false } })()
            const abandonCd = foodNeedPending ? Number(process.env.OPP_CRISIS_RETRY_MS || 60000) : 300000
            // bounded unwind wait: the aborted build settles at its next isStopped poll
            // (a mid-smelt unwind took ~33s live - commands.js:3281); bail on crisis.
            const unwindBy = Date.now() + Number(process.env.OPP_UNWIND_MS || 90000)
            while ((commands.isBusy && commands.isBusy()) && Date.now() < unwindBy) {
              let crisis = null; try { crisis = provision.survivalNeed(bot, { foodThreshold: foodSec.busyPreemptFood() }) } catch {}
              if (crisis) { schedMaintainCooldownUntil = Date.now() + abandonCd; return 'window abandoned - crisis (' + crisis.need + ') during unwind' + (foodNeedPending ? ' (food need pending - 60s retry)' : '') }
              await new Promise(r => setTimeout(r, 500))
            }
            if (commands.isBusy && commands.isBusy()) { schedMaintainCooldownUntil = Date.now() + abandonCd; return 'window abandoned - build did not unwind in time' + (foodNeedPending ? ' (food need pending - 60s retry)' : '') }
          }
          const windowEnd = Date.now() + Number(process.env.OPP_WINDOW_MS || 300000)
          const night = !!(provision.isNight && provision.isNight(bot))
          const r = await provision.maintenancePass(bot, {
            say: schedSay, nightIndoorOnly: night, opportunistic: true,
            isStopped: () => Date.now() > windowEnd
          })
          const worked = !!(r && r.steps && r.steps.length && !/^bail/.test(r.reason || ''))
          schedMaintainCooldownUntil = Date.now() + (worked ? 600000 : Number(process.env.OPP_NOOP_COOLDOWN_MS || 1800000))
          schedOppLastWindowAt = Date.now()
          return 'opp window: ' + (r && r.steps && r.steps.length ? r.steps.join('+') : (r && r.reason) || 'nothing due')
        })
        return
      }
      // 5. RESOLVE the executor (the dispatch map). `name` = the executor kind actually dispatched.
      const knownBed = (provision.knownBed && provision.knownBed()) || undefined
      let name = null
      let executor = null
      const wantSecureFood = () => { name = 'secureFood'; executor = async () => { const r = await provision.secureFood(bot, { home: knownBed, canHold: true, say: schedSay }); return r.fed ? `fed (food ${bot.food})` : `not fed - blocked on ${r.blockedOn}` } }
      const wantRecoverHp = () => { name = 'recoverHp'; executor = () => provision.recoverHp(bot, { say: schedSay }) }
      const wantRecover = () => { name = 'recover' } // recover has its own runner (cooldown needs the result); executor stays null
      if (pick.job === 'graveSweep') wantRecover()
      else if (pick.job === 'secureFood') wantSecureFood()
      else if (pick.job === 'recoverHp') wantRecoverHp()
      else if (pick.job === 'nightShelter') { if (schedDeferNoted !== 'nightShelter') { schedDeferNoted = 'nightShelter'; note('(sched) nightShelter - reflex-owned in S4, holding') } return }
      else if (pick.job === 'recoveryLadder') {
        if (LADDER_ON) {
          // S5: EXECUTE the ladder (provision.recoverFromDegraded runs recoveryPlan first-feasible).
          if (Date.now() < schedLadderCooldownUntil) return
          name = 'recoverFromDegraded'
          executor = async () => {
            const r = await provision.recoverFromDegraded(bot, { say: schedSay })
            if (!r.done) schedLadderCooldownUntil = Date.now() + 60000 // honest fail -> don't re-run every 15s
            return (r.done ? 'recovered' : 'NOT recovered (' + (r.reason || 'rungs exhausted') + ')') +
                   (r.rungs.length ? ' via ' + r.rungs.join(' > ') : '')
          }
        } else {
          // S4 DOWNGRADE (RECOVERY_LADDER=0 - do NOT build the ladder): re-read the single need and
          // route to its producer; shelter/flee stay reflex-owned; a degraded-only state with a near
          // grave = recover.
          let need = null
          try { need = provision.survivalNeed(bot) } catch {}
          if (need) {
            const prod = scheduler.needProducer(need.need)
            if (prod === 'secureFood') wantSecureFood()
            else if (prod === 'recoverHp') wantRecoverHp()
            else { if (schedDeferNoted !== 'ladder-reflex') { schedDeferNoted = 'ladder-reflex'; note('(sched) ladder need ' + need.need + ' is reflex-owned (' + (prod || 'flee') + ') - holding') } return }
          } else if (nearest && nearest.dist <= GRAVE_NEAR_LADDER) {
            wantRecover()
          } else { if (schedDeferNoted !== 'degraded') { schedDeferNoted = 'degraded'; note('(sched) degraded but no executor until S5 - holding') } return }
        }
      } else return // unknown survival job name - do nothing
      if (name !== 'recover' && !executor) return
      // NIGHT-FORAGE GUARD (#11 - live death: creeper at the hut doorstep, foraging at night un-armored):
      // pickJob picks secureFood off the food<14 need, but at moderate hunger the crisis-grade need
      // (threshold 6) is actually 'shelter' (night + under-armored, arbiter.js:149). Foraging OUT into
      // the dark naked is the death - so HOLD secureFood and let the NIGHT_SHELTER reflex sleep it
      // through; it forages at dawn. A real food<=6 / hp<=6 crisis has need food/heal (not shelter) and
      // still dispatches below. (NIGHT_FORAGE_GUARD=0 rolls back.)
      if (name === 'secureFood' && process.env.NIGHT_FORAGE_GUARD !== '0') {
        let sn = null; try { sn = provision.survivalNeed(bot, { foodThreshold: foodSec.busyPreemptFood() }) } catch {} // #40 F3.2: FOOD_SURVIVAL raises the food preempt 6 -> 10
        if (sn && sn.need === 'shelter') {
          if (schedDeferNoted !== 'night-forage') { schedDeferNoted = 'night-forage'; note('(sched) secureFood held - night + under-armored: sheltering, not foraging out into the dark (forage at dawn)') }
          return
        } else if (schedDeferNoted === 'night-forage') schedDeferNoted = ''
      }
      // 6. BUSY vs IDLE dispatch policy (single-goal discipline).
      const bodyBusy = (commands.isBusy && commands.isBusy()) || (provision.isResting && provision.isResting()) || (provision.isSecuringFood && provision.isSecuringFood())
      if (bodyBusy) {
        // busy -> dispatch ONLY when crisis-grade: a near grave IS the survival move (recover), OR a
        // crisis-grade vitals need (food<=SCHED_CRISIS_FOOD, or hp/threat/etc via survivalNeed).
        // #41 P0.2: under the post-death latch, recoverFromDegraded is crisis-grade UNCONDITIONALLY
        // (preempts on the FIRST death, not the third) - the deathsRecent>=2 gate no longer holds the
        // naked bot's recovery behind the build. RESILIENT_RECOVERY=0 -> the >=2 gate byte-for-byte.
        const latch = RESILIENT_ON && commands.isPostDeathRecovery && commands.isPostDeathRecovery()
        let crisis = scheduler.preemptCrisisGrade({ name, deathsRecent: s.deathsRecent || 0, postDeathRecovery: latch }) // a death-spiral signature (>=2 recent deaths, or the post-death latch) may preempt the build
        if (!crisis) { try { crisis = !!provision.survivalNeed(bot, { foodThreshold: foodSec.busyPreemptFood() }) } catch { crisis = false } } // #40 F3.2: busy job preempted for secureFood at food<=10 (FOOD_SURVIVAL), not <=6
        if (!crisis) { if (schedHeldLog !== name) { schedHeldLog = name; note('(sched) ' + name + ' held - body busy, not crisis-grade (single-goal)') } return }
        schedHeldLog = ''
        if (commands.preemptForSurvival) commands.preemptForSurvival() // sets ONLY buildAbort; the build resumes via persistedResume
        note('(sched) PREEMPT ' + name + ' (' + pick.reason + ') - crisis-grade survival outranks the busy job')
      } else schedHeldLog = ''
      // 7. LATCH CHECKS + COOLDOWNS (never double-drive) + 8. the single job-latch runner.
      if (name === 'secureFood') { if (provision.isSecuringFood && provision.isSecuringFood()) return; await runJob(name, executor) }
      else if (name === 'recoverFromDegraded') { if (provision.isRecoveringDegraded && provision.isRecoveringDegraded()) return; await runJob(name, executor) }
      else if (name === 'recoverHp') {
        if ((provision.isRecoveringHp && provision.isRecoveringHp()) || Date.now() < schedHpCooldownUntil) return
        await runJob(name, executor)
        schedHpCooldownUntil = Date.now() + 60000 // mirror hp-crisis: cool 60s after the attempt
      } else if (name === 'recover') {
        if (Date.now() < schedGraveCooldownUntil) return
        schedJob = { name, startedAt: Date.now() }
        commands.touchProgress('dispatch:recover') // S7 (d): zero-idle at t0
        // task #18 M4: verdict-classed back-off (scheduler.graveCooldownMs) instead of a blanket 300s -
        // a stalled PARTIAL comes straight back inside the despawn window. GRAVE_URGENT=0 -> the single
        // 300s branch, byte-equivalent. remainMs is the nearest grave's despawn budget (from the snap).
        const graveUrgentOn = process.env.GRAVE_URGENT !== '0'
        const graveRemainMs = graveUrgentOn && nearest ? nearest.remainMs : undefined
        try {
          const r = await commands.handle(bot, 'recover', { source: 'scheduler' })
          // success (retrieved/gone) marks the grave, it then leaves the snapshot; anything else keeps
          // the grave with a result-classed cooldown (partial/capacity 30s, won't-open 120s, travel/
          // throw scaled by the despawn budget) so we neither hammer it nor lose the despawn race.
          const cd = scheduler.graveCooldownMs(r, { remainMs: graveRemainMs, flagOn: graveUrgentOn })
          if (cd > 0) schedGraveCooldownUntil = Date.now() + cd
          note('(sched) recover -> ' + String(r || '').split('\n')[0] + (graveUrgentOn && cd > 0 ? ' (cooldown ' + Math.round(cd / 1000) + 's)' : ''))
        } catch (e) {
          const cd = scheduler.graveCooldownMs('', { remainMs: graveRemainMs, flagOn: graveUrgentOn })
          if (cd > 0) schedGraveCooldownUntil = Date.now() + cd
          note('(sched) recover failed: ' + e.message)
        }
        finally { schedJob = null }
      }
    } catch (e) { try { note('(sched) tick error: ' + e.message) } catch {} }
    finally { if (myGen === tickGen) setTimeout(tick, 15000 + (Math.random() * 6000 - 3000)) } // self-rescheduling => built-in jitter, one dispatch at a time; S7: a re-armed chain (tickGen++) orphans this stale one so two chains never coexist
  }
  setTimeout(tick, 15000)

  // S7 (§3.4c): the in-process FORWARD-PROGRESS watchdog. Every 5s it reads the SAME activeJob the
  // snapshot builds, runs the PURE danger-scaled scheduler.watchdog, and applies the §6 ladder via the
  // PURE scheduler.wdPhase reducer: NUDGE (loud log + markStalled, NO body action - the inner layers
  // get first crack) -> FAIL-JOB (set the job's EXISTING stop latch + recordOutcome; the executor
  // unwinds its honest-failure path and the next 15s tick's pickJob re-plans) -> GIVEUP (log once; a
  // latch-immune hung promise is layer d's class). Plus idle-with-work (crisis-cooldown clear + kick)
  // and a generation-guarded tick-liveness re-arm. WATCHDOG=0 -> this whole block never runs.
  if (WATCHDOG_ON) {
    let wdState = { phase: 'ok', jobKey: null }
    let idleWorkSince = 0
    let lastKickAt = 0
    let lastLivenessRearm = 0
    const cycRing = []            // task #34: bounded 48-sample position ring (~4min @ 5s)
    let cycState = { phase: 'idle', firedAt: -Infinity, cycleKey: null, workCount: 0 } // cycle-detect latch (mirrors wdState)
    const wdTimer = setInterval(() => {
      try {
        // 1. GUARDS. Dead/absent body: nothing to watch. A DECLARED hold (bed-sleep, night-rest) is a
        //    dawn-waking hold (I5) whose own inner watchdog stays the authority - heartbeat + return
        //    (same reasoning WEDGE_WATCHDOG uses, expressed as a heartbeat instead of a clock reset).
        if (!bot.entity || bot.health <= 0) return
        if (bot.isSleeping || (provision.isResting && provision.isResting())) { commands.touchProgress('declaredHold'); return }
        // 2. the active job (sync, cheap - no snapshot build on the 5s path).
        const job = provision.activeJobInfo()
        const now = Date.now()
        // 3. pure verdict + escalation phase.
        let verdict = scheduler.watchdog(job, { hp: bot.health, food: bot.food }, now)
        const jobKey = job ? (job.name + '@' + (job.startedAt || '')) : null
        // 3b. task #34 BEHAVIORAL CYCLE DETECTION (an S7 organ): sample position into a bounded ring
        //     and, when the pure detector flags an oscillation / repeat-fail, synthesize a fail-job
        //     verdict into the UNMODIFIED wdPhase + lever map (max-severity merge - a real fail-job is
        //     never downgraded). SURVIVE-tier maneuvers + escaping suppress it (invariant 6); the
        //     sleep/rest declared-hold early-returns above already exclude declared holds.
        if (CYCLE_DETECT_ON && !(commands.isEscaping && commands.isEscaping()) && !arbiter.maneuverActive(arbiter.PRIORITY.SURVIVE)) {
          const pp = bot.entity && bot.entity.position
          if (pp) {
            let wc = 0; try { wc = commands.progressInfo().workCount || 0 } catch {}
            cycRing.push({ t: now, x: pp.x, y: pp.y, z: pp.z, cycleKey: job ? job.name : null, workCount: wc }) // job NAME, not per-dispatch jobKey (root cause 2b)
            if (cycRing.length > 48) cycRing.shift()
          }
          let outRing = []; try { outRing = commands.recentOutcomes() } catch {}
          if (CYCLE_SELFABORT_EXEMPT) outRing = outRing.filter(r => !(r.selfAbort && !r.ok)) // #49: drop self-abort FAILS (watchdog/preempt "(stopped)" pauses); keep successes + genuine fails so repeatFail still latches on real failures
          const det = cycleDetect.detect(cycRing, outRing, now)
          cycState = cycleDetect.step(cycState, det, now)
          if (cycState.act === 'break') {
            if (job) {
              note('(wd) CYCLE ' + det.kind + ' on ' + job.name + ' - forcing fail-job (behavioral loop, not a freeze)')
              verdict = 'fail-job' // synthetic - flows through the UNMODIFIED wdPhase/lever map below
              // FOOD_FLOOR F4: a repeatFail cycle on the survival ladder / secureFood is the eternal
              // food re-loop - BUMP the floor's no-progress counter so its next dispatch ESCALATES
              // (widen the water scout, active fishing over a passive hold) instead of re-running the
              // identical failing sequence. FOOD_FLOOR=0 -> escalateFoodFloor is a no-op.
              if (process.env.FOOD_FLOOR !== '0' && /recoverFromDegraded|recoveryLadder|secureFood/.test(job.name || '')) { try { provision.escalateFoodFloor() } catch {} }
            } else {
              note('(wd) CYCLE ' + det.kind + ' with no active job - clearing the goal so the brain sees the loop')
              try { commands.recordOutcome('cycle:' + det.kind, false, 'A<->B loop broken (no job to fail)') } catch {}
              try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {} // honest cancel the nav stack understands; NO forceUnstick (the body can move - the decision is stuck)
            }
          }
        }
        wdState = scheduler.wdPhase(wdState, verdict, jobKey)
        if (job && wdState.act !== 'none') {
          const base = job.lastProgressAt != null ? job.lastProgressAt : (job.startedAt != null ? job.startedAt : now)
          const idle = Math.round((now - base) / 1000)
          if (wdState.act === 'nudge') {
            note('(wd) NUDGE ' + job.name + ' - no verified progress for ' + idle + 's (hp ' + bot.health + ' food ' + bot.food + ') - marking stalled, letting its own recovery act')
            commands.markStalled() // NOTHING else: no forceUnstick, no stop, no goal poke - the nudge is loud + a flag only
          } else if (wdState.act === 'fail') {
            note('(wd) FAIL-JOB ' + job.name + ' - no verified progress for ' + idle + 's - setting its stop latch')
            try { commands.recordOutcome('watchdog:' + job.name, false, 'no verified progress for ' + idle + 's - stop latch set') } catch {}
            // the LEVER MAP - every lever is an EXISTING, already-polled abort latch (no new dig/build/nav):
            if (/^(autobuild|gather|provision|travel|come|huntat|fish|huttidy|gearup)$/.test(job.name)) {
              try { commands.preemptForSurvival() } catch {} // sets ONLY buildAbort; persistedResume stays intact -> a failed build PAUSES, never cancels
            } else if (job.name === 'maintenancePass') {
              try { provision.stopMaintenance() } catch {}
            } else if (job.name === 'secureFood' || job.name === 'recoverHp' || job.name === 'recoverFromDegraded' || job.name === 'recoveryLadder') {
              try { provision.stopSurvivalJob() } catch {}
            }
            // recover/graveSweep: NO latch bites by design (recover ignores buildAbort) - log + recordOutcome
            // only; its own travel deadlines unwind it and the tick applies schedGraveCooldownUntil. A
            // promise-hung recover is caught by GIVEUP next window (layer d's class).
          } else if (wdState.act === 'giveup') {
            note('(wd) stop latch ineffective on ' + job.name + ' - a hung promise; standing down, layer d (supervisor frozen-vitals/kill) owns this')
          }
        }
        // 7. IDLE-WITH-WORK (§6 item 3): a survival pick sits undispatched while the body is truly idle
        //    (no busy activity, no pathfinder goal, no schedJob) and no latch job is running. Continuous
        //    >30s -> kick; at CRISIS vitals also clear the stale scheduler cooldowns so the next tick
        //    dispatches (the surgical fix for "sat frozen while graves gleamed 3b away"). Rate-limited 60s.
        const idleBody = !(commands.isBusy && commands.isBusy()) && !(bot.pathfinder && bot.pathfinder.goal) && !schedJob
        if (schedLastPick && schedLastPick.cls === 'survival' && job == null && idleBody) {
          if (!idleWorkSince) idleWorkSince = now
          if (now - idleWorkSince > 30000 && now - lastKickAt > 60000) {
            lastKickAt = now
            note('(wd) IDLE WITH WORK 30s+: pick=' + (schedLastPick && schedLastPick.job) + ' undispatched - kicking')
            if (bot.health <= 6 || bot.food <= 2) {
              schedGraveCooldownUntil = schedLadderCooldownUntil = schedHpCooldownUntil = 0
              note('(wd) crisis vitals - cleared stale grave/ladder/hp cooldowns so the next tick can dispatch')
            }
          }
        } else idleWorkSince = 0
        // 8. TICK-LIVENESS: the self-rescheduling chain itself died (a hung await -> its finally never
        //    ran). Re-arm with the generation guard (tickGen++ orphans any later-resolving stale chain;
        //    schedJob still guarantees one dispatch). Rate-limited to once per 5 min.
        if (schedLastTickAt && now - schedLastTickAt > 90000 && now - lastLivenessRearm > 300000) {
          lastLivenessRearm = now
          note('(wd) scheduler tick chain stalled >90s - re-arming (generation guard prevents a double chain)')
          tickGen++
          setTimeout(tick, 0)
        }
      } catch (e) { try { note('(wd) watchdog error: ' + e.message) } catch {} }
    }, 5000)
    if (wdTimer.unref) wdTimer.unref() // never hold the process open on this timer alone
  }
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
// fix #14 (flag SHELTER_BED_FALLBACK, default ON): free the built-in flee/defend at CRITICAL
// hp. Read once at module load like the other reflex flags; =0 reverts both guarded
// expressions below to their old forms byte-equivalently.
const SHELTER_BED_FALLBACK = process.env.SHELTER_BED_FALLBACK
const CRIT_HP = parseInt(process.env.SHELTER_CRIT_HP || '6', 10)
// fix #15 (flag DEFEND_WHEN_HIT, default ON): a hostile actively HITTING the bot must be fought
// or fled - never absorbed - even mid-build / night-resting / nav-recovery. Read once at module
// load like the other reflex flags; =0 reverts every guarded expression (Pieces A/B/C/D) to its
// old form byte-equivalently. provision.js reads the same env once at module load for Piece C.
const DEFEND_WHEN_HIT_ON = process.env.DEFEND_WHEN_HIT !== '0'
// fix #10 (flag CREEPER_BACKOFF, default ON): a creeper never emits a pre-blast hit, so #14's
// beingHit re-arm can't open the three whole-tick gates for a silent walking bomb, and the
// full recovery ladder + 40s deadline are the wrong tool against a 1.5s-fuse threat. Read once
// at module load like the other reflex flags; =0 makes creeperClose constant-false (all three
// gates byte-revert), keeps today's avoid-nav budgets, and never fires the sprint burst.
const CREEPER_BACKOFF_ON = process.env.CREEPER_BACKOFF !== '0'
const CREEPER_REARM_DIST = parseInt(process.env.CREEPER_REARM_DIST || '8', 10)
// task #45 (flag WATER_SAFE, default ON): while the head is UNDERWATER the fight/flee reflex stands
// down (RETREAT-TO-LAND, not fight) and the drown-escape fires EARLIER (block-based, not at low
// oxygen). The bot drowned TWICE fighting a Drowned while submerged. =0 reverts both to today.
const WATER_SAFE = process.env.WATER_SAFE !== '0'
const CREEPER_BURST_MS = parseInt(process.env.CREEPER_BURST_MS || '2500', 10)
// PHASE A: route the time-critical flee reflexes (burst, creeper back-off, hut-retreat approach)
// through navigate.reactiveMove - a bounded control-driven short move - instead of a timeout-prone
// goto. =0 => each reflex falls back to its exact current call (today byte-for-byte).
const REACTIVE_MOVE_ON = process.env.NAV_REACTIVE_MOVE !== '0'
let defendEquipped = false
let lastDefendTarget = null
let lastFleeAt = 0
// ROD_SUPPLY (M1): the last spider we auto-meleed, so that once it DIES we can walk to its STRING
// drop and pick it up (string = the one string source on this no-animal site, and the precondition
// for a first fishing rod). Only tracked/collected under the flag; spiderLootBusy re-entry-guards
// the async collect so the 700ms reflex never stacks pickups.
let lastSpiderMelee = null
let spiderLootBusy = false
// fix #15 Piece D: the "someone is hitting me" detector is hoisted to module scope (below, a
// bot.on('health') handler + beingHitNow()) so the busy/rest COMMAND gate can see hits even when
// AUTO_DEFEND=0. The AUTO_DEFEND tick delegates to beingHitNow() instead of tracking hp itself.
let lastDamagedAt = 0 // epoch ms of the last >=0.5 hp DROP (module-scope hit tracker)
let hitTrackLastHp = 20
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
// fix #10 F3: the primitive sprint-away burst - a REFLEX move-away that uses ONLY primitives
// the reflex already uses (setGoal(null), bot.lookAt, setControlState). NO pathfinder goal (so
// no brain-vs-body carousel), NO dig/place. Rate-limited to one burst per CREEPER_BURST_MS+1s.
// Clearing the goal is an honest cancel of any in-flight avoid nav (navigate.js:806-808), which
// then unwinds through its own catch while this drives the body. Blind sprint-jump is the same
// pre-existing recovery idiom as the nudge rung (navigate.js:243). finally-clears the control
// states so an exception can't leave them latched.
let lastBurstAt = 0
async function burstAwayFrom (threatPos) {
  const now = Date.now()
  if (now - lastBurstAt < CREEPER_BURST_MS + 1000) return // rate-limit
  lastBurstAt = now
  if (REACTIVE_MOVE_ON) { // Phase A: the sprint-jump burst IS the reactiveMove primitive - same away-vector, sustained + measured, arbiter/recoveringDepth-coordinated
    try { await navigate.reactiveMove(bot, { awayFrom: threatPos, minClearB: 8, budgetMs: CREEPER_BURST_MS, priority: arbiter.PRIORITY.SURVIVE }) } catch {}
    return
  }
  try {
    try { bot.pathfinder.setGoal(null) } catch {} // cancel any in-flight avoid nav
    try {
      const me = bot.entity.position
      const away = me.minus(threatPos)
      const dest = me.plus(away.scaled(8 / (away.norm() || 1))) // same away-vector the flee/back-off compute
      await bot.lookAt(dest, true)
    } catch {}
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    bot.setControlState('jump', true)
    await new Promise(r => setTimeout(r, CREEPER_BURST_MS)) // ~12-14b at sprint
  } finally {
    try { bot.setControlState('forward', false) } catch {}
    try { bot.setControlState('sprint', false) } catch {}
    try { bot.setControlState('jump', false) } catch {}
  }
}
// fix #15 Piece D: shared "under attack" tracker at module scope (NOT inside the AUTO_DEFEND
// guard) so the busy/rest command gate defends even with AUTO_DEFEND=0. Same >=0.5-drop threshold
// and 8s window the AUTO_DEFEND tick used; both the tick and the gate now read beingHitNow().
bot.on('health', () => {
  const hp = bot.health == null ? 20 : bot.health
  if (hp < hitTrackLastHp - 0.5) lastDamagedAt = Date.now()
  hitTrackLastHp = hp
})
function beingHitNow () { return Date.now() - lastDamagedAt < 8000 }
if (process.env.AUTO_DEFEND !== '0') {
  setInterval(() => {
    if (!bot.entity) return
    // Track being-HIT first, so the shelter gate below can tell "safely holed up" from
    // "under attack" (health dropped in the last 8s).
    const hpNow = bot.health == null ? 20 : bot.health
    const beingHit = beingHitNow() // delegated to the module-scope hit tracker (Piece D)
    // fix #10 F1: a creeper never emits a pre-blast hit, so #14's beingHit re-arm can't open the
    // three whole-tick gates below for a silent walking bomb. A cheap proximity check (same
    // filter shape as the :1353 scan; one entity iteration the ungated scan already does) re-arms
    // the reflex when a creeper is within CREEPER_REARM_DIST (8b, >= blast 3 + fuse-close + a tick
    // + goto spin-up) so a resting/recovering/sheltering bot isn't reflex-blind till point-blank.
    let creeperClose = false
    if (CREEPER_BACKOFF_ON) {
      try {
        const mp = bot.entity.position
        for (const e of Object.values(bot.entities || {})) {
          if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
          if (!/creeper/.test(e.name || '')) continue
          if (e.position.distanceTo(mp) <= CREEPER_REARM_DIST) { creeperClose = true; break }
        }
      } catch {}
    }
    // While digging UP out of a cave, don't let the flee reflex hijack the pathfinder
    // sideways - rising out of the hole IS the escape (fleeing horizontally just keeps us
    // in the mob-filled cave and pins us at depth). fix #14: only ACTUALLY-being-hit at
    // <=CRIT_HP re-arms it - absorbing hits there is strictly fatal (travelFar's blocking
    // rest raises isEscaping precisely so flee doesn't fight the shelter dig).
    if (commands.isEscaping && commands.isEscaping() && !(SHELTER_BED_FALLBACK !== '0' && beingHit && (hpNow <= CRIT_HP || DEFEND_WHEN_HIT_ON)) && !creeperClose) return
    // Same rule while a navigation RECOVERY is maneuvering (pillaring out of a pit,
    // threading a doorway, hopping from water) - the recovery IS the escape. fix #15 Piece A:
    // a recovery maneuver defers to defense the moment hits actually land (the 18:27 blind spot -
    // a wedged bot runs recovery rungs almost continuously, so defense was blind while being hit).
    if (navigate.isRecovering() && !creeperClose && !(DEFEND_WHEN_HIT_ON && beingHit)) return
    // While sheltering (sealed bunker / hut night-wait) stand down - UNLESS something is
    // actually HITTING us. A sealed pit takes no hits (the mob can't reach), so this still
    // yields there; but an enderman teleported into the hut, or a leaky pit, must be FOUGHT
    // - we're armored and win - not passively absorbed to death (live: 'attack enderman
    // suppressed' then died). The moment we take damage, defense/flee re-engages.
    if (provision.isSheltering && provision.isSheltering() && !beingHit && !creeperClose) return
    // task #45: HEAD UNDERWATER -> stand down. The bot drowned twice trading blows with a Drowned
    // while submerged (`(flee) PINNED ... can't flee, fighting`). While the head is underwater the
    // SURVIVE-tier drown-escape (AUTO_SURFACE) owns the body and swims to the nearest bank (also
    // away from the water mob); fighting resumes the instant the head clears (on land/shallow),
    // where the melee/flee ladder below is unchanged. WATER_SAFE=0 keeps today's fight-while-wet.
    if (scheduler.fightSuppressedWhenSubmerged({ flagOn: WATER_SAFE, submerged: navigate.headInWater(bot) })) return
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
                  if (REACTIVE_MOVE_ON) { // Phase A: reactive control-driven approach toward home (no 20s goto), then the EXISTING atomic door crossing (crossOwnDoor/#33 kept exactly as-is)
                    try { await navigate.reactiveMove(bot, { toward: { x: gx, y: gy, z: gz }, reach: 16, arriveB: 2, budgetMs: 2500, priority: arbiter.PRIORITY.SURVIVE }) } catch {}
                    try { await navigate.enterStructure(bot, hut, { isStopped: () => false, priority: arbiter.PRIORITY.SURVIVE }) } catch {}
                  } else {
                    await navigate.navigateToPreempt(bot, new goals.GoalNear(gx, gy, gz, 1),
                      { timeoutMs: 15000, deadlineMs: CREEPER_BACKOFF_ON ? 20000 : 40000, climb: false, priority: arbiter.PRIORITY.SURVIVE, budgets: { door: 3, pit: 0, water: 0, nudge: 1, stepout: 1 }, label: 'hut-retreat' })
                  }
                  note('(flee) inside the hut - door-assist sealed the door behind me')
                }
              } else {
                note(`(flee) creeper ${fbest.toFixed(1)}m - backing off 20b to deaggro`)
                if (REACTIVE_MOVE_ON) { // Phase A: bounded control-driven back-off - the burst is now the PRIMARY tool, not a post-goto fallback. Up to 3 sustained bursts (each <=2.5s) until 20b netted; the futility bookkeeping below reads the measured net move from the body position exactly as before
                  let net = 0
                  for (let b = 0; b < 3 && net < 20; b++) {
                    let R = null
                    try { R = await navigate.reactiveMove(bot, { awayFrom: flee.position, minClearB: 20, budgetMs: 2500, priority: arbiter.PRIORITY.SURVIVE }) } catch {}
                    try { net = Math.hypot(bot.entity.position.x - startPos.x, bot.entity.position.z - startPos.z) } catch {}
                    if (!R || R.moved < 1) break // wedged - stop bursting, let the futility path below take over
                  }
                } else {
                  const away = me.minus(flee.position)
                  const dest = me.plus(away.scaled(20 / (away.norm() || 1))) // 20b -> past the creeper's 16m follow range -> deaggro (no boundary jitter)
                  await navigate.navigateToPreempt(bot, new goals.GoalNear(Math.floor(dest.x), Math.floor(me.y), Math.floor(dest.z), 2),
                    CREEPER_BACKOFF_ON
                      ? { timeoutMs: 6000, deadlineMs: 12000, priority: arbiter.PRIORITY.SURVIVE, label: 'creeper-backoff', budgets: { nudge: 1, stepout: 1, climb: 0, pit: 0, door: 0, indoor: 0, water: 1, wetbreach: 0 } } // fix #10 F2: 1.5s-fuse threat - ladder-light, the burst is the fallback not the ladder
                      : { timeoutMs: 15000, deadlineMs: 40000, priority: arbiter.PRIORITY.SURVIVE, label: 'creeper-backoff' })
                }
              }
              ok = true
            } catch (e) { note(`(flee) creeper avoid failed (${e.message})`) }
            // FUTILITY: the maneuver failed OR we barely moved (fenced/wedged) -> can't reach
            // safety; suppress re-fleeing THIS creeper for 90s so job/reflex don't ping-pong and
            // a can't-reach creeper doesn't freeze the body forever (the wedge watchdog case).
            let netMove = 0; try { netMove = Math.hypot(bot.entity.position.x - startPos.x, bot.entity.position.z - startPos.z) } catch {}
            if (!ok || netMove < 2.5) {
              // fix #10 F4a: the ladder wedged, but the body can still move. Before conceding a
              // 90s futility stand-down, if the creeper is still within 12b fire the raw sprint
              // burst (setControlState only) and re-measure; only mark futile if the burst ALSO
              // netted < 2.5b. Burst (2.5s) completes within the 5s settle - latch timing unchanged.
              let stillClose = false
              try { stillClose = !!(flee && flee.position && bot.entity && flee.position.distanceTo(bot.entity.position) <= 12) } catch {}
              if (CREEPER_BACKOFF_ON && stillClose) {
                note('(flee) creeper backoff wedged - raw sprint burst')
                await burstAwayFrom(flee.position)
                try { netMove = Math.hypot(bot.entity.position.x - startPos.x, bot.entity.position.z - startPos.z) } catch {}
              }
            }
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
        // standoff suppression (see fleeFutileUntil above) - a hit always re-arms.
        // fix #14 CAN'T-RUN-SO-FIGHT: when flee is standoff-suppressed AND the threat is in
        // melee reach (<=4b), don't freeze - fall through to the auto-defend section below
        // (bot.attack + lookAt, NO pathfinder goal) instead of returning. Only return when the
        // threat is out of melee reach. Flag-gated; =0 keeps the old bare returns.
        const suppressed = !beingHit && (fleeFutileUntil.get(flee.id) || 0) > now
        // fix #10 F4b: #14's meleeFall is a no-op for creepers (NO_AUTO_MELEE forbids punching
        // them, :1522), so a futility-suppressed creeper inside blast range currently gets NO
        // response. Fire the (rate-limited) raw sprint burst instead of freezing, then return.
        // The melee fall-through (meleeFall/defendInstead) stays byte-identical for non-creepers.
        if (suppressed && isCreeper && fbest <= 6 && CREEPER_BACKOFF_ON) {
          burstAwayFrom(flee.position).catch(() => {})
          return
        }
        const meleeFall = SHELTER_BED_FALLBACK !== '0' && fbest <= 4
        let defendInstead = false
        if (suppressed) {
          if (!meleeFall) return
          defendInstead = true // in melee reach + can't run -> fight (fall through)
        }
        if (!defendInstead) {
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
            if (!meleeFall) return
            defendInstead = true // just marked futile AND in melee reach -> fight this tick
          }
          // fix #15 Piece B: BEING-HIT-PINNED. The fleeEp window already re-bases on >=2.5b of
          // real movement, so `now - fleeEp.start > 4000` while beingHit = 4s of hits with no net
          // movement = wedged/cornered and flee is impossible. Do NOT set fleeFutileUntil - the
          // moment we net movement the episode re-bases and normal flee resumes.
          else if (DEFEND_WHEN_HIT_ON && beingHit && isCreeper && now - fleeEp.start > 4000 && CREEPER_BACKOFF_ON) {
            // pinned creeper: NO_AUTO_MELEE forbids punching it - fire the raw sprint burst
            // instead (mirror of :1605-1607) and return.
            note(`(flee) PINNED + hit, creeper ${fbest.toFixed(1)}m - can't flee, sprint burst`)
            burstAwayFrom(flee.position).catch(() => {})
            return
          } else if (scheduler.fightNotFlee({ flagOn: DEFEND_WHEN_HIT_ON, beingHit, pinnedMs: now - fleeEp.start, threatDist: fbest, isCreeper })) {
            // pinned non-creeper in melee reach: stop shoving the wall, drop the stale flee goal,
            // and FIGHT (falls through to the melee section below - bot.attack + lookAt, no goal).
            try { bot.pathfinder.setGoal(null) } catch {}
            note(`(flee) PINNED + hit by ${flee.name || why} ${fbest.toFixed(1)}m for 4s - can't flee, fighting`)
            defendInstead = true
          }
        }
        if (!defendInstead) {
          if (flee !== lastDefendTarget || now - lastFleeAt > 1000) {
            const away = me.minus(flee.position)
            const dest = me.plus(away.scaled(16 / (away.norm() || 1))) // back off ~16 blocks (past creeper aggro range)
            // fix #10 F4c: point-blank creeper first sighting (the death case) - control-states
            // move the body in ms; a pathfinder goal needs path-compute the ~1.5s fuse doesn't
            // grant. Fire the burst INSTEAD of setGoal at <=4b; >4b (and non-creepers) keep it.
            if (isCreeper && fbest <= 4 && CREEPER_BACKOFF_ON) {
              burstAwayFrom(flee.position).catch(() => {})
            } else {
              bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(dest.x), Math.floor(me.y), Math.floor(dest.z), 1))
            }
            bot.setControlState('sprint', true) // RUN - creepers sprint the last stretch; a walking flee lost twice tonight
            lastFleeAt = now
            if (flee !== lastDefendTarget) note(`(flee) ${why} ${fbest.toFixed(1)}m`)
            lastDefendTarget = flee
          }
          return
        }
        // fix #14: standoff-suppressed melee threat -> fall through to the defend section below
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
      // ROD_SUPPLY (M1): a spider we just fought in self-defense drops STRING - the one string
      // source on this no-animal site. When we still NEED string for a first rod, walk to the drop
      // ONCE and pick it up (string is kept - not in JUNK_RE / safekeep). Bounded, post-death only
      // (no live-fight distraction), re-entry-guarded; no-op when stocked. Flag off => never fires.
      if (process.env.ROD_SUPPLY === '1' && lastSpiderMelee && !lastSpiderMelee.isValid && !spiderLootBusy) {
        const inv = bot.inventory ? bot.inventory.items() : []
        const need = foodSec.needStringForRod({
          hasRod: inv.some(i => i.name === 'fishing_rod'),
          packString: inv.reduce((n, i) => n + (i.name === 'string' ? i.count : 0), 0),
          bankRods: 0
        })
        lastSpiderMelee = null
        if (need) { spiderLootBusy = true; provision.collectDrops(bot, 6).catch(() => {}).then(() => { spiderLootBusy = false }) }
      }
      if (!target) { defendEquipped = false; lastDefendTarget = null; return }
      if (!defendEquipped) {
        const w = (bot.inventory ? bot.inventory.items() : []).find(i => i.name.endsWith('_sword'))
        if (w) { defendEquipped = true; bot.equip(w, 'hand').catch(() => {}) }
      }
      bot.lookAt(target.position.offset(0, 1, 0)).catch(() => {})
      bot.attack(target)
      // ROD_SUPPLY (M1): remember a spider we're meleeing so its string drop is collected on death.
      if (process.env.ROD_SUPPLY === '1' && /^(spider|cave_spider)$/i.test(target.name || '')) lastSpiderMelee = target
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
  let wdFailPos = null // where the last force-escape failed (for the same-cell streak)
  let wdFailStreak = 0 // consecutive same-cell force-escape failures
  const DIGOUT_ON = process.env.DIGOUT_ESCAPE !== '0' // hard-wedge dig-out escape (default ON; =0 restores today)
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
      const ok = await navigate.forceUnstick(bot, { digOut: DIGOUT_ON && wdFailStreak >= 1 })
      if (ok) {
        note(`(watchdog) force-escape MOVED me to ${bot.entity.position.floored()}`)
        wdHist = []; wdFailStreak = 0; wdFailPos = null
      } else {
        // ESCALATION (water-wedge escape, Change B): track consecutive same-cell failures.
        // The 4-min retry cadence (wdLastFire) is deliberately unchanged; nothing here aborts
        // or cancels a job (stop semantics are protected and an abort can't move the body).
        const cur = bot.entity.position
        if (wdFailPos && Math.hypot(cur.x - wdFailPos.x, cur.y - wdFailPos.y, cur.z - wdFailPos.z) <= 4) wdFailStreak++
        else wdFailStreak = 1
        wdFailPos = { x: cur.x, y: cur.y, z: cur.z }
        note('(watchdog) force-escape could not move me - will retry in 4 min')
        if (wdFailStreak === 2) {
          // ~8 min frozen on the same cell: ONE immediate retry with the wider breach budget.
          note('(watchdog) 2nd failed escape at the same cell - one DESPERATE retry (wider breach)')
          let ok2 = false
          try { ok2 = await navigate.forceUnstick(bot, { desperate: true, digOut: DIGOUT_ON }) } catch (e) { note(`(watchdog) desperate retry failed: ${e.message}`) }
          if (ok2) { note(`(watchdog) DESPERATE escape MOVED me to ${bot.entity.position.floored()}`); wdHist = []; wdFailStreak = 0; wdFailPos = null }
        } else if (wdFailStreak >= 3) {
          const mins = Math.round((now - old.t) / 60000)
          note(`(watchdog) HARD-WEDGED at ${cur.floored()}: ${wdFailStreak} consecutive failed escapes over ~${mins} min - out of tools, will keep retrying${DIGOUT_ON ? ' (dig-out tried)' : ''}`)
        }
      }
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
    // task #45: in OVER-THE-HEAD (deep) water, intervene on the FIRST confirmed submerged poll
    // instead of waiting ~6s (wetHist>=3 ~= the `low oxygen` point that lost the race). Block-based
    // `deep` flag (bot.oxygenLevel is unreliable on live). WATER_SAFE=0 -> today's flat wetHist>=3.
    if (WATER_SAFE) {
      const deep = provision.deepWaterUnderfoot(bot)
      if (!scheduler.submergedEscapeDue({ flagOn: true, submerged: true, deep, wetHist, oxygenReliable: false })) return
    } else if (wetHist < 3) return // ~3 of the last 4 polls wet (2s cadence ~= 6s submerged) before intervening
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
      // WATER_ESCAPE (task #48): escapeWater's success is HEAD-based (!headInWater), so a bobbing bot
      // whose head clears for a tick declared "out of the water" while its body kept treading the same
      // pond (the log-50236 false victory, design §2b). Under the flag, judge "out" by the FEET so the
      // head-based reflex and the feet-based recovery `water` rung agree on "actually out". Purely the
      // success LABEL + cooldown gate; the escape it ran is unchanged. Flag OFF => today's head-based ok.
      const out = (process.env.WATER_ESCAPE === '1') ? !navigate.feetInWater(bot) : ok
      note(`(drown-crisis) ${out ? 'out of the water' : 'still wet - will retry after a cooldown'}`)
      if (!out) drownCooldownUntil = Date.now() + 10000
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
      // The external liveness supervisor (run.js) is allowed past the BRAIN-suppression gates
      // (which guard against the BRAIN, not ops) - but ONLY for the two recovery verbs and ONLY
      // with the X-Supervisor header. Verb-allowlisted at the parse site so a forged/compromised
      // local process gains nothing the loopback bind (controlHost 127.0.0.1) didn't already give.
      // It stays inside the CHEAT confinement below (defense in depth) and can never run any other verb.
      const fromSupervisor = req.headers['x-supervisor'] === '1' && /^(stop|recover)\s*$/i.test(String(line).trim())
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
      if (!fromSupervisor && /^stop\b/i.test(String(line).trim()) && commands.persistedResume && commands.persistedResume()) {
        note(`(cmd) ${line}${rz} -> held (a saved build job exists - the brain may not cancel it)`)
        return send(res, 200, "held: there's a build to finish - i shouldn't stop it")
      }
      const bodyBusy = (commands.isBusy && commands.isBusy()) || (provision.isResting && provision.isResting()) || (provision.isSecuringFood && provision.isSecuringFood()) || (provision.isRecoveringDegraded && provision.isRecoveringDegraded())
      const trimmedLine = String(line).trim()
      // S4 (REDESIGN §3.4): classify read-only via scheduler.commandClass when SCHEDULER is on.
      // Deliberate, documented widening: commandClass's perception set adds turn|lookbehind|
      // waypoints|places|help to the old whitelist - all read-only/head-only ("perception/chat ->
      // allow as today"). SCHEDULER=0 keeps the old regex byte-for-byte.
      const cls = SCHED_ON ? scheduler.commandClass(trimmedLine) : null
      const readOnly = SCHED_ON ? (cls === 'perception' || cls === 'chat')
        : /^(state|scan|find|block|entities|inventory|look|say)\b/i.test(trimmedLine)
      if (bodyBusy && !readOnly && !fromSupervisor) {
        // S1 HOTFIX (REDESIGN §3.4): survival-class commands are no longer muzzled by the body's
        // own hold - they PREEMPT it. The live freeze: `recover`/`eat`/`wear` suppressed for 8+
        // minutes at 1hp/food 0 while the famine-hold sat inside `_securingFood` with iron in a grave
        // 3b away. When a real survival need exists (or a grave is at arm's reach) the command
        // sets the stop latch (the failing hold unwinds; any build resumes via persistedResume)
        // and falls through to run. Progress-class commands keep exactly today's suppression.
        // S1_HOTFIX=0 restores the old blanket hold. `stop`-suppression + the persisted-build
        // hold above are UNTOUCHED (they guard operator intent, orthogonal to survival).
        // S4: survival-class via commandClass + decide via the pure admissible(schedulerState).
        // commandClass's survival vocabulary is wider than S1's regex (equip/gearup/hunt/...), but
        // admissible still requires a REAL need or a near grave, so a whimsical gearup at full health
        // while a build runs is still HELD (now with the scheduler's greppable reason). SCHEDULER=0
        // restores S1_HOTFIX + survivalAdmissible byte-for-byte.
        // fix #15 Piece D: being actively DAMAGED is a survival situation - a brain attack/defend
        // must not be muzzled by the build/rest hold while a mob is hitting us (the 18:27 death:
        // every attack/defend logged `held (night-resting)` while a zombie beat the bot). Checked
        // BEFORE the survival-class check; mirrors the S1/S4 survival PREEMPT (pause, not cancel,
        // any build via preemptForSurvival -> resumes through persistedResume). The 8s beingHitNow()
        // window bounds it. attack/defend stay 'progress' class in scheduler.js - no reclassify.
        const defenseCmd = /^(attack|defend)\b/i.test(trimmedLine)
        const defendPreempt = DEFEND_WHEN_HIT_ON && defenseCmd && beingHitNow()
        // #41 P0.4: while the post-death recovery latch is set, recovery-class commands are NOT muzzled
        // by the busy-gate (RC-A: goto home / recover / retreat were all held "busy building" while the
        // build dragged the naked bot back). A recovery MOVE (recover/getstuff/retreat/goto-home) passes
        // even though `goto`/`travel` are progress-class; survival commands use admissibleUnderLatch so
        // a bare `recover` at deathsRecent==1 passes in the post-death window. RESILIENT off -> unchanged.
        const latchOn = RESILIENT_ON && commands.isPostDeathRecovery && commands.isPostDeathRecovery()
        const recoveryMove = latchOn && SCHED_ON && scheduler.isRecoveryMove(trimmedLine)
        const survivalCmd = SCHED_ON ? (cls === 'survival')
          : (process.env.S1_HOTFIX !== '0' && /^(recover|getstuff|eat|wear|armorup|sleep)\b/i.test(trimmedLine))
        const adm = survivalCmd ? (SCHED_ON ? scheduler.admissibleUnderLatch('survival', trimmedLine, await provision.schedulerState(bot), latchOn) : survivalAdmissible(bot)) : null
        if (defendPreempt) {
          const label = commands.isBusy && commands.isBusy() ? 'busy building' : (provision.isSecuringFood && provision.isSecuringFood() ? 'securing food' : 'night-resting')
          note(`(cmd) ${line}${rz} -> PREEMPT (under attack) - defense outranks the ${label} hold`)
          if (commands.preemptForSurvival) commands.preemptForSurvival() // stop latch; a build resumes via persistedResume
          // fall through: the command runs and owns the body
        } else if (recoveryMove) {
          const label = commands.isBusy && commands.isBusy() ? 'busy building' : (provision.isSecuringFood && provision.isSecuringFood() ? 'securing food' : 'night-resting')
          note(`(cmd) ${line}${rz} -> PREEMPT (post-death recovery) - recovery outranks the ${label} hold`)
          if (commands.preemptForSurvival) commands.preemptForSurvival() // stop latch; a build resumes via persistedResume
          // fall through: the recovery command runs and owns the body
        } else if (survivalCmd && adm.allow) {
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
      // S6: an incoming progress/survival command STOPS a running maintenance pass (the pass
      // unwinds at its next poll; the incoming job takes the body). perception/chat never do.
      if (provision.isMaintaining && provision.isMaintaining() && cls !== 'perception' && cls !== 'chat') provision.stopMaintenance()
      try {
        const result = await commands.handle(bot, line, { source: fromSupervisor ? 'supervisor' : 'brain' })
        // A non-perception command is the brain's response to any waiting player,
        // so consider the request answered (perception commands keep it pending).
        if (!PREP_CMDS.test(String(line).trim())) clearPendingChat()
        note(`(cmd)${fromSupervisor ? ' [supervisor]' : ''} ${line}${rz} -> ${result.split('\n')[0]}`)
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
        const result = await commands.handle(bot, line, { source: 'operator' })
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

// ---------------------------------------------------------------------------
// STATE-HISTORY recorder + supervisor heartbeat (observability; REDESIGN §8.1).
// One compact flat JSON line every ~5s to logs/state-history.jsonl (size-rotated
// at ~5 MB, one .old generation) - the consolidated, queryable time-series that
// brain-decisions.jsonl (a 29 MB firehose) never gave us. Pure telemetry: it
// reuses the same in-process snapshot the /state handler builds (commands.state),
// never self-calls HTTP, never touches decision/survival logic, and any error is
// swallowed so it can't harm the bot. STATE_HISTORY=0 disables (BRANCH_MINE-style).
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || path.join(__dirname, 'heartbeat.json')
if (process.env.STATE_HISTORY !== '0') {
  let hbLastPos = null
  let hbLastProgressAt = Date.now()
  const historyTick = () => {
    try {
      const sample = loghistory.compactSample(commands.state(bot), Date.now())
      loghistory.appendSample(sample)
      // lastProgressAt: advance when the body materially moved (>=1 block, 3-D) - a
      // supervisor watching heartbeat.json can spot a wedged/frozen bot (pos static
      // while connected) without parsing the whole history.
      const p = sample.pos
      if (p && hbLastPos && (Math.abs(p.x - hbLastPos.x) + Math.abs(p.y - hbLastPos.y) + Math.abs(p.z - hbLastPos.z)) >= 1) hbLastProgressAt = sample.t
      // S7 (§3.4e): merge the VERIFIED-progress clock so layer d (supervise.js frozen-vitals, 5 min)
      // stops false-flagging a bot standing still at a furnace for 10 min of real smelting.
      if (WATCHDOG_ON) { try { hbLastProgressAt = Math.max(hbLastProgressAt, commands.progressInfo().at) } catch {} }
      if (p) hbLastPos = p
      try { fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(Object.assign({}, sample, { connected: !!bot.entity, lastProgressAt: hbLastProgressAt }))) } catch {}
    } catch { /* telemetry must never kill the bot */ }
  }
  const historyTimer = setInterval(historyTick, 5000)
  if (historyTimer.unref) historyTimer.unref() // never hold the process open on this timer alone
}
