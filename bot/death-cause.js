'use strict'
// DEATH ATTRIBUTION - what actually killed the bot.
//
// AUDIT 2026-07-29, defect D3: of 34 deaths in one session the bot could name the cause of TWO.
// The other 32 were recorded as `unknown death at <x,y,z>`, and `unknown` is worth nothing
// downstream: grave-policy's hard hazard rung explicitly refuses to arm on a cause with no
// readable medium, `causeWritesOff` says the gear is still there, and every "learn from your
// deaths" mechanism in the tree is reading a column of nulls.
//
// The reason was not subtlety. `classifyDeathCause` reads four things at the death CELL (y<-60,
// a lava block in the box, water at the head, a fallDistance the caller never passes) - so it can
// only ever name the ways the WORLD kills you standing still, and never the ways something else
// kills you. Mobs, explosions, starvation, suffocation, fire ticks and arrows are the actual
// killers, and all of them land in the same `unknown` bucket.
//
// Meanwhile the server broadcasts the exact answer in chat - `Animus was shot by Skeleton` - and
// the bot, which already parses chat for its own name, throws that line away.
//
// This module is the missing reader, in three layers of descending authority:
//   1. parseDeathMessage  the server's own verdict. Unambiguous when present.
//   2. damage log         what hit us in the seconds before we died (health-drop samples with the
//                         nearest hostile + medium at the time). Covers servers/plugins that mute
//                         or reword death messages.
//   3. block reads        today's classifyDeathCause, unchanged, as the floor.
// `attributeDeath` composes them. Layers 1 and 2 are PURE and offline-tested (deathcausetest.js);
// only `installDamageTracker` touches a bot.
//
// The cause VOCABULARY is a superset of grave-policy's: every cause that file knows
// (lava/fire/drowning/void/fall) keeps its exact spelling, so `causeWritesOff` and `HAZARD_MEDIUM`
// keep working byte-for-byte and the new causes simply stop being lies.

// Causes this module can produce. The first five are grave-policy's existing vocabulary.
const CAUSES = ['void', 'lava', 'fire', 'drowning', 'fall', 'explosion', 'mob', 'starvation',
  'suffocation', 'cactus', 'magic', 'lightning', 'freezing', 'unknown']

