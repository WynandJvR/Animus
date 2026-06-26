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
//   TICK_MS    deprecated alias — if set, used as TICK_MIN_MS (back-compat)
//
// The model is asked to reply with ONE JSON object: {"command":"...","reason":"..."}.
// On llama.cpp, pair this with a GBNF grammar so the output is ALWAYS valid.

const LLM_URL = process.env.LLM_URL || 'http://127.0.0.1:8080/v1/chat/completions'
const LLM_MODEL = process.env.LLM_MODEL || 'local'
const BOT_URL = process.env.BOT_URL || 'http://127.0.0.1:3001'
const GOAL = process.env.GOAL || 'Stay near the nearest player and build something nice when asked.'
// Pace the loop at the speed decisions actually complete. The floor defaults to
// 0 (no artificial delay — go as fast as the model + bot round-trip allows).
const TICK_MIN_MS = parseInt(process.env.TICK_MIN_MS || process.env.TICK_MS || '0', 10)
const TICK_MAX_MS = parseInt(process.env.TICK_MAX_MS || '8000', 10)
// How many recent actions to feed back so the model knows what it already did
// (stops it looping on the same command — its only memory between ticks).
const HISTORY_MAX = parseInt(process.env.HISTORY_MAX || '8', 10)
// Idle pacing: when nothing salient has changed AND no player is waiting, the body
// keeps executing its current behaviour (a follow goal keeps tracking, a stop stays
// stopped), so re-running the LLM every ~0.5s is wasted GPU. Poll state cheaply
// every IDLE_POLL_MS and only think again on a real change, a pending chat, or every
// IDLE_HEARTBEAT_MS as a slow heartbeat (so it can still pursue the goal on its own).
const IDLE_POLL_MS = parseInt(process.env.IDLE_POLL_MS || '900', 10)
const IDLE_HEARTBEAT_MS = parseInt(process.env.IDLE_HEARTBEAT_MS || '15000', 10)

const sleep = ms => new Promise(r => setTimeout(r, ms))

// A compact fingerprint of the SALIENT world state. Player *presence* (names) and
// danger matter; exact distances of a player we're already following do not, so
// they're left out / coarsely bucketed to avoid waking the LLM on every step.
function signature (state) {
  if (!state) return 'none'
  const players = (state.players || []).map(p => p.name).sort().join(',')
  const threat = state.threat ? `${state.threat.type}:${Math.round(state.threat.dist / 3)}` : '-'
  const hp = Math.round((state.health ?? 20) / 5)
  const food = Math.round((state.food ?? 20) / 4)
  const ask = (state.unanswered || []).length
  return [players, threat, hp, food, state.isDay ? 'day' : 'night', ask].join('|')
}

const SYSTEM = `You control a Minecraft bot. Each turn you receive the world state as JSON
(your position, facing, nearby blocks/players/entities, inventory), a list of your
RECENT actions (most recent last), and any chat players addressed to you in the
state's "unanswered" field.
Respond with EXACTLY ONE JSON object: {"command": "<one command>", "reason": "<short>"}.
Valid commands — your "command" MUST begin with exactly one of these verbs.
Do NOT prefix it with a category word like "perceive", "move", "build", or "chat":
  state | scan [radius] | find <block> [radius] | block <x> <y> <z> | entities | inventory | look <x> <y> <z>
  come [player] | goto <x> <y> <z> | follow <player> | stop
  turn <around|left|right|north|south|east|west>   (rotate to look that way)
  attack | defend   (fight the nearest hostile mob — also happens automatically)
  mine <x> <y> <z> | break [blocktype]   (break a block; bare "break" chops the nearest tree, walking to it; uses the right tool)
  collect   (walk over and pick up nearby dropped items)
  plant <item>   (place a sapling/block on nearby grass/dirt)
  place <item> [x y z]   (place a block on any solid surface — torches, blocks, table)
  craft <item> [count]   (craft an item; walks to a crafting table if needed)
  hunt [animal]   (kill a nearby animal for food/resources)
  sleep | wake   (sleep in a nearby bed at night / wake up)
  equip <item>   (hold an item from your inventory)
  drop <item> [count]   (toss real items from your inventory to give to a player)
  eat            (eat food when hungry — also happens automatically)
  say <message>
Materials are Minecraft block ids like stone, oak_planks, glass, cobblestone.
TALK BACK — PRIORITY: if "unanswered" is non-empty, a player is waiting on you, so your
command THIS TURN MUST address it — reply with say, or do exactly what they asked
(come/follow/build/equip/...). Do NOT follow/move/idle while a message is unanswered.
Reply once, briefly, addressing them by name. Do NOT say anything when
"unanswered" is empty. NEVER repeat a previous reply or send filler/status chatter ("I'm
ready", "what's next") — that gets the bot kicked for spam. If a player asked for an action
(come/follow/build/stop), do that action instead of chatting. When there is nothing new to
say, choose a non-chat action (e.g. follow) or stop — silence is correct.
BE ACCURATE: base every reply on the ACTUAL state fields — heldItem, inventory, players,
entities, pos, biome, blockBelow, threat, alone — and on your RECENT action results. NEVER claim
an item you are not holding or something you do not actually see. If heldItem is null you are
holding nothing — say so plainly; never invent or name an item you do not have.
LOOK FIRST, THEN ANSWER: if a player asks what you see / what's nearby / where you are and the
state doesn't already answer it, this turn run a perceive command (entities, scan, find, or
look) instead of guessing. Its result lands in your RECENT actions, so on the next turn answer
from that. Example: "what do you see?" -> turn 1 {"command":"entities"}, then turn 2
{"command":"say I see a wolf nearby and you, <name>"} using the real result.
SHOW/HOLD: ONLY when a player explicitly asks you to hold, show, or equip a SPECIFIC item
(e.g. "show me your sword"), first equip it for real with {"command":"equip <item>"} — it must
already be in your inventory — THEN say, so what you hold matches what you claim. A question like
"what are you holding?" is NOT such a request: just answer it from heldItem (say "nothing" if it
is null). Never equip an item you do not have, and never invent one.
Use scan/find first if you are unsure of the terrain. Build a few blocks away from players.
DON'T FIDGET: calmly repeating "follow" or just standing still is the CORRECT choice when there
is nothing new to do. Do NOT insert pointless turns, scans, stops, or random moves just to vary
your actions — that makes you jitter and look broken. Only scan/find when you genuinely need to
survey (once or twice), only turn/look when a player asks or you need to face something, and
never spam give/build. React when a player talks to you or something happens (a mob, low food);
otherwise keep calmly following or wait.
ALONE / SELF: "players" lists OTHER players only — you are "name" and are never in it. If "alone"
is true, do NOT follow or come to anyone (least of all yourself): just wait calmly or work toward
the goal. Never use your own name as a follow/come/look target.
THREAT: if "threat" is set, a hostile mob is near. If threat.flee is true (a creeper) back away,
never melee it. Otherwise stay calm if it's far; only attack/defend when it's close and safe.
Do not explain outside the JSON. Pick the single best next command toward the goal.`

