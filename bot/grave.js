'use strict'
// DEATH LEDGER: what the bot was carrying when it died, where it died, and which of those
// graves is still worth going back for. Split out of commands.js unchanged.
//
// This is the STATEFUL half of the grave system - grave-policy.js holds the pure decisions
// (worth / urgency / ordering / chase gate / loot verdict) and this file owns the record.
//
// It used to be a single slot, so dying on the way to a recovery OVERWROTE the grave that
// mattered (verified live: died with full iron at 553,62,50, died again trekking back, and
// the iron grave was forgotten forever while the bot faithfully visited every worthless
// naked-death grave after it). Now every unretrieved death is kept, with a snapshot of what
// was carried, and the most VALUABLE one is recovered first.
//
// ---- TWO COUPLINGS, HANDLED RATHER THAN HIDDEN ---------------------------------------
// (1) snapInventory reports an item-count delta as verified progress. That is a one-way
//     call into telemetry.js and is fine.
// (2) recordDeath must ABORT a running gather/provision. buildAbort is commands.js's latch,
//     not this file's, so recordDeath RETURNS { abortLongOp } and commands.js sets it. The
//     alternative - reaching back into commands.js - is exactly the entanglement this split
//     exists to remove.

const fs = require('fs')
const path = require('path')
const telemetry = require('./telemetry.js') // one-way: progress touches + the active-op name
const { graveValue, graveWorthIt, graveUrgency, graveCompare } = require('./grave-policy.js')

// death recovery: where we last died + whether it's dangerous to return to (lava/fire/
// void). Set by the body's death handler; surfaced in /state so the BRAIN can decide
// whether to `recover`. Cleared/marked once retrieved. Expires so it's not stale forever.
let lastDeath = null // NEWEST death (kept for quick checks); the LEDGER below is the real record
const DEATH_FILE = process.env.DEATH_FILE || path.join(__dirname, 'last-death.json') // env-overridable (test isolation)
let deathLedger = []

function persistDeath () {
  try {
    const keep = deathLedger.filter(d => !d.retrieved).slice(-8)
    if (keep.length) fs.writeFileSync(DEATH_FILE, JSON.stringify({ deaths: keep }))
    else fs.unlinkSync(DEATH_FILE)
  } catch {}
}

try {
  const j = JSON.parse(fs.readFileSync(DEATH_FILE, 'utf8'))
  const arr = Array.isArray(j.deaths) ? j.deaths : (j && j.x != null ? [j] : []) // old single-death shape migrates
  deathLedger = arr.filter(d => d && !d.retrieved && Date.now() - (d.at || 0) < 24 * 3600 * 1000)
  lastDeath = deathLedger[deathLedger.length - 1] || null
} catch {}

// Live references for the call sites that scan/mark the ledger directly (the `recover`
// command marks a grave retrieved, the degraded signature counts recent deaths). Returning
// the live array keeps that behaviour identical - callers mutate entries in place.
function ledger () { return deathLedger }
function lastDeathInfo () { return lastDeath }

// Rolling snapshot of what the bot carries (armor slots included - items() skips them), so a
// death can record what went into the grave. Read at death time it's already unreliable.
let invSnap = { count: 0, notable: [], at: 0 }
let lastItemCount = -1 // S7 H2: total carried-item count from the previous snap (a delta = a VERIFIED inventory change). Separate from invSnap.count (consumed by the death recorder).
function snapInventory (bot) {
  try {
    const items = bot.inventory ? bot.inventory.items() : []
    const worn = []
    for (const s of ['head', 'torso', 'legs', 'feet']) { const it = bot.inventory && bot.inventory.slots[bot.getEquipmentDestSlot(s)]; if (it) worn.push(it.name) }
    if (!items.length && !worn.length) return
    const notable = items.filter(i => /_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$|_ingot$|^diamond|^emerald/.test(i.name)).map(i => i.name)
    const count = items.reduce((s, i) => s + i.count, 0) + worn.length
    // FIX #16: bulk BUILD materials (logs/planks/wood/cobble/stone) tallied so grave-worth can
    // credit a grave full of wood, not just "notable" gear - a meaningful stash below the generic
    // count>=10 bulk bar was abandoned. This tally is build-only, so junk (dirt/seeds) never trips it.
    const build = items.filter(i => /_log$|_planks$|_wood$|^cobblestone$|^stone$|^cobbled_deepslate$|^deepslate$/.test(i.name)).reduce((s, i) => s + i.count, 0)
    invSnap = { count, notable: notable.concat(worn), build, at: Date.now() }
    // H2: any total-count change (craft/withdraw/deposit/pickup/eat/toss) is verified progress.
    if (lastItemCount !== -1 && count !== lastItemCount) telemetry.touchProgress('itemDelta')
    lastItemCount = count
  } catch {}
}

