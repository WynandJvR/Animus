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
const { graveValue, graveWorthIt, graveUrgency, graveCompare, salvageVerdict } = require('./grave-policy.js')
// #112 HAZARD_NOT_LURE: hazard memory lives in world-memory.json, NOT in this file's ledger.
// This module WRITES a hazard when it records a death and READS one to gate salvage - but it
// never owns one, so retrieving a grave (or deleting last-death.json) cannot erase danger.
const worldMemory = require('./world-memory.js')

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

// ONE-TIME SEED of hazard memory from whatever ledger exists at first load, so shipping the
// split does not blank the bot's #85 death-spot routing costs on deploy day. Seeds are marked
// already-traversed: an old ledger row is evidence that a death happened there, NOT evidence
// that the bot has since failed to get through, so it prices the box (soft, cost 40) without
// arming the hard rung or deferring salvage. The first REAL death re-arms it properly.
try {
  if (!worldMemory.hazardsSeeded()) {
    for (const d of deathLedger) {
      const rec = worldMemory.recordHazard(d, d.cause || (d.dangerous ? 'lava' : 'unknown'))
      if (rec) rec.traversedSinceDeath = true
    }
    worldMemory.markHazardsSeeded()
  }
} catch {}

// The hazard verdict for one grave: may the bot survive the medium that killed it here, and
// what is the loot worth net of that risk? Pure decision (grave-policy) over the hazard record
// (world-memory) - this file only joins the two.
function graveSalvage (d, caps) {
  try { return salvageVerdict(d, worldMemory.hazardAt(d), caps) } catch { return { go: true, why: 'no hazard data', discount: 1 } }
}

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
  // #112: the hazard write happens FIRST and unconditionally - it is the half of this record
  // that must outlive the loot. `info.cause` is classified by the death handler from grounded
  // reads at the death cell (grave-policy.classifyDeathCause).
  try { worldMemory.recordHazard(info, info.cause) } catch {}
  info.items =(Date.now() - invSnap.at < 90000) ? { count: invSnap.count, notable: invSnap.notable.slice(0, 12), build: invSnap.build || 0 } : { count: 0, notable: [], build: 0 }
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
// A TRIP THAT CANNOT REACH THE GRAVE IS THE WORLD ANSWERING (2026-08-26). Every other reason a
// grave leaves the candidate list is evidence - retrieved, dangerous, not worth it, despawned, a
// medium we cannot survive - but "I physically could not get there" was recorded NOWHERE, so a
// grave the bot cannot reach stayed top of the list and the corpse run retried forever. Live, after
// dying at the bottom of the ravine it had fallen into:
//   (cmd) recover -> couldn't get back to where i died (75,43,-2): timed out
//   (cmd) goto 75 43 -2 -> got near but couldn't settle: goto timed out (tried: pit, climb x2, nudge x3, drybreach x2, stepout)
//   ...three times in ninety seconds, food draining, and because recoveryLadder is survival-tier it
//   outranked the build the whole time, so the bot never left for the castle.
// TWO failures, not one: a single timeout can be a mob, a chunk load, a bad moment. Two says the
// route is the problem. This DEFERS like #112's salvage verdict rather than writing the grave off -
// the row and its value stay on the books, and any success clears the count - but it stops the bot
// spending its day on a hole it has already proved it cannot enter.
const GRAVE_TRIP_FAILS_MAX = 2
function noteGraveTrip (d, ok, why) {
  if (!d) return
  if (ok) { if (d.tripFails) { d.tripFails = 0; persistDeath() } return }
  d.tripFails = (d.tripFails || 0) + 1
  persistDeath()
}
function graveReachable (d) { return (d.tripFails || 0) < GRAVE_TRIP_FAILS_MAX }

function bestGrave () {
  const now = Date.now()
  // #112: `graveSalvage(d).go` is the new clause - a grave in a medium the bot cannot survive is
  // not a candidate at all. It is DEFERRED, not written off: the ledger keeps the row and the
  // value, and the verdict flips as soon as the bot proves it can get through there alive.
  const c = deathLedger.filter(d => !d.retrieved && !d.dangerous && graveWorthIt(d) && graveReachable(d) && now - (d.at || 0) < 24 * 3600 * 1000 && graveUrgency(d, now).tier !== 'expired' && graveSalvage(d).go)
  c.sort((a, b) => graveCompare(a, b, now))
  return c[0] || null
}

function unretrievedGraves () { return deathLedger.filter(d => !d.retrieved && !d.dangerous && graveWorthIt(d) && graveReachable(d) && graveSalvage(d).go).length } // only graves actually worth a trip
// The worthwhile-but-DEFERRED graves: still owned, still on the books, just behind a condition.
// The `recover` command needs these so it reports honestly instead of falling through to the
// "nothing worth going back for" branch and marking the row retrieved (which would throw the gear away).
function deferredGraves () { return deathLedger.filter(d => !d.retrieved && !d.dangerous && graveWorthIt(d) && !graveSalvage(d).go) }

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
    // #112: the row carries its SALVAGE VERDICT (go + discount). It is not dropped - the value
    // stays visible and on the books - but the schedulers filter on `salvage.go` and score the
    // grave NET of `salvage.discount` instead of pricing it as gross "free gear".
    graves.push({ x: d.x, y: d.y, z: d.z, at: d.at || 0, dist: isFinite(near) ? near : null, value: graveValue(d), dangerous: !!d.dangerous, hasGear, remainMs: u.remainMs, tier: u.tier, salvage: graveSalvage(d) })
  }
  // deathsRecent: deaths in the last 20 min, REGARDLESS of retrieved (a reclaimed grave was still a
  // death - the ratchet signal). CAVEAT: the process-restart load above drops retrieved entries, so
  // this UNDER-counts across restarts; acceptable (it only biases the degraded signature toward LESS
  // aggressive, and S5's ladder re-derives).
  const deathsRecent = led.filter(d => d && t - (d.at || 0) < 20 * 60000).length
  return { graves, deathsRecent }
}

module.exports = { persistDeath, noteGraveTrip, graveReachable, snapInventory, recordDeath, bestGrave, unretrievedGraves, worthwhileGrave, gravesSnapshot, ledger, lastDeathInfo, graveSalvage, deferredGraves, DEATH_FILE }