async function getState () {
  const r = await fetch(`${BOT_URL}/state`)
  return await r.json()
}

async function runCommand (command) {
  const r = await fetch(`${BOT_URL}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command })
  })
  return await r.text()
}

async function decide (state, history) {
  const recent = history.length
    ? history.map((h, i) => `${i + 1}. ${h.command} -> ${h.result}`).join('\n')
    : '(none yet)'
  // Surface any player request LOUDLY at the top so it dominates the decision
  // (buried inside the state JSON the model under-weights it).
  const asks = (state && Array.isArray(state.unanswered)) ? state.unanswered : []
  const askLine = asks.map(c => `${c.from} says: "${c.text}"`).join('  |  ')
  const userContent = askLine
    ? `A PLAYER IS TALKING TO YOU RIGHT NOW — THIS IS YOUR #1 PRIORITY THIS TURN.\nMessage: ${askLine}\nWork out what they want in plain language and pick the ONE command that does it now ` +
      `(come/follow/goto/turn/look/drop/equip/eat/mine/break/collect/plant/place/craft/hunt/sleep/attack/defend/scan/find), or "say" to answer a question. Do not just keep following.\n` +
      `RECENT actions:\n${recent}\nSTATE: ${JSON.stringify(state)}\nRespond with one JSON command.`
    : `GOAL: ${GOAL}\nRECENT actions (oldest first):\n${recent}\nSTATE: ${JSON.stringify(state)}\nPick the next command that makes progress (do not repeat the above). Respond with one JSON command.`
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userContent }
  ]
  // OLLAMA_NATIVE=1 -> hit Ollama's /api/chat with think:false, which TRULY disables
  // Qwen3's hybrid reasoning (the OpenAI /v1 shim can't) — ~0.6s vs ~10s, and valid
  // JSON via format:json. Otherwise use the OpenAI-compatible shape.
  const native = process.env.OLLAMA_NATIVE === '1'
  const body = native
    ? { model: LLM_MODEL, messages, think: false, stream: false, format: 'json', options: { temperature: 0.3 } }
    : { model: LLM_MODEL, temperature: 0.3, messages, response_format: { type: 'json_object' } }
  const r = await fetch(LLM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!r.ok) throw new Error(`LLM ${r.status}: ${await r.text()}`)
  const j = await r.json()
  const content = native ? (j.message?.content ?? '') : (j.choices?.[0]?.message?.content ?? '')
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
  for (;;) {
    const t0 = Date.now()
    try {
      const state = await getState()
      const sig = signature(state)
      const waiting = (state.unanswered || []).length > 0
      const changed = sig !== lastSig
      const heartbeat = Date.now() - lastDecideAt > IDLE_HEARTBEAT_MS
      // Nothing to react to and nothing changed -> hold the current behaviour and
      // poll cheaply, instead of burning an inference to re-decide the same thing.
      if (!waiting && !changed && !heartbeat) {
        if (!idleLogged) { console.log(`[brain] holding "${lastCmd}" - idle until state changes (heartbeat ${Math.round(IDLE_HEARTBEAT_MS / 1000)}s)`); idleLogged = true }
        lastSig = sig
        await sleep(IDLE_POLL_MS)
        continue
      }
      const action = await decide(state, history)
      const result = await runCommand(action.command)
      const ms = Date.now() - t0
      const summary = result.split('\n')[0].slice(0, 120)
      console.log(`[brain] ${ms}ms ${action.command}  (${action.reason || ''}) -> ${summary}`)
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
      console.log(`[brain] skip (${Date.now() - t0}ms): ${e.message} — retry in ${backoff}ms`)
      await sleep(backoff)
    }
  }
}

loop()