// ---------------------------------------------------------------------------
// LAYER 1 - the server's own death message.
//
// Vanilla death messages are the single most reliable signal available and cost nothing to read.
// The patterns below are the en_us `death.attack.*` strings for 1.21. Ordered most-specific-first
// because several overlap ("was blown up by" is also "was killed by"-shaped on some plugins).
//
// A message is OURS only if it starts with our username followed by a space - checked by the
// caller through `username`, never by a substring search, so a chat line that merely MENTIONS the
// bot ("Animus was shot by a skeleton lol") can never be mistaken for a death report. Death
// messages are system messages with no `<speaker>` prefix, which is the second discriminator.
const MESSAGE_PATTERNS = [
  // world / environment
  [/\bfell out of the world\b|\bdidn't want to live in the same world as\b/i, 'void'],
  [/\btried to swim in lava\b|\bdiscovered the floor was lava\b|\bwalked into the danger zone due to\b/i, 'lava'],
  [/\bburned to death\b|\bwent up in flames\b|\bwas burnt to a crisp\b|\bwalked into fire\b|\bwas killed by even more magic\b/i, 'fire'],
  [/\bdrowned\b/i, 'drowning'],
  [/\bfroze to death\b|\bwas frozen to death by\b/i, 'freezing'],
  [/\bstarved to death\b/i, 'starvation'],
  [/\bsuffocated in a wall\b|\bwas squished too much\b|\bwas squashed by\b/i, 'suffocation'],
  [/\bwas pricked to death\b|\bwalked into a cactus\b/i, 'cactus'],
  [/\bwas struck by lightning\b/i, 'lightning'],
  // falling - several phrasings, all the same cause
  [/\bfell from a high place\b|\bhit the ground too hard\b|\bfell off\b|\bfell while climbing\b|\bwas doomed to fall\b|\bexperienced kinetic energy\b|\bwas impaled on a stalagmite\b|\bwas skewered by a falling stalactite\b/i, 'fall'],
  // explosions - creeper/tnt/bed/respawn anchor
  [/\bblew up\b|\bwas blown up by\b|\bwas killed by \[?intentional game design\]?\b/i, 'explosion'],
  // magic / indirect
  [/\bwithered away\b|\bwas killed by magic\b|\bwas killed using magic\b/i, 'magic'],
  // anything with a named killer that is not one of the above is a mob (or a player) fight
  [/\bwas slain by\b|\bwas shot by\b|\bwas fireballed by\b|\bwas pummeled by\b|\bwas impaled by\b|\bwas stung to death\b|\bwas obliterated by\b|\bwas skewered by\b|\bwas killed by\b|\bwas poked to death by a sweet berry bush\b/i, 'mob']
]
// The killer's name, when the message names one: "... by Skeleton", optionally "... using <item>".
const BY_RE = /\bby\s+(.+?)(?:\s+using\s+.+)?$/i

// PURE. Returns { cause, attacker } when `text` is a death message for `username`, else null.
// `attacker` is null unless the message named one.
function parseDeathMessage (text, username) {
  const line = String(text == null ? '' : text).trim()
  if (!line || !username) return null
  // A death message opens with the bare player name. `<Animus> i died` (a chat line) never matches,
  // because the name is bracketed - which is exactly the impersonation guard we want.
  const name = String(username)
  if (line.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return null
  const rest = line.slice(name.length)
  if (!/^[\s]/.test(rest)) return null // "AnimusBot fell..." must not match username "Animus"
  for (const [re, cause] of MESSAGE_PATTERNS) {
    if (!re.test(rest)) continue
    let attacker = null
    const m = rest.match(BY_RE)
    if (m) attacker = m[1].trim().replace(/[.!]+$/, '') || null
    return { cause, attacker }
  }
  return null
}

// ---------------------------------------------------------------------------
// LAYER 2 - the damage log.
//
// A rolling window of "we lost health, and here is what the world looked like at that instant".
// It exists for the case layer 1 cannot cover (a server that suppresses death messages, a plugin
// that rewrites them, a locale that is not en_us) and it is deliberately coarse: it does not try
// to identify the killer, only the KIND of death, which is all any consumer downstream needs.
//
// Sample shape (all optional): { t, drop, hostile: { type, dist }, inWater, inLava, onFire,
//                                falling, buried, foodZero }
const DAMAGE_WINDOW_MS = 10000  // "the seconds before we died" - anything older is a different event
const RING_MAX = 24             // bounded: this is a diagnostic buffer, not a history

// PURE. Given the recent damage samples, name the most likely cause, or null when the log has
// nothing to say. Ordered by how unambiguous the reading is, and biased toward the LAST samples -
// what killed you is what was hitting you at the end, not what scratched you a minute ago.
function causeFromDamage (samples, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now()
  const win = opts.windowMs != null ? opts.windowMs : DAMAGE_WINDOW_MS
  const recent = (Array.isArray(samples) ? samples : []).filter(s => s && (s.t == null || now - s.t <= win))
  if (!recent.length) return null
  const last = recent[recent.length - 1]
  // Media first: standing in the thing that is hurting you is not ambiguous.
  if (last.inLava) return 'lava'
  if (last.onFire) return 'fire'
  if (last.inWater && last.drowning) return 'drowning'
  if (last.buried) return 'suffocation'
  // A big single hit with no mob in reach and a fall in flight reads as a fall.
  if (last.falling && last.drop >= 3) return 'fall'
  // Starvation ticks are small, repeated, and only happen at food 0.
  if (last.foodZero && recent.length >= 2 && recent.every(s => s.foodZero && s.drop <= 2)) return 'starvation'
  // A hostile in reach across the recent window: this is the common case the old classifier
  // could not represent at all. An explosion is a mob hit big enough to only be a creeper/TNT.
  const withHostile = recent.filter(s => s.hostile && s.hostile.dist != null && s.hostile.dist <= 6)
  if (withHostile.length) {
    const worst = withHostile.reduce((a, b) => (b.drop || 0) > (a.drop || 0) ? b : a)
    if ((worst.drop || 0) >= 8 && /creeper|tnt/i.test(worst.hostile.type || '')) return 'explosion'
    return 'mob'
  }
  // A ranged killer (skeleton at 12b) leaves no melee-range sample but still leaves hostiles about.
  const anyHostile = recent.find(s => s.hostile && s.hostile.type)
  if (anyHostile) return 'mob'
  return null
}

// The attacker name the damage log can offer (best-effort, used only to enrich the record).
function attackerFromDamage (samples, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now()
  const win = opts.windowMs != null ? opts.windowMs : DAMAGE_WINDOW_MS
  const recent = (Array.isArray(samples) ? samples : []).filter(s => s && s.hostile && s.hostile.type && (s.t == null || now - s.t <= win))
  if (!recent.length) return null
  return recent[recent.length - 1].hostile.type
}

// ---------------------------------------------------------------------------
// LAYER 3 + composition.

// PURE. The one entry point the death handler calls. `blockCause` is whatever today's
// classifyDeathCause returned from the cell reads - it stays the floor, so removing layers 1 and 2
// leaves behaviour exactly as it was before this module existed.
//
// Returns { cause, attacker, source } where source is 'message' | 'damage' | 'blocks', so the log
// line (and any future post-mortem) can say how confident the attribution is.
function attributeDeath ({ message, username, samples, blockCause, now } = {}) {
  const fromMsg = parseDeathMessage(message, username)
  if (fromMsg) return { cause: fromMsg.cause, attacker: fromMsg.attacker, source: 'message' }
  const fromDmg = causeFromDamage(samples, { now })
  if (fromDmg) return { cause: fromDmg, attacker: attackerFromDamage(samples, { now }), source: 'damage' }
  return { cause: blockCause || 'unknown', attacker: null, source: 'blocks' }
}

// ---------------------------------------------------------------------------
// The (impure) tracker. Installed once at spawn; keeps the ring the layer-2 reader consumes.
//
// It samples ONLY on a health DROP, so it costs nothing while the bot is healthy - the operator's
// body-first rule ([[body-first-priority]]): no polling loop, no world scan on a timer. The single
// world read it does (the nearest hostile) is over the entity table mineflayer already maintains.
const HOSTILE_RE = /zombie|skeleton|creeper|spider|enderman|witch|slime|drowned|husk|stray|phantom|pillager|vindicator|evoker|ravager|vex|blaze|ghast|piglin|hoglin|zoglin|wither|guardian|shulker|silverfish|endermite|warden|breeze|bogged/i

function nearestHostile (bot) {
  try {
    let best = null; let bd = Infinity
    const me = bot.entity && bot.entity.position
    if (!me) return null
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || !e.position) continue
      const nm = e.name || (e.kind === 'Hostile mobs' ? 'hostile' : null)
      if (!nm || !HOSTILE_RE.test(nm)) continue
      const d = me.distanceTo(e.position)
      if (d < bd) { bd = d; best = { type: nm, dist: d } }
    }
    return best
  } catch { return null }
}

