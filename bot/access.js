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

// A non-command message counts as "addressed to the bot" if it mentions the
// bot's name - or any configured alias - as a whole word. Word-boundary match
// avoids false hits like "Bot" inside "robot"/"about". Aliases let players use a
// friendly name instead of an awkward account name (e.g. "claude" for "Claudebot").
function isAddressed (message, botName, cfg = {}) {
  const m = String(message || '').toLowerCase()
  const names = [botName, ...(cfg.aliases || [])]
    .map(n => String(n || '').trim().toLowerCase())
    .filter(Boolean)
  for (const b of names) {
    const esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${esc}\\b`).test(m)) return true
  }
  return false
}

// World-editing / admin commands the autonomous brain is NEVER allowed to run on
// the HTTP /cmd path (it can only move, perceive, equip, eat, chat) - so it can't
// grief or dupe. Operators keep full access via in-game !commands. Lift with
// BRAIN_ALLOW_CHEATS=1. Shared by BOTH bodies so the two lists can't drift apart.
const CHEAT_CMDS = /^(give|fill|setblock|clear|clearinv|wall|tower|house|schem|schematic|provision|gamemode|tp)\b/i

module.exports = { operatorSet, isOperator, isAddressed, CHEAT_CMDS }
