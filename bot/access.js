'use strict'
// Shared access/chat helpers used by BOTH bodies (index.js Java, index-bedrock.js).
// Keeps operator-gating and "is this addressed to me?" logic identical across editions.

// Build the set of authorized operator names (lowercased). Sources, merged:
//   config.operators  (array)         e.g. ["Steve", "Alex"]
//   env OPERATORS      (comma-list)   e.g. OPERATORS="Steve,Alex"
function operatorSet (cfg) {
  const fromEnv = (process.env.OPERATORS || '').split(',')
  const list = [...(cfg.operators || []), ...fromEnv]
    .map(s => String(s).trim().toLowerCase())
    .filter(Boolean)
  return new Set(list)
}

// Floodgate prefixes Bedrock usernames (default '.') on a Geyser server, so we
// compare both the raw name and the prefix-stripped name.
function variants (name, cfg) {
  const raw = String(name || '').trim().toLowerCase()
  const prefix = String(process.env.FLOODGATE_PREFIX ?? cfg.floodgatePrefix ?? '').toLowerCase()
  const out = new Set([raw])
  if (prefix && raw.startsWith(prefix)) out.add(raw.slice(prefix.length))
  return out
}

// Only players on the allowlist may run !commands. Empty list = nobody (locked
// down by default - configure operators to enable chat control).
function isOperator (name, cfg) {
  const ops = operatorSet(cfg)
  if (ops.size === 0) return false
  for (const v of variants(name, cfg)) if (ops.has(v)) return true
  return false
}

// Fold a name/word to a comparable "core": lowercase, drop underscores/punctuation,
// and de-leet common digit-for-letter swaps. So "_D1gital_" -> "digital", which is
// what a player naturally types when they call the bot by a look-alike of its name.
function deleet (s) {
  return String(s || '').toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
}
function coreForms (name) {
  const raw = String(name || '').trim().toLowerCase()
  const stripped = raw.replace(/[^a-z0-9]+/g, '') // drop _, spaces, punctuation
  return [...new Set([raw, stripped, deleet(stripped)])].filter(s => s.length >= 3)
}

// A non-command message counts as "addressed to the bot" if it mentions the bot's
// name - or any configured alias - by a SIMILAR word, not just an exact match.
// "_D1gital_" is reached by "digital"; a long-enough prefix ("digi") counts too.
// Still token-based (not raw substring) so "about"/"robot" don't false-trigger.
function isAddressed (message, botName, cfg = {}) {
  const tokens = deleet(message).split(/[^a-z0-9]+/).filter(Boolean)
  const names = [botName, ...(cfg.aliases || [])]
  for (const n of names) {
    for (const core of coreForms(n)) {
      if (tokens.includes(core)) return true
      for (const t of tokens) {
        // "similar": a reasonably long token that is a prefix of the name (or vice versa)
        if (t.length >= 4 && (core.startsWith(t) || t.startsWith(core))) return true
      }
    }
  }
  return false
}

// Parse an operator's PLAIN-CHAT build request (no "!" prefix), e.g.
//   "build castle"           "can you build the mansion"
//   "Animus build my tower"  "please build the barn and clear the site"
// Returns { name, clear } or null. Deliberately STRICT so ordinary conversation
// ("we should build a base someday", "how do I build a farm") never triggers a
// build: a build verb must lead the request, preceded only by pleasantries or the
// bot's name. The caller still operator-gates this - it only extracts intent.
const BUILD_VERB = /\b(build|rebuild|construct)\b\s+(.+)$/i
// Three integers (optionally intro'd by "at"/"to"), matched ANYWHERE in the message.
const COORD_RE = /(?:\b(?:at|to)\s+)?(-?\d+)\s*[, ]\s*(-?\d+)\s*[, ]\s*(-?\d+)/
// Words allowed to appear BEFORE the verb: addressing, politeness, and simple
// movement/location lead-ins - so compound orders like "go to <coords> and build X"
// or "come here and build X" are accepted. Anything else before "build" means it's
// prose, not a command -> not a build request.
const BEFORE_OK = new Set([
  'please', 'pls', 'plz', 'hey', 'yo', 'ok', 'okay', 'can', 'could', 'would',
  'will', 'you', 'u', 'kindly', 'go', 'and', 'then', 'now', 'lets', 'let', 'just',
  'to', 'head', 'walk', 'come', 'move', 'over', 'there', 'here', 'at'
])
function parseBuildRequest (message, botName, cfg = {}) {
  let raw = String(message || '').trim()
  if (!BUILD_VERB.test(raw)) return null // must contain a build verb somewhere
  // Pull coordinates from ANYWHERE first, so they work whether they come BEFORE the
  // verb ("go to 435 67 111 and build the castle") or AFTER ("build castle at 435 67
  // 111"). Remove them so they can't confuse the before-guard or leak into the name.
  let at = null
  const coord = raw.match(COORD_RE)
  if (coord) {
    at = { x: parseInt(coord[1], 10), y: parseInt(coord[2], 10), z: parseInt(coord[3], 10) }
    raw = raw.replace(coord[0], ' ')
  }
  const m = raw.match(BUILD_VERB)
  if (!m) return null
  // Guard: with coords removed, every word before the verb must be a pleasantry,
  // movement lead-in, or the bot's name - else it's ordinary prose, not a command.
  // Match the bot's name the SAME fuzzy way isAddressed does (de-leet look-alikes),
  // so "digital ..." addressing a bot named "_D1gital_" is accepted.
  const nameForms = new Set()
  for (const n of [botName, ...((cfg && cfg.aliases) || [])]) for (const f of coreForms(n)) nameForms.add(f)
  const beforeTokens = raw.slice(0, m.index).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (beforeTokens.some(t => !BEFORE_OK.has(t) && !nameForms.has(t) && !nameForms.has(deleet(t)))) return null
  // Work on the tail after the verb.
  const tail = ' ' + m[2].toLowerCase() + ' '
  const clear = /\b(clear|flatten|level)\b/.test(tail)
  // Whatever's left, stripped of the clear request, articles, politeness and
  // location fillers ("here"/"at"/"for me"...), is the schematic name.
  const name = tail
    .replace(/\b(and|then)?\s*(clear|flatten|level)(\s+(the|this))?(\s+(site|ground|area|land|terrain|spot))?\b/g, ' ')
    .replace(/\bschematics?\b/g, ' ')
    .replace(/\b(a|an|the|my|our|your|me|us|for|please|pls|plz|now|here|there|at|on|right|over|down|up|somewhere|nearby|where|im|standing|thanks|thank|you|it|and|then|go|to)\b/g, ' ')
    .replace(/[^a-z0-9 _-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name) return null
  return { name, clear, at }
}

// World-editing / admin commands the autonomous brain is NEVER allowed to run on
// the HTTP /cmd path (it can only move, perceive, equip, eat, chat) - so it can't
// grief or dupe. Operators keep full access via in-game !commands. Lift with
// BRAIN_ALLOW_CHEATS=1. Shared by BOTH bodies so the two lists can't drift apart.
const CHEAT_CMDS = /^(give|fill|setblock|clear|clearinv|wall|tower|house|schem|schematic|provision|autobuild|cancelbuild|abandonbuild|stash|unstash|gamemode|tp)\b/i

module.exports = { operatorSet, isOperator, isAddressed, parseBuildRequest, CHEAT_CMDS }
