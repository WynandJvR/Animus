'use strict'
// CHAT + ATTENTION: who addressed the bot, what is still waiting for an answer, whether an
// outgoing line is actually allowed to be said, and who the bot should be looking at.
// Split out of index.js unchanged.
//
// index.js's header claims it is a thin body-plus-HTTP-API; in practice ~1250 of its lines
// are autonomous behaviour. This is the first cohesive subsystem lifted out of it. Everything
// here is state + policy about TALKING - no bot handle is stored, no reflex runs from this
// file, and index.js keeps the event handlers and the gaze reflex that consume it.
//
// The one outside dependency, "is the body busy right now", is INJECTED into gateSay rather
// than required, so this file never reaches into commands.js.

// ---- pending chat --------------------------------------------------------------------
// Short-term memory of chat addressed to the bot, surfaced in /state. Each message is offered
// for up to MAX_DELIVERIES ticks so the brain reliably gets a chance to respond (not dropped
// after one poll), yet bounded so it can't loop forever.
const MAX_DELIVERIES = parseInt(process.env.CHAT_MAX_DELIVERIES || '6', 10)
const recentChat = []
// separate, noise-free record of ALL player chat (so it isn't flooded out of the main event
// log by the bot's own follow/scan commands). Seen via /chat.
const chatLog = []
function recordChatLog (line) { chatLog.push(line); if (chatLog.length > 40) chatLog.shift() }
function chatLogTail (n) { return chatLog.slice(-(n || 40)) }

let lastAddressedAt = 0 // when a player last addressed the bot (gates brain chatter)
let lastReplyAt = 0     // when the bot last spoke a reply
function addressedAt () { return lastAddressedAt }

// gaze/attention state (the gaze reflex in index.js reads this): who last spoke to us (eye
// contact while replying), and a window where a manual look/turn owns the head.
let gazeFocusPlayer = null
let gazeFocusAt = 0
let gazeSuppressUntil = 0
function gazeState () { return { player: gazeFocusPlayer, at: gazeFocusAt, suppressUntil: gazeSuppressUntil } }
function noteManualLook (line) { // a deliberate look/turn should not be overridden by gaze
  if (/^(look|turn|lookbehind)\b/i.test(String(line).trim())) gazeSuppressUntil = Date.now() + 6000
}

function recordChat (from, text) {
  recentChat.push({ from, text, ts: Date.now(), deliveries: 0 })
  if (recentChat.length > 6) recentChat.shift()
  lastAddressedAt = Date.now()
  gazeFocusPlayer = from; gazeFocusAt = Date.now() // look at whoever just addressed us
}

// Resolve the OLDEST still-pending message - one fulfilling action answers one request.
// Clearing ALL of them dropped a second player's message unanswered when two people spoke in
// the same window; now each message gets its own turn.
function clearPendingChat () {
  const pending = recentChat.filter(c => c.deliveries < MAX_DELIVERIES)
  if (pending.length) pending[0].deliveries = MAX_DELIVERIES
}
// The live pending list, for /state to walk and stamp deliveries on (mutated in place).
function pendingChat () { return recentChat.filter(c => c.deliveries < MAX_DELIVERIES) }

// ---- outgoing say gate ---------------------------------------------------------------
// A "say" is only actually sent if it isn't a duplicate and the cooldown elapsed - kills
// repeated/again-spam chat and server anti-spam kicks. Returns null to send, or a reason
// string to suppress.
// Brain chat comes in two kinds: a REPLY (a player addressed it since it last spoke) is always
// allowed; an UNPROMPTED quip ("vibe") is allowed at most once per VIBE_CHAT_MS so the bot
// feels alive without ever spamming itself into a kick.
const CHAT_COOLDOWN_MS = parseInt(process.env.CHAT_COOLDOWN_MS || '2500', 10)
// Budget for UNPROMPTED quips (a direct reply is never throttled). 90s felt spammy, 150s STILL
// felt spammy on the live server ("i see a bunch of wolves..." every couple of minutes) - a
// real player idles quietly. One ambient line per ~10 min feels alive.
const VIBE_CHAT_MS = parseInt(process.env.VIBE_CHAT_MS || '600000', 10)
// The spam is characteristically NARRATION - announcing what it sees or that it's waiting.
// Those lines carry zero information for players; block the genre outright for unprompted
// chat (replies are never filtered - if you ASK what it sees, it answers).
const NARRATION_RE = /^(i (see|spot|notice|hear|found) |i'?m (still here|just|waiting|around|chilling)|just (waiting|hanging|chilling)|let me know if|anyone (need|want)|nothing (going on|happening)|all quiet)/i
let lastSayAt = 0
let lastVibeAt = 0
let lastBusyReplyAt = 0 // rate-limits the body's own "can't right now - busy" replies

// Content de-dupe. A fixated model re-emits near-identical lines ("why are there so many
// wolves here") every tick; the timing gates alone let one identical copy through each window,
// so players see the same message on repeat. Track the last few sent lines and suppress
// near-duplicates of UNPROMPTED chatter (a direct reply is never blocked, but is recorded so
// the next quip can't just echo it).
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

// opts.isBusy: injected from index.js (commands.isBusy) - see the header note.
function gateSay (line, fromBrain, opts = {}) {
  const isBusy = typeof opts.isBusy === 'function' ? opts.isBusy : () => false
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
    if (isBusy()) return 'busy - no idle chatter'
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

// The body's own "can't right now - busy" reply is rate-limited separately: it answers a
// player, so it must not be silenced, but it must not repeat every tick either.
function busyReplyDue (withinMs, gapMs) {
  const now = Date.now()
  return (now - lastAddressedAt < (withinMs || 20000)) && (now - lastBusyReplyAt > (gapMs || 30000))
}
function markBusyReply () { lastBusyReplyAt = Date.now() }

// ---- impactful-command gate ------------------------------------------------------------
// Block spamming the same world-changing command - caps any single impactful command
// (give/build) to once per IMPACT_COOLDOWN_MS, so a fixated model can't dupe items or
// re-build the same thing on a loop. Returns a reason or null.
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

module.exports = {
  recordChatLog, chatLogTail,
  recordChat, clearPendingChat, pendingChat, addressedAt,
  noteManualLook, gazeState,
  normSay, tooSimilar, isDupSay, recordSaid, gateSay,
  busyReplyDue, markBusyReply,
  gateImpactful,
  MAX_DELIVERIES, CHAT_COOLDOWN_MS, VIBE_CHAT_MS, NARRATION_RE, SAY_DUP_WINDOW_MS, RECENT_SAY_MAX, IMPACT_COOLDOWN_MS
}
