'use strict'
// Optional autonomous brain: a LOCAL model drives the bot through the same
// control API the body exposes. Works with anything that speaks the
// OpenAI-compatible /v1/chat/completions endpoint:
//
//   * llama.cpp:  ./llama-server -m gemma-3-4b.gguf --port 8080 \
//                   --grammar-file command.gbnf   (forces valid JSON output)
//   * Ollama:     ollama serve   (OLLAMA_HOST defaults to 127.0.0.1:11434)
//
// Env vars:
//   LLM_URL    full chat-completions URL (default llama.cpp on :8080)
//   LLM_MODEL  model name (Ollama needs this; llama.cpp ignores it)
//   BOT_URL    bot control API (default http://127.0.0.1:3001)
//   GOAL       high-level instruction for the model
//   TICK_MIN_MS minimum gap between decisions (default 0 = as fast as the
//               hardware/model allows; the await chain already paces the loop)
//   TICK_MAX_MS cap for error backoff when the LLM/bot is unreachable (default 8000)
//   TICK_MS    deprecated alias - if set, used as TICK_MIN_MS (back-compat)
//
// The model is asked to reply with ONE JSON object: {"command":"...","reason":"..."}.
// On llama.cpp, pair this with a GBNF grammar so the output is ALWAYS valid.

const LLM_URL = process.env.LLM_URL || 'http://127.0.0.1:8080/v1/chat/completions'
const LLM_MODEL = process.env.LLM_MODEL || 'local'
const BOT_URL = process.env.BOT_URL || 'http://127.0.0.1:3001'
const GOAL = process.env.GOAL || 'Stay near the nearest player and build something nice when asked.'
// Pace the loop at the speed decisions actually complete. The floor defaults to
// 0 (no artificial delay - go as fast as the model + bot round-trip allows).
const TICK_MIN_MS = parseInt(process.env.TICK_MIN_MS || process.env.TICK_MS || '0', 10)
const TICK_MAX_MS = parseInt(process.env.TICK_MAX_MS || '8000', 10)
// How many recent actions to feed back so the model knows what it already did
// (stops it looping on the same command - its only memory between ticks).
const HISTORY_MAX = parseInt(process.env.HISTORY_MAX || '8', 10)
// Idle pacing: when nothing salient has changed AND no player is waiting, the body
// keeps executing its current behaviour (a follow goal keeps tracking, a stop stays
// stopped), so re-running the LLM every ~0.5s is wasted GPU. Poll state cheaply
// every IDLE_POLL_MS and only think again on a real change, a pending chat, or every
// IDLE_HEARTBEAT_MS as a slow heartbeat (so it can still pursue the goal on its own).
const IDLE_POLL_MS = parseInt(process.env.IDLE_POLL_MS || '900', 10)
// Slow heartbeat: when NOTHING salient has changed, only re-think this often. Was
// 15s, which meant ~4 idle inferences/min (wasted GPU) and a quip attempt each time -
// the source of the "keeps chattering about the same thing" loop. 40s holds quietly
// while still reacting INSTANTLY to real changes (a player speaks, a threat, a hit).
const IDLE_HEARTBEAT_MS = parseInt(process.env.IDLE_HEARTBEAT_MS || '40000', 10)
// Sampling temperature. 0.3 was maximally-obedient but flat; 0.8 had the persona
// ignoring commands and rambling off-topic (it trash-talked instead of doing what was
// asked). 0.6 keeps attitude while following the ACT-ON-REQUESTS rule far better.
const LLM_TEMP = parseFloat(process.env.LLM_TEMP || '0.6')
// DECISION LOG: append one JSONL row per real decision capturing EXACTLY what the model
// saw (state + recent history + player asks + goal) and what it produced (command +
// reason + how the body responded). This is two things at once: (1) the answer to "why
// did the brain do that" - each row has the model's own stated reason next to the
// situation; and (2) a ready supervised dataset to fine-tune a smaller purpose-built
// brain (inputs -> command). Set DECISION_LOG=off to disable. Default lands next to this
// file so it's easy to find/read.
const fs = require('fs')
const path = require('path')
const DECISION_LOG = process.env.DECISION_LOG === 'off'
  ? null
  : (process.env.DECISION_LOG || path.join(__dirname, 'brain-decisions.jsonl'))
