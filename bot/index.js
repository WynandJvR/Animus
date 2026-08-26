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
const provHut = require('./provision-hut.js')
const provRecovery = require('./provision-recovery.js')
const provFood = require('./provision-food.js')
const provCore = require('./provision-core.js')
const provMaintain = require('./provision-maintain.js')
const provShelter = require('./provision-shelter.js')
const provision = require('./provision.js') // for the body-side survival-hunt reflex
const gravePolicy = require('./grave-policy.js') // PURE: the death-cause taxonomy the death handler stamps (#112)
const deathCause = require('./death-cause.js') // AUDIT D3: real attribution (server death message > damage log > block reads)
const resources = require('./resources.js') // unified pack+chest resource model (food withdraw)
const navigate = require('./navigate.js') // unified navigation (isRecovering gates the reflexes)
const arbiter = require('./arbiter.js') // priority body-ownership: reflexes defer to a running navigation maneuver
const access = require('./access.js')
const schematic = require('./schematic.js')
const loghistory = require('./loghistory.js') // compact rolling state time-series + heartbeat (observability)
const scheduler = require('./scheduler.js') // S4: pure survival-tier decision core (commandClass/admissible/pickJob) - wires the busy-gate + the tick
const schedulerCore = require('./scheduler-core.js') // #65 DYNAMIC_CORE Phase 1: the PURE utility choosing layer (flag DYNAMIC_CORE, default OFF - soaked offline before the coordinator flips it live)
const maintain = require('./maintain.js') // #40 F2: pure buffer needs() - to detect a pending food (pack/bank) need when an opp window is abandoned
const foodSec = require('./food.js') // #40 F3.2: pure busy-preempt food threshold (FOOD_SURVIVAL raises it 6 -> 10)
const pov = require('./pov.js') // GUI-OVERHAUL §2: sliced DDA raycaster behind GET /pov (all logic lives in pov.js)
const reflexes = require('./reflexes.js') // PLAN-one-runner: the proposal registry + the ONE body-ownership rule the tick arbitrates with
const attempts = require('./attempts.js') // review §3.3: attempt memory keyed (job, step, 4b-cell) - replaces runner.noOp + runner.ladderBlock
const cmdGate = require('./gate.js') // M1 of the deadlock-free-arbitration design: THE refusal registry - the nine brain-command gates as ROWS, one evaluator, one place a `held (` may be built
const SCHED_ON = process.env.SCHEDULER !== '0' // master flag: SCHEDULER=0 restores the S1-hotfix wiring byte-for-byte (gate takes the survivalAdmissible path, the tick never registers, the 3 reflexes run as today)
const LADDER_ON = SCHED_ON && process.env.RECOVERY_LADDER !== '0' // S5: RECOVERY_LADDER=0 restores S4's recoveryLadder DOWNGRADE + the one-shot respawn grave gating byte-for-byte
const MAINTAIN_ON = SCHED_ON && process.env.MAINTAIN !== '0' // S6: MAINTAIN=0 restores the defer-note + the four proactive reflexes on their old timers byte-for-byte
const WATCHDOG_ON = SCHED_ON && process.env.WATCHDOG !== '0' // S7: the in-process forward-progress watchdog. WATCHDOG=0 -> no interval, no heartbeat merge, no wdPhase call; the touchProgress hooks remain as inert timestamps nobody reads (behaviorally byte-identical)
const OPP_ON = MAINTAIN_ON && process.env.OPPORTUNISTIC_MAINTAIN !== '0' // opportunistic at-hut maintenance during the build era; OPPORTUNISTIC_MAINTAIN=0 restores S6 byte-for-byte
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

// Chat, the outgoing say-gate and gaze/attention state live in chat-gate.js. The event
// handlers and the gaze reflex below consume it; gateSay takes commands.isBusy injected.
const chatGate = require('./chat-gate.js')
const { recordChatLog, recordChat, clearPendingChat, noteManualLook, gateImpactful } = chatGate
const gateSay = (line, fromBrain) => chatGate.gateSay(line, fromBrain, {
  isBusy: commands.isBusy,
  // #113: the crisis probe the chatter budgets consult. Evaluated ONLY on the unprompted-quip
  // path inside gateSay, so the vitals scan never runs on ordinary replies (body-first).
  inCrisis: () => { try { return arbiter.mortalDanger(provision.survivalNeed(bot)) } catch { return false } }
})
// Command-gate vocabularies stay here (they are about COMMANDS, not chat). The world-edit/
// admin block list is shared from access.js so both bodies stay in sync.
const CHEAT_CMDS = access.CHEAT_CMDS
// Perception commands are PREPARATORY ("look first, then answer"): they don't resolve a
// player's request, so a pending message stays offered until the brain actually answers. Any
// OTHER command (follow/come/equip/say/...) IS the response, so it clears the pending request.
const PREP_CMDS = /^(scan|find|entities|block|look|state|inventory)/i