function installDamageTracker (bot) {
  const ring = []
  let lastHealth = bot.health != null ? bot.health : 20
  const push = (s) => { ring.push(s); while (ring.length > RING_MAX) ring.shift() }
  bot.on('health', () => {
    const hp = bot.health != null ? bot.health : 20
    const drop = lastHealth - hp
    lastHealth = hp
    if (!(drop > 0)) return
    let inWater = false; let inLava = false; let buried = false
    try {
      const feet = bot.blockAt(bot.entity.position)
      const head = bot.blockAt(bot.entity.position.offset(0, 1, 0))
      inWater = !!(head && /water/.test(head.name))
      inLava = !!((feet && /lava/.test(feet.name)) || (head && /lava/.test(head.name)))
      // buried = a solid block where the head is (suffocation), and not one we can breathe in
      buried = !!(head && head.boundingBox === 'block')
    } catch {}
    push({
      t: Date.now(),
      drop,
      hostile: nearestHostile(bot),
      inWater,
      inLava,
      buried,
      onFire: !!(bot.entity && bot.entity.metadata && bot.entity.metadata[0] & 0x01),
      // oxygenLevel is unreliable on the live server (project memory), so drowning is asserted
      // from the head-block read plus the fact that something is damaging us while submerged.
      drowning: inWater,
      falling: !!(bot.entity && !bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.4),
      foodZero: bot.food === 0
    })
  })
  // The death message. mineflayer emits every server message as `messagestr`; death reports arrive
  // as SYSTEM messages, so this is the same stream the chat handler already reads - we just stop
  // discarding the one line that says why we died.
  let lastDeathMessage = null
  bot.on('messagestr', (text) => {
    const hit = parseDeathMessage(text, bot.username)
    if (hit) lastDeathMessage = { text: String(text), at: Date.now() }
  })
  return {
    samples: () => ring.slice(),
    // The death message is only valid for the death it describes: a stale one from three deaths
    // ago must never attribute this one, so it expires with the same window the damage log uses.
    deathMessage: (now = Date.now()) => (lastDeathMessage && now - lastDeathMessage.at <= DAMAGE_WINDOW_MS) ? lastDeathMessage.text : null,
    clear: () => { ring.length = 0; lastDeathMessage = null }
  }
}

module.exports = {
  CAUSES,
  DAMAGE_WINDOW_MS,
  RING_MAX,
  parseDeathMessage,
  causeFromDamage,
  attackerFromDamage,
  attributeDeath,
  installDamageTracker,
  nearestHostile
}