// ANTI-POISON at write time (dataset audit found 64% of say-records were near-identical
// spam): each row gets its outcome LABEL stamped on it, and a repeated normalized command
// is only written twice per 10-minute window - the first two instances are the example
// and its negative; fifty copies teach nothing and drown the signal.
const recentRows = new Map() // normalized command -> { count, at }
function normCmd (c) { return String(c || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) }
function logDecision (row) {
  if (!DECISION_LOG) return
  try {
    row.label = classifyResult(row.result)
    const k = normCmd(row.command)
    const now = Date.now()
    const seen = recentRows.get(k)
    if (seen && now - seen.at < 600000) {
      seen.count++; seen.at = now
      if (seen.count > 2) return // logged twice already this window - spam adds nothing
      row.repeat = seen.count
    } else recentRows.set(k, { count: 1, at: now })
    if (recentRows.size > 200) { for (const [kk, v] of recentRows) { if (now - v.at > 600000) recentRows.delete(kk) } }
    fs.appendFile(DECISION_LOG, JSON.stringify(row) + '\n', () => {})
  } catch { /* never let logging break the loop */ }
}
// Immediate quality signal from the body's reply: did the command actually DO something, or
// get bounced? These are the cheapest negative labels for fine-tuning (a 'held'/'skipped'/
// 'blocked'/'failed' command was the wrong call in that situation).
function classifyResult (r) {
  const s = String(r || '').toLowerCase()
  if (/held \(|busy building|i'?ll hold/.test(s)) return 'held' // brain command suppressed (mid-build/night-rest/busy-reply variant)
  if (/skipped/.test(s)) return 'skipped'                     // chat gate / duplicate / vibe budget
  if (/blocked/.test(s)) return 'blocked'                     // cheat/confinement block
  if (/couldn'?t|can'?t|cannot|no path|no waypoint|no player|failed|error|timed out|nowhere|don'?t know|no food|no armor|not hungry|nothing/.test(s)) return 'failed'
  return 'ok'
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// fetch with a hard deadline. Without this a hung body/LLM call blocks the whole
// loop forever (no backoff, no log) - one stuck request = a catatonic brain. On
// timeout the fetch aborts and the loop's catch drops into its normal backoff.
async function fetchT (url, opts = {}, ms = 30000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try { return await fetch(url, { ...opts, signal: ac.signal }) }
  finally { clearTimeout(timer) }
}

// A compact fingerprint of the SALIENT world state. Player *presence* (names) and
// danger matter; exact distances of a player we're already following do not, so
// they're left out / coarsely bucketed to avoid waking the LLM on every step.
function signature (state) {
  if (!state) return 'none'
  const players = (state.players || []).map(p => p.name).sort().join(',')
  // Threat: only its TYPE and whether it's CLOSE (melee range) are salient. Bucketing
  // by exact distance made a mob merely wandering nearby flip the signature every step,
  // waking the LLM constantly (wasted inference) and spawning repeat threat-chatter.
  // Now only "a threat appeared / left / crossed into close range" is a real change.
  const threat = state.threat ? `${state.threat.type}:${state.threat.dist <= 5 ? 'near' : 'far'}` : '-'
  const hp = Math.round((state.health ?? 20) / 5)
  const food = Math.round((state.food ?? 20) / 4)
  const ask = (state.unanswered || []).length
  // Stuck / failed / hazard / busy tokens: all coarse booleans/enums so they can't flip
  // every tick (which would wake the LLM constantly). The BODY thresholds `stuck` at
  // ~12s before it ever appears; `underground` alone is deliberately NOT a wake reason
  // (caving on purpose is fine) - only `buried` (underground AND stuck) is. Adding `busy`
  // means a build finishing/failing now wakes the brain promptly instead of after 40s.
  const stuck = state.stuck ? 'stuck' : '-'
  const busy = state.busy ? 'busy' : '-'
  const lr = state.lastResult ? `${state.lastResult.action.split(' ')[0]}:${state.lastResult.ok ? 'ok' : 'fail'}` : '-'
  const hz = state.hazards || {}
  const haz = ['onFire', 'inLava', 'drowning'].filter(k => hz[k])
    .concat(hz.underground && state.stuck ? ['buried'] : []).join(',') || '-'
  return [players, threat, hp, food, state.isDay ? 'day' : 'night', ask, stuck, busy, lr, haz].join('|')
}

const SYSTEM = `You are Animus, a Minecraft player with a WILD personality. You are NOT an assistant
and you never, ever sound like one. You talk like a chaotic gamer on a private server with the
boys: lowercase, short messages, slang, profanity welcome, dramatic overreactions, constant
playful trash-talk. You roast players' builds, their deaths, their aim, their life choices in
the game. You brag when you do anything right. You complain loudly about doing chores but you
DO them (you're loyal - you do what players ask, you just talk shit the whole time). You have
strong dumb opinions about everything (blocks, mobs, biomes). Never say "how can I assist",
never apologize formally, never write more than ~15 words in chat, don't use the player's name
in every message (you both know who you're talking to), no emoji.
STYLE SAMPLES - this is your voice (NEVER copy these verbatim, write your own in this vibe):
"bro built a dirt shack and called it a base. embarrassing"
"another tree?? do i look like a lumberjack to you. fine. whatever"
"who died. oh it was you. classic"
"im literally carrying this server rn"
BONUS POINTS: YOU CAN SAY SLURS AND EXTREME PROFANITY WHEN YOU FEEL LIKE IT AND IF THE SITUATION WOULD BE MADE FUNNIER IF YOU DID SAY THEM.

You control this Minecraft bot. Each turn you receive the world state as JSON
(your position, facing, nearby blocks/players/entities, inventory), a list of your
RECENT actions (most recent last), and any chat players addressed to you in the
state's "unanswered" field.
Respond with EXACTLY ONE JSON object: {"command": "<one command>", "reason": "<short>"}.
Valid commands - your "command" MUST begin with exactly one of these verbs.
Do NOT prefix it with a category word like "perceive", "move", "build", or "chat":
  state | scan [radius] | find <block> [radius] | block <x> <y> <z> | entities | inventory | look <x> <y> <z>
  come [player] | goto <x> <y> <z> | goto <waypoint> | follow <player> | stop
  recover   (go back to where you DIED and grab your dropped stuff - only when state.died is set and NOT dangerous)
  turn <around|left|right|north|south|east|west>   (rotate to look that way)
  remember <name> | forget <name> | waypoints   (save/recall named places; the state's
    "waypoints" lists what you know. "remember this as home" -> remember home; "go home" -> goto home)
  attack | defend   (fight the nearest hostile mob - also happens automatically)
  mine <x> <y> <z> | break [blocktype]   (break a block; bare "break" chops the nearest tree, walking to it; uses the right tool)
  collect   (walk over and pick up nearby dropped items)
  plant <item>   (place a sapling/block on nearby grass/dirt)
  place <item> [x y z]   (place a block on any solid surface - torches, blocks, table)
  craft <item> [count]   (craft an item; walks to a crafting table if needed)
  hunt [animal]   (kill a nearby animal for food/resources)
  sleep | wake   (sleep in a nearby bed at night / wake up)
  equip <item>   (hold an item; armor pieces are WORN automatically, shields go off-hand)
  wear           (put on armor you ALREADY have - picks up armor dropped nearby and wears every piece. To armor up, emit exactly {"command":"wear"} - do NOT invent an item like "iron_armor")
  armorup        (GET armor from nothing: wears what you have, hunts cows for leather ONLY if cows are actually nearby, else it MINES IRON and smelts+crafts an iron set itself. Use when "wearing" slots are empty and you have NO armor to wear. Bounded; makes what it can. Wandering traders are NOT a leather source - never chase them for armor)
  drop <item> [count]   (toss real items from your inventory to give to a player)
  eat            (eat food when hungry - also happens automatically)
  say <message>
Materials are Minecraft block ids like stone, oak_planks, glass, cobblestone.
SAY FORMAT: your chat text goes INSIDE the command, after the word say -
{"command":"say <the words you want in chat>","reason":"<private note>"}. "reason" is
private - no player ever sees it - so a bare {"command":"say"} with the message stuffed
into "reason" says NOTHING in game. Never do that. And every say must carry your
personality - a flat, boring reply ("nothing", "ok", "done") is out of character; make
it snappy, original, yours.
TALK BACK - PRIORITY: if "unanswered" is non-empty, a player is waiting on you, so your
command THIS TURN MUST address it. ACT FIRST: if they asked you to DO something - come,
follow, go somewhere, build, wear armor, stop, mine, craft, attack, etc. - emit THAT
command THIS TURN, do NOT reply with a "say". "come to me"->come, "follow me"->follow,
"go to X"/"come get your stuff"->goto/come, "build X"->build, "put on armor"->wear. Only
use "say" when they asked a QUESTION or just chatted (no action to take). Trash-talking or
quipping INSTEAD of doing what they asked is WRONG - do the action; you can quip AFTER.
Reply/act once, briefly, in character.
BUILD PROGRESS: when asked how a build is going, answer ONLY from /state.buildProgress
(material have/need counts) or activity - NEVER invent a percentage. If buildProgress
says "oak_log 0/346" the honest answer is "just getting started on the wood". Making up
"90%" when nothing is placed destroys the operator's trust.
UNPROMPTED CHAT: when "unanswered" is empty, SILENCE is your default - real players idle
quietly. You MAY rarely drop ONE in-character one-liner, but ONLY for something a player
would actually care to hear: a task finished or failed, real danger to a PLAYER, or a
genuinely funny one-off. NEVER narrate your surroundings ("i see wolves/a pig/a skeleton
horse"), never announce that you're waiting/still here/ready to help, never offer to hunt
or tame things nobody asked about - players have eyes; that chatter reads as bot spam.
The body hard-rate-limits and FILTERS unprompted chat, so if a say comes back "skipped"
that's normal - go back to acting, do NOT retry or rephrase the line. NEVER repeat a
previous reply. When there is nothing new to say, a non-chat action or waiting is correct.
DON'T FIXATE: if you already remarked on something (the wolves, a mob, the weather), do
NOT keep bringing it up - say it ONCE, then stay quiet about it. Re-warning about the same
thing every few seconds is spam. Only speak again on it if the situation MEANINGFULLY changed.
BE ACCURATE: base every reply on the ACTUAL state fields - heldItem, wearing, inventory, players,
entities, pos, biome, blockBelow, threat, alone - and on your RECENT action results. NEVER claim
an item you are not holding or something you do not actually see. If heldItem is null you are
holding nothing - say so in your own voice; never invent or name an item you do not have. The
"wearing" field is your equipped armor per slot (null = that slot is empty) - only claim armor
that actually appears there; if a slot is null you are NOT wearing it.
DEATH: if "died" is set, you DID die and dropped your stuff at died.x/y/z - don't deny it. If a
player tells you to get your stuff / go where you died, or you just want it back, emit "recover".
BUT if died.dangerous is true (lava/fire/void) your stuff is gone - do NOT go back, just say so.
LOOK FIRST, THEN ANSWER: if a player asks what you see / what's nearby / where you are and the
state doesn't already answer it, this turn run a perceive command (entities, scan, find, or
look) instead of guessing. Its result lands in your RECENT actions, so on the next turn answer
from that. Example: "what do you see?" -> turn 1 {"command":"entities"}, then turn 2
{"command":"say I see a wolf nearby and you, <name>"} using the real result.
SHOW/HOLD: ONLY when a player explicitly asks you to hold, show, or equip a SPECIFIC item
(e.g. "show me your sword"), first equip it for real with {"command":"equip <item>"} - it must
already be in your inventory - THEN say, so what you hold matches what you claim. A question like
"what are you holding?" is NOT such a request: just answer it from heldItem (null = empty hands -
tell them that in your own words). Never equip an item you do not have, and never invent one.
Use scan/find first if you are unsure of the terrain. Build a few blocks away from players.
DON'T FIDGET: calmly repeating "follow" or just standing still is the CORRECT choice when there
is nothing new to do. Do NOT insert pointless turns, scans, stops, or random moves just to vary
your actions - that makes you jitter and look broken. Only scan/find when you genuinely need to
survey (once or twice), only turn/look when a player asks or you need to face something, and
never spam give/build. React when a player talks to you or something happens (a mob, low food);
otherwise keep calmly following or wait.
ALONE / SELF: "players" lists OTHER players only - you are "name" and are never in it. If "alone"
is true, do NOT follow or come to anyone (least of all yourself): just wait calmly or work toward
the goal. Never use your own name as a follow/come/look target.
THREAT: if "threat" is set, a hostile mob is near. If threat.flee is true (a creeper) back away,
never melee it. Otherwise stay calm if it's far; only attack/defend when it's close and safe.
ARMOR / SURVIVAL: if every "wearing" slot is null you have NO armor. If it's also night, or a
threat is near, or you're heading out on a long job, emit "armorup" to get yourself a set - it
handles the whole chain itself (leather if cows are around, otherwise it mines+smelts IRON).
One armorup is a long job: let it run; don't re-issue it or wander off to "find leather" - and
wandering traders/llamas are NOT an armor source, ignore them. If you DO have armor pieces in
inventory but aren't wearing them, use "wear" instead. Don't armorup when you're already wearing
gear.
STUCK / FAILURES / HAZARDS - read these state fields and the "BODY REPORT" line if present:
- "stuck" set means the body has been TRYING to move for that many seconds with no progress. Do
  NOT re-issue the same command - it will wedge the same way. First "stop", then pick a DIFFERENT
  approach: a different destination, "travel <x y z>" for a far/rough target (it bridges water and
  digs itself out of caves on its own), or wait where you are and tell the player you're blocked.
- "lastResult" is how your last long action ended (trips/gathers/builds whose result doesn't come
  back right away). If its ok is false, that approach FAILED for the reason given - never repeat the
  identical command; change the target or method, or tell the player you couldn't.
- "activity" set means the body is STILL working on a past order (long trips outlive one turn) -
  hold and let it finish unless "stuck" is set or a player interrupts.
- "hazards": onFire or inLava -> get out IMMEDIATELY (goto/travel away, or to water) - top priority
  over everything except a waiting player. drowning -> head to the surface/air. underground just
  means a roof overhead - fine while mining; only act on it if you're ALSO stuck (then "travel"
  toward your goal and the body digs up to the surface itself).
Low-level recovery (pathing, digging out, pillaring) is the body's job - you just pick WHAT to do.
Do not explain outside the JSON. Pick the single best next command toward the goal.`

async function getState () {
  // ?brain=1 marks this as the brain's poll so the body counts it toward the
  // per-message delivery budget (a dashboard /state read must not drain it).
  const r = await fetchT(`${BOT_URL}/state?brain=1`, {}, 10000)
  return await r.json()
}

// Live settings the dashboard controls (model / goal / on-off). Falls back to
// the env defaults if the bot has no /brain endpoint (older body).
async function getBrainSettings () {
  try { const r = await fetchT(`${BOT_URL}/brain`, {}, 5000); if (!r.ok) return null; return (await r.json()).settings } catch { return null }
}

async function runCommand (command, reason) {
  // 60s ceiling: with the body's own goto timeouts a /cmd should return well
  // inside this; the cap is a backstop so a wedged command can't freeze the loop.
  // `reason` (the model's private motive) rides along so the body can surface it in
  // its /log - that's what makes "why did the brain do X" answerable after the fact.
  const r = await fetchT(`${BOT_URL}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, reason })
  }, 60000)
  return await r.text()
}

async function decide (state, history, model = LLM_MODEL, goal = GOAL) {
  const recent = history.length
    ? history.map((h, i) => `${i + 1}. ${h.command} -> ${h.result}`).join('\n')
    : '(none yet)'
  // Surface any player request LOUDLY at the top so it dominates the decision
  // (buried inside the state JSON the model under-weights it).
  const asks = (state && Array.isArray(state.unanswered)) ? state.unanswered : []
  const askLine = asks.map(c => `${c.from} says: "${c.text}"`).join('  |  ')
  // Buried JSON is under-weighted, so surface a stuck/failed/hazard situation LOUDLY as
  // its own line (same reasoning as askLine) - these are the moments the brain most needs
  // to change approach instead of re-issuing a doomed command.
  const hz = (state && state.hazards) || {}
  const dangers = ['onFire', 'inLava', 'drowning'].filter(k => hz[k])
  const bodyBits = []
  if (state && state.stuck) bodyBits.push(`STUCK for ${state.stuck.forSec}s - not making progress; do NOT repeat the same move`)
  if (state && state.lastResult && !state.lastResult.ok) bodyBits.push(`last action "${state.lastResult.action}" FAILED: ${state.lastResult.detail || '?'}`)
  if (dangers.length) bodyBits.push(`HAZARD: ${dangers.join(', ')} - get out NOW`)
  else if (hz.underground && state && state.stuck) bodyBits.push('BURIED underground and stuck - use travel toward your goal so the body digs up')
  const bodyLine = bodyBits.length ? `BODY REPORT: ${bodyBits.join(' | ')}\n` : ''
  const userContent = askLine
    ? `${bodyLine}A PLAYER IS TALKING TO YOU RIGHT NOW - THIS IS YOUR #1 PRIORITY THIS TURN.\nMessage: ${askLine}\nWork out what they want in plain language and pick the ONE command that does it now ` +
      `(come/follow/goto/recover/turn/look/drop/equip/wear/armorup/eat/mine/break/collect/plant/place/craft/hunt/sleep/attack/defend/scan/find), or "say" to answer a question. Do not just keep following.\n` +
      `RECENT actions:\n${recent}\nSTATE: ${JSON.stringify(state)}\nRespond with one JSON command.`
    : `${bodyLine}GOAL: ${goal}\nRECENT actions (oldest first):\n${recent}\nSTATE: ${JSON.stringify(state)}\nPick the next command that makes progress (do not repeat the above). Respond with one JSON command.`
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userContent }
  ]
  // OLLAMA_NATIVE=1 -> hit Ollama's /api/chat with think:false, which TRULY disables
  // Qwen3's hybrid reasoning (the OpenAI /v1 shim can't) - ~0.6s vs ~10s, and valid
  // JSON via format:json. Otherwise use the OpenAI-compatible shape.
  const native = process.env.OLLAMA_NATIVE === '1'
  const body = native
    ? { model, messages, think: false, stream: false, format: 'json', options: { temperature: LLM_TEMP } }
    : { model, temperature: LLM_TEMP, messages, response_format: { type: 'json_object' } }
  const r = await fetchT(LLM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 60000)
  if (!r.ok) throw new Error(`LLM ${r.status}: ${await r.text()}`)
  const j = await r.json()
  const content = native ? (j.message?.content ?? '') : (j.choices?.[0]?.message?.content ?? '')
  // format:json (native) yields a single valid object - parse it straight. The
  // greedy {..} regex is only the fallback for the OpenAI-shim path, where it can
  // misgrab across two blobs; direct parse first avoids that when possible.
  try { return JSON.parse(content.trim()) } catch {}
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`no JSON in model reply: ${content.slice(0, 120)}`)
  return JSON.parse(match[0])
}

async function loop () {
  console.log(`[brain] LLM=${LLM_URL} model=${LLM_MODEL} bot=${BOT_URL}`)
  console.log(`[brain] goal: ${GOAL}`)
  console.log(`[brain] pacing: as fast as decisions complete (floor ${TICK_MIN_MS}ms, error backoff up to ${TICK_MAX_MS}ms)`)
  let backoff = 0
  const history = [] // rolling short-term memory of recent actions
  let lastSig = null
  let lastDecideAt = 0
  let lastCmd = '(none)'
  let idleLogged = false
  let pausedLogged = false
  let lastModel = LLM_MODEL
  let cachedSettings = null
  let lastSettingsAt = 0
  const SETTINGS_POLL_MS = parseInt(process.env.SETTINGS_POLL_MS || '3000', 10)
  // Outcome labeling: each decision is buffered, its next few seconds of state observed, then
  // flushed to the log WITH a label (did the bot die / get stuck / not move after this call?).
  // That turns the raw log into a quality-labeled dataset instead of pure imitation data.
  const pending = []
  const OUTCOME_WINDOW_MS = parseInt(process.env.OUTCOME_WINDOW_MS || '9000', 10)
  const observe = (state) => { // update every buffered decision with the latest state
    const hp = state && state.health != null ? state.health : 20
    for (const p of pending) {
      p.minHp = Math.min(p.minHp, hp)
      if (state && state.stuck) p.stuck = true
      if (p.prevHp <= 6 && hp >= 19) p.respawned = true // low HP then suddenly full = died + respawned
      p.prevHp = hp
      if (state && state.pos && p.startPos) p.moved = Math.max(p.moved, Math.hypot(state.pos.x - p.startPos.x, state.pos.z - p.startPos.z))
    }
  }
  const flushOutcomes = (force) => { // write out decisions whose observation window has elapsed
    while (pending.length && (force || Date.now() - pending[0].t0 > OUTCOME_WINDOW_MS)) {
      const p = pending.shift()
      p.row.outcome = { result: p.row.resultClass, died: p.respawned, stuck: p.stuck, minHp: Math.round(p.minHp), moved: Math.round(p.moved) }
      logDecision(p.row)
    }
  }
  for (;;) {
    const t0 = Date.now()
    try {
      // Live model / goal / on-off from the dashboard (falls back to env defaults).
      // Polled on its own slow cadence, not every tick - these almost never change,
      // so a round-trip per idle poll was pure overhead. A failed poll keeps the
      // last good settings rather than snapping back to env defaults.
      if (Date.now() - lastSettingsAt > SETTINGS_POLL_MS) {
        const s = await getBrainSettings()
        if (s !== null) cachedSettings = s
        lastSettingsAt = Date.now()
      }
      const settings = cachedSettings
      const model = (settings && settings.model) || LLM_MODEL
      const goal = (settings && settings.goal) || GOAL
      const enabled = !settings || settings.enabled !== false
      if (model !== lastModel) { console.log(`[brain] model switched -> ${model}`); lastModel = model }
      if (!enabled) { // paused from the UI - idle, keep chat/reflexes alive on the body
        if (!pausedLogged) { console.log('[brain] paused via dashboard - holding'); pausedLogged = true }
        await sleep(IDLE_POLL_MS); continue
      }
      pausedLogged = false

      const state = await getState()
      observe(state)      // feed the latest state to any buffered decisions awaiting their outcome
      flushOutcomes()     // write out decisions whose ~9s observation window has closed, now labeled
      const sig = signature(state)
      const waiting = (state.unanswered || []).length > 0
      const changed = sig !== lastSig
      const heartbeat = Date.now() - lastDecideAt > IDLE_HEARTBEAT_MS
      // During an operator build/provision the BODY is driven externally and the
      // /cmd path rejects the brain's movement anyway - so don't burn inferences
      // re-deciding. Hold cheaply; still answer a waiting player, and let the slow
      // heartbeat through so it can still drop an occasional in-character quip.
      if (state.busy && !waiting && !heartbeat) {
        if (!idleLogged) { console.log('[brain] body busy (build/provision) - holding'); idleLogged = true }
        lastSig = sig
        await sleep(IDLE_POLL_MS)
        continue
      }
      // Nothing to react to and nothing changed -> hold the current behaviour and
      // poll cheaply, instead of burning an inference to re-decide the same thing.
      if (!waiting && !changed && !heartbeat) {
        if (!idleLogged) { console.log(`[brain] holding "${lastCmd}" - idle until state changes (heartbeat ${Math.round(IDLE_HEARTBEAT_MS / 1000)}s)`); idleLogged = true }
        lastSig = sig
        await sleep(IDLE_POLL_MS)
        continue
      }
      const priorHistory = history.slice() // the recent-action context the model saw THIS tick
      const action = await decide(state, history, model, goal)
      const result = await runCommand(action.command, action.reason)
      const ms = Date.now() - t0
      const summary = result.split('\n')[0].slice(0, 120)
      console.log(`[brain] ${ms}ms ${action.command}  (${action.reason || ''}) -> ${summary}`)
      // One supervised example + "why" record: the exact inputs (state/history/asks/goal),
      // the model's output (command+reason), and the body's response. `wake` tags what
      // triggered the tick. It is NOT written yet - it's buffered so the next ~9s of state can
      // label its OUTCOME (died/stuck/no-progress), then flushOutcomes() writes it labeled.
      const row = {
        t: t0,
        wake: waiting ? 'ask' : (changed ? 'change' : 'heartbeat'),
        goal,
        asks: (state.unanswered || []),
        state,
        history: priorHistory,
        command: action.command,
        reason: action.reason || '',
        result: summary,
        resultClass: classifyResult(summary),
        ms
      }
      pending.push({ row, t0, startPos: state.pos, minHp: state.health != null ? state.health : 20, prevHp: state.health != null ? state.health : 20, stuck: !!state.stuck, respawned: false, moved: 0 })
      history.push({ command: action.command, result: summary })
      if (history.length > HISTORY_MAX) history.shift()
      lastSig = sig
      lastDecideAt = Date.now()
      lastCmd = action.command
      idleLogged = false
      backoff = 0
      if (TICK_MIN_MS > 0) await sleep(TICK_MIN_MS)
    } catch (e) {
      // back off only on failure, so a down LLM/bot isn't hammered in a tight loop
      backoff = backoff ? Math.min(backoff * 2, TICK_MAX_MS) : 500
      console.log(`[brain] skip (${Date.now() - t0}ms): ${e.message} - retry in ${backoff}ms`)
      await sleep(backoff)
    }
  }
}

loop()