const log = []
// Persistent event log: the in-memory buffer dies on restart and the console dies
// with its window - for post-mortems everything also lands in logs/bot-events.log
// (rotated at ~5 MB so it can run for weeks). One file for body events, commands,
// build progress, deaths - the first place to look when asking "what happened?".
const EVENTS_LOG = process.env.EVENTS_LOG || path.join(__dirname, '..', 'logs', 'bot-events.log') // env-overridable so a test instance doesn't interleave into the live flight recorder
// Cap for brain-decisions.jsonl (operator + brain decision firehose). It had NO cap at all
// and reached 39.7 MB live while the state-history next to it rotated dutifully at 5 MB.
const DECISION_LOG_CAP = parseInt(process.env.DECISION_LOG_CAP || String(16 * 1024 * 1024), 10)
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
    try { fs.appendFileSync(EVENTS_LOG, `[${ts()}] (logsink) recovered after ${n} dropped line(s)` + String.fromCharCode(10)) } catch {}
  }
}
// LOCAL-time log stamps (operator demand: the UTC ISO stamps read "hours wrong" against the
// wall clock). Same sortable shape, local clock, with the UTC offset suffix so post-mortems
// stay unambiguous. LOG_UTC=1 restores the old toISOString stamps.
function ts () {
  if (process.env.LOG_UTC === '1') return new Date().toISOString()
  const d = new Date(); const p = (n, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset(); const oh = p(Math.floor(Math.abs(off) / 60)); const om = p(Math.abs(off) % 60)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${oh}:${om}`
}
function note (msg) {
  const line = `[${ts()}] ${msg}`
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
function noteDebug (msg) { fileLog(`[${ts()}] ${msg}`) }
commands.setDebugSink(noteDebug)
provision.setDebugSink(noteDebug)
resources.setDebugSink(noteDebug)
navigate.setDebugSink(noteDebug)
require('./pathfix.js').setDebugSink(noteDebug) // [verify] place/dig world-recheck traces
require('./pathfix.js').setProgressSink(commands.touchProgress) // [S7] a pathfix-VERIFIED place/break -> the forward-progress heartbeat
require('./scaffold.js').setDebugSink(noteDebug) // [scaffold] registry/teardown traces
require('./reclaim.js').setDebugSink(noteDebug) // [reclaim] #119 commitment-ledger payment traces
require('./schematic.js').setDebugSink(noteDebug) // [schem] build loop + material sourcing traces (dbg() here was undefined until #108)
require('./planner.js').setDebugSink(noteDebug) // [plan] re-planning goal-driver traces (rounds/strikes/relocates)
arbiter.setDebugSink(noteDebug) // [arb] maneuver begin/end/expire + reflex deferrals
// A build job saved to disk survived a process restart - let the operator know it's resumable.
try {
  const rj = commands.persistedResume && commands.persistedResume()
  if (rj) note(`(resume) saved build found: "${rj.name}" at ${rj.at.x},${rj.at.y},${rj.at.z} - the chooser owns picking it up`)
} catch {}
// ==== THE BUILD'S THREE PRIVATE DRIVERS ARE DELETED (2026-08-25, review D6 / item 7) =======
//
// A 25-second boot one-shot and a 120-second re-arm interval stood here, and a third copy lived
// inside the respawn handler. Each of them read the saved job off disk, re-derived its own idea
// of "is the body free" from a hand-written stack of latch reads (isBusy / isResting /
// isMaintaining / mayDoProgress / resumeHoldRemaining), and then called `resumebuild` - taking
// the body with no lease, no jobKey, no attempt memory and nothing the chooser could weigh it
// against. That is the shape PLAN-one-runner deleted everywhere else in this file eight months
// ago ("add a ROW, never a new setInterval"), left standing for the one job that runs longest.
//
// The review's D6 is the bill for it: the build layer had no plan-level memory and no abandonment
// verdict, because none of the three timers could HAVE one - a timer that fires every two minutes
// is not a decision-maker, it is a retry. "gathering 3x oak_log" restarted every twenty minutes
// all day and nothing anywhere counted it.
//
// It is a row in reflexes.js now (`build`), dispatched by the ONE dispatcher, holding the ONE
// lease, remembered by attempt memory against (job, step, cell), and refused out loud when it
// cannot run. Everything the timers uniquely did survives, in the place that owns it:
//   * "is the body free"      -> reflexes.bodyRefusal, via candidateRefusal (logged, not silent)
//   * "is a survival need on" -> the chooser weighs the build against it every tick
//   * the pause hold          -> scheduler.buildReady, from the snapshot's buildHoldMs
//   * "retry if a travel leg failed" -> the tick itself, every ~15s, with a verdict at the end
//     of it instead of an unbounded loop
// The OPERATOR path is untouched: `resumebuild` typed by a human still goes through
// commands.handle and still overrides a stand-down hold, which is the whole point of a hold.

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

let connected = false // live connection state - the ONLY honest source for /health (see bot.on('end'))

// THE RUNNER OWNS EVERY BODY READ (reflexes invariant 2). A hold DECLARES its premise by NAME;
// this is the ONE place that resolves it, read by BOTH watchdogs - two copies of this rule is how
// one watchdog ends up trusting a hold the other has already disowned. An unknown premise name
// stays TRUSTED: a new hold must never be silently stripped of its suppression by a resolver that
// has not been taught about it, and neither must a bot that really is sealed in.
const holdPremiseOK = kind => {
  if (kind !== 'sheltered') return true
  try { if (bot.isSleeping) return true } catch {}
  try { if (provRecovery.isResting && provRecovery.isResting()) return true } catch {}
  try { if (provHut.insideOwnStructure && provHut.insideOwnStructure(bot)) return true } catch {}
  // A SEALED NIGHT PIT is a ceiling a few blocks under the SURFACE - the 2026-07-29 case this
  // whole mechanism exists for (digInForNight caps a shallow hole and sets no latch, so nothing
  // else vouches for it). A bare hasSolidCeiling is NOT that test: underground, a mine roof
  // satisfies it trivially, which is how the bot went on claiming "sheltering until dawn" at y37
  // - thirty-one blocks below its own hut - even after the premise was introduced. So the ceiling
  // only counts near the surface, measured against a GROUNDED read; UNKNOWN fails safe (trusted).
  // A HOLD THAT NAMES ITS WAKE MUST DIE AT THAT WAKE (2026-08-26, live, twice). The sealed-pit
  // premise below is a DAY/NIGHT claim - `nightShelter waking on dawn` - and nothing ever checked
  // whether dawn had come. activeHold() tests only a TTL and this premise, so at 08:36 the
  // heartbeat still published {label:'nightShelter', wake:'dawn'} in broad DAYLIGHT, the tick sat
  // dead behind it, and the run lost hours to it twice. I first patched the SUPERVISOR to tolerate
  // the lie; this is the lie itself. Sleeping and resting keep their own wakes and returned above;
  // being inside a real structure is not a night claim either. Only the pit branch is scoped to
  // night, because only the pit branch means 'sealed in until dawn'.
  try { if (bot.time && bot.time.isDay) return false } catch {}
  try {
    if (provHut.hasSolidCeiling && provHut.hasSolidCeiling(bot, 4)) {
      const s = require('./pathfix.js').surfaceYAt(bot, bot.entity.position.x, bot.entity.position.z)
      if (!s || !s.known || s.y == null) return true
      if (s.y - bot.entity.position.y <= Number(process.env.SHELTER_PIT_DEPTH || 5)) return true
    }
  } catch { return true }
  return false
}

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

// AUDIT D3: the damage log + death-message reader. Installed once, before anything can die.
// Costs nothing while healthy (it samples only on a health DROP) - [[body-first-priority]].
let damageLog = null

bot.once('spawn', () => {
  commands.setupMovements(bot)
  installDigTimeGuard(bot)
  try { damageLog = deathCause.installDamageTracker(bot) } catch (e) { note(`(death-cause) tracker not installed: ${e.message}`) }
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
      if (provMaintain.isMaintaining && provMaintain.isMaintaining()) { try { const dcls = scheduler.commandClass(direct); if (dcls !== 'perception' && dcls !== 'chat') provMaintain.stopMaintenance() } catch {} }
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
// ==== A DISCONNECT MUST BE VISIBLE TO THE SUPERVISOR (2026-08-01) ==========================
// 'end' used to only LOG. `bot.entity` survives the disconnect, so GET /health went on
// answering {ok:true, spawned:true} - and the supervisor, whose entire job is to notice a dead
// body, was told everything was fine. The server closed at 04:30:02 and the bot sat there
// disconnected for NINE HOURS, emitting nothing but its 2-minute resume timer:
//   KICKED: {"type":"string","value":"Server closed"} / disconnected: socketClosed
//   ...then 339x `resume: bootstrap needed (food)` and not one scheduler or watchdog line.
// Same defect as the rest of this session: a claim (`spawned`) read from a STALE artefact
// instead of from the live condition. The connection state is now recorded where the probe
// can see it, so "spawned" means CONNECTED and the supervisor can do its job.
bot.on('end', (reason) => { connected = false; note(`disconnected: ${reason}`) })
bot.on('login', () => { connected = true })

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
  // #112 HAZARD_NOT_LURE: name WHAT KILLED THE BOT, not just "is it risky to come back".
  // The bot could previously represent exactly two ways of dying (lava/fire, via the hand-set
  // `dangerous` flag); a drowning trap was unrepresentable, which is why the grave lure won over
  // a pocket that had just drowned it. The cause is classified here - the one place with the
  // vitals and the blocks at the death cell - and `dangerous` is now DERIVED from it, so there is
  // one taxonomy instead of a flag plus an unwritable rest.
  let hazardNear = false
  try {
    for (let dx = -1; dx <= 1 && !hazardNear; dx++) {
      for (let dy = -1; dy <= 2 && !hazardNear; dy++) {
        for (let dz = -1; dz <= 1 && !hazardNear; dz++) {
          const b = bot.blockAt(p.offset(dx, dy, dz))
          if (b && /lava|fire|magma/.test(b.name)) hazardNear = true
        }
      }
    }
  } catch {}
  // Grounded block reads at the head/feet cells. oxygenLevel is only a corroborating signal:
  // per the project memory it is unreliable on the live server, so it never decides alone.
  let headWater = false; let feetWater = false
  try {
    const hb = bot.blockAt(p.offset(0, 1, 0)); const fb = bot.blockAt(p)
    headWater = !!(hb && /water/.test(hb.name)); feetWater = !!(fb && /water/.test(fb.name))
  } catch {}
  // AUDIT D3. The block reads above are now the FLOOR of the attribution, not the whole of it:
  // they can only ever name the ways the world kills you standing still, which is why 32 of 34
  // deaths on 2026-07-20 were recorded `unknown` - and `unknown` disables the hard hazard rung,
  // keeps `dangerous` false, and makes every "learn from your deaths" mechanism read a column of
  // nulls. The server's own death message is the authority when it exists; the damage log covers
  // the case where it does not. `blockCause` keeps today's behaviour as the last resort.
  const blockCause = gravePolicy.classifyDeathCause({ y: p.y, hazardNear, headWater, feetWater, oxygen: bot.oxygenLevel })
  const att = deathCause.attributeDeath({
    message: damageLog ? damageLog.deathMessage() : null,
    username: bot.username,
    samples: damageLog ? damageLog.samples() : [],
    blockCause
  })
  const cause = att.cause
  const dangerous = gravePolicy.causeWritesOff(cause) // lava/fire/void: the stuff is gone (unchanged semantics)
  const info = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), cause, attacker: att.attacker || null, causeSource: att.source, dangerous, at: Date.now(), retrieved: false }
  try { if (damageLog) damageLog.clear() } catch {} // this death consumed the window; the next one starts clean
  commands.recordDeath(info)
  commands.markBuildInterrupted && commands.markBuildInterrupted() // keep the build to resume
  // #41 P0: set the post-death recovery LATCH - recovery now OWNS the bot and OUTRANKS build-resume
  // until recoveryReady (P4). Cleared by provision.recoveryReadyNow / the scheduler tick. Reads are
  // flag-gated (isPostDeathRecovery), so RESILIENT_RECOVERY=0 leaves this inert = today byte-for-byte.
  commands.setPostDeathRecovery && commands.setPostDeathRecovery(true)
  deathPending = true
  note(`(death) at ${info.x},${info.y},${info.z} (${cause}${att.attacker ? ' - ' + att.attacker : ''}, via ${att.source})${dangerous ? ' - LAVA/FIRE/VOID, risky to return' : ' - can go recover'}`)
})

// After a DEATH -> RESPAWN, auto-resume any interrupted build. The build survives losing
// everything: resumeBuild re-provisions from scratch (or the build's chest) and only
// places the still-missing blocks. 'spawn' also fires on first join, so gate on a death.
let deathPending = false
let autoRecoverTries = 0 // consecutive auto death-drop recovery attempts (capped so recovery can't death-loop)
// THE RUNNER'S STATE (PLAN-one-runner.md). These were six loose module-level `sched*` variables
// that the tick, the watchdog and three reflexes all poked independently. They are the runner's
// own memory - back-offs, latches and the "who is walking home" flag - and the proposals in
// reflexes.js read them in refuse() and write them in run(), through the tick's ctx. Grouping
// them is what lets a proposal own its own back-off without index.js growing another global.
const runner = {
  graveCooldownUntil: 0, // a grave we just failed to open/reach - verdict-classed, not blanket
  hpCooldownUntil: 0, // after a heal attempt: give regeneration a window
  maintainCooldownUntil: 0 // 10 min after a real pass, 5 after a no-op/bail
  // `ladderBlock` and `noOp` LIVED HERE, and both are deleted (structural review D3 / §3.6).
  // They were two latches keyed on the same fingerprint - scheduler.recoverySignature - saying
  // the same true sentence ("re-running a plan whose inputs have not changed cannot produce a
  // different result") about the same jobs. Neither could ever re-arm from a wedge, because
  // position is not in that fingerprint: a bot stuck at full hp beside its house has a signature
  // that cannot move, so both latched their targets off permanently (736 + 651 refusals in one
  // HEAD-era day). One rule with two definitions, and both definitions unreachable from the state
  // they fired in. The rule is written once now, in attempts.js, keyed by (job, step, 4b-cell) -
  // so the re-arm is reachable by the one thing a stuck bot can be made to do: move.
}
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
      // ==== AUDIT 2026-07-29 FIX 2/4: THE HARDCODED RESPAWN SCRIPT IS GONE ==================
      //
      // What stood here was a fixed three-step sequence run once per death: (1) walk home,
      // whatever the distance/hour/armour; (2) then walk home AGAIN to re-anchor the spawn;
      // (3) then consider the grave. Each step was individually reasonable and the sequence was
      // lethal: on 2026-07-20 it marched a naked bot 458-489 blocks into the dark eight times in
      // seven minutes, and because the walk owned the body, the shelter it needed was suppressed
      // for the whole loop. A fixed order cannot weigh itself against the world.
      //
      // Both walks are now CANDIDATES the 15s chooser weighs every tick, against the same
      // journeyAdmissible rule that gates every recovery trek:
      //   - going home        -> the `homecoming` job (scheduler-core B1b)
      //   - fixing the anchor -> bootstrapNeed 'spawn' -> maintenancePass (#117, already wired)
      //   - the grave         -> `graveSweep` (already a candidate)
      // So they still happen - when they are survivable, retried every tick instead of once per
      // death, and losing to shelter/food/heal when those matter more. This handler's whole job is
      // now to set the latch and let the scheduler think (design principle 3).
      const homeAnchor = (provHut.hutAnchor && provHut.hutAnchor()) || (provision.knownBed && provision.knownBed()) || null
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
              const r = await provRecovery.recoverFromDegraded(bot, { say: m => note('(respawn) ' + m), reason: 'respawn' })
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
      // ==== THE RESPAWN NO LONGER RESUMES THE BUILD ITSELF (review D6 / item 7) ============
      // A `for (attempt < 3)` loop stood here calling commands.resumeBuild directly, with a
      // 30-second sleep between tries. It was the third of the build's three private drivers and
      // the least defensible of them: it re-entered the longest job in the process from inside a
      // death handler, on a body that had just respawned, holding no lease and answering to
      // nobody - so the same build could be driven from here and from the 120s re-arm at once,
      // and neither knew about the other.
      // Nothing is lost by deleting it. #41 P0.1 already routes a post-death resume through
      // scheduler.buildReady's postDeathRecovery gate ("the build waits, kept on disk, never
      // driving the naked bot back into the death cell"), and the chooser picks the build up on
      // its own tick the moment recovery reports ready - which is the ONE driver, weighing it
      // against everything else, exactly as it does every other job.
      if (commands.persistedResume && commands.persistedResume()) note('(resume) a saved build is waiting - the chooser resumes it once post-death recovery reports ready')
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

// ==== THE NINE TIMERS THAT USED TO LIVE HERE (PLAN-one-runner S5) ==========================
// auto-cook, survival-hunt, food-top-up, food-crisis, hp-crisis, food-supply, night-shelter,
// gear-up and home-repair were nine independent setIntervals, each with its own guard stack of
// four to eleven latch reads, each able to move the body the moment those latches happened to
// read false. They are all PROPOSALS now - rows in bot/reflexes.js that the scheduler tick
// weighs against everything else and dispatches through one path, where a decline is logged
// with its blocker instead of being a silent `return`.
//
// Three of them (survival-hunt, food-crisis, hp-crisis) had already been dead code since S4:
// `if (SCHED_ON) return` on the first line, ~90 lines of never-executed body behind it. Three
// more (food-top-up, gear-up, home-repair) had been dead since S6 in the same way - they are
// steps 1, 6 and 9 of the maintenance pass, and the registry records that ownership by name.
// Deleting a dead branch is the fix; carrying it is the debt (DESIGN-PRINCIPLES, flag debt).
//
// What is NOT here, deliberately: the INSTANT class above (auto-eat, auto-equip) and the
// time-critical SURVIVE reflexes below (auto-defend at 700ms, the drown escape at 2s). Those
// never conflict or cannot afford a 15s tick, and scheduler.REFLEX_OWNED names the latter.

// PLAN-one-runner: hoisted to module scope so ANY caller can ask the one authority.
// The follow reflexes below consult it too - a sticky-follow that re-issues its goal on a
// sheltering bot is the same defect as a reflex with its own private guard list.
// WHO OWNS THE BODY, asked ONCE per tick, in one place. This single function replaces the ~120
// scattered latch reads across index.js. The ORDER matters: it reports the highest-tier owner
// first, because that is the one a proposal has to out-rank.
//
// ==== ...AND A CLAIM IS A LEASE (2026-08-25, structural review D2) ==========================
// This used to BE the registry: nine `if`s, first match wins, and whatever it returned was the
// final word on who owns the body. Nothing in the process watched a claim. On 2026-08-03 16:54:51
// the recovery ladder's rung deadline abandoned a secureFood promise, `_securingFood` was never
// lowered, and this function answered `foodRun` for THREE HOURS AND FIFTEEN MINUTES - through 328
// ownership refusals, 110 `held (busy building+securing food)` double-owner lines and the process
// dying at 20:10 - on behalf of a job that had not existed since lunchtime.
//
// The latches are still the only witnesses to who is working, so they are still read here. What
// changed is that they are OBSERVATIONS now, not verdicts: they are written through to the ONE
// claim registry (reflexes.syncClaims), each raise opens a lease, and a lease lives only while the
// work behind it produces world-state deltas - the item-1 work ledger, the same evidence the
// supervisor judges a job by, on the same window it calls a job hung. An owner that has produced
// nothing since then is not an owner, and its latch is taken back through the ONE release path.
//
// Each latch is probed under its own try/catch rather than one around all nine. The old shape
// failed open for the WHOLE body - one unreadable latch hid the other eight, including a live
// escape - and "an unreadable owner must never immobilise the bot" is satisfied better, not
// worse, by dropping only the latch that could not be read.
const bodyLatches = () => {
  const up = []
  const probe = (key, fn) => { try { if (fn()) up.push(key) } catch { /* this ONE latch is unreadable: it does not get to own the body, and it does not hide the others */ } }
  probe('escape', () => commands.isEscaping && commands.isEscaping())
  probe('navRecovery', () => navigate.isRecovering() || navigate.isUnsticking())
  probe('ladder', () => provRecovery.isRecoveringDegraded && provRecovery.isRecoveringDegraded())
  probe('foodRun', () => provFood.isSecuringFood && provFood.isSecuringFood())
  probe('shelter', () => provRecovery.isResting && provRecovery.isResting())
  probe('maintain', () => provMaintain.isMaintaining && provMaintain.isMaintaining())
  probe('job', () => commands.isBusy && commands.isBusy())
  probe('walk', () => bot.pathfinder && bot.pathfinder.goal)
  probe('dig', () => bot.targetDigBlock)
  return up
}
// WHO IS DRIVING - i.e. which claim a world delta belongs to. Item 1 left this gap open by name:
// "while one job holds the ledger key, ANY advance in the process credits it". The dispatch slot
// is the answer, and it already exists: it names the job the CHOOSER put on the body, and
// BODY_OWNERS.owns names the claim that job raises. At 16:54 the slot held the ladder, not the
// food run it had abandoned - so the ladder's rungs credit the ladder, and the corpse ages.
// Fallbacks, in order: a commands-level activity (autobuild, a brain command) raises no registry
// row but IS the `job` claim by construction; failing that the top live claim, because with no
// dispatch and no busy latch nothing else could have produced the delta.
const drivingClaim = (up) => {
  const d = dispatchBusy()
  const k = d && d.jobKey ? reflexes.claimOfJob(d.jobKey) : null
  if (k) return k
  if (up.includes('job')) return 'job'
  return up.find(key => !((reflexes.ownerInfo(key) || {}).engine)) || null
}
// A lease expired. The claim stops being an owner the moment syncClaims says so - it does NOT wait
// for the latch to be honoured, because a hung promise is precisely the case where nothing honours
// anything. The latch behind it is then taken back through the ONE release path, scoped to this
// claim: without that, `isSecuringFood()` keeps answering true and every future food run returns
// `blocked on busy` at its own front door (44 of the 328 refusals in the terminal window).
const revokeClaim = (c) => {
  const row = reflexes.ownerInfo(c.key) || {}
  note('(claim) REVOKED ' + c.key + ' (' + (row.label || c.key) + ') - ' + c.why + '; it is not an owner any more')
  try {
    const freed = commands.releaseBodyClaims('claim lease expired: ' + c.key + ' - ' + c.why, { only: [c.key] })
    note(freed
      ? '(claim) ...and took back the latch it was still holding: ' + freed
      : '(claim) ...nothing to take back: the latch behind ' + c.key + ' is outside releaseBodyClaims\' owners table - a wiring hole, not a decision')
  } catch (e) { try { note('(claim) ...release threw: ' + e.message) } catch {} }
  try { commands.recordOutcome('claim:' + c.key, false, c.why) } catch {}
}
const bodyOwner = () => {
  try {
    const up = bodyLatches()
    // An unreadable ledger is NOT evidence that an owner is stuck (#10): syncClaims makes no
    // revocation verdict without it, so this passes the absence through rather than inventing one.
    const ev = (() => { try { return commands.advanceInfo() } catch { return { at: null } } })()
    const r = reflexes.syncClaims(up, { driver: drivingClaim(up), at: ev.at, vitals: { hp: bot.health, food: bot.food } })
    for (const c of r.revoked) revokeClaim(c)
    return r.owner
  } catch { /* the registry itself failing must never immobilise the bot */ return null }
}

// SCHEDULER TICK (S4, REDESIGN §3.2/§10): ONE dispatcher for the survival tier. Replaces the three
// ad-hoc crisis timers above (SURVIVAL_HUNT/FOOD_CRISIS/HP_CRISIS early-return while SCHEDULER is
// on). Builds a snapshot, asks the pure pickJob which ONE job should own the body, and dispatches
// ONLY survival-class jobs to the existing executors (graveSweep->recover, secureFood, recoverHp),
// preempting a busy body only on a crisis-grade need or a near grave. SCHEDULER=0 removes it entirely.
// ==== THE DISPATCH SLOT IS A LEASE, NOT A FLAG (2026-07-30) ==============================
// `schedJob` is an EXCLUSIVE claim on the body: while it is set, the scheduler tick returns early
// and dispatches nothing (see `dispatchBusy()` consumers below). Its release was coupled to
// `runJob`'s promise resolving - so an executor that never resolves held the slot FOREVER and the
// bot could never run another job. Live 2026-07-30, repeatedly, on three different jobs:
//   (wd) stop latch ineffective on recoveryLadder - a hung promise; standing down, layer d ... owns this
//   (wd) stop latch ineffective on secureFood     - a hung promise; ...
//   (wd) stop latch ineffective on recover        - a hung promise; ...  (every 2-3 min, for hours)
// The escalation ladder's last rung (GIVEUP) only LOGGED and deferred to "layer d", which never
// collected them. So NUDGE -> FAIL-JOB -> GIVEUP ended in a rung with no power, and every latch in
// the system is COOPERATIVE: it can only be seen by a job that awaits something polling isStopped().
// A job hung in an await that never settles cannot observe any of them, by construction.
//
// reflexes.js already solved this for body HOLDS and states the rule in its own comment:
// "an expired hold is NOT a hold: the watchdog gets the body back" (activeHold drops expired
// entries lazily on read). The dispatch slot was the one exclusive claim exempt from that rule.
// This applies the EXISTING rule rather than adding a special case: the slot carries an expiry, is
// checked on read, and can be REVOKED. A generation counter makes the revocation safe - a
// late-resolving abandoned executor must never clear its successor's slot.
const DISPATCH_LEASE_MS = parseInt(process.env.DISPATCH_LEASE_MS || '600000', 10)
let schedJob = null             // the single job-latch (I4): one scheduler dispatch at a time
let schedGen = 0                // bumped on every dispatch AND every revoke - the anti-clobber epoch

// The slot, or null - expiring a stale lease lazily on read, exactly as reflexes.activeHold does.
// This is the ONE definition of "is a dispatch in flight"; nothing may test `schedJob` directly.
// ==== ...AND THE LEASE IS RENEWED BY EVIDENCE (2026-08-25, review item 7) ==================
// `until` was a flat 600s from dispatch, which is a blanket timer (#6) and was survivable only
// because nothing dispatched here ran longer than a few minutes. Item 7 puts the BUILD in this
// slot, and a build legitimately runs for hours: a flat expiry would have revoked a healthy
// build - clearing its nav goal, its control states and its body claims - every ten minutes,
// forever. The fix is not a bigger number for the build (that is a second definition of "hung",
// and the seam comes straight back). It is the rule item 2 already wrote for body claims, said
// once more here: a lease that is producing world-state deltas does not expire. So the deadline
// is measured from the LAST ADVANCE, not from the dispatch - identical behaviour for a hung
// executor (it produces nothing, so `adv` never moves and it dies at startedAt+600s exactly as
// before) and unbounded for one that is actually working, which is what a lease should mean.
// The advance record is the process-wide one on purpose: the slot-holder IS the driver (that is
// drivingClaim's whole premise), so while it holds the slot its work is the work.
function dispatchBusy () {
  if (!schedJob) return null
  const adv = (() => { try { return commands.advanceInfo().at || 0 } catch { return 0 } })()
  const deadline = Math.max(schedJob.until || 0, adv + DISPATCH_LEASE_MS)
  if (schedJob.until != null && deadline <= Date.now()) {
    const stale = schedJob
    revokeDispatch('lease expired after ' + Math.round((Date.now() - stale.startedAt) / 1000) + 's with no world delta for ' + Math.round((Date.now() - Math.max(adv, stale.startedAt)) / 1000) + 's')
    return null
  }
  return schedJob
}
// THE IN-FLIGHT DISPATCH, WHEN IT STILL ENDS THE TICK (review item 7).
//
// `if (dispatchBusy()) return` was the tick's first guard, and for as long as every dispatch was
// a few minutes long it was a fair proxy for "the body is taken, there is nothing to decide".
// With the build dispatched like everything else it stops being one: a chooser that cannot make
// a decision for the several HOURS a castle takes is the 2026-08-03 day rebuilt on purpose - the
// night shelter, the food run, the grave sweep, the recovery ladder and the terminal action are
// all dispatched from this tick and every one of them would have been unreachable.
//
// The slot was doing arbitration's job. Arbitration has an owner: reflexes.bodyRefusal, plus the
// slot-rank clause in candidateRefusal below. So a dispatch of PROGRESS tier or lower no longer
// ends the tick - the tick keeps choosing, and the ONLY things that can be dispatched over the
// incumbent are the ones that already out-rank it and already have to preempt it first (step 7),
// which is exactly what happened while the build ran INLINE. A SURVIVE-tier dispatch still ends
// the tick: nothing out-ranks survival work, so there is genuinely nothing left to decide.
function gatingDispatch () {
  const d = dispatchBusy()
  if (!d) return null
  const row = d.jobKey ? reflexes.get(d.jobKey) : null
  // No row (a legacy/unknown key) -> treat it as gating, the conservative direction.
  if (!row || reflexes.tierRank(row.tier) >= reflexes.TIERS.SURVIVE) return d
  return null
}

// Take the body back from a job that cannot give it back. Releases the declared hold, frees the
// slot, bumps the epoch, and - critically - lets go of the CONTROLS and the nav goal: an abandoned
// executor may still be steering, and two actors driving one body is precisely what the one-runner
// work forbids. The abandoned promise is left to settle into nothing; its `finally` is epoch-guarded.
//
// ==== "THE BODY IS FREE FOR THE NEXT JOB" HAD TO BE MADE TRUE (2026-08-02) ================
// It was not. The slot is only ONE of the two records of "this job owns the body"; the other is the
// executor's own latch (`_recoveringDegraded`, `_maintaining`, `_securingFood`, `_resting`,
// `provisioning`), raised before the await and lowered in a `finally` a hung executor never reaches.
// reflexes.BODY_OWNERS reads THOSE, not the slot - and `ladder` is `hard: true`, so it refuses
// everything, at every tier, crisis included.
//
// Live, 18:12:40 local:
//   (wd) REVOKED the dispatch slot from recoverFromDegraded - lease expired after 605s; the body is free
//   (core) maintenancePass REFUSED: the recovery ladder owns the body      <- for the next 19 minutes
//   (core) nightShelter    REFUSED: the recovery ladder owns the body
//   (core) chose build/idle: standoff ... CRISIS UNANSWERED (nightShelter: the recovery ladder owns
//          the body; ...) | hp=20 food=20 armor=0
// The bot stood on one block, hp 20 / food 20 / naked, from 18:00 to 18:31 - through a full night -
// refused by a ladder that had not existed for nineteen of those minutes. The log line was a lie in
// exactly the way #7 forbids: it reported an intent, not what happened.
//
// The release itself needed no new machinery and no fourth actor on the reclaim path: the WATCHDOG
// GIVEUP rung's `!revoked` branch already did precisely this (index.js, "...AND THE BODY CLAIM"),
// so the two branches of one verdict disagreed about what taking the body back means. The call
// moves HERE, where the verdict is made, and the duplicate is deleted from that branch (#4).
// Both callers of this function are already terminal judgements about an abandoned executor - a
// 600s lease expiry, and the giveup rung after its full verified-progress ladder - so this is never
// reached for a job that is merely slow.
function revokeDispatch (why) {
  const j = schedJob
  if (!j) return false
  schedJob = null
  schedGen++
  try { if (j.holdToken) reflexes.endHold(j.holdToken) } catch {}
  try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
  try { commands.touchProgress('dispatchRevoked:' + j.name) } catch {}
  note('(wd) REVOKED the dispatch slot from ' + j.name + ' - ' + why + '; the body is free for the next job')
  // ...and the latch that OUTLIVES the slot, which is the one the chooser actually reads.
  try {
    const freed = commands.releaseBodyClaims('dispatch revoked: ' + j.name + ' - ' + why)
    if (freed) note('(wd) ...and released the body claim ' + j.name + ' was still holding: ' + freed + ' - without this the chooser refuses every candidate to a job that no longer exists')
  } catch (e) { try { note('(wd) ...body-claim release threw: ' + e.message) } catch {} }
  try { commands.recordOutcome('revoke:' + j.name, false, why) } catch {}
  return true
}
let schedLastLog = ''           // decision-change log throttle
let schedHeldLog = ''           // busy-held note throttle (separate so it never clobbers the decision key)
// (the back-offs and latches that used to live here as five loose `sched*` globals are the
//  runner's own state now - see `runner` above. The two that were keyed on recoverySignature -
//  FIX 3's ladder gate and FIX 11's job-identity latch - are gone entirely: "I tried this and it
//  achieved nothing" is a fact about a PLACE and lives in attempts.js, asked once for every job.)
let schedOppLastWindowAt = 0 // last opportunistic window CLOSE (drives the checkupDue bit)
let schedDeferNoted = ''        // one note per deferred job kind (nightShelter/maintain/degraded/ladder-reflex)
let schedLastPick = null        // S7 idle-with-work: the tick's last pickJob decision
let schedLastPickAt = 0
let schedLastTickAt = 0          // S7 tick-liveness: last time the tick body entered (the watchdog re-arms if this goes >90s stale)
let tickGen = 0                 // S7 generation guard: a resurrected tick chain can never coexist with the live one
// ONE number, two consumers (#4): rung 7 asks "is the last pick still a live decision?" and rung 8
// asks "is the tick chain still alive?" - they are the same question about the same chain, and they
// drifted into a hard-coded 90000 in one and an unchecked staleness in the other. A chain quieter
// than this is presumed dead: with the dispatch-and-return change below the tick re-enters every
// few seconds even while a job runs, so silence this long is anomalous, never merely slow.
const TICK_STALE_MS = 90000
let schedGateKey = ''            // ROOT H: which tick gate is currently held (throttle key)
let schedGateSince = 0           // ...and since when, so the note can carry the number
let schedGateNotedAt = 0         // ...and when we last said so, so it is not chatty (#8)
// ROOT H (2026-08-02): THE list of latches that can gate the scheduler tick, each naming WHO can
// force-release it. It exists because the tick's gate list and commands.releaseBodyClaims' release
// list are two copies of one rule (#4) and they had already drifted: the rung released
// building/provisioning/buildReqActive - none of which gate the tick - and released none of the
// four that do. Live 2026-08-02: the tick ran every cycle (rung 8 never fired, schedLastTickAt
// fresh) and yet schedLastPick went 412s stale, i.e. every single cycle returned here, silently,
// for seven minutes. A decision that produces no action and says nothing is the defect (#5, #7).
//   third column = the owner of the force-release. 'engine-state' means it is NOT ours: a bot that
//   is genuinely asleep SHOULD gate the tick, and mineflayer clears bot.isSleeping itself on wake,
//   so there is nothing to release and a long hold there is legitimate - which is also why only
//   the non-engine gates can raise the stuck-gate note below.
// tickgatetest.js reads this table and fails if a gate here has no force-release in
// releaseBodyClaims, so a future gate cannot be added without one.
const TICK_GATES = [
  ['escaping', () => !!(commands.isEscaping && commands.isEscaping()), 'commands.releaseBodyClaims'],
  ['nav-recovering', () => !!navigate.isRecovering(), 'navigate.releaseNavLatches'],
  ['nav-unstick', () => !!navigate.isUnsticking(), 'navigate.releaseNavLatches'],
  ['sleeping', () => !!bot.isSleeping, 'engine-state']
]
if (SCHED_ON) {
  const GRAVE_NEAR_LADDER = Number(process.env.GRAVE_NEAR_LADDER || 32)
  const schedSay = m => bot.chat(String(m).slice(0, 200))
  // ==== AUDIT 2026-07-29 FIX 11: JOB IDENTITY (AltoClef's Task.isEqual, generalised) =======
  // AltoClef gives every Task an `isEqual`, so re-issuing a task equal to the running one
  // CONTINUES it instead of restarting it. The absence of that primitive is literally loop #2 of
  // this audit: the recovery ladder re-derived an identical plan against an identical world every
  // 60s, forever. FIX 3 solved it for the ladder alone, with recoverySignature.
  //
  // This is the same idea for every survival job: when a dispatch produces NOTHING and the world
  // has not changed in any way the recovery machinery cares about, re-dispatching it is provably
  // pointless, so candidateRefusal refuses it and the chooser spends the tick on something else.
  // The latch clears the instant the signature moves - a CONDITION, never a timer.
  //
  // Deliberately narrow: only a job that reported a NO-OP arms it. A job that did work, failed
  // loudly, or threw is left alone (a real failure often deserves an immediate retry).
  // ==== THE JOB-IDENTITY LATCH IS THE EXECUTOR'S OWN VERDICT, NOT A REGEX ON ITS PROSE =====
  //
  // FIX 11's latch means "this ran in this exact world and achieved nothing, so running it again
  // cannot produce a different result". It decided that by REGEX-MATCHING the result string:
  //   NOOP_RE = /^(no-op|nothing|could not|couldn't|not fed|NOT recovered|deferred|held|blocked)/i
  // Live, 2026-07-29 21:12, at hp 1 / food 0 / naked:
  //   (sched) recoverFromDegraded -> NOT recovered (stopped, blocked on no-progress)
  //   (sched) recoverFromDegraded achieved nothing - not re-dispatching it until the situation changes
  //   (core) chose build/idle: CRISIS UNANSWERED (...) - doing what i can instead: resuming the build
  // The ladder had been STOPPED - by the watchdog's own fail-job lever - and an interrupted pass
  // proves NOTHING about the world. The regex could not tell "I tried everything and the world
  // will not budge" from "someone stopped me mid-sentence", so a starving bot latched off its own
  // recovery and went back to the build. (Ironically this only bit once the latch was keyed
  // correctly: before that it silently never matched for the ladder at all.)
  //
  // So a proposal now SAYS whether it achieved nothing, from data it actually has - fed/blockedOn,
  // rested true/false, steps.length - and the two transient blockers ('busy', 'stopped') are never
  // a verdict about the world. A survival policy must not be decided by a regex on a log line.
  // THE STEP HALF OF THE ATTEMPT KEY (job, step, cell) - review §3.3.
  // A job that plans in steps names the step it is attempting, so "gathering 3x oak_log failed
  // here" is remembered about THAT step and not about the whole build. Nothing declares one yet:
  // checklist steps arrive with item 7 (job-level verdicts), and until then every job has exactly
  // one step, '-'. It is a function rather than a literal precisely so the RECORD side and the
  // QUERY side can never key on two different things (#4) - both call this, and item 7 fills it in
  // in ONE place.
  const stepOf = (jobKey) => {
    const p = reflexes.get(jobKey)
    if (p && typeof p.step === 'function') { try { return String(p.step() || '-') } catch { return '-' } }
    return '-'
  }
  // runJob(name, executor, opts) - the ONE dispatch path. `opts.holds` is a proposal's DECLARED
  // hold ({ wake }): while it is in force the body is deliberately still and the watchdogs must
  // not read that stillness as a hang (PLAN §3.4; the 2026-07-29 creeper death).
  const runJob = async (name, executor, opts = {}) => {
    // `jobKey` is the CHOOSER's name for this work; `name` is the executor's. They differ for two
    // jobs (recoveryLadder->recoverFromDegraded, graveSweep->recover) and the job-identity latch
    // must key off the chooser's, or it silently never matches the candidate it is meant to
    // refuse - which is exactly what FIX 11 did for the ladder until this line existed.
    const jobKey = opts.jobKey || name
    // The lease: this dispatch owns the slot until it returns OR the lease runs out, whichever is
    // first. `myGen` is the epoch this executor belongs to - if the slot is revoked underneath it,
    // the epoch moves on and this executor's `finally` must not touch its successor's state.
    const myGen = ++schedGen
    const startedAt = Date.now()
    // `jobKey` rides in the slot because the slot is the answer to "who is driving" (see
    // drivingClaim above): BODY_OWNERS.owns is keyed by the CHOOSER's name, and `name` here is the
    // executor's - they differ for recoveryLadder/graveSweep, which is exactly the pair the claim
    // registry must not mis-credit.
    schedJob = { name, jobKey, startedAt, gen: myGen, until: startedAt + DISPATCH_LEASE_MS, holdToken: null }
    // NO t0 STAMP. `touchProgress('dispatch:' + name)` used to live here so a just-dispatched job
    // read as zero-idle - but it wrote that into the ONE global progress cell, so being dispatched
    // told every OTHER reader the body had progressed. The work ledger re-bases on the new jobKey
    // by itself (telemetry.jobProgress), which is the same guarantee without the lie (review D1).
    // What this dispatch still needs is a BASELINE, so the release below can tell "this job did
    // something" from "this job merely ran" - and the honest baseline is the work counter, not a
    // timestamp anything could have refreshed.
    const t0Progress = (() => { try { return commands.progressInfo().advanceCount || 0 } catch { return 0 } })()
    const holdToken = opts.holds ? reflexes.beginHold(name, opts.holds.wake, opts.holds.ttlMs || 900000, { premise: opts.holds.premise }) : null
    if (schedJob && schedJob.gen === myGen) schedJob.holdToken = holdToken // so a revoke can release it
    try {
      // An executor returns either a plain string (what happened, for the log) or
      // { msg, noOp } - `noOp` being ITS OWN verdict that it ran to completion and the world
      // would not budge. Nothing here inspects the prose.
      const r = await executor()
      const obj = r && typeof r === 'object' && !Array.isArray(r)
      const msg = obj ? (r.msg || 'done') : (r === false ? 'no-op/deferred' : (typeof r === 'string' ? r.split('\n')[0] : 'done'))
      note('(sched) ' + name + ' -> ' + msg)
      try {
        // THE VERDICT IS RECORDED AGAINST A PLACE, NOT AGAINST AN ABSTRACT WORLD (review §3.3).
        // Same executor verdict as before (`r.noOp`, data the executor computed, never a regex on
        // its prose); what changed is the KEY. The signature still rides along - as the record's
        // "and the world still reads the same" clearing condition, never as the key - so this is
        // strictly MORE re-armable than the latch it replaces: moving 4 blocks, changing step or
        // changing the world each re-arms it, where before only the last could, and only the last
        // was unreachable from a wedge.
        const cell = attempts.cellOf(bot.entity && bot.entity.position)
        if (obj && r.noOp === true) {
          let sig = ''
          try { sig = scheduler.recoverySignature(await provision.schedulerState(bot)) } catch {}
          const rec = attempts.record(jobKey, stepOf(jobKey), cell, { sig, why: r.noOpWhy || 'it ran to completion and the world would not budge', now: Date.now() })
          note('(sched) ' + name + ' achieved nothing HERE (cell ' + cell + ', attempt ' + rec.n + ') - not re-dispatching it until i move, it changes step, or the world does')
        } else attempts.forget(jobKey, stepOf(jobKey), cell)
      } catch {}
    }
    catch (e) { note('(sched) ' + name + ' failed: ' + e.message); try { commands.recordOutcome('sched:' + name, false, e.message) } catch {} } // a failed dispatch is an OUTCOME the brain and the flight recorder must see; it used to be gated behind CYCLE_DETECT (default on), and the dead side of that flag went with cycle-detect.js (review §3.6 / DESIGN-PRINCIPLES flag debt)
    finally {
      // Release the declared hold and touch progress ONCE, on the way out. That single touch is
      // what the per-hold heartbeats were really for: without it a job that legitimately sat
      // still for ten minutes is instantly stale when it stands up again. One honest stamp at
      // release beats a 3-second heartbeat claiming progress that never happened.
      // EPOCH-GUARDED. If the slot was revoked while this executor was hung, the body has already
      // been handed to someone else - a late return must release only ITS OWN hold and then keep its
      // hands off. Clearing `schedJob` unconditionally here would silently free the SUCCESSOR's slot
      // and let two jobs run at once, which is the exact invariant the one-runner work established.
      const mine = schedJob && schedJob.gen === myGen
      if (holdToken) reflexes.endHold(holdToken) // idempotent (Map.delete) - safe either way
      if (mine) {
        // ==== A JOB THAT MERELY RAN IS NOT PROGRESS (2026-07-31) ==========================
        // This stamp used to be UNCONDITIONAL, and it blinded the one mechanism whose whole job
        // is to notice a frozen bot. Live: the build and the opportunistic maintain livelocked -
        //   OPPORTUNISTIC MAINTAIN - at the hut mid-build (pausing the build; it resumes via re-arm)
        //   maintenancePass -> window abandoned - build did not unwind in time (60s retry)
        // ...every ~90s. maintenancePass returns a plain string there, so each abandoned window
        // stamped `holdReleased:maintenancePass` and reset the progress clock. The body did NOT
        // MOVE FOR 5.5 HOURS (no [prov]/[build]/[nav] line at all) and the watchdog never fired a
        // single NUDGE, because the livelock kept feeding its witness.
        // That is this session's defect one more time: a record written from an ATTEMPT instead of
        // from EVIDENCE. The release stamp is honest ONLY for a job that actually did something -
        // the case its comment describes ("a job that legitimately sat still for ten minutes").
        // So: stamp only if something touched progress BETWEEN dispatch and release. If nothing
        // did, this job ran and the world did not budge, and the watchdog must keep aging.
        let didWork = true
        try { didWork = (commands.progressInfo().advanceCount || 0) !== t0Progress } catch {}
        if (didWork) commands.touchProgress('holdReleased:' + name)
        else note('(sched) ' + name + ' released having touched nothing - NOT stamping progress (a frozen body must stay visible to the watchdog)')
        schedJob = null
      } else if (holdToken) {
        note('(sched) ' + name + ' returned after its slot was revoked - releasing its hold only, not the current job\'s')
      }
    }
  }
  // #65 DYNAMIC_CORE Phase 1 adapter: run the PURE schedulerCore.chooseActivity and shape its verdict
  // into the SAME `pick` object pickJob returns, so the whole dispatch block below is unchanged. The
  // caller (here) owns the clock - it passes Date.now() in so the pure fn never reads one itself. On a
  // build/idle verdict (job=null) it delegates to pickJob, whose survival tier the core has already
  // cleared, so pickJob returns exactly the same build/resume/brain/maintain/idle decision it would.
  // #114 ONE_READINESS (design §3.7): the chooser's verdict, with the executor's refusal FED BACK
  // IN-TICK. `buildRefusal` is the precondition probe - it asks scheduler.buildReady, the SAME
  // function the chooser scores the build candidate with and the SAME one commands.js resumeBuild
  // enforces, so a disagreement between the three is unrepresentable rather than merely unlikely.
  // (That is why this probe is near-inert in practice; it exists so a FUTURE executor gate cannot
  // recreate the standoff - the design's cross-check of item 12 against B2.) The bounded, condition-
  // scoped re-selection loop itself lives in the PURE core (schedulerCore.selectWithRefusals).
  // ==== AUDIT 2026-07-29 FIX 4: EVERY dispatch guard is a refusal the chooser can see =======
  //
  // `buildRefusal` used to be the whole of this: it returned null for every candidate whose job
  // was not the build, so #114's refusal-feedback machinery was wired to exactly one of six
  // candidates. Every OTHER "the executor cannot run right now" condition lived as a silent
  // `return` further down the dispatcher - a second, invisible decision-maker that overruled the
  // chooser ~90% of the time and told nobody (780 decisions, 82 executions, 2026-07-20).
  //
  // This is that same probe, generalised. It answers, for ANY candidate, "would the dispatcher
  // actually run this right now, and if not, what condition is in the way?" A refusal re-enters
  // selection immediately (schedulerCore.selectWithRefusals), so the tick picks the best thing it
  // CAN do instead of standing still - and it is logged with its blocker, every time.
  //
  // Only PERSISTENT conditions belong here. A momentary one (a job already latched, the tick
  // re-entering) is handled by the tick's own early-return, not by refusing a candidate.
  //
  // ==== PLAN-one-runner S2/S3: THE GUARD STACKS COLLAPSE INTO ONE QUESTION ==================
  //
  // Every candidate's "can the dispatcher actually run this?" is now answered in the same three
  // steps, in this order, for every proposal in the registry:
  //   (1) has this job already achieved nothing in exactly this world?   (FIX 11 job identity)
  //   (2) who owns the body, and does this proposal out-rank them?       (reflexes.bodyRefusal)
  //   (3) the proposal's OWN persistent conditions                       (its refuse(), one place)
  // There is no per-job guard list any more. Adding a behaviour is adding a row to reflexes.js,
  // not editing eleven other behaviours' guard stacks - which is the O(n^2) coupling (audit D5)
  // that made a missing guard invisible until it killed the bot.

  // The tick's context, built ONCE per tick and handed to every refuse()/run(). One snapshot,
  // one clock reading, one food threshold - so a refusal and the choice it feeds back into can
  // never disagree about the world (the snapshot-TIMING drift #114 left open).
  const mkCtx = (s, pick) => ({
    s,
    now: Date.now(),
    nowMs: () => Date.now(), // executors run for minutes; a cooldown they set is stamped on the way out
    foodThreshold: (() => { try { return foodSec.busyPreemptFood() } catch { return 6 } })(),
    progressFoodMin: parseInt(process.env.PROGRESS_FOOD_MIN || '14', 10),
    knownBed: (provision.knownBed && provision.knownBed()) || undefined,
    nearestGrave: (s.graves || []).filter(g => g && !g.dangerous && g.value > 0 && g.dist != null).sort((a, b) => a.dist - b.dist)[0] || null,
    pick: pick || null,
    say: schedSay,
    note,
    // A DECLARED HOLD IS ALIVE BY CONSTRUCTION, and the runner is the only layer that can judge a
    // hold's PREMISE (holdPremiseOK reads the body; reflexes.js only ever knows the premise's
    // name). The supervisor already asks this on its 5s pass; the terminal action needs the same
    // answer before it forces a physical un-wedge, because "sitting perfectly still until dawn"
    // is a goal and the layer that could not tell the difference dug the bot out of its own
    // sealed shelter on 2026-07-29 and got it killed by a creeper. One reader, one definition.
    holdOK: () => { try { return reflexes.activeHold(holdPremiseOK) } catch { return null } },
    runner
  })
  // Is this proposal crisis-grade RIGHT NOW - i.e. may it take the body off a build, or out of a
  // shelter? The two existing authorities, unchanged: scheduler.preemptCrisisGrade (a death
  // spiral / the post-death latch) and the arbiter's live survival need. Read off the tick
  // snapshot rather than by re-scanning the world, so it agrees with the pick it is judging.
  const crisisGrade = (p, s, ctx) => {
    const latch = RESILIENT_ON && commands.isPostDeathRecovery && commands.isPostDeathRecovery()
    if (scheduler.preemptCrisisGrade({ name: p.label || p.name, deathsRecent: s.deathsRecent || 0, postDeathRecovery: latch })) return true
    try { return !!arbiter.jobSurvivalNeed(s, { foodThreshold: ctx.foodThreshold }) } catch { return false }
  }
  const candidateRefusal = (c, s) => {
    if (!c) return null
    const job = c.job
    // (a) BUILD / IDLE - the #114 probe, unchanged: the same buildReady the executor enforces.
    if (job == null) {
      let r = null
      try { r = scheduler.buildReady(s) } catch { return null }
      return (r && !r.ok) ? { key: 'build', why: r.why + (r.need ? ' (needs ' + r.need + ')' : '') } : null
    }
    const p = reflexes.get(job)
    // A job with no row in the registry is a WIRING BUG, not a refusal - the tick's dispatch tail
    // says so out loud rather than swallowing it (and bot/reflexestest.js makes it impossible).
    if (!p) return null
    // (00) THE TERMINAL ACTION IS NEVER REFUSED (review §3.3). Not "is refused for fewer
    //      reasons" - never, by any rule in this function, including body ownership: it TAKES the
    //      body (step 7 below) rather than waiting for it. This is the single line that makes the
    //      arbiter a total function, and reflexestest.js pins the other half of the contract (a
    //      terminal row may not carry a refuse()). If this ever returns a refusal, the chooser is
    //      back to accepting "no" for an answer and the bot stands still for 3 hours.
    if (p.terminal) return null
    // (0a) THE SLOT IS A CLAIM TOO (review item 7). The tick's first guard used to end the tick
    //      on ANY dispatch in flight, and that early-return was carrying the whole of "one job at
    //      a time" on its own. `gatingDispatch` hands the PROGRESS-tier half of that duty back to
    //      the ordering rule, so the rule has to say it: an incumbent that holds the slot is not
    //      a candidate, and a candidate that does not OUT-RANK the incumbent may not be dispatched
    //      on top of it. Without this the same job could be dispatched twice in the window between
    //      runJob taking the slot and its executor raising its body latch - the exact race the
    //      early-return closed by accident.
    {
      const infl = dispatchBusy()
      if (infl) {
        if (infl.jobKey === job) return { key: job, why: 'it is already running - it holds the dispatch slot (' + Math.round((Date.now() - infl.startedAt) / 1000) + 's)' }
        const irow = infl.jobKey ? reflexes.get(infl.jobKey) : null
        const irank = irow ? reflexes.tierRank(irow.tier) : reflexes.TIERS.PROGRESS
        if (reflexes.tierRank(p.tier) <= irank) return { key: job, why: infl.name + ' holds the dispatch slot and this does not out-rank it' }
      }
    }
    const ctx = mkCtx(s, c)
    // (0) ATTEMPT MEMORY (review §3.3, replacing FIX 11's job-identity latch): this job already
    //     ran HERE, in a world that still reads the same, and achieved nothing. Running it again
    //     from this same cell cannot produce a different result - but moving four blocks, or
    //     changing step, or the world moving, each makes it live again. The old latch had only
    //     the last of those three re-arms and it was unreachable from a wedge, which is how a
    //     stuck bot disqualified its own rescuer permanently (736 refusals in a day).
    {
      let sig = ''
      try { sig = scheduler.recoverySignature(s) } catch {}
      const cell = attempts.cellOf(bot.entity && bot.entity.position)
      const rec = attempts.futile(job, stepOf(job), cell, sig)
      if (rec) return { key: job, why: 'already tried this here (cell ' + cell + ', attempt ' + rec.n + ') and it achieved nothing - ' + rec.why + '; moving, changing step or the world changing re-arms it' }
    }
    // (1) BODY OWNERSHIP - the one ordering rule. This is the whole of what "if (isBusy()) return;
    //     if (isResting()) return; if (isSecuringFood()) return; ..." used to say, and unlike
    //     those it is LOGGED and re-routes the tick to something it can actually do.
    const ownerKey = bodyOwner()
    if (ownerKey) {
      const why = reflexes.bodyRefusal(p.tier, ownerKey, { crisis: crisisGrade(p, s, ctx), name: p.name })
      if (why) return { key: job, why }
    }
    // (2) the proposal's own persistent conditions (its back-off, its night gate, ...) - written
    //     once, beside the executor they gate, instead of scattered down the dispatcher.
    if (typeof p.refuse === 'function') {
      let why = null
      try { why = p.refuse(ctx) } catch (e) { why = null } // a refusal that throws must not silently block the job
      if (why) return { key: job, why }
    }
    // (3) a proposal EXECUTED BY ANOTHER JOB is never dispatched on its own - it names its owner.
    if (typeof p.run !== 'function') return { key: job, why: 'performed by ' + p.owner + ', which the chooser weighs on its own terms' }
    return null
  }
  let coreLastChoice = '' // log the CHOICE on change; dispatches, refusals and standoffs always log
  // job|why -> printed. Bounded by construction: the keys are (candidate x its own refusal
  // reasons), a small closed set. Cleared whenever the CHOSEN line changes, so a genuinely new
  // situation re-prints its refusals and a stuck one does not repeat them every two seconds.
  const coreRefusalNoted = new Map()
  const coreAdapter = (s) => {
    const aj = s.activeJob || null
    // IS ANYBODY ALREADY ANSWERING THE CRISIS? (review §3.3, case (a)). bodyOwner() is the claim
    // registry's effective owner and a revoked claim is not an owner (item 2), so a SURVIVE-tier
    // owner here is one whose work produced a world delta inside the watchdog's own fail window.
    // That is an ACTOR, and a crisis with an actor is not unanswered - which is what 248 of the
    // 847 CRISIS UNANSWERED lines actually were. It is also what stops the terminal action from
    // yanking the body out from under a live escape or a food run that is genuinely feeding us.
    const ownerKey = bodyOwner()
    const ownerRow = ownerKey ? reflexes.ownerInfo(ownerKey) : null
    // ...and a SURVIVAL RUN NESTED INSIDE A PROGRESS JOB IS STILL SOMEBODY ANSWERING (2026-08-26).
    // bodyOwner() knows who HOLDS the body; it does not know what the body is DOING. The build
    // holds a PROGRESS claim while running the food chain inside itself (resumeBuild's material
    // chain, travelFar's mid-trek block), so this read null and the terminal action killed the very
    // job that was feeding us - 14s in, mid-farm-build, every cycle. s.survivalRun answers from the
    // producers' own latches instead of from the claim label (§10: the world, not a proxy).
    const survivalActor = (ownerRow && ownerRow.tier === 'SURVIVE' ? { key: ownerKey, label: ownerRow.label } : null) ||
      (s.survivalRun ? { key: s.survivalRun.key, label: s.survivalRun.label } : null)
    // ...and the SAME crisis-grade verdict the ownership rule applies, asked for the terminal row,
    // so "crisis" cannot mean one thing to the chooser and another to the body-ownership rule (#4).
    const terminalRow = reflexes.get(reflexes.TERMINAL) || { name: reflexes.TERMINAL }
    // (the only thing crisisGrade reads off a ctx is the food threshold, so this builds that one
    //  field rather than a whole mkCtx per tick - #8, body budget before observability)
    const crisis = (() => {
      try { return crisisGrade(terminalRow, s, { foodThreshold: foodSec.busyPreemptFood() }) } catch { return null }
    })()
    const c = schedulerCore.selectWithRefusals(s, {
      activeJob: aj && aj.name,
      activeCls: aj && aj.cls,
      lastProgressAt: aj && aj.lastProgressAt, // verified-progress timestamp (caller-provided; drives the anti-thrash bonus)
      survivalActor,                           // §3.3 case (a): who is already acting
      crisisGrade: crisis,                     // §3.3 case (b): may this need take the body at all
      now: Date.now()                          // caller's clock - the pure core compares timestamps, never reads a clock
    }, candidateRefusal, (cand, rf) => {
      // THROTTLED, on the same argument the chosen-line uses (design principle 7): a standoff
      // prints four of these per tick, the tick runs every 2s at crisis vitals, and live that
      // was ~7000 near-identical lines an hour burying the ones that mattered - which is the
      // exact log-flooding this audit criticised. Print each distinct refusal when it ARISES
      // and when its reason CHANGES; the standoff itself is already named on the chosen line.
      const k = (cand.job || 'build/idle') + '|' + rf.why
      if (coreRefusalNoted.get(k)) return
      coreRefusalNoted.set(k, true)
      note('(core) ' + (cand.job || 'build/idle') + ' REFUSED: ' + rf.why + ' - re-selecting in this tick (no watchdog wait)')
    })
    // Logging discipline (design principle 7): the unchanged choice was printed every tick - 780
    // near-identical lines that buried the 82 that mattered. Print it when it CHANGES, and always
    // print a standoff or an unanswered crisis, which are the lines a post-mortem needs.
    // The key includes the full reason, so a standoff or an unanswered crisis logs the moment it
    // ARISES and again whenever its shape changes - but not once per tick for as long as it lasts.
    // Force-logging those two was my own reasoning that they are the most important lines in a
    // crisis; live, it reprinted an identical CRISIS UNANSWERED paragraph every 15s for a whole
    // night, which is the same log-flooding this audit criticised (780 near-identical lines
    // burying the 82 that mattered). Important is not the same as repeated.
    const key = (c.job || 'build/idle') + '|' + c.reason
    if (key !== coreLastChoice) {
      coreLastChoice = key
      coreRefusalNoted.clear() // a new situation: let its refusals speak once each
      note('(core) chose ' + (c.job || 'build/idle') + ': ' + c.reason)
    }
    if (c.job == null) {
      // ==== ONE CHOOSER PER QUESTION ======================================================
      // job==null means "no survival or maintain work is owed - the progress tail may proceed",
      // so the tail is what we want from pickJob: build / resume / brain / idle. But pickJob
      // answers the WHOLE question, survival tier included, and it has neither this tick's
      // refusals nor the core's utility model - so it happily returns a survival job the core
      // has just finished declining, against the same snapshot. Live:
      //   (core) chose build/idle: CRISIS UNANSWERED (secureFood: body busy, not crisis-grade)
      //   (sched) pick=secureFood PREEMPT reason="food 12 < 14"
      //   (sched) secureFood NOT dispatched: body busy, not crisis-grade
      // Three layers, one answer, two of them redundant - and the middle line reads like the bot
      // is about to do something it has already ruled out twice. The core's own charter says it
      // owns the survival + bootstrap-vs-build choice and pickJob owns the progress plumbing;
      // taking pickJob's SURVIVAL verdict here is a contract violation, not a safety net.
      // ...so ASK FOR THE TAIL, don't ask the whole question and throw the answer away. This used
      // to call pickJob(s), and on a survival answer returned { job: null } - discarding the
      // PROGRESS TAIL along with the survival verdict it meant to ignore, so NOTHING was
      // dispatched. A decision must produce an action (§5); this one produced a log line.
      // Live 2026-08-26 12:26-12:33, the castle trek dead in the water at 61,-33:
      //   (core) chose build/idle: ... - continuing with: resuming the saved build - survival infra in order
      //   (core) pickJob still wants secureFood ("food 10 < 14") - ... not re-opening a settled question
      //   (sched) pick=null
      // every tick, with hp/food frozen and the body idle. The standoff was unbreakable by
      // construction: food 10 is a need but not crisis-grade, secureFood is latched off because it
      // ran here and achieved nothing, and food only falls - so the veto could never lift, and the
      // one job that WOULD have moved the bot (and fed it en route) was the one being discarded.
      // tailOnly cannot return cls 'survival', so there is no answer left to throw away.
      return scheduler.pickJob(s, { tailOnly: true })
    }
    return { job: c.job, cls: c.cls, reason: c.reason, preempt: !!c.preempt, bootstrap: c.bootstrap }
  }
  const tick = async () => {
    const myGen = tickGen // S7 tick-liveness: capture this chain's generation; the finally only reschedules if still current
    schedLastTickAt = Date.now() // S7: liveness stamp - the watchdog re-arms the chain if this goes >90s stale
    try {
      // 1. GUARDS (cheap; mirror the crisis reflexes). NOT gated on arbiter.maneuverActive() - a
      //    survival preempt must be able to interrupt a nav leg (same as FOOD_CRISIS today).
      if (!bot.entity || gatingDispatch()) return // see gatingDispatch: a PROGRESS-tier dispatch (the build) no longer mutes the chooser for hours
      // FARM_EXPAND's passive river-crossing note: O(1), self-throttled to <=1/60s, never
      // navigates. It rode the FOOD_SUPPLY timer purely because that timer existed; when that
      // timer was deleted (S5) this was the one line in it that still had a job to do.
      try { provision.noteWaterCrossing(bot) } catch {}
      // ROOT H: ONE read of the gate table - the gate decision and the log line can no longer
      // disagree about who is holding the body, and a gate that holds longer than the chain is
      // allowed to be quiet (TICK_STALE_MS, the same number rungs 7 and 8 use) says so with its
      // age. Throttled to at most one line per TICK_STALE_MS per distinct gate set (#8).
      const gatedBy = TICK_GATES.filter(([, p]) => { try { return !!p() } catch { return false } })
      if (gatedBy.length) {
        const key = gatedBy.map(([n]) => n).join('+')
        const now = Date.now()
        if (schedGateKey !== key) { schedGateKey = key; schedGateSince = now; schedGateNotedAt = 0 }
        const ours = gatedBy.filter(([, , owner]) => owner !== 'engine-state')
        if (ours.length && now - schedGateSince > TICK_STALE_MS && now - schedGateNotedAt > TICK_STALE_MS) {
          schedGateNotedAt = now
          note('(sched) tick gated by ' + key + ' for ' + Math.round((now - schedGateSince) / 1000) + 's (>' +
            Math.round(TICK_STALE_MS / 1000) + 's) - no job has been picked since; force-release owner: ' +
            ours.map(([n, , o]) => n + '->' + o).join(', '))
          // ...AND THE OWNER IS CALLED (2026-08-02). Naming a force-release and not invoking it is
          // a decision that produces no action (#5) - the log line above was already the complete
          // diagnosis and the complete instruction, printed at nobody. Live 18:39:09-18:47:06 it
          // printed six times, once per 90s, while `nav-recovering` held the tick for 476 SECONDS:
          // the chooser made ZERO decisions in that window and the bot died six times, naked, at
          // night, to mobs. Every rule this audit is about - the hp abort, the night rule, the
          // crisis pick - lives downstream of this `return` and none of them ran.
          // This is a DEADLINE ON AN ATTEMPT, not a delay before thinking (#6): the gate has had
          // TICK_STALE_MS of continuous, uninterrupted hold to clear itself, which is the same
          // number rungs 7 and 8 already use to call a chain dead. `ours` excludes engine-state, so
          // a genuinely sleeping bot is never disturbed. releaseBodyClaims is the EXISTING terminal
          // rung and already owns all three of our gates (commands.js owners table) - no new actor.
          try {
            const freed = commands.releaseBodyClaims('tick gated by ' + key + ' for ' + Math.round((now - schedGateSince) / 1000) + 's')
            note(freed
              ? '(sched) ...force-released: ' + freed + ' - the chooser gets the body back'
              : '(sched) ...force-release found nothing to take back: the gate is held by something outside releaseBodyClaims\' owners table - this is a wiring hole, not a decision')
          } catch (e) { note('(sched) ...force-release threw: ' + e.message) }
        }
        return
      }
      schedGateKey = ''; schedGateSince = 0; schedGateNotedAt = 0
      // 2. SNAPSHOT + decision.
      const s = await provision.schedulerState(bot)
      // #41 P4: the SINGLE place the post-death latch clears on a regular cadence - the moment the
      // world reports recoveryReady (hp/food/armor/tools restored, or the best-affordable escape),
      // release the build. Runs even when there's no build to resume, so the latch never sticks.
      if (RESILIENT_ON && commands.isPostDeathRecovery && commands.isPostDeathRecovery()) {
        try { if (scheduler.recoveryReady(s).ready) { commands.clearPostDeathRecovery(); note('(sched) recovery complete - post-death latch cleared, the build may resume') } } catch {}
      }
      // #65 DYNAMIC_CORE Phase 1 (the CHOOSING layer): behind DYNAMIC_CORE (default OFF - soaked
      //   offline; the coordinator flips it after live parity). When ON, the PURE schedulerCore
      //   chooseActivity replaces pickJob's SELECTION: same snapshot in, the same pick shape out
      //   (job/cls/reason/preempt/bootstrap), so every downstream dispatch below is untouched. When
      //   the core returns job=null (build/idle may proceed) it hands off to pickJob's existing
      //   build/resume/brain/maintain/idle TAIL - the core only owns the survival + bootstrap-vs-build
      //   choice, not the progress plumbing. DYNAMIC_CORE!=1 -> today's pickJob path, byte-for-byte.
      const pick = process.env.DYNAMIC_CORE === '1' ? coreAdapter(s) : scheduler.pickJob(s)
      // 3. OBSERVABILITY: log on CHANGE (not every tick). Dispatches/outcomes always log (rare).
      const nearest = (s.graves || []).filter(g => g && !g.dangerous && g.value > 0 && g.dist != null).sort((a, b) => a.dist - b.dist)[0]
      const key = pick ? (pick.job + '|' + pick.preempt) : 'idle'
      if (key !== schedLastLog) {
        schedLastLog = key
        note(`(sched) pick=${pick ? pick.job : 'idle'}${pick && pick.preempt ? ' PREEMPT' : ''} reason="${pick ? pick.reason : 'idle'}" | hp=${s.hp} food=${s.food} packPts=${s.packFoodPts} armor=${s.armorPieces} graves=${(s.graves || []).length}${nearest ? '(near ' + Math.round(nearest.dist) + 'b)' : ''} home=${s.homeDist == null ? '?' : Math.round(s.homeDist) + 'b'}`)
      }
      schedLastPick = pick; schedLastPickAt = Date.now() // S7: expose the last decision to the idle-with-work watchdog
      // ==== 4. DISPATCH - ONE table, ONE path (PLAN-one-runner S2/S3) =======================
      //
      // This was a chain of `if (pick.job === 'x')` branches, and each branch carried its own
      // admission-gate stack - a SECOND copy of conditions candidateRefusal already knew. The
      // maintain pass had seven of them, and measured live on 2026-07-29 they overruled the
      // chooser seven times in five minutes while logging nothing. Both copies are gone: the
      // registry names the executor, the refusal probe is the ONLY gate, and every decline is
      // logged with its blocker and re-routed in the same tick.
      const proposal = pick && pick.job ? reflexes.get(pick.job) : null
      // (a) `flee` is REFLEX-owned, and says so. needProducer maps lava/fire/drowning/threat/
      //     creeper to 'flee', which is not a scheduler job - the arbiter/escape stack acts on
      //     those inside the tick, faster than any dispatch could. That was correct and totally
      //     invisible until it was named (DESIGN-PRINCIPLES §5; scheduler.REFLEX_OWNED).
      //     The LIST is the authority, not this branch: it used to test `pick.job === 'flee'`
      //     while the comment pointed at scheduler.REFLEX_OWNED, so a second reflex-owned job
      //     added to that list would have been dispatched anyway - named in one place, enforced
      //     in another, which is the drift §4 exists to stop.
      if (pick && scheduler.REFLEX_OWNED.includes(pick.job)) {
        if (schedDeferNoted !== pick.job) { schedDeferNoted = pick.job; note('(sched) ' + pick.job + ' is REFLEX-owned (arbiter/escape stack handles it in-tick) - not dispatching a job for it: ' + pick.reason) }
        return
      }
      // (b) the maintenance pass exists but is not wired in this era (MAINTAIN=0).
      if (pick && pick.job === 'maintenancePass' && !MAINTAIN_ON) {
        if (schedDeferNoted !== 'maintain') { schedDeferNoted = 'maintain'; note('(sched) maintain needed - deferred to S6') }
        return
      }
      // (c) nothing here for the runner to drive: build / resume / the brain's own job own this
      //     window, and so do the proposals whose owner is another job (gearup, homeRepair,
      //     foodTopUp are steps of the maintenance pass). The one thing the tick still does in
      //     this window is the opportunistic at-hut chore window, below.
      if (!proposal || typeof proposal.run !== 'function') {
        // OPPORTUNISTIC MAINTENANCE (design-docs/DESIGN-opportunistic-maintenance.md):
        // during the build era pickJob can never pick maintenancePass (persistedBuild
        // shadows it, scheduler.js resumeGate) - so when the build's own life has the bot ALREADY
        // at the hut, open a brief bounded chore window: pause (never cancel) the build,
        // run the home-only maintenancePass, cool down, and let the 2-min re-arm resume it.
        if (!OPP_ON) return
        // gatingDispatch, not dispatchBusy (review item 7): the whole point of this window is to
        // borrow the body from a RUNNING build, and since the build now holds the dispatch slot,
        // asking `dispatchBusy()` here would have deleted the opportunistic pass outright. The
        // preempt arm below still proves the build owns the body (oppOwner === 'job') and still
        // waits for it to unwind before touching anything, so nothing double-drives.
        if (gatingDispatch() || Date.now() < runner.maintainCooldownUntil) return
        const checkupDue = Date.now() - schedOppLastWindowAt >= Number(process.env.OPP_CHECKUP_MS || 1800000)
        const elig = scheduler.oppMaintain(s, { checkupDue })
        if (!elig.ok) return
        // OWNERSHIP, through the one rule. This was the last private guard stack in the tick -
        // four latch reads plus two busy checks, saying (in its own words) what BODY_OWNERS says
        // in one vocabulary. The window is a PROGRESS-tier claim with one twist the ordering rule
        // cannot express on its own: on the preempt path a busy build is not an obstacle, it is
        // the PRECONDITION (the whole point is to borrow the body while the build has it at home).
        const oppOwner = bodyOwner()
        const oppOwnerInfo = oppOwner ? reflexes.ownerInfo(oppOwner) : null
        if (oppOwnerInfo && oppOwnerInfo.tier === 'SURVIVE') return // never borrow the body from survival work
        if (!provision.mayDoProgress(bot)) return
        if (elig.preempt) {
          if (oppOwner !== 'job') return // activity says autobuild but the latch dropped - next tick re-reads
        } else if (oppOwner) return // the idle path must be TRULY idle - any owner at all disqualifies it
        note('(sched) OPPORTUNISTIC MAINTAIN - ' + elig.reason + (elig.preempt ? ' (pausing the build; it resumes via re-arm)' : ''))
        // DISPATCH AND RETURN (ROOT E) - see the dispatch at the bottom of this tick for why.
        // This one matters MOST: the opportunistic window runs maintenancePass, whose chest/craft
        // flows go through the two mineflayer waits that are still unbounded (bot.craft and
        // putAway both end in a bare `once(window, 'updateSlot:...')`). Awaiting it here put the
        // whole tick chain behind exactly the promises ROOT A does not cover.
        runJob('maintenancePass', async () => {
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
            // (a mid-smelt unwind took ~33s live - commands.js resumeBuild); bail on crisis.
            const unwindBy = Date.now() + Number(process.env.OPP_UNWIND_MS || 90000)
            while ((commands.isBusy && commands.isBusy()) && Date.now() < unwindBy) {
              let crisis = null; try { crisis = provision.survivalNeed(bot, { foodThreshold: foodSec.busyPreemptFood() }) } catch {}
              if (crisis) { runner.maintainCooldownUntil = Date.now() + abandonCd; return 'window abandoned - crisis (' + crisis.need + ') during unwind' + (foodNeedPending ? ' (food need pending - 60s retry)' : '') }
              await new Promise(r => setTimeout(r, 500))
            }
            if (commands.isBusy && commands.isBusy()) { runner.maintainCooldownUntil = Date.now() + abandonCd; return 'window abandoned - build did not unwind in time' + (foodNeedPending ? ' (food need pending - 60s retry)' : '') }
          }
          const windowEnd = Date.now() + Number(process.env.OPP_WINDOW_MS || 300000)
          const night = !!(provCore.isNight && provCore.isNight(bot))
          const r = await provMaintain.maintenancePass(bot, {
            say: schedSay, nightIndoorOnly: night, opportunistic: true,
            isStopped: () => Date.now() > windowEnd
          })
          const worked = !!(r && r.steps && r.steps.length && !/^bail/.test(r.reason || ''))
          runner.maintainCooldownUntil = Date.now() + (worked ? 600000 : Number(process.env.OPP_NOOP_COOLDOWN_MS || 1800000))
          schedOppLastWindowAt = Date.now()
          return 'opp window: ' + (r && r.steps && r.steps.length ? r.steps.join('+') : (r && r.reason) || 'nothing due')
        }).catch(e => { try { note('(sched) runJob(maintenancePass) leaked an error: ' + e.message) } catch {} })
        return
      }
      // 5. LEGACY REMAP: RECOVERY_LADDER=0 keeps S4's downgrade - re-read the single need and
      //    route to its producer, rather than running a ladder this era does not build.
      let job = pick.job
      if (job === 'recoveryLadder' && !LADDER_ON) {
        let need = null
        try { need = provision.survivalNeed(bot) } catch {}
        if (need) {
          const prod = scheduler.needProducer(need.need)
          if (prod === 'secureFood' || prod === 'recoverHp') job = prod
          else { if (schedDeferNoted !== 'ladder-reflex') { schedDeferNoted = 'ladder-reflex'; note('(sched) ladder need ' + need.need + ' is reflex-owned (' + (prod || 'flee') + ') - holding') } return }
        } else if (nearest && nearest.dist <= GRAVE_NEAR_LADDER) {
          job = 'graveSweep' // a degraded-only state with a near grave: the grave IS the recovery
        } else { if (schedDeferNoted !== 'degraded') { schedDeferNoted = 'degraded'; note('(sched) degraded but no executor until S5 - holding') } return }
      }
      const chosen = job === pick.job ? proposal : reflexes.get(job)
      if (!chosen || typeof chosen.run !== 'function') {
        // A job name with no executor is a WIRING BUG, not a decision. It used to be a bare
        // `return`: a second, invisible decision-maker that unmade the chooser's verdict without
        // a line in the log. bot/reflexestest.js enumerates every job the choosers can emit
        // against this registry, so reaching here means the two drifted anyway - say so.
        note('(sched) ' + job + ' picked (cls=' + pick.cls + ') but NOTHING in the registry can run it - nothing dispatched (this is a wiring bug, not a decision): ' + pick.reason)
        return
      }
      const name = chosen.label || chosen.name
      // 6. THE FINAL GATE - the ONLY place a dispatch is declined, and it always says why.
      //    Under DYNAMIC_CORE these refusals have already fed back into selection, so this is
      //    near-inert by construction; on the plain pickJob path it IS the guard stack - the
      //    same one, logged, instead of the eleven silent `return`s that used to live here.
      const gate = candidateRefusal({ job, cls: chosen.tier === 'SURVIVE' ? 'survival' : pick.cls }, s)
      if (gate) {
        const key = 'refuse:' + gate.key + '|' + gate.why
        if (schedHeldLog !== key) { schedHeldLog = key; note('(sched) ' + name + ' NOT dispatched: ' + gate.why) }
        // A refusal must perform the alternative it names, or name the owner that will
        // (DESIGN-PRINCIPLES §5). `alternative` is that promise as data: the night-forage guard
        // used to print "sheltering, not foraging" while nothing sheltered, for two years.
        if (chosen.alternative) {
          const alt = reflexes.get(chosen.alternative)
          const altGate = alt && typeof alt.run === 'function' ? candidateRefusal({ job: alt.name, cls: 'survival' }, s) : { why: 'no executor' }
          if (!altGate) {
            note('(sched) ' + name + ' -> doing ' + alt.name + ' instead, which is what that refusal names')
            // DISPATCH AND RETURN (ROOT E) - see the dispatch at the bottom of this tick for why.
            runJob(alt.label || alt.name, () => alt.run(bot, mkCtx(s, pick)), { jobKey: alt.name, holds: alt.holds })
              .catch(e => { try { note('(sched) runJob(' + (alt.label || alt.name) + ') leaked an error: ' + e.message) } catch {} })
          }
        }
        return
      }
      schedHeldLog = ''
      schedDeferNoted = ''
      // 7. TAKE THE BODY. The ownership rule already said this proposal out-ranks whoever holds
      //    it; taking it means telling that owner to stand down through the latch it already
      //    polls. No new abort machinery - these are the same two levers the watchdog uses.
      const ownerKey = bodyOwner()
      if (chosen.terminal) {
        // THE TERMINAL ACTION TAKES THE BODY (§3.3). Not "out-ranks whoever holds it" - takes it.
        // Every other proposal here asks the ordering rule for permission and stands down when the
        // answer is no; that is exactly the mechanism that let a crisis go 847 ticks unanswered.
        // The floor is the one row for which the answer cannot be no, so the claims go, through the
        // ONE release path (the executor repeats this on its own - a decision that depends on its
        // executor having been reached is not a decision).
        try { const freed = commands.releaseBodyClaims('terminal action taking the body: ' + pick.reason); if (freed) note('(sched) TERMINAL ' + name + ' - took the body from ' + freed) } catch (e) { try { note('(sched) TERMINAL claim release threw: ' + e.message) } catch {} }
      } else if (ownerKey === 'job' || ownerKey === 'shelter' || ownerKey === 'foodRun') {
        if (commands.preemptForSurvival) commands.preemptForSurvival() // sets ONLY buildAbort; the build resumes via persistedResume
        note('(sched) PREEMPT ' + name + ' (' + pick.reason + ') - ' + (reflexes.ownerInfo(ownerKey) || {}).label + ' yields to a crisis-grade need')
      } else if (ownerKey === 'maintain') {
        try { provMaintain.stopMaintenance() } catch {}
        note('(sched) PREEMPT ' + name + ' (' + pick.reason + ') - stopping the maintenance pass, survival outranks chores')
      }
      // 8. DISPATCH AND RETURN. One line, for every proposal in the registry.
      //
      // ROOT E (2026-08-02): this used to `await` the executor, which made the tick chain a
      // hostage of every promise a job could get stuck on. The re-arm lives in this tick's
      // `finally`, so an executor that never settles means the finally never runs, means THERE
      // IS NO NEXT TICK - the scheduler is dead until the watchdog's liveness rung notices,
      // 90-300s later. That is exactly how the bot went structurally dead at 13:47 on a single
      // hung `await bot.dig(b)` inside ensurePillarFiller.
      //
      // The await was also a SECOND mutual-exclusion mechanism for a rule the lease already
      // owns (#4). runJob takes the lease SYNCHRONOUSLY - there is no await between its entry
      // and `schedJob = {...}` - so the slot is held before this call returns and the next tick
      // exits at the `dispatchBusy()` early-return. No double dispatch is possible. The epoch
      // guards (myGen/schedGen in runJob, myGen/tickGen here) are untouched, so a late-resolving
      // abandoned executor still cannot clear a successor's slot. Nothing below this line in the
      // tick body depended on the ordering: outcome handling, the noOp latch and hold release all
      // live inside runJob itself.
      //
      // What changes: the tick keeps ticking while a job runs (schedLastTickAt stays fresh, so
      // rung 8 stops false-alarming on a legitimately slow job, and crisis-scaled re-arm delays
      // keep being recomputed from live vitals). runJob catches everything internally, so the
      // .catch below is a defense line rather than a path - but an unhandled rejection escaping a
      // dispatcher is never acceptable.
      runJob(name, () => chosen.run(bot, mkCtx(s, pick)), { jobKey: job, holds: chosen.holds })
        .catch(e => { try { note('(sched) runJob(' + name + ') leaked an error: ' + e.message) } catch {} })
    } catch (e) { try { note('(sched) tick error: ' + e.message) } catch {} }
    finally {
      // FIX 19: the reschedule is DANGER-SCALED. A flat 15s±3s is a sampling rate chosen for a
      // calm bot and applied to a dying one - live 18:40, the bot fell to hp 1 and died 11
      // seconds later with its next decision up to 18s away (the 8s HP_CRISIS reflex that used
      // to cover this is disabled under SCHEDULER). Vitals are read straight off the body here:
      // plain numbers that cannot throw, and the snapshot may not exist on an early return.
      // Jitter is applied only to the CALM cadence - de-synchronising a crisis buys nothing.
      if (myGen === tickGen) {
        let delay = scheduler.TICK_CALM_MS
        try {
          delay = scheduler.tickDelayMs({
            hp: bot.health,
            food: bot.food,
            inLava: !!(bot.entity && bot.entity.isInLava),
            drowning: navigate.headInWater(bot)
          })
        } catch {}
        if (delay >= scheduler.TICK_CALM_MS) delay += (Math.random() * 6000 - 3000)
        setTimeout(tick, delay)
      }
    } // self-rescheduling; S7: a re-armed chain (tickGen++) orphans this stale one so two chains never coexist
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
    let stalePickNoted = '' // one honest line per staleness episode (the heldNoted throttle idiom)
    let heldNoted = ''
    let wdOtherNoted = '' // one line per (hold,job) pair when a hold is NOT the thing holding the body (#7: say it once, not every 5s)
    const wdTimer = setInterval(() => {
      try {
        // 1. GUARDS. Dead/absent body: nothing to watch.
        //
        // ==== PLAN-one-runner S4: A DECLARED HOLD IS ALIVE BY CONSTRUCTION ==================
        // Sitting perfectly still until a named wake IS the goal - sealed in a pit until dawn,
        // asleep in a bed, waiting out a famine indoors - so stillness must not read as a hang.
        // This used to be true only for the two latches named here (isSleeping/isResting), which
        // is why 2026-07-29 19:20-19:24 happened: the shelter that sealed the pit was a RUNG of
        // the recovery ladder, so neither latch was set, the watchdog failed the ladder at 90s,
        // the wedge watchdog dug the bot out at 195s and a creeper killed it at 19:24:33.
        // reflexes.activeHold() is the general form: whoever waits DECLARES it and names the
        // wake, once, and this is the one place that reads it (each hold used to have to
        // remember to fake progress on its own heartbeat - and one of them forgot).
        if (!bot.entity || bot.health <= 0) return
        // 1b. THE CLAIM REGISTRY'S HEARTBEAT (review item 2). Leases are opened, credited and
        // revoked inside bodyOwner(), and every OTHER caller of it is downstream of something that
        // can itself be blocked: the tick returns early on a held TICK_GATE, and the two follow
        // reflexes are opt-out. A dead owner holding the body is exactly the state in which those
        // callers go quiet, so the one loop that is nobody's dependent asks the question too - the
        // same 5s pass that already judges whether a JOB is advancing, now also judging whether an
        // OWNER is. Deliberately before the declared-hold branch below: a hold's suppression is
        // stamped every pass, so the claim it vouches for is already fresh from the last one.
        bodyOwner()
        const hold = reflexes.activeHold(holdPremiseOK)
        // A HOLD VOUCHES FOR ITS OWN HOLDER, NOT FOR THE WHOLE BOT (2026-08-26; the handoff's
        // long-open ROOT O). This branch returned on ANY live hold, from ANY responder, BEFORE
        // reading which job actually owns the body - so one responder's legitimate stillness
        // excused a completely different one's stall. Live, at spawn, 344 blocks from the castle:
        //   (core) maintenancePass REFUSED: it is already running - it holds the dispatch slot (235s)
        //   (wd)   nightShelter is a DECLARED hold waking on dawn - stillness here is the goal
        // nightShelter was legitimately waiting for dawn; maintenancePass had the body and was
        // frozen; and because the hold check returned first, the watchdog never even LOOKED at the
        // job it was supposed to be judging. The build was re-chosen every tick and could never be
        // dispatched. `activeHold` returns the OLDEST hold, so the excuse need not even come from
        // anything related to the work that is stuck.
        // Sleeping and resting stay unconditional - those are genuinely the whole body. Only the
        // generic hold is scoped, and only when we can positively identify a DIFFERENT responder:
        // no job, or an unresolvable one, keeps today's behaviour, because failing to strand a bot
        // that really is sealed in is the whole reason this mechanism exists.
        const heldJob = provision.activeJobInfo()
        const holdCoversJob = (() => {
          if (!hold) return false
          if (!heldJob || !heldJob.name) return true            // nothing else is running to be excused
          if (hold.label === heldJob.name) return true
          try {
            const r = reflexes.get(heldJob.name); if (r && (r.label === hold.label || r.name === hold.label)) return true
            const h = reflexes.get(hold.label); if (h && (h.label === heldJob.name || h.name === heldJob.name)) return true
          } catch { return true }                               // unresolvable -> trust the hold
          return false
        })()
        if (hold && !holdCoversJob && wdOtherNoted !== hold.label + '|' + heldJob.name) {
          wdOtherNoted = hold.label + '|' + heldJob.name
          note('(wd) ' + hold.label + ' holds for ' + hold.wake + ', but ' + heldJob.name + ' owns the body - a hold excuses its OWN stillness only; judging ' + heldJob.name + ' normally')
        }
        if (bot.isSleeping || (provRecovery.isResting && provRecovery.isResting()) || (hold && holdCoversJob)) {
          if (hold && heldNoted !== hold.label) { heldNoted = hold.label; note('(wd) ' + hold.label + ' is a DECLARED hold waking on ' + hold.wake + ' - stillness here is the goal, not a stall') }
          // A HOLD SUPPRESSES THE CLOCK; IT DOES NOT FEED IT. This used to be
          // touchProgress('declaredHold'), which announced verified progress to every reader of
          // the one progress cell every 5s while the bot sat perfectly still - the opposite of
          // what a hold means (#7). The ledger's own suppression says exactly what is true:
          // these seconds are not counted against the job, and nothing was achieved in them.
          commands.suppressJobIdle()
          return
        }
        if (heldNoted) heldNoted = ''
        // 2. the active job (sync, cheap - no snapshot build on the 5s path). Already read above
        // for the hold-scoping test; reuse it rather than paying for a second read (#8).
        const job = heldJob
        const now = Date.now()
        // 3. pure verdict + escalation phase.
        let verdict = scheduler.watchdog(job, { hp: bot.health, food: bot.food }, now)
        const jobKey = job ? job.key : null // ONE definition of the key - activeJobInfo builds it, the work ledger is filed under it, this reducer escalates on it (#4)
        // ==== THE CYCLE DETECTOR IS DELETED (review 2026-08-25, D4/§3.6, item 5) ==========
        // A ~40-line block stood here: a bounded 48-sample position ring, an outcome-ring read
        // with a self-abort filter, cycleDetect.detect/step, and a synthetic `fail-job` verdict
        // merged into wdPhase. cycle-detect.js is gone with it.
        //
        // It was the third detector in a circle of three and it never caught anything after
        // 04:09 on the day the bot died. Its oscillation predicate needs >=48 BLOCKS of gross
        // path inside a 180s window (cycle-detect.js:27); the terminal wedge shuttled 1.6-2.2b
        // per escape burst, roughly 6-8b per 4-minute cycle - an order of magnitude under the
        // floor - so slow oscillation was invisible to it BY CONSTRUCTION. Its own comment
        // delegated that case to "the freeze watchdogs' domain", and navigate.js's navRung stamp
        // delegated A<->B detection to IT. Each of the three deferred to the next; none acted.
        // It was also suppressed outright while any SURVIVE maneuver or escape held the body -
        // i.e. during precisely the episodes worth detecting.
        //
        // §3.1 leaves ONE stall test: no world delta credited to this job for its window. That
        // is what the lines below already compute, from the per-job work ledger, on evidence a
        // rescue cannot manufacture. A second detector with a different definition of "stuck"
        // was never a safety net; it was a second opinion nobody reconciled (#4).
        // (A cheap A<->B check may live INSIDE unstick if one is ever needed - §3.6 says so
        // explicitly - where it would be a fact about one rescue, not a rival verdict about a job.)
        wdState = scheduler.wdPhase(wdState, verdict, jobKey, now)
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
              try { provMaintain.stopMaintenance() } catch {}
            } else if (job.name === 'secureFood' || job.name === 'recoverHp' || job.name === 'recoverFromDegraded' || job.name === 'recoveryLadder') {
              try { provision.stopSurvivalJob() } catch {}
              // FOOD_FLOOR F4: BUMP the floor's no-progress counter so the next dispatch ESCALATES
              // (widen the water scout, active fishing over a passive hold) instead of re-running
              // the identical failing sequence. This used to hang off cycle-detect's repeatFail
              // verdict - a detector that fired zero times after 04:09 on the day the bot died.
              // The trigger it needed already existed one line up: the supervisor concluding, from
              // the work ledger, that this exact job has produced nothing. One evidence source, not
              // two (#4). FOOD_FLOOR=0 -> escalateFoodFloor is a no-op.
              if (process.env.FOOD_FLOOR !== '0' && /recoverFromDegraded|recoveryLadder|secureFood/.test(job.name || '')) { try { provFood.escalateFoodFloor() } catch {} }
            }
            // recover/graveSweep: NO latch bites by design (recover ignores buildAbort) - log + recordOutcome
            // only; its own travel deadlines unwind it and the tick applies runner.graveCooldownUntil. A
            // promise-hung recover is caught by GIVEUP next window (layer d's class).
          } else if (wdState.act === 'giveup') {
            // GIVEUP USED TO ONLY LOG. It set no latch, freed nothing, and deferred to "layer d
            // (supervisor frozen-vitals/kill)" - which did not collect these: live 2026-07-30 the
            // same line repeated every 2-3 minutes for hours on `recover`, `recoveryLadder` and
            // `secureFood`. A rung with no power is not a rung, and it was the LAST one, so the
            // ladder's terminal state was "log forever".
            // Every latch above it is COOPERATIVE - only a job that awaits something polling
            // isStopped() can see one. The whole point of the final rung is the case where that
            // assumption has already failed, so the final rung must NOT be cooperative. It now takes
            // the body back by revoking the dispatch lease (§ the slot is a lease, not a flag).
            note('(wd) stop latch ineffective on ' + job.name + ' - a hung promise; taking the body back (latch set ' + Math.round((wdState.latchIdleMs || 0) / 1000) + 's ago)')
            // Unconditional statement, deliberately NOT folded into the `if` below: the revoke is the
            // rung's whole purpose, and an action buried in a condition is an action that can be
            // quietly disabled (a `false &&` reads as still-present to a source-level guard).
            const revoked = revokeDispatch('hung promise: no verified progress for ' + Math.round((now - (job.lastProgressAt || job.startedAt || now)) / 1000) + 's and the stop latch did not bite')
            if (!revoked) {
              // No slot to revoke: the hang is inside a non-dispatch path - a brain command, a
              // reflex, or an OPERATOR-issued `autobuild`/`gather`, which enter through
              // commands.handle rather than through the chooser. (Autonomy's own build is no
              // longer in that list: since review item 7 it is dispatched like every other job
              // and holds the lease, so a hung build is revoked by the line above instead of
              // falling through to this branch - which is what "autobuild runs INLINE and so
              // never takes a lease" used to mean, and why the last rung so often had nothing to
              // take back.) Yanking the nav goal and the control states out from under a job that
              // is merely SLOW breaks it, so this last resort asks the progress clock to agree.
              const stalled = (() => { try { return !!commands.progressInfo().stalled } catch { return false } })()
              if (!stalled) {
                // NOT terminal: the rung stays ARMED at 'failed' rather than latching 'gaveup'.
                // A giveup that declines to act and then goes silent forever is the exact defect
                // 55857e6 fixed - a rung with no power is not a rung.
                note('(wd) ' + job.name + ' holds no dispatch slot and its progress clock is NOT stalled - leaving the controls alone, staying armed')
                wdState = { ...wdState, phase: 'failed', act: 'none' }
              } else {
                note('(wd) ' + job.name + ' holds no dispatch slot - releasing the controls instead')
                try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
                try { bot.clearControlStates() } catch {}
                // ...AND THE BODY CLAIM. This rung decides "hung - take the body back", and used
                // to stop at the nav goal, which is not what was holding the body: `provisioning`
                // (isBusy) stays true when a hung promise never runs its `finally`, and isBusy
                // gates EVERY dispatch. Live 2026-07-31 the tick chain re-armed, ran, and refused
                // to dispatch anything for 51 minutes while the bot stood frozen at (242,45,-102).
                // A decision must produce an action (#5). This is condition-driven - the
                // verified-progress ladder above is the evidence (#3, #6). 2026-08-02: the SAME
                // act revokeDispatch now performs when there IS a slot; only this branch did it.
                // ...AND THE BODY CLAIM - SCOPED TO THIS JOB'S OWN LEASE (review §3.6, item 5).
                const claimKey = reflexes.claimOfJob(job.name) || 'job' // the claim THIS job raises; 'job' is the commands-level activity (autobuild runs inline and takes no lease)
                try { const freed = commands.releaseBodyClaims('watchdog giveup on ' + job.name, { only: [claimKey] }); if (freed) note('(wd) ...and released the ' + claimKey + ' claim it was still holding: ' + freed) } catch {}
                // WHY IT IS SCOPED NOW. This was a WHOLE-BODY releaseBodyClaims: it cleared every
                // latch in the owners table because ONE job was hung - the coarse-release bug item
                // 2 removed everywhere else and deliberately left standing here. The reason it had
                // to stay was a threshold seam, not a design: at critical vitals this rung fires at
                // ~100s while a body claim was priced at a FIXED 150s/300s, so nothing else would
                // have taken the latch back for another 200 seconds. That seam is closed at its
                // source - scheduler.failWindows is now the ONE definition of "how long before this
                // is hung" and reflexes.claimStaleMs asks it with the live vitals - so the registry
                // revokes this same lease on the same schedule, and the line above is the belt to
                // its braces rather than a second, blunter mechanism.
                // NO touchProgress HERE. `touchProgress('giveupRelease:' + job.name)` stood on the
                // next line: the supervisor announcing to every reader of the body clock that
                // something had happened, at the exact instant it concluded that nothing had. It
                // is the same class as the navRung stamp item 1 deleted - a layer vouching for the
                // work it just declared dead (#7).
              }
            }
          }
        }
        // 7. IDLE-WITH-WORK (§6 item 3): a survival pick sits undispatched while the body is truly idle
        //    (no busy activity, no pathfinder goal, no schedJob) and no latch job is running. Continuous
        //    >30s -> kick; at CRISIS vitals also clear the stale scheduler cooldowns so the next tick
        //    dispatches (the surgical fix for "sat frozen while graves gleamed 3b away"). Rate-limited 60s.
        //
        //    STALENESS-HONEST (ROOT E, 2026-08-02): `schedLastPick` was read with NO freshness
        //    check, so when the tick chain died this rung asserted a live decision from a dead
        //    chain - "pick=recoveryLadder undispatched - kicking", 20x in one day, about a pick
        //    nothing was ever going to dispatch - and cleared back-offs nothing would consume. A
        //    pick older than TICK_STALE_MS is not a decision, it is a fossil: say so, and leave
        //    the recovery to the liveness re-arm below that actually owns it (#5, #7).
        const idleBody = !(commands.isBusy && commands.isBusy()) && !(bot.pathfinder && bot.pathfinder.goal) && !dispatchBusy()
        const survivalPickIdle = !!(schedLastPick && schedLastPick.cls === 'survival' && job == null && idleBody)
        const pickAgeMs = schedLastPickAt ? now - schedLastPickAt : Infinity
        if (survivalPickIdle && (now - schedLastPickAt) <= TICK_STALE_MS) {
          stalePickNoted = ''
          if (!idleWorkSince) idleWorkSince = now
          if (now - idleWorkSince > 30000 && now - lastKickAt > 60000) {
            lastKickAt = now
            note('(wd) IDLE WITH WORK 30s+: pick=' + schedLastPick.job + ' (' + Math.round(pickAgeMs / 1000) + 's old) undispatched - kicking')
            // ==== A KICK THAT ONLY LOGS IS NOT A KICK (live 2026-08-01) ==========================
            // The clearing used to be gated on crisis vitals, so at any healthy reading this whole
            // branch was a message and nothing else. Live, at FULL hp and food, with the castle
            // resumed and waiting:
            //   (wd) IDLE WITH WORK 30s+: pick=recoveryLadder undispatched - kicking   x4, no dispatch
            // The bot stood at (195,68,-97) for four minutes being "kicked".
            // What makes a back-off stale is not the vitals - it is the body sitting idle with work
            // pending. Every one of these exists to stop the scheduler SPINNING, and 30s of an idle
            // body holding an undispatched survival pick is proof they have stopped doing that job.
            // So the remedy runs whenever the condition that names it holds.
            runner.graveCooldownUntil = runner.hpCooldownUntil = 0
            const forgotten = attempts.forgetAll({ except: reflexes.TERMINAL }) // the ladder's own latch is one of these now - one clear, one rule
            note('(wd) ...cleared every stale back-off (grave/hp) and forgot ' + forgotten + ' attempt record(s) so the next tick can dispatch')
          }
        } else if (survivalPickIdle) {
          // The pick is STALE. No kick, no back-off clearing - just the truth, once per episode.
          idleWorkSince = 0
          const k = 'stale:' + schedLastPick.job
          if (stalePickNoted !== k) {
            stalePickNoted = k
            note("(wd) idle-with-work: last pick '" + schedLastPick.job + "' is " + Math.round(pickAgeMs / 1000) + 's stale (>' + Math.round(TICK_STALE_MS / 1000) + 's) - tick chain suspect, deferring to the liveness re-arm')
          }
        } else { idleWorkSince = 0; stalePickNoted = '' }
        // 8. TICK-LIVENESS: the self-rescheduling chain itself died (a hung await -> its finally never
        //    ran). Re-arm with the generation guard (tickGen++ orphans any later-resolving stale chain;
        //    schedJob still guarantees one dispatch).
        //    ROOT E: the detection threshold is now the SHARED TICK_STALE_MS (same 90s, one name), and
        //    the rate limit drops from a flat 300s to that same number. With dispatch-and-return a
        //    stale chain is anomalous rather than the price of a long job, tickGen++ makes re-arming
        //    idempotent-safe (a duplicate chain is orphaned by myGen !== tickGen), so every watchdog
        //    pass that still MEASURES staleness may act - a deadline on an attempt, not a delay
        //    before thinking (#6). This rung is kept as the backstop for a hang in the tick body
        //    itself (e.g. `await provision.schedulerState(bot)`, the one await left ahead of the
        //    dispatch); it is no longer the primary recovery.
        if (schedLastTickAt && now - schedLastTickAt > TICK_STALE_MS && now - lastLivenessRearm > TICK_STALE_MS) {
          lastLivenessRearm = now
          note('(wd) scheduler tick chain stalled ' + Math.round((now - schedLastTickAt) / 1000) + 's (>' + Math.round(TICK_STALE_MS / 1000) + 's) - re-arming (generation guard prevents a double chain)')
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
const HOSTILE_RE = require('./perception.js').HOSTILE // ONE canonical hostile list (was a byte-identical copy of commands.js's)
// never AUTO-melee these: creepers explode point-blank, ghast/warden/wither are ranged/deadly
const NO_AUTO_MELEE = /creeper|ghast|warden|wither_boss|^wither$/i
// below this health, DISENGAGE from any hostile (retreat) instead of trading hits -
// how it survived to death overnight was by fighting a skeleton while low. Tunable.
const RETREAT_HP = parseInt(process.env.RETREAT_HP || '8', 10)
// #78 (flag FLEE_LOS, default ON): don't flee a hostile that is fully walled off - a creeper
// sealed in a cave 13b below the hut can't reach the bot, yet the straight-line flee scans
// phantom-retreat off every harvest walk. Mirror the survival-snapshot occlusion gate (the same
// THREAT_LOS test that already discounts walled mobs for mining) at the two flee candidate
// filters: <=floor ALWAYS counts (thin wall / right above-below / breaking through), the raycast
// runs only in the (floor, cap] band, both feet+head rays must be blocked to discount, FAIL-OPEN
// on any error (blocked=false -> the mob still counts). FLEE_LOS=0 -> blocked stays false ->
// hostileThreatens is true for every candidate past the floor -> both scans byte-for-byte today.
// Floor from THREAT_LOS_FLOOR (shared with survival-snapshot); NOT coupled to THREAT_LOS itself.
const FLEE_LOS_ON = process.env.FLEE_LOS !== '0'
const FLEE_LOS_FLOOR = parseInt(process.env.THREAT_LOS_FLOOR || '5', 10)
function fleeThreatens (bot, me, e, d, cap) {
  let blocked = false
  if (FLEE_LOS_ON && d > FLEE_LOS_FLOOR && d <= cap) {
    try {
      const { Vec3 } = require('vec3')
      const { AIRISH } = require('./provision-core.js')
      const los = require('./los.js')
      const eye = me.offset(0, (bot.entity && bot.entity.height) || 1.62, 0)
      const isSolid = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!(b && b.boundingBox === 'block' && !AIRISH(b.name)) }
      const feet = los.lineBlocked(eye, e.position.offset(0, 0.5, 0), isSolid)
      const head = feet ? los.lineBlocked(eye, e.position.offset(0, (e.height || 1.6) - 0.1, 0), isSolid) : false
      blocked = feet && head
    } catch { blocked = false }
  }
  return arbiter.hostileThreatens(d, blocked, { floor: FLEE_LOS_FLOOR })
}
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
// Clearing the goal is an honest cancel of any in-flight avoid nav (navigate.js escapeToDryLand), which
// then unwinds through its own catch while this drives the body. Blind sprint-jump is the same
// pre-existing recovery idiom as the nudge rung (navigate.js, the 'nudge' recovery rung). finally-clears the control
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
    if (provShelter.isSheltering && provShelter.isSheltering() && !beingHit && !creeperClose) return
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
        const d = e.position.distanceTo(me)
        if (!fleeThreatens(bot, me, e, d, 12)) continue // #78: skip a fully walled-off creeper (fail-open; <=floor always counts)
        if (d < fbest) { fbest = d; flee = e }
      }
      if (!flee && hp <= RETREAT_HP) { // low health -> disengage from whatever's hunting us
        let best = 13
        for (const e of Object.values(bot.entities || {})) {
          if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
          if (!HOSTILE_RE.test(e.name || '')) continue
          const d = e.position.distanceTo(me)
          if (!fleeThreatens(bot, me, e, d, 13)) continue // #78: skip a fully walled-off hostile (fail-open; <=floor always counts)
          if (d < best) { best = d; flee = e; why = `low hp (${Math.round(hp)})` }
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
          try { if (provHut.insideOwnStructure && provHut.insideOwnStructure(bot)) return } catch {}
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
                if (provHut.insideOwnStructure && provHut.insideOwnStructure(bot)) {
                  note('(flee) creeper near home but already inside the hut - holding, door stays sealed')
                } else {
                  note(`(flee) creeper ${fbest.toFixed(1)}m near home - retreating INTO the hut`)
                  // Target a FREE interior floor cell (furniture-aware), not the fixed hut+2,+2;
                  // the nav's door pre-flight crosses the doorway to reach it. Fallback to center.
                  const cell = (() => { try { return provHut.freeInteriorCell ? provHut.freeInteriorCell(bot, hut) : null } catch { return null } })()
                  const gx = cell ? cell.x : hut.x + 2; const gy = cell ? cell.y : hut.y + 1; const gz = cell ? cell.z : hut.z + 2
                  if (REACTIVE_MOVE_ON) { // Phase A: reactive control-driven approach toward home (no 20s goto), then the EXISTING atomic door crossing (crossOwnDoor/#33 kept exactly as-is)
                    try { await navigate.reactiveMove(bot, { toward: { x: gx, y: gy, z: gz }, reach: 16, arriveB: 2, budgetMs: 2500, priority: arbiter.PRIORITY.SURVIVE }) } catch {}
                    try { await navigate.enterStructure(bot, hut, { isStopped: () => false, priority: arbiter.PRIORITY.SURVIVE }) } catch {}
                  } else {
                    await navigate.navigateToPreempt(bot, new goals.GoalNear(gx, gy, gz, 1),
                      { timeoutMs: 15000, deadlineMs: CREEPER_BACKOFF_ON ? 20000 : 40000, climb: false, priority: arbiter.PRIORITY.SURVIVE, rescue: 'light', label: 'hut-retreat' })
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
                      ? { timeoutMs: 6000, deadlineMs: 12000, priority: arbiter.PRIORITY.SURVIVE, label: 'creeper-backoff', rescue: 'light' } // fix #10 F2: 1.5s-fuse threat - rescue-light (no cutting/pillaring rung under a 1.5s fuse); the burst is the fallback
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
          const armored = !provShelter.underArmored(bot)
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
        if (need) { spiderLootBusy = true; provCore.collectDrops(bot, 6).catch(() => {}).then(() => { spiderLootBusy = false }) }
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

// (the proactive spawn keepalive moved to bot/reflexes.js as TWO proposals - PLAN-one-runner.
//  It was one timer doing two jobs: a SURVIVE-tier repair when the anchor is known wrong (a bad
//  anchor is how a death costs 480 blocks instead of 11), and an IDLE-tier top-up when it is
//  merely unconfirmed. One timer, two tiers, one guard stack - so the survival half was gated
//  behind the idle half's `if (pathfinder.goal) return`. They are separate rows now.)

// ==== THE FREEZE WATCHDOG IS DELETED (structural review 2026-08-25, D4/§3.5(3), item 5) ====
// `if (process.env.WEDGE_WATCHDOG !== '0') { ... }` stood here: a 5s timer that measured a 150s
// positional freeze, logged `(watchdog) position FROZEN ~195s at (x,y,z) - forcing an escape`,
// ran navigate.forceUnstick, and on failure armed a FLAT 4-MINUTE RETRY plus a same-cell failure
// streak and a "DESPERATE" second escape. It was the fifth independent stall detector in this
// process and the one that killed the bot.
//
// The arithmetic, verified in the log: the job supervisor's non-critical fail rung is at 240s.
// This timer fired at 195s - FORTY-FIVE SECONDS EARLIER - and its step-out rungs always
// "succeeded" by netting 1.6-2.2 blocks, which (through the navRung stamp deleted with item 1)
// reset the job clock to zero. NUDGE at ~120s, escape at ~195s, clock reset, repeat: the exact
// 4-minute period observed 32 times on 2026-08-03 between 16:54 and 20:10, zero FAIL-JOB in
// 4h15m, process death with the bot standing two blocks from its own bed. Two watchdogs, one
// body, and the faster one was the one with no evidence ([[threshold-seams]], between layers).
//
// Everything it did is now owned, once, by things that can be held to account:
//   * "is the body physically wedged"      -> unstick() (navigate.js) - one plan, chosen from
//                                             WHERE the body is, bounded by attempt memory keyed
//                                             to a 4b cell, escalating on evidence, never on a
//                                             timer, and returning a VERDICT when it is spent.
//   * "is this JOB going nowhere"          -> scheduler.watchdog on the per-job work ledger
//                                             (item 1): NUDGE -> FAIL-JOB -> GIVEUP, on world
//                                             deltas only. Nothing can wind that clock any more.
//   * "who rescues when the job is dead"   -> the arbiter's terminal action (item 3), which takes
//                                             the body, resets, and is the ONE caller allowed to
//                                             force a rescue in a cell that has already failed.
// There is deliberately NO replacement timer. A blanket retry is what hid this livelock for four
// hours (#1, #6), and DIGOUT_ESCAPE / WEDGE_WATCHDOG were its two remaining flags: the dig-out
// escalation is now armed by unstick's own record of having failed here, which is strictly more
// evidence than "the body has not moved for 150s". No dig permission changed with any of it.

// (auto-collect moved to bot/reflexes.js as an IDLE-tier proposal - S5. It scored its own
//  eagerness by distance there, so a drop underfoot is picked up and one 8b away is not worth
//  the walk - which is what a player does, and what a 3s timer with a flat 8b radius could not.)

// (the idle scaffold sweep moved to bot/reflexes.js as an IDLE-tier proposal - S5.)

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
  // #116 ESCAPE_ACCOUNTABLE: `drownCooldownUntil` - a 10-SECOND BLANKET TIMER that muted this
  // reflex entirely after a failed escape - was DELETED here. It was a wall-clock hold on the
  // one reflex that answers drowning, in violation of the no-blanket-time-holds rule, and it is
  // NOT replaced by another timer: escapeWater is now re-entrant-guarded and owns the crisis for
  // exactly as long as the bot is submerged, and accountability for a failing rung is the
  // arbiter's condition-scoped progress revocation, not a clock.
  let drowning = false
  setInterval(async () => {
    if (drowning || !bot.entity) return
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
      if (navigate.isRecovering() || navigate.isUnsticking()) return
      if (provRecovery.isResting && provRecovery.isResting()) return
    }
    if (bot.isSleeping) return
    drowning = true
    try {
      note('(drown-crisis) head underwater - taking the controls to get out of the water')
      // #116: epoch-scope the whole claim. At 15:51:19 this reflex logged `out of the water`
      // 1.7s AFTER the bot drowned - the check was honest and described the RESPAWN POINT,
      // 137 blocks away. A claim that outlives the bot that made it is not a claim.
      const pathfix = require('./pathfix.js')
      const e0 = pathfix.epoch()
      const ok = await navigate.escapeWater(bot, { isStopped: () => false })
      // WATER_ESCAPE (task #48): escapeWater's success is HEAD-based (!headInWater), so a bobbing bot
      // whose head clears for a tick declared "out of the water" while its body kept treading the same
      // pond (the log-50236 false victory, design §2b). Under the flag, judge "out" by the FEET so the
      // head-based reflex and the feet-based recovery `water` rung agree on "actually out". Purely the
      // success LABEL + cooldown gate; the escape it ran is unchanged. Flag OFF => today's head-based ok.
      if (!pathfix.sameEpoch(e0)) { note('(drown-crisis) I died down there - not claiming an escape I did not make') } else {
        // ONE PREDICATE, BOTH SIDES (2026-07-30). This used to be `!feetInWater` under the flag and
        // the raw `ok` without it, while escapeWater's ladder stopped on `headInWater` - so the
        // escape declared success in a state its caller called failure, 1ms apart, and the reflex
        // re-fired every 4s. Worse: the ladder stopped, ENDED the maneuver and released the body
        // while the bot was still afloat, so it sank and drowned holding the success claim (twice,
        // 10:34 and 10:35). `navigate.outOfWater` is now the single definition both sides read, so a
        // success here means the same thing the escape was working toward. Flag no longer changes
        // the predicate - a correct verdict is not opt-in.
        const out = navigate.outOfWater(bot) && ok
        note(`(drown-crisis) ${out ? 'out of the water' : 'still wet - re-evaluating while I am still under'}`)
      }
    } catch (e) { note(`(drown-crisis) failed: ${e.message}`) } finally { drowning = false; wetHist = 0; drownStart = 0 }
  }, 2000)
}

// (auto-torch moved to bot/reflexes.js as an IDLE-tier proposal - PLAN-one-runner S5. It is
//  still opt-in via AUTO_TORCH=1: an autonomous block-placer earns its way in, it is not
//  granted one. As a proposal it can only run on a body nobody else wants, which is the
//  guarantee its old `bot.targetDigBlock` check was reaching for.)

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
      if (Date.now() < chatGate.gazeState().suppressUntil) return            // a manual look/turn owns the head
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
      const gz = chatGate.gazeState()
      if (gz.player && now - gz.at < 5000) {
        const p = bot.players[gz.player] && bot.players[gz.player].entity
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
    // PLAN-one-runner: the follow reflexes KEEP their 1.5s timers - a follow is the execution
    // loop of a command the operator issued, not an autonomous reflex competing for the body,
    // and putting it on the 15s tick would make following visibly laggy. What they had NO
    // guards for at all was yielding: this re-issued its goal on a bot that was sheltering,
    // fleeing or mid-recovery. They now ask the SAME one authority every proposal asks,
    // instead of growing a private guard list of their own.
    if (reflexes.bodyRefusal('PROGRESS', bodyOwner())) return
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
    // same one authority as the leash above (and as every proposal): a sticky-follow must never
    // re-issue its goal on top of a shelter, an escape or a recovery.
    if (reflexes.bodyRefusal('PROGRESS', bodyOwner())) return
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
  res.writeHead(code, { 'Content-Type': (typeof body === 'string' ? 'text/plain' : 'application/json') + '; charset=utf-8' })
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
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, spawned: connected && !!bot.entity, connected })
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
      const pending = chatGate.pendingChat()
      s.unanswered = pending.map(c => ({ from: c.from, text: c.text }))
      // Only the BRAIN's poll (?brain=1) spends the delivery budget. A generic
      // /state read (the dashboard polls every ~1s) must NOT drain it, or a
      // player's message expires before the brain gets its MAX_DELIVERIES turns.
      if (/[?&]brain=1(?:&|$)/.test(req.url)) pending.forEach(c => { c.deliveries++ })
      return send(res, 200, s)
    } catch (e) { return send(res, 500, `error: ${e.message}`) }
  }
  if (req.method === 'GET' && req.url === '/log') return send(res, 200, log.slice(-40).join('\n'))
  if (req.method === 'GET' && req.url === '/chat') return send(res, 200, chatGate.chatLogTail(40).join('\n'))
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
      // ==== THE GATE IS A TABLE NOW (bot/gate.js, M1 of the deadlock-free-arbitration design) ===
      // Nine hand-written branches used to live here: the CHEAT confinement, the saved-build stop
      // hold, the body-hold with its four PREEMPT arms and its two refusals, and one-job-at-a-time.
      // Together they were a SECOND ARBITER - a decision function over the brain's proposals,
      // disjoint from scheduler-core's candidate set, with no executable floor and no feedback. A
      // refused command simply evaporated: no successor, nothing recorded, nothing re-chosen. Two
      // total decision functions over disjoint sets are not a total function over the union, which
      // is how the machine deadlocked on 2026-08-25 with every layer in it working as designed:
      // this stack refused `mine 23 64 -13 «need to get materials to craft armor»` twenty-one
      // times on behalf of a saved build whose own reconcile list asked for cobblestone and
      // raw_iron, while that build's gearup FAIL-JOBed every 93 seconds.
      //
      // The branches are UNCHANGED - byte-for-byte, swept in gatetest.js against a transcription of
      // themselves and replayed against every held/PREEMPT line in both event logs - but they are
      // ROWS now, and a row must declare whose interest it serves, what it reads, and what happens
      // INSTEAD of what it refuses. Add a ROW, never a branch: gatetest.js fails the build if a
      // `held (` is constructed anywhere outside gate.js.
      //
      // What stays HERE is the EFFECT half - log it, preempt, answer the player, answer the HTTP
      // request. Those touch the body, the chat and the socket; gate.js may touch none of them,
      // which is what makes the table testable with a plain object and no bot at all.
      const trimmedLine = String(line).trim()
      // S4 (REDESIGN §3.4): classify read-only via scheduler.commandClass when SCHEDULER is on.
      // Deliberate, documented widening: commandClass's perception set adds turn|lookbehind|
      // waypoints|places|help to the old whitelist - all read-only/head-only ("perception/chat ->
      // allow as today"). SCHEDULER=0 keeps the old regex byte-for-byte.
      const cls = SCHED_ON ? scheduler.commandClass(trimmedLine) : null
      const proposal = {
        line,
        trimmed: trimmedLine,
        why,
        cls,
        fromSupervisor,
        readOnly: SCHED_ON ? (cls === 'perception' || cls === 'chat')
          : /^(state|scan|find|block|entities|inventory|look|say)/i.test(trimmedLine),
        // S4: survival class via commandClass. Its survival vocabulary is wider than S1's regex
        // (equip/gearup/hunt/...), but the gate's `adm` still demands a REAL need or a near grave,
        // so a whimsical gearup at full health while a build runs is still held. SCHEDULER=0
        // restores the S1_HOTFIX regex byte-for-byte.
        survival: SCHED_ON ? (cls === 'survival')
          : (process.env.S1_HOTFIX !== '0' && /^(recover|getstuff|eat|wear|armorup|sleep)/i.test(trimmedLine))
      }
      const verdict = await cmdGate.decide(proposal, {
        cheatsAllowed: () => process.env.BRAIN_ALLOW_CHEATS === '1',
        persistedResume: () => (commands.persistedResume ? commands.persistedResume() : null),
        // M3's LEASE READER. Answers, for gate.js, whether the saved build is a principal in
        // GOOD STANDING - i.e. whether it may still refuse things on its own behalf. It is NOT a
        // new definition of stalled: it reads the two numbers the runner already maintains.
        //   1. the job layer stood the build down (item 7's markResumePaused -> buildHoldMs)
        //   2. its work ledger (item 1) has not advanced inside one PATIENT fail window
        // Either one means the build is not making progress, so a survival move is not a
        // 'side trip' competing with it - there is nothing to compete with.
        principalStalled: () => {
          try {
            const j = commands.persistedResume && commands.persistedResume()
            if (!j) return true                                  // no saved job at all
            if (j.pausedAt && j.pauseHoldMs && Date.now() - j.pausedAt < j.pauseHoldMs) return true // stood down
            const info = provision.activeJobInfo && provision.activeJobInfo()
            // The build is only advancing if IT is the active job AND its ledger moved recently.
            if (!info || !/build|autobuild/.test(String(info.name || ''))) return true
            const last = info.lastProgressAt
            if (typeof last !== 'number') return true
            const win = (scheduler.failWindows ? scheduler.failWindows('progress', { hp: bot.health, food: bot.food }).failMs : 240000)
            return (Date.now() - last) > win
          } catch { return true }                                // unknown -> stalled; see gate.js
        },
        // bodyOwner() writes the claim registry through BEFORE the four latches are read, so a
        // lease that has expired is not a hold (review D2). It revokes, releases and logs - which
        // is exactly why gate.js reads it lazily, and only where the if-stack read it.
        syncClaims: () => bodyOwner(),
        claimInfo: key => reflexes.claimInfo(key),
        defendWhenHit: () => DEFEND_WHEN_HIT_ON,
        beingHit: () => beingHitNow(),
        postDeathLatch: () => RESILIENT_ON && commands.isPostDeathRecovery && commands.isPostDeathRecovery(),
        recoveryMoveCmd: t => SCHED_ON && scheduler.isRecoveryMove(t),
        admissible: async (t, latchOn) => (SCHED_ON
          ? scheduler.admissibleUnderLatch('survival', t, await provision.schedulerState(bot), latchOn)
          : survivalAdmissible(bot)),
        // #113 CRISIS_OUTRANKS_PEACETIME (DESIGN §3.4 D2): what the hold IS FOR, computed from the
        // predicates themselves rather than from the display label - a hold that serves no survival
        // need (a build/gather: commands.isBusy) is deliberately absent from this list. Most urgent
        // wins when several are latched at once (gate.js sorts by arbiter.needRank).
        holdNeeds: () => [
          (provRecovery.isRecoveringDegraded && provRecovery.isRecoveringDegraded()) ? 'heal' : null,
          (provFood.isSecuringFood && provFood.isSecuringFood()) ? 'food' : null,
          (provRecovery.isResting && provRecovery.isResting()) ? 'shelter' : null
        ].filter(Boolean),
        liveCrisis: () => provision.survivalNeed(bot)
      })
      if (verdict) {
        note(`(cmd) ${line}${rz} -> ${verdict.text}`)
        if (verdict.preempt) {
          if (commands.preemptForSurvival) commands.preemptForSurvival() // stop latch; a build resumes via persistedResume
          // fall through: the command runs and owns the body
        } else {
          // If a PLAYER just asked for this (the held command is the brain answering them),
          // don't leave them on read - the BODY replies once with what it's doing. Verified
          // live: "digital go sleep" -> six silent holds and the player heard nothing.
          if (verdict.busyReply && chatGate.busyReplyDue(20000, 30000)) {
            chatGate.markBusyReply()
            let doing = 'working'
            try { const a = commands.state(bot).activity; if (a && a.name) doing = a.name + (a.detail ? ' (' + a.detail + ')' : '') } catch {}
            bot.chat(`can't right now - busy with ${doing}. say "stop" first if you need me to drop it`.slice(0, 200))
            clearPendingChat() // that IS the answer - stop the brain re-trying the same order
          }
          return send(res, 200, verdict.reply)
        }
      }
      const drop = gateSay(line, true) || gateImpactful(line) // brain: gated chat + repeat-guard
      if (drop) { note(`(cmd) ${line}${rz} -> skipped (${drop})`); return send(res, 200, `skipped: ${drop}`) }
      noteManualLook(line)
      // S6: an incoming progress/survival command STOPS a running maintenance pass (the pass
      // unwinds at its next poll; the incoming job takes the body). perception/chat never do.
      if (provMaintain.isMaintaining && provMaintain.isMaintaining() && cls !== 'perception' && cls !== 'chat') provMaintain.stopMaintenance()
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
  // ---- NO WEB UI. THE CONTROL SURFACE IS Animus.exe ---------------------------
  // The browser dashboard was retired when the native GUI landed, but its ROUTES stayed
  // behind serving a string that told you to go use the other thing - and launch.ps1 kept
  // dutifully opening a tab to read it. A retired feature that still answers on its old
  // address is not retired, it is a decoy: it makes `/` look like a UI to anyone probing
  // the port, and it kept the stale "open the dashboard" step alive in RUN.md and the
  // launcher for weeks. Deleting the route is the retirement (#1: remove, don't wrap).
  // /state, /cmd, /log, /pov, /brain and /health are the API the GUI actually uses.
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
      connected: connected && !!bot.entity, // is it actually in-world right now? (bot.entity SURVIVES a disconnect - the live socket state is the only honest answer; 2026-08-01, nine hours offline reported as connected)
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
          loghistory.appendLineRotating(path.join(__dirname, 'brain-decisions.jsonl'), {
            t: Date.now(), source: 'operator', command: String(line).slice(0, 120),
            result: String(result).slice(0, 160), state: commands.state(bot)
          }, DECISION_LOG_CAP)
        } catch {}
        send(res, 200, result)
      } catch (e) { note(`(ui-cmd error) ${line} -> ${e.message}`); send(res, 500, `error: ${e.message}`) }
    })
    return
  }
  // GUI-OVERHAUL §2.5 / POV-V2: the bot's point of view as a 128x72 frame for the Animus POV panel.
  // Computed only on request, sliced across event-loop turns and cached 250 ms (see pov.js).
  if (req.method === 'GET' && req.url === '/pov') {
    if (!bot.entity) return send(res, 503, { ok: false, reason: 'not spawned' })
    return pov.requestFrame(bot, frame => send(res, 200, frame))
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
      // THE DECLARED HOLD, PUBLISHED (2026-08-25, live). supervise.js is a SECOND reader of
      // "is this bot stalled" and it lives in another process, so the only thing it can know is
      // what this file tells it. Review item 1 correctly stopped a hold from stamping
      // touchProgress('declaredHold') - a bot sitting still on purpose was announcing verified
      // progress every 5s, which is the exact lie #7 forbids. But `lastProgressAt` above is
      // derived from that same body clock, so the honest clock made a night shelter look FROZEN
      // to the supervisor, which stopped the bot four times in twenty minutes on 2026-08-25
      // while it was sheltering correctly - once mid-gather.
      // The fix is not to put the lie back. It is that BOTH readers get the same fact: the
      // in-process watchdog already asks reflexes.activeHold(holdPremiseOK) on its own 5s pass
      // (§ "whoever waits DECLARES it and names the wake"), and this publishes that same answer.
      // One rule, one definition, two readers (#4). `hold` is the label, `holdWake` names what
      // ends it - so a supervisor can log WHY it stood down, not just that it did.
      let hbHold = null
      try { const h = reflexes.activeHold(holdPremiseOK); if (h) hbHold = { label: h.label, wake: h.wake } } catch {}
      try { if (!hbHold && (bot.isSleeping || (provRecovery.isResting && provRecovery.isResting()))) hbHold = { label: bot.isSleeping ? 'sleeping' : 'resting', wake: 'dawn' } } catch {}
      // ...and publish it to /state, so the GUI's chip and the heartbeat agree by construction
      // rather than by two modules each asking reflexes their own way (#4).
      try { commands.setHoldInfo(hbHold) } catch {}
      if (p) hbLastPos = p
      try { fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(Object.assign({}, sample, { connected: connected && !!bot.entity, hold: hbHold, lastProgressAt: hbLastProgressAt }))) } catch {}
    } catch { /* telemetry must never kill the bot */ }
  }
  const historyTimer = setInterval(historyTick, 5000)
  if (historyTimer.unref) historyTimer.unref() // never hold the process open on this timer alone
}