// Returns { abortLongOp } - see the coupling note at the top. A death ABORTS a standalone
// gather/provision: the loop has no death handling of its own and kept "gathering" from the
// respawn point through the night (verified on test server: count went NEGATIVE, then a
// 14-death carousel). Builds handle death via markBuildInterrupted/resume; this covers the
// op/brain-issued long ops.
function recordDeath (info) {
  info.items = (Date.now() - invSnap.at < 90000) ? { count: invSnap.count, notable: invSnap.notable.slice(0, 12), build: invSnap.build || 0 } : { count: 0, notable: [], build: 0 }
  invSnap = { count: 0, notable: [], at: 0 } // consumed - the NEXT death starts naked until a new snap
  telemetry.resetProgressAnchor() // S7 H1: the respawn teleport must re-anchor cleanly (a huge displacement is not progress)
  deathLedger.push(info)
  if (deathLedger.length > 16) deathLedger.shift()
  lastDeath = info
  persistDeath()
  const act = telemetry.activityInfo()
  return { abortLongOp: !!(act && /^(gather|provision)$/.test(act.name)) }
}

// The grave worth going back for: unretrieved, reachable (not lava), urgency-then-richest first.
// (task #18: an about-to-despawn grave outranks a richer one that can still wait; expired graves -
// past 1.5x the despawn window - drop off the candidate list, but are NEVER auto-marked retrieved:
// only a physical visit that confirms absence marks 'gone', or the 24h ledger expiry reaps them.)
function bestGrave () {
  const now = Date.now()
  const c = deathLedger.filter(d => !d.retrieved && !d.dangerous && graveWorthIt(d) && now - (d.at || 0) < 24 * 3600 * 1000 && graveUrgency(d, now).tier !== 'expired')
  c.sort((a, b) => graveCompare(a, b, now))
  return c[0] || null
}

function unretrievedGraves () { return deathLedger.filter(d => !d.retrieved && !d.dangerous && graveWorthIt(d)).length } // only graves actually worth a trip

// Is there a WORTHWHILE, reachable death-drop to go recover right now? The respawn handler
// fires recovery on this BEFORE re-mining from scratch (gear-up-critical: it kept dropping
// iron/tools then re-mining instead of walking back for them). Returns {x,y,z,items} or null.
function worthwhileGrave () { const g = bestGrave(); return g ? { x: g.x, y: g.y, z: g.z, items: (g.items && g.items.notable) || [], value: graveValue(g) } : null }

// GRAVES SNAPSHOT (S4): export the death ledger in the plain-data shape the pure scheduler
// consumes (scheduler.pickJob / admissible read snap.graves[]). Walks the ledger with the SAME
// worth+age filter as bestGrave - but INCLUDING dangerous graves (the shape carries the flag;
// the scheduler filters on it) - and the exact min(botDist, homeDist) XZ math of
// shouldChaseGrave. `ledger` defaults to the module deathLedger; the parameter is the
// OFFLINE-TEST seam (inject a fixture array, no fs / recordDeath ceremony). `now` defaults to
// Date.now(). Never throws - a malformed entry is skipped defensively by the field reads.
function gravesSnapshot ({ pos, home, now, ledger: injected } = {}) {
  const led = Array.isArray(injected) ? injected : deathLedger
  const t = now != null ? now : Date.now()
  const graves = []
  for (const d of led) {
    if (!d || d.retrieved || !graveWorthIt(d) || t - (d.at || 0) >= 24 * 3600 * 1000) continue
    const u = graveUrgency(d, t) // task #18 despawn budget (safe when GRAVE_URGENT off / clock unset)
    if (u.tier === 'expired') continue // past 1.5x the despawn window - stop chasing a ghost (never auto-marked retrieved)
    const dBot = pos ? Math.hypot(d.x - pos.x, d.z - pos.z) : Infinity
    const dHome = home ? Math.hypot(d.x - home.x, d.z - home.z) : Infinity
    const near = Math.min(dBot, dHome) // exact min(bot, home) of shouldChaseGrave; scheduler skips a null-dist grave
    const notable = (d.items && d.items.notable) || []
    const hasGear = notable.some(n => /^(iron|diamond|netherite|golden)_|_(helmet|chestplate|leggings|boots)$/.test(n)) // verbatim realGear regex from graveWorthIt
    graves.push({ x: d.x, y: d.y, z: d.z, at: d.at || 0, dist: isFinite(near) ? near : null, value: graveValue(d), dangerous: !!d.dangerous, hasGear, remainMs: u.remainMs, tier: u.tier })
  }
  // deathsRecent: deaths in the last 20 min, REGARDLESS of retrieved (a reclaimed grave was still a
  // death - the ratchet signal). CAVEAT: the process-restart load above drops retrieved entries, so
  // this UNDER-counts across restarts; acceptable (it only biases the degraded signature toward LESS
  // aggressive, and S5's ladder re-derives).
  const deathsRecent = led.filter(d => d && t - (d.at || 0) < 20 * 60000).length
  return { graves, deathsRecent }
}

module.exports = { persistDeath, snapInventory, recordDeath, bestGrave, unretrievedGraves, worthwhileGrave, gravesSnapshot, ledger, lastDeathInfo, DEATH_FILE }
