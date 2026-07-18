'use strict'
// Action layer ("what the body can do"). Every command is plain text in,
// text result out, so the same surface works for a human, for Claude (curl),
// and for a local model. Building uses server commands (/fill, /setblock) -
// the bot is op+creative on the lab server, which makes structures reliable
// instead of fighting physical block-placement reach/inventory rules.

const fs = require('fs')
const path = require('path')
const { goals, Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const memory = require('./memory.js') // persistent named waypoints
const schematic = require('./schematic.js') // download/parse + survival physical building
const provision = require('./provision.js') // BOM -> gather/craft plan + execution
const resources = require('./resources.js') // unified resource model: pack + verified chests, withdraw>craft>gather
const mining = require('./mining.js') // pure tool-durability model (toolUsesLeft) for the freshPickaxes computation
const navigate = require('./navigate.js') // unified navigation: ONE goto + the full stuck-recovery ladder
const planner = require('./planner.js') // re-planning goal driver (slice 1: gear-up behind the planarmor/PLANNER_GEARUP seam)
const arbiter = require('./arbiter.js') // priority body-ownership (sticky-follow defers to a running maneuver)
const routeMem = require('./route-mem.js') // PURE route/wedge geometry: replay proven treks + soft-steer around learned wedges (semantic-world-map slice 1)
const hutModel = require('./hut-model.js') // PURE self-structure model + #37 repair decision (decideHutRepair) / tolerant classifier (cellMismatch)
const navLeg = require('./nav-leg.js') // PURE leg-planning core (NAV Phase B): Y-banded surface-trek leg goal so travelFar legs can't ride a cave 45b down to lava
const gravePolicy = require('./grave-policy.js') // PURE grave decisions (worth/urgency/order/chase-gate/loot-verdict); the LEDGER itself stays here
const { graveValue, graveWorthIt, graveUrgency, graveUrgencyRank, graveCompare, shouldChaseGrave, graveLootVerdict } = gravePolicy
const perception = require('./perception.js') // read-only world/self observation; state() below stitches these with the records THIS file owns
const { HOSTILE, facing, summariseEntities, biomeName, nearestThreat, nearbyPlayers, wornArmor, isWaterlogged, hazards } = perception
const GoalNearXZBanded = navLeg.makeGoalNearXZBanded(goals.Goal) // Y-aware drop-in for goals.GoalNearXZ (NAV_HAZARD_LEGS)
const NAV_HAZARD_LEGS = process.env.NAV_HAZARD_LEGS !== '0' // NAV Phase B (default ON): Y-band the trek leg goal + price lava in travelMovements; =0 => today's Y-blind GoalNearXZ + no lava cost, byte-for-byte
const WATER_SAFE = process.env.WATER_SAFE !== '0' // task #45 (default ON): price OVER-THE-HEAD water in travelMovements so legs route around a pond aquifer (shallow water stays free -> farm/fishing reachable); =0 => no water cost, byte-for-byte
// ---- NAV Phase C flags (DESIGN-nav-overhaul.md §3 Phase C = DESIGN-navigation-redesign §5 P2-4) ----
const NAV_LEG_PROBE = process.env.NAV_LEG_PROBE !== '0' // Phase C / §5-P2 (default ON): pre-flight getPathTo probe of a bearing leg; noPath => rotate ±60/±120 and take the first reachable (SOFT). =0 => today byte-for-byte
const NAV_WAYPOINT_GRAPH = process.env.NAV_WAYPOINT_GRAPH !== '0' // Phase C / §5-P3 (default ON): compose proven route segments over a waypoint graph before whole-route replay / bearing. =0 => graph unused, today byte-for-byte
const NAV_LADDER_DIET = process.env.NAV_LADDER_DIET === '1' // Phase C / §5-P4 DEFAULT OFF: retire the superseded wedge soft-steer only after the design's >=1wk soak; unset => today byte-for-byte
const PROBE_MS = Math.max(200, parseInt(process.env.NAV_PROBE_MS || '1000', 10)) // bounded getPathTo budget per candidate (success/noPath resolve fast; only a far `timeout` costs the full budget)
let dbgSink = null // injected by index.js: debug lines persist to logs/bot-events.log
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[build] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

// HOSTILE (the entity-name test for attack/defend and auto-defense) now lives in
// perception.js and is destructured above - one canonical list instead of a local copy.

// remembered spot of the last block/tree broken, so "plant where you chopped" works
let lastBrokeAt = null

// schematic build state (one bot per process, so module-level is fine).
// loadedSchem: the parsed schematic ready to build; building: a build is running;
// buildAbort: set by `stop` to halt an in-progress build cleanly.
let loadedSchem = null
let building = false
// #37 non-destructive hut repair: in-memory progress latch so the destructive rebuild path
// can never fire twice without `bad` decreasing (decideHutRepair reads lastBad/lastAction).
// hutPendingRestore is set only when a rebuild couldn't re-deposit the treasury into a chest -
// the next camp pass runs restoreBank() FIRST, before any repair logic.
let hutRepairLatch = { lastBad: null, lastAction: null, ts: 0 }
let hutPendingRestore = null
let buildAbort = false // set by `stop`; watched by schematic builds AND provision runs
// S1 HOTFIX (REDESIGN §3.4 / invariant I1): let an admissible SURVIVAL command PREEMPT a body
// hold without cancelling operator intent. Unlike the `stop` command it sets ONLY the abort
// latch - the current boundedHold/secureFood/gather unwinds, but resumeJob/persistedResume are
// left intact so an interrupted build resumes via its normal resume path. `recover` ignores
// buildAbort entirely (its travels use isStopped:()=>false), so this cleanly frees the body for
// the survival move without breaking the recover it is preempting for.
function preemptForSurvival () { buildAbort = true }
// #41 RESILIENT_RECOVERY (P0): the post-death recovery LATCH. Set on bot.on('death'); while set,
// recovery OWNS the bot and OUTRANKS build-resume (resumeBuild waits, kept on disk), recovery is
// crisis-grade unconditionally, and recovery-class commands are not muzzled by the busy-gate. Cleared
// ONLY when recoveryReady (P4, via provision.recoveryReadyNow / the scheduler tick). RESILIENT_
// RECOVERY=0 -> reads return false (inert) = today byte-for-byte. Stamps set-time for the P4 ceiling.
let postDeathRecovery = false
let postDeathRecoveryAt = 0
function setPostDeathRecovery (v) { if (v) { if (!postDeathRecovery) postDeathRecoveryAt = Date.now() } else postDeathRecoveryAt = 0; postDeathRecovery = !!v }
function isPostDeathRecovery () { return process.env.RESILIENT_RECOVERY !== '0' && postDeathRecovery }
function clearPostDeathRecovery () { postDeathRecovery = false; postDeathRecoveryAt = 0 }
function postDeathRecoveryHeldMs () { return postDeathRecovery ? Date.now() - postDeathRecoveryAt : 0 }
let recovering = false // recover mutex - concurrent recovers raced inventory diffs (live)
let provisioning = false
let escaping = false   // true while digging UP out of a cave - the flee reflex must not
                       // hijack the pathfinder sideways (rising IS the escape from mobs)
// sticky-follow: who the bot was told to follow. Persists across the brain briefly
// switching tasks (attack/goto/scan replace the follow goal), so a body-side reflex
// can resume trailing them once idle. Cleared by `stop` (or a new follow retargets).
let followTarget = null
// death recovery: where we last died + whether it's dangerous to return to (lava/fire/
// void). Set by the body's death handler; surfaced in /state so the BRAIN can decide
// whether to `recover`. Cleared/marked once retrieved. Expires so it's not stale forever.
let lastDeath = null // NEWEST death (kept for quick checks); the LEDGER below is the real record
// Death LEDGER, persisted to disk. It used to be a single slot - so dying on the way to a
// recovery OVERWROTE the grave that mattered (verified live: died with full iron at 553,62,50,
// died again trekking back, and the iron grave was forgotten forever while the bot faithfully
// visited every worthless naked-death grave after it). Keep every unretrieved death, with a
// snapshot of what was carried, and recover the most VALUABLE one first.
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
// Rolling snapshot of what the bot carries (armor slots included - items() skips them), so a
// death can record what went into the grave. Read at death time it's already unreliable.
let invSnap = { count: 0, notable: [], at: 0 }
let lastItemCount = -1 // S7 H2: total carried-item count from the previous snap (a delta = a VERIFIED inventory change). Separate from invSnap.count (consumed by the death recorder).
let progAnchor = null  // S7 H1: the position the bot last made 8b of real progress from (anti-spin anchor; reset on respawn)
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
    if (lastItemCount !== -1 && count !== lastItemCount) touchProgress('itemDelta')
    lastItemCount = count
  } catch {}
}
function recordDeath (info) {
  info.items = (Date.now() - invSnap.at < 90000) ? { count: invSnap.count, notable: invSnap.notable.slice(0, 12), build: invSnap.build || 0 } : { count: 0, notable: [], build: 0 }
  invSnap = { count: 0, notable: [], at: 0 } // consumed - the NEXT death starts naked until a new snap
  progAnchor = null // S7 H1: the respawn teleport must re-anchor cleanly (a huge displacement is not progress)
  deathLedger.push(info)
  if (deathLedger.length > 16) deathLedger.shift()
  lastDeath = info
  persistDeath()
  // A death ABORTS a standalone gather/provision: the loop has no death handling of its
  // own and kept "gathering" from the respawn point through the night (verified on test
  // server: count went NEGATIVE, then a 14-death carousel). Builds handle death via
  // markBuildInterrupted/resume; this covers the op/brain-issued long ops.
  if (activity && /^(gather|provision)$/.test(activity.name)) { buildAbort = true }
}
// graveValue / graveWorthIt / graveUrgency / graveUrgencyRank / graveCompare now live in
// grave-policy.js (pure, destructured at the top of this file). The LEDGER stays here.
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
// shouldChaseGrave (the SAFE+FED survival gate for a corpse run) now lives in grave-policy.js.
// graveLootVerdict (did the loot attempt genuinely empty the grave) now lives in grave-policy.js.
// GRAVES SNAPSHOT (S4, DESIGN §5): export the death ledger in the plain-data shape the pure
// scheduler consumes (scheduler.pickJob / admissible read snap.graves[]). Walks the ledger with
// the SAME worth+age filter as bestGrave - but INCLUDING dangerous graves (the shape carries the
// flag; the scheduler filters on it) - and the exact min(botDist, homeDist) XZ math of
// shouldChaseGrave. `ledger` defaults to the module deathLedger; the parameter is the OFFLINE-TEST
// seam (inject a fixture array, no fs / recordDeath ceremony). `now` defaults to Date.now().
// Never throws - a malformed entry is skipped defensively by the field reads.
function gravesSnapshot ({ pos, home, now, ledger } = {}) {
  const led = Array.isArray(ledger) ? ledger : deathLedger
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
// activityInfo (S4, DESIGN §5): a one-liner over the module `activity` record (set by beginActivity)
// so schedulerState can read the active op's name/detail/startedAt WITHOUT building the heavyweight
// state(bot) snapshot (blockAtCursor/entity summaries) on every tick. null when nothing is running.
function activityInfo () { return activity ? { name: activity.name, detail: activity.detail, startedAt: activity.startedAt } : null }

// auto-resume: the build to pick back up after a death interrupts it. autoBuild
// re-provisions whatever we lost and Build diffs world-vs-schematic, so resuming just
// finishes the missing blocks. Kept across a death; cleared on finish or `stop`.
let resumeJob = null       // { schem, at }
let resumeAnnounced = false // "back online - picking up my build" is said ONCE per process (a genuine reconnect), NOT on every 2-min re-arm retry (which spammed it while survival kept preempting the build)
let buildInterrupted = false
let resumeDeaths = 0 // consecutive deaths since the resume job was set / bot last reached the site
let spawnSuspect = false // a respawn landed far from the remembered bed - the server spawn anchor is WRONG
// PERSISTED via provision (world-memory): the RAM flag died with every restart/deploy
// mid-crisis, so the carousel kept spinning across reconnects. Cleared by any real
// spawn-setting action (provision.rememberBed).
function flagSpawnSuspect () { spawnSuspect = true; try { provision.setSpawnSuspect(true) } catch {} }
function spawnIsSuspect () { return spawnSuspect || !!(provision.isSpawnSuspect && provision.isSpawnSuspect()) }
let buildProgress = null // REAL build progress for /state - the brain must answer from this, not vibes
const RESUME_MAX_DEATHS = parseInt(process.env.RESUME_MAX_DEATHS || '4', 10)
// BUILD PERSISTENCE (DESIGN-build-persistence.md): stop = PAUSE not destroy; only an
// operator cancelbuild (or a REAL finish) deletes a saved build. STOP_KEEPS_BUILD=0
// restores today's destructive behavior at every touched site (BRANCH_MINE=0 convention).
const STOP_KEEPS_BUILD = process.env.STOP_KEEPS_BUILD !== '0'
const RESUME_HOLD_MS = parseInt(process.env.RESUME_HOLD_MS || '900000', 10) // pause hold before autonomy resumes (15min)
const SUPERVISOR_RESUME_HOLD_MS = parseInt(process.env.SUPERVISOR_RESUME_HOLD_MS || '60000', 10) // a supervisor UNSTICK (frozen-vitals nudge: stop->recover) pauses only briefly, not the full operator 15min
let cancelArmedAt = 0 // two-step cancelbuild confirm window (ms epoch of the arm)

// ---- observability: what the body is DOING, how the last long op ENDED, and whether
// it's WEDGED. The brain reads /state to make high-level calls; without these a stuck
// or failed body looks identical to a working one, so the brain re-issues the same
// doomed command and idles up to a heartbeat before noticing. These surface enough for
// the brain to change approach - the low-level recovery stays body-side.
let activity = null    // { name, detail, startedAt } - a long op running RIGHT NOW
let lastOutcome = null // { action, ok, detail, at } - how the last long op ended
function beginActivity (name, detail) { activity = { name, detail: detail || '', startedAt: Date.now() }; touchProgress('begin:' + name) } // S7: a just-started job is at zero idle - a stale clock must never insta-fail it
// Record an outcome the brain should NOTICE: any FAILURE, a DETACHED flow (build/
// provision/autobuild resolve after /cmd already returned, so their result never
// reaches the brain otherwise), or anything that ran > 45s (likely outlived the brain's
// 60s /cmd fetch). Short successful awaited commands already reach the brain via the
// /cmd reply + history, so we skip those to avoid redundant wakes.
function endActivity (ok, detail, opts = {}) {
  const a = activity
  if (a && (!ok || opts.detached || Date.now() - a.startedAt > 45000)) {
    lastOutcome = { action: a.name + (a.detail ? ' ' + a.detail : ''), ok: !!ok, detail: String(detail || '').slice(0, 100), at: Date.now() }
  }
  // TRAINING DATA (episodes): the body's autonomous task-level competence - gathers,
  // recoveries, travels, builds - with real outcomes and durations. The brain dataset
  // only captures brain choices; this captures what the BODY can do (the richer skill).
  if (a) {
    try { pushOutcomeRing(a.name + (a.detail ? ' ' + a.detail : ''), ok, detail, (!ok && /\(stopped\)/.test(String(detail || '')))) } catch {} // task #34: feed the outcome ring (successes too - they reset a repeat-fail streak); #49: a "(stopped)" fail is a watchdog/preempt-induced PAUSE, not a behavioral failure -> tag selfAbort
    try {
      const b = globalBot
      fs.appendFile(EPISODE_LOG, JSON.stringify({
        t: Date.now(), episode: a.name, detail: String(a.detail || '').slice(0, 60), ok: !!ok,
        note: String(detail || '').slice(0, 100), ms: Date.now() - a.startedAt,
        hp: b && b.health != null ? Math.round(b.health * 10) / 10 : null,
        food: b && b.food != null ? b.food : null,
        pos: b && b.entity ? { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) } : null
      }) + '\n', () => {})
    } catch {}
  }
  if (a && a.name === 'autobuild') jobList = null // the job's checklist dies with the job
  activity = null
}
const EPISODE_LOG = process.env.EPISODE_LOG || path.join(__dirname, 'body-episodes.jsonl')
let globalBot = null // set once by trackTick; lets endActivity snapshot vitals without threading bot everywhere
// Let non-command code (reflexes) record an outcome directly (e.g. a wedged follow).
function recordOutcome (action, ok, detail) { lastOutcome = { action, ok: !!ok, detail: String(detail || '').slice(0, 100), at: Date.now() }; try { pushOutcomeRing(action, ok, detail, /^watchdog:/.test(String(action || ''))) } catch {} } // task #34: also feed the bounded outcome ring; #49: watchdog:* records are the watchdog's own verdict -> tag selfAbort

// ---- S7 FORWARD-PROGRESS LATCH (DESIGN-S7-watchdog) --------------------------------------
// A module-level heartbeat advanced ONLY by VERIFIED progress via touchProgress (an anchored 8b
// displacement, an item-count delta, a pathfix-verified place/break, a collected smelt output, a
// completed rung/step, a regen tick, a valid pass of a DECLARED hold). Read by
// provision.activeJobInfo -> the 5s watchdog. One object write per touch; a job spinning/hung in
// place touches NOTHING - that is the whole point. WATCHDOG=0 leaves these as inert timestamps.
// task #34 (cycle detector): a MONOTONIC workCount, advanced ONLY by a WORK tag (item/block/smelt/
// heal/rung/chore progress - never by movement or a fresh dispatch). It is the chest<->build shuttle
// guard: the oscillation predicate requires ZERO work touches across its whole window, so real
// back-and-forth work (which always moves an item or a block) can never be flagged. Inert unless the
// watchdog's cycle detector reads it (like S7's touchProgress: cheap + unread == byte-identical).
const CYCLE_WORK_TAGS = new Set(['itemDelta', 'placed', 'broke', 'smelt', 'regen', 'ladderRung', 'maintStep'])
let bodyProgress = { at: Date.now(), by: 'boot', stalled: false, workCount: 0 }
function touchProgress (tag) { const w = bodyProgress.workCount || 0; bodyProgress = { at: Date.now(), by: tag || '', stalled: false, workCount: CYCLE_WORK_TAGS.has(tag) ? w + 1 : w } } // any touch clears stalled; WORK tags also bump workCount
function progressInfo () { return bodyProgress }
function markStalled () { bodyProgress.stalled = true } // the nudge's blockedOn='stalled' marker; cleared by the next touch
function _resetProgress () { bodyProgress = { at: Date.now(), by: 'reset', stalled: false, workCount: 0 } } // test seam (house pattern: _setNow/_setMaintaining)

// ---- OUTCOME RING (task #34): a bounded 16-entry history of how recent long ops ENDED, so the
// repeat-fail predicate can SEE the same failure recur. The architecture records each failure into
// the single-record `lastOutcome` and immediately forgets it (that is the "why is this even possible"
// gap); this ring is the memory. Pushed from the two EXISTING recording paths (endActivity /
// recordOutcome) + the scheduler's runJob catch. Each record: { t, action, ok, failClass, cell } where
// failClass = detail lowercased with digits/coords stripped (so "door at 433,62,112" repeats match)
// and cell = position floored to 4b. lastOutcome / the brain's lastResult are UNCHANGED (additive).
const CYCLE_OUTCOME_MAX = 16
let recentOutcomesRing = []
function cycleFailClass (detail) { return String(detail || '').toLowerCase().replace(/-?\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim() }
function cycleCellOf () { const b = globalBot; const p = b && b.entity && b.entity.position; if (!p) return null; return { x: Math.floor(p.x / 4) * 4, y: Math.floor(p.y / 4) * 4, z: Math.floor(p.z / 4) * 4 } }
function pushOutcomeRing (action, ok, detail, selfAbort) {
  recentOutcomesRing.push({ t: Date.now(), action: String(action || ''), ok: !!ok, failClass: ok ? '' : cycleFailClass(detail), cell: cycleCellOf(), selfAbort: !!selfAbort }) // #49: selfAbort tags watchdog/preempt-induced "(stopped)" pauses; additive + inert unless index.js filters on it
  if (recentOutcomesRing.length > CYCLE_OUTCOME_MAX) recentOutcomesRing.shift()
}
function recentOutcomes () { return recentOutcomesRing }

// ---- JOB CHECKLIST (operator order: a goal gets a CHECKLIST and is worked step by
// step - only survival may interrupt). Observational, not a scheduler: each phase of a
// job announces itself, so the flight recorder and /state always show exactly which
// step the job is on ("what is it doing" is never a guess). Cleared when the autobuild
// activity ends; each step's own code still decides whether it applies (no-op = quick).
let jobList = null // { steps: [names], current, startedAt }
const JOB_STEPS = ['travel to site', 'survey the site', 'basic tools', 'stone pickaxe',
  'camp: chest/furnace/bed', 'camp: safehouse hut', 'camp: bank into hut', 'camp: wheat farm', 'armor up', 'gather materials', 'build']
function checklistBegin (steps) { jobList = { steps: steps.slice(), current: null, startedAt: Date.now() } }
function checklistStep (name) {
  if (!jobList) return
  jobList.current = name
  dbg(`[job] step ${jobList.steps.indexOf(name) + 1}/${jobList.steps.length}: ${name}`)
}

// Stuck detection: the body is TRYING to get somewhere but making no progress. Driven
// by index.js on a 1s tick. "Trying" = a non-follow pathfinder goal is set, OR a travel/
// gather/come/recover activity is running. "No progress" = moved < 1.5 blocks (3-D, so a
// climb-out counts as progress) over the trailing ~12s. Excluded so we don't cry wolf:
// operator builds (isBusy - they legitimately stand still and self-recover), cave-escape
// climbs (escaping), active digs (targetDigBlock IS progress), and follow (a stationary
// player is not "stuck" - the leash reflex owns that). Surfaced in /state.stuck.
let posHist = []       // ring of { x, y, z, t }
let stuckSince = 0
let tryingSince = 0    // when the CURRENT move attempt began (goal/activity became active)
const STUCK_WINDOW_MS = 12000
const STUCK_DIST = 1.5
function trackTick (bot) {
  globalBot = bot // vitals reference for the episode logger
  snapInventory(bot) // rolling carried-items snapshot - stamps death records (grave value)
  const ent = bot.entity
  if (!ent || !ent.position) { stuckSince = 0; tryingSince = 0; posHist = []; return }
  const now = Date.now()
  const p = ent.position
  posHist.push({ x: p.x, y: p.y, z: p.z, t: now })
  while (posHist.length && now - posHist[0].t > STUCK_WINDOW_MS + 2000) posHist.shift()
  // S7 H1 (before the isBusy early-return below - busy bodies are exactly who we watch): anchored
  // 8b-displacement heartbeat. The anchor advances ONLY when the bot gets 8 blocks from where it
  // last made progress, so a bot spinning/bobbing/pacing inside an 8b pocket NEVER touches
  // (displacement-from-anchor, not path length) - the anti-spin is by construction. Cost: one hypot/s.
  if (!progAnchor) progAnchor = { x: p.x, y: p.y, z: p.z }
  else if (Math.hypot(p.x - progAnchor.x, p.y - progAnchor.y, p.z - progAnchor.z) >= 8) { touchProgress('moved8b'); progAnchor = { x: p.x, y: p.y, z: p.z } }
  const goal = bot.pathfinder && bot.pathfinder.goal
  const following = goal && goal.constructor && goal.constructor.name === 'GoalFollow'
  const trying = (goal && !following) || (activity && /^(travel|gather|come|recover)$/.test(activity.name))
  if (!trying || bot.targetDigBlock || isBusy() || escaping) { stuckSince = 0; tryingSince = 0; return }
  if (!tryingSince) tryingSince = now // just started this attempt - clock starts NOW, so idle time
  // before the move began (pathfinding takes a second or two) never counts as "stuck".
  if (now - tryingSince < STUCK_WINDOW_MS) return // give the attempt a full window to show progress
  const cutoff = Math.max(now - STUCK_WINDOW_MS, tryingSince)
  const old = posHist.find(h => h.t >= cutoff)
  if (!old) return
  const moved = Math.hypot(p.x - old.x, p.y - old.y, p.z - old.z)
  if (moved < STUCK_DIST) { if (!stuckSince) stuckSince = now }
  else stuckSince = 0
}

// Progress chatter from a long build/provision run calls bot.chat DIRECTLY (bypassing
// the normal chat gate), so it spammed "smelting 5/96... 7/96..." every ~20s. Wrap the
// say callback so routine progress is at most one line per ~40s, while IMPORTANT lines
// (asking for a material, errors, "done", setup) always get through.
// Build/provision progress is LOG-FIRST: the GUI's live panel streams the log, and
// players don't want a play-by-play (verified live: "need stone: X/Y" matched the old
// \bneed\b important-bypass EVERY material round and flooded public chat on the castle
// run). Chat now gets only lines that need a PLAYER (asking for materials/help) plus at
// most one progress heartbeat per BUILD_CHAT_MS (default 10 min) so watchers know it's
// alive. Terminal results (done/error/stopped) are bot.chat'ed directly by the callers.
let logFn = (msg) => { try { console.log(msg) } catch {} }
function setLogger (fn) { logFn = fn } // index.js injects note() so say lines reach /log
const CHAT_NEEDS_PLAYER = /drop (some|a few|it)|by me\?|can'?t (obtain|get) |giving up|keep dying|skipping it/i
function throttledSay (bot, minGapMs = parseInt(process.env.BUILD_CHAT_MS || '600000', 10)) {
  let last = 0
  return (msg) => {
    const s = String(msg)
    logFn(`(build) ${s}`)
    const now = Date.now()
    if (!CHAT_NEEDS_PLAYER.test(s) && now - last < minGapMs) return
    last = now
    bot.chat(s.slice(0, 256))
  }
}

// pathfinder.goto with a hard deadline. An unreachable target (a player who flew
// somewhere unpathable, an item across a ravine) can otherwise hang goto FOREVER,
// and because the brain awaits each /cmd, that one stuck call freezes the WHOLE
// brain loop with no recovery. Racing a timer + cancelling the goal turns "the bot
// went catatonic" into a normal "couldn't reach" result that the caller handles.
function gotoTimed (bot, goal, ms = 20000) {
  return navigate.gotoOnce(bot, goal, ms) // the one shared implementation (navigate.js)
}

// goto WITH the full recovery ladder (door-assist, pit-escape, climb-out, nudge). The
// old version bolted door-assist alone onto a failed goto; navigateTo applies the whole
// consistent toolkit and resumes after reflex interruptions ("goal was changed").
async function gotoTimedDA (bot, goal, ms = 20000) {
  await navigate.navigateTo(bot, goal, { timeoutMs: ms })
}

// Robust "walk to a player". A single GoalNear gives up the instant no exact path
// exists (walled off, across water, too far to path in one shot), which reads as the
// bot "running into a wall and freezing". Instead: try to arrive exactly, but on
// failure progressively accept getting as CLOSE as reachable, re-reading the player's
// live position each try (they keep moving). Doors are opened en route (setupMovements:
// canOpenDoors) and we still never dig - so this can't grief.
async function comeToPlayer (bot, name, deadlineMs = 30000) {
  const started = Date.now()
  let lastErr = 'no path'
  // Always aim to get RIGHT NEXT to them (range 2). A wide accept-radius is tempting
  // for "get as close as you can", but it lets the bot stop at whatever wall is nearest
  // as-the-crow-flies ("close enough") instead of taking the real route through a door -
  // that was the "ran to the glass" bug. Small range forces the actual path. We just
  // retry with fresh compute + their live position; doors are opened en route, no digging.
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = findPlayer(bot, name)
    if (!t) return `lost sight of ${name || 'player'}`
    const remaining = deadlineMs - (Date.now() - started)
    if (remaining < 2000) break
    const p = t.position
    try {
      // full recovery ladder per attempt: the player may be indoors (door-assist) or the
      // bot may be starting from a pit/cave - the same rescues as every other flow.
      await navigate.navigateTo(bot, new goals.GoalNear(p.x, p.y, p.z, 2), { timeoutMs: Math.min(remaining, 15000), deadlineMs: remaining, label: 'come' })
      return `arrived at ${name || 'player'}`
    } catch (e) {
      lastErr = e.message
      await new Promise(r => setTimeout(r, 500)) // let them move / world settle, then retry
    }
  }
  const cur = findPlayer(bot, name)
  const d = cur ? Math.round(bot.entity.position.distanceTo(cur.position)) : '?'
  return `couldn't reach ${name || 'player'} (~${d} blocks off): ${lastErr}. i won't smash blocks - clear a path or leave a door open`
}

// Long-distance travel. A single pathfinder goal can't reach a target hundreds of
// blocks away: chunks past view distance aren't loaded (no terrain to path through)
// and A* gives up before searching that far. So we WALK there in stages - repeatedly
// path ~32 blocks toward the target (which streams in fresh chunks as we go) until
// we're close. GoalNearXZ ignores Y, so unknown terrain height on each leg doesn't
// make it unreachable. Returns { ok, reason, dist }. Honors an isStopped() abort.
// Blocks the bot can bridge/pillar with. Count how many it's carrying so travel can
// top up (gather dirt) before setting off, so a ravine/water gap can't strand it.
const BRIDGE_MATERIALS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'gravel', 'stone', 'dirt_path', 'andesite', 'granite', 'diorite', 'netherrack', 'coarse_dirt']
function bridgingBlockCount (bot) {
  const items = bot.inventory ? bot.inventory.items() : []
  return items.filter(i => BRIDGE_MATERIALS.includes(i.name)).reduce((n, i) => n + i.count, 0)
}


async function travelFar (bot, dest, opts = {}) {
  const arrive = opts.arrive || 16       // horizontal "close enough" to hand off
  const hop = opts.hop || 32             // per-leg distance (well within view distance)
  // Scale the deadline with distance (~2.5s/block + a 5-min floor). A fixed 5 min timed out
  // a 600-block trek right at the surface, killing the whole build request; the survival/climb
  // time is already credited out below so a legit slow trek isn't punished.
  const d0 = (bot.entity && bot.entity.position) ? Math.hypot(dest.x - bot.entity.position.x, dest.z - bot.entity.position.z) : 0
  const deadlineMs = opts.deadlineMs || Math.max(300000, Math.round(d0 * 2500))
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const start = Date.now()
  let lastD = Infinity
  let stalls = 0
  let gathers = 0
  // ROUTE-REUSE + WEDGE-MEMORY (semantic-world-map slice 1): replay a proven trek + learn
  // this one. Waypoint choice ONLY - the recovery ladder / reflexes / survival branch below
  // are untouched. Crumb collection PAUSES during survival/surfaceOut (a >40b gap discards
  // the recording) so a shelter/food detour never gets baked into the reusable line.
  const startPos = (bot.entity && bot.entity.position) ? { x: bot.entity.position.x, z: bot.entity.position.z } : { x: dest.x, z: dest.z }
  const crumbs = [{ x: startPos.x, z: startPos.z }]
  let lastCrumb = crumbs[0]
  let recording = true
  const pushCrumb = q => {
    if (!recording) return
    const gap = Math.hypot(q.x - lastCrumb.x, q.z - lastCrumb.z)
    if (gap > 40) { recording = false; return } // a >40b jump = a survival/climb detour - don't bake it into the line
    if (gap >= 8) { lastCrumb = { x: q.x, z: q.z }; crumbs.push(lastCrumb) }
  }
  // NAV Phase C leg-target source (priority: graph plan > whole-route replay > bearing+probe).
  let graphPlan = NAV_WAYPOINT_GRAPH ? provision.planTrekRoute(startPos, { x: dest.x, z: dest.z }) : null
  if (graphPlan) dbg('travel: composed a ' + graphPlan.pts.length + '-node graph route to ' + Math.round(dest.x) + ',' + Math.round(dest.z))
  let replay = graphPlan ? null : provision.recallRoute(startPos, { x: dest.x, z: dest.z })
  if (replay) dbg('travel: replaying a proven ' + replay.pts.length + '-pt route to ' + Math.round(dest.x) + ',' + Math.round(dest.z))
  let climbs = 0
  let lastSurvival = 0  // throttle the per-leg survival check
  let climbTimeMs = 0   // time spent digging out of caves / sheltering - doesn't count against the travel clock
  // Are we buried in a cave WELL below the (surface) target? We only ever climb for this -
  // an open valley/ravine below the target (can see sky) is fine to just walk through.
  const buried = () => opts.climbOut !== false && bot.entity &&
    bot.entity.position.y < dest.y - 6 && provision.hasSolidCeiling(bot)
  // Dig straight up to the surface. Holds off the sideways flee reflex (rising IS the
  // escape) and doesn't bill the climb against the travel clock. Returns true if we rose.
  const surfaceOut = async (reason) => {
    if (climbs >= 8) return false
    say(reason)
    const cs = Date.now(); const yBefore = Math.floor(bot.entity.position.y)
    escaping = true
    try { await provision.climbToSurface(bot, Math.floor(dest.y), { isStopped }) }
    catch { /* couldn't cut up from here */ } finally { escaping = false }
    climbTimeMs += Date.now() - cs
    bot.pathfinder.setMovements(travelMovements(bot))
    climbs++
    const gained = Math.floor(bot.entity.position.y) > yBefore
    if (!gained) climbs = 8 // truly boxed in - stop retrying so we don't spin forever
    return gained
  }
  // Cross-country movement: BRIDGE gaps/ravines and pillar with the cheap blocks the
  // bot carries, swim across water, parkour small gaps - so terrain doesn't stop it or
  // drop it into a ravine. Still never digs (anti-grief). Restored to the safe profile
  // in finally. If it carries no bridging blocks it just routes around instead.
  bot.pathfinder.setMovements(travelMovements(bot))
  try {
    // Starting buried (logged in / spawned inside a cave)? Get to the surface FIRST, before
    // any horizontal legs. Otherwise the XZ-only pathing follows cave openings DOWNWARD
    // chasing the target and can ride them to bedrock/lava - exactly how it died before.
    if (buried()) await surfaceOut("i'm underground - digging up to the surface before i head out...")
    for (;;) {
      if (isStopped()) return { ok: false, reason: 'stopped', dist: lastD }
      // SURVIVAL during the long trek: a far build site is a 600-block walk, and the idle
      // reflexes are gated off while busy - so, like the gather loop, do it inline here.
      // Without this the bot starved to 1 hp / got killed naked before it ever arrived.
      // The time spent is credited against the travel clock (a night-shelter must not time
      // out the trip). travelFar's movement profile is restored after.
      if (Date.now() - lastSurvival > 12000 && (provision.needsFood(bot) || provision.nightRestWanted(bot))) {
        lastSurvival = Date.now(); const sv0 = Date.now()
        try {
          if (provision.needsFood(bot)) { say('starving - sorting out food before i push on'); await provision.secureFood(bot, { isStopped, say, scoutHunt: false, canHold: false }) } // mid-trek: eat/bank/hunt/fish nearby; no cross-country scouting or holing up - the trek itself may be the way home
          else { escaping = true; try { if (provision.underArmored(bot)) await provision.restUntilSafe(bot, { isStopped, say }); else await provision.nightRest(bot, { isStopped, say }) } finally { escaping = false } }
        } catch { /* keep travelling regardless */ }
        climbTimeMs += Date.now() - sv0
        bot.pathfinder.setMovements(travelMovements(bot)); lastD = Infinity; continue
      }
      if (Date.now() - start - climbTimeMs > deadlineMs) {
        const hd = Math.hypot(dest.x - bot.entity.position.x, dest.z - bot.entity.position.z)
        return { ok: false, reason: 'timed out', dist: hd }
      }
      // A leg dropped us into a cave? Climb back out NOW instead of riding it deeper.
      if (buried() && climbs < 8) { await surfaceOut("dropped into a cave - climbing back to the surface..."); stalls = 0; lastD = Infinity; continue }
      const me = bot.entity.position
      const dx = dest.x - me.x; const dz = dest.z - me.z
      const d = Math.hypot(dx, dz)
      // Arrive only when close horizontally AND not still stuck deep underground: arriving
      // at bedrock under a surface target and handing off a precise goal is what walked us
      // into the lava. If we're close but buried, the loop above climbs us out first.
      if (d <= arrive && !buried()) {
        // Record this trek as a reusable route (long trips only; a survival detour already
        // stopped the recording via the >40b gap guard). Merges into any existing route.
        if (recording && d0 >= routeMem.ROUTE_MIN_LEN) { pushCrumb({ x: me.x, z: me.z }); provision.rememberRoute(startPos, { x: dest.x, z: dest.z }, crumbs) }
        return { ok: true, reason: 'arrived', dist: d }
      }
      // Self-abandon a stale replay/graph plan once >60% of the (survival-credited) deadline has burned.
      if (graphPlan && Date.now() - start - climbTimeMs > 0.6 * deadlineMs) { dbg('travel: abandoning graph route - >60% of the deadline burned'); graphPlan = null }
      if (replay && Date.now() - start - climbTimeMs > 0.6 * deadlineMs) { dbg('travel: abandoning route replay - >60% of the deadline burned'); replay = null }
      // Leg target: graph node > replay point > blind bearing (wedge soft-steered + probed). Proven
      // routes/graph edges are NOT wedge-checked/probed; the soft-steer + probe only touch a fresh bearing.
      const step = Math.min(hop, d)
      let wx = me.x + (dx / d) * step
      let wz = me.z + (dz / d) * step
      let replayLeg = false
      let graphLeg = false
      if (graphPlan) {
        const cur = routeMem.routeCursor(graphPlan.pts, me)
        const pt = graphPlan.pts[cur]
        wx = pt.x; wz = pt.z; graphLeg = true
      } else if (replay) {
        const cur = routeMem.routeCursor(replay.pts, me)
        const pt = replay.pts[cur]
        wx = pt.x; wz = pt.z; replayLeg = true
      } else {
        // NAV_LADDER_DIET (Phase C / §5-P4, default OFF): the probe+graph supersede this soft-steer.
        if (!NAV_LADDER_DIET) {
          const wedges = provision.listWedges()
          if (wedges.length && routeMem.wedgeOnSegment(wedges, me, { x: wx, z: wz })) {
            const ux = dx / d; const uz = dz / d; const sstep = Math.min(hop, d)
            for (const deg of [60, -60, 120, -120]) {
              const th = deg * Math.PI / 180
              const cx = me.x + (ux * Math.cos(th) - uz * Math.sin(th)) * sstep
              const cz = me.z + (ux * Math.sin(th) + uz * Math.cos(th)) * sstep
              if (!routeMem.wedgeOnSegment(wedges, me, { x: cx, z: cz })) { wx = cx; wz = cz; dbg('travel: soft-steering ' + deg + 'deg around a learned wedge'); break }
            }
          }
        }
        // NAV_LEG_PROBE (Phase C / §5-P2): pre-flight the bearing leg; noPath => rotate ±60/±120,
        // take the first reachable, else keep the direct bearing (SOFT). Bearing legs ONLY.
        if (NAV_LEG_PROBE) {
          try {
            const dirx = wx - me.x; const dirz = wz - me.z; const dn = Math.hypot(dirx, dirz) || 1
            const pm = provision.trekMovements(bot, () => travelMovements(bot))
            try { bot.pathfinder.setMovements(pm) } catch {}
            const cands = navLeg.legCandidates({ x: me.x, z: me.z }, dirx / dn, dirz / dn, dn, dn, Math.min(hop, d))
            const verdict = (c) => { try { const r = bot.pathfinder.getPathTo(pm, new goals.GoalNearXZ(Math.floor(c.x), Math.floor(c.z), 4), PROBE_MS); return (r && r.status === 'noPath') ? 'noPath' : ((r && r.status) || 'unknown') } catch { return 'unknown' } }
            const pick = navLeg.chooseProbedLeg(cands, verdict)
            if (pick) { wx = pick.cand.x; wz = pick.cand.z; if (pick.rotated) dbg('travel: probe noPath at bearing - took ' + pick.cand.deg + 'deg (' + pick.verdict + ')') }
          } catch (e) { dbg('travel: leg probe skipped - ' + e.message) }
        }
      }
      // Each leg goes through the UNIFIED navigator: door-assist, pit-escape, water-hop
      // and the surface nudge all fire consistently mid-leg now (they used to be inline
      // copies here, wired into this loop only). Rescue time is credited against the
      // travel clock; the climb rung is off because this loop does its own proactive
      // surfacing (surfaceOut) with dest-aware depth checks.
      let legErr = null
      let reflexWaitMs = 0
      const legT0 = Date.now()
      // NAV Phase B leg goal: Y-BANDED to the (surface) destination Y so A* can't satisfy this
      // leg deep down a cave at the target's XZ (#41). travelFar already surfaces reactively
      // (buried()/surfaceOut, dest.y-keyed) - this is the plan-time complement, and both keep
      // final arrival on the independent XZ+!buried() check below. NAV_HAZARD_LEGS=0 => today's
      // Y-blind GoalNearXZ, byte-for-byte.
      const legGoal = NAV_HAZARD_LEGS
        ? new GoalNearXZBanded(wx, wz, 4, dest.y)
        : new goals.GoalNearXZ(wx, wz, 4)
      try {
        const nav = await navigate.navigateTo(bot, legGoal, {
          timeoutMs: 30000, deadlineMs: 75000, isStopped, climb: false, label: 'travel',
          budgets: { water: 1, pit: 1, door: 1, nudge: 1 }, // one rescue of each kind per leg - the trip loop retries legs
          escalate: false, doorPreflight: false, // this trek loop owns its own stall handling; a near-home leg must not spuriously cross a door
          // NAV Phase 1 selector: flag OFF (default) => travelMovements(bot), byte-identical
          // no-dig behavior; flag ON + >32b from home => the wild dig-capable profile.
          movements: () => provision.trekMovements(bot, () => travelMovements(bot))
        })
        climbTimeMs += nav.recoveryMs
        reflexWaitMs = nav.reflexWaitMs || 0
      } catch (e) {
        legErr = e.message /* leg blocked/timed out - re-aim from wherever we ended up */
        if (e.nav) { climbTimeMs += e.nav.recoveryMs || 0; reflexWaitMs = e.nav.reflexWaitMs || 0 }
      }
      const reflexDominated = reflexWaitMs > 37500 // > legDeadline(75s)/2: body held by a survival reflex, not blocked
      const nd = Math.hypot(dest.x - bot.entity.position.x, dest.z - bot.entity.position.z)
      pushCrumb({ x: bot.entity.position.x, z: bot.entity.position.z }) // record the trek shape for the reusable route
      // leg telemetry: the Sonnet shepherd watched "moving:true" while stationary for 90s
      // on OPEN ground - these lines make the next such stall's anatomy readable
      dbg('travel leg -> ' + Math.round(nd) + 'b left (was ' + (lastD === Infinity ? 'inf' : Math.round(lastD)) + ', stalls ' + stalls + (legErr ? ', err: ' + legErr : '') + ')')
      // no meaningful progress this leg -> count a stall. A leg that FAST-FAILED (goto
      // no-pathed in ms, every rescue declined) must still cost a beat - otherwise three
      // stalls burn in ~2 seconds and the trek reports "blocked" before the world (a
      // drifting boat gap, a mob shoving us ashore) gets any chance to change.
      if (nd >= lastD - 3) {
        // MEASURED stall on a composed GRAPH leg (non-reflex) -> abandon the graph plan for THIS
        // trek and fall back to whole-route replay / bearing (the graph is read-only over route
        // memory; the underlying routes still dement through their own replay).
        if (graphLeg && !reflexDominated) { graphPlan = null; replay = provision.recallRoute({ x: bot.entity.position.x, z: bot.entity.position.z }, { x: dest.x, z: dest.z }); dbg('travel: graph route stalled - abandoning, falling back to replay/bearing'); lastD = Infinity; continue }
        // MEASURED stall mid-replay (non-reflex) -> the proven route is stale here. Dement it
        // and abandon the cursor; the next leg falls through to today's blind bearing/stall
        // handling from the current position, UNCHANGED.
        if (replayLeg && !reflexDominated) { provision.dementRoute(replay.route); replay = null; dbg('travel: route replay stalled - demented, falling back to blind bearing'); lastD = Infinity; continue }
        stalls++
        if (Date.now() - legT0 < 3000) await new Promise(r => setTimeout(r, 1500))
        // Stalled AND out of blocks to bridge with? Dig some dirt on our own (like the
        // build gathers its materials), then retry - so a ravine/water gap can't strand
        // us. Only when actually stuck (not upfront), so open ground never triggers it.
        if (stalls >= 2 && opts.gather !== false && gathers < 3 && bridgingBlockCount(bot) < 4) {
          say("hit a gap and I'm out of blocks - digging some dirt to bridge with...")
          try {
            const r = await provision.runGather(bot, 'dirt', 12, { isStopped, restoreMovements: () => {} })
            if (r && r.gathered) say(`got ${r.gathered} dirt, carrying on`)
          } catch { /* nothing to dig right here */ }
          bot.pathfinder.setMovements(travelMovements(bot)) // gather reset movements
          gathers++; stalls = 0; lastD = Infinity; continue
        }
        // Stalled AND buried -> dig out (the per-leg buried() check usually gets this first).
        if (stalls >= 2 && buried()) { await surfaceOut("stuck underground - digging up toward the surface..."); stalls = 0; lastD = Infinity; continue }
        if (stalls >= 3) return { ok: false, reason: 'blocked', dist: nd }
      } else stalls = 0
      lastD = nd
    }
  } finally {
    setupMovements(bot) // back to the safe anti-grief profile
  }
}

// Movement profile for cross-country travel. Preserves the one rule that matters -
// canDig stays FALSE, so it never breaks blocks to path (no griefing) - but permits
// the things a survival player does to get past terrain: bridge gaps/ravines and
// pillar with cheap filler blocks from inventory, parkour, open doors, and swim.
function travelMovements (bot) {
  const m = new Movements(bot)
  m.canDig = false            // never destroy blocks (anti-grief)
  m.allow1by1towers = true    // pillar up to climb out of / over things
  m.canOpenDoors = true
  m.allowParkour = true
  m.maxDropDown = 4           // don't plunge into caves/ravines chasing the target's XZ
  m.liquidCost = 4            // NAV P0: route AROUND water - library default is 1 (priced like land) so A* happily swam lakes; mirrors gatherMovements (provision.js). Treks are how the bot reaches water-pocket geometry.
  if ('infiniteLiquidDropdownDistance' in m) m.infiniteLiquidDropdownDistance = false
  if ('allowSprinting' in m) m.allowSprinting = true
  // Bridge gaps/ravines with cheap blocks the bot is carrying (dirt/cobble/gravel...).
  // Only used where a bridge is actually needed; on open ground it just walks.
  try {
    const md = require('minecraft-data')(bot.version)
    const bridge = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'gravel', 'dirt_path', 'andesite', 'granite', 'diorite']
    const ids = bridge.map(n => md.itemsByName[n] && md.itemsByName[n].id).filter(x => x != null)
    if ('scafoldingBlocks' in m) m.scafoldingBlocks = ids
  } catch { /* mcData not ready - fall back to no bridging (routes around) */ }
  try { const ex = provision.cropExclusionStep && provision.cropExclusionStep(bot); if (ex && Array.isArray(m.exclusionAreasStep)) m.exclusionAreasStep.push(ex) } catch {} // FARM_NO_TRAMPLE: treks bend around our crop cells (cost-only, never a wall/dig)
  try { const px = provision.cropPlaceExclusion && provision.cropPlaceExclusion(bot); if (px && Array.isArray(m.exclusionAreasPlace)) m.exclusionAreasPlace.push(px) } catch {} // NO_PLACE_ON_FARM (fix #17): never bridge/place on our own farmland
  // NAV Phase B: price lava (+lava-adjacent pool edges) so surface-trek legs route AROUND it at
  // plan time (cost-only, never a forbid). Flag-gated so NAV_HAZARD_LEGS=0 is byte-for-byte today.
  try { if (NAV_HAZARD_LEGS && provision.hazardStepExclusion && Array.isArray(m.exclusionAreasStep)) m.exclusionAreasStep.push(provision.hazardStepExclusion(bot)) } catch {}
  // WATER_SAFE (task #45): price DEEP (over-the-head) water so a trek routes AROUND a pond aquifer;
  // shallow water stays free (liquidCost) so the river-farm/fishing spots stay reachable. Cost-only.
  try { if (WATER_SAFE && provision.waterStepExclusion && Array.isArray(m.exclusionAreasStep)) m.exclusionAreasStep.push(provision.waterStepExclusion(bot)) } catch {}
  return m
}

// How close the bot trails a player when following. Range 2 settles right on top of
// them (felt crowding); ~3 blocks reads as walking alongside. Tunable via FOLLOW_RANGE.
const FOLLOW_RANGE = Math.max(1, parseInt(process.env.FOLLOW_RANGE || '3', 10))

// ---- helpers ---------------------------------------------------------------

function blockPos (bot) {
  const p = bot.entity.position
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

// An anchor a few blocks in front of the bot's facing, so it never builds on
// top of itself. Yaw 0 = south(+z); we snap to the nearest cardinal.
function anchorInFront (bot, dist = 3) {
  const b = blockPos(bot)
  const yaw = bot.entity.yaw
  const dirs = [
    { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, { x: 1, z: 0 }
  ]
  const idx = (Math.round(yaw / (Math.PI / 2)) % 4 + 4) % 4
  const d = dirs[idx]
  return { x: b.x + d.x * dist, y: b.y, z: b.z + d.z * dist }
}

function fill (bot, x1, y1, z1, x2, y2, z2, block) {
  bot.chat(`/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${block}`)
}
function setblock (bot, x, y, z, block) {
  bot.chat(`/setblock ${x} ${y} ${z} ${block}`)
}

// normalize a username for fuzzy matching: lowercase + drop a leading
// non-alphanumeric prefix (e.g. Bedrock/Floodgate names like ".PlayerName")
function normName (n) { return String(n || '').toLowerCase().replace(/^[^a-z0-9_]+/i, '') }

function findPlayer (bot, name) {
  if (name) {
    // never target yourself: the bot appears in bot.players under its own name, and
    // an alone brain otherwise latches onto its own name ("follow Claudebot" -> self)
    const want = normName(name)
    if (name === bot.username || want === normName(bot.username)) return null
    // exact first, then case-/prefix-insensitive (so "PlayerName" finds ".PlayerName")
    if (bot.players[name] && bot.players[name].entity) return bot.players[name].entity
    for (const p of Object.values(bot.players)) {
      if (!p.entity || p.username === bot.username) continue
      if (normName(p.username) === want) return p.entity
    }
    return null
  }
  // nearest other player
  let best = null
  let bestD = Infinity
  for (const p of Object.values(bot.players)) {
    if (!p.entity || p.username === bot.username) continue
    const d = p.entity.position.distanceTo(bot.entity.position)
    if (d < bestD) { bestD = d; best = p.entity }
  }
  return best
}

// ---- building primitives ---------------------------------------------------

function buildWall (bot, material, length, height, a) {
  fill(bot, a.x, a.y, a.z, a.x + length - 1, a.y + height - 1, a.z, material)
  return `wall: ${material} ${length}x${height} at ${a.x},${a.y},${a.z}`
}

function buildTower (bot, material, height, size, a) {
  const x2 = a.x + size - 1
  const z2 = a.z + size - 1
  // solid then hollow to leave a climbable shaft
  fill(bot, a.x, a.y, a.z, x2, a.y + height - 1, z2, material)
  if (size > 2) {
    fill(bot, a.x + 1, a.y, a.z + 1, x2 - 1, a.y + height - 1, z2 - 1, 'air')
  }
  return `tower: ${material} ${size}x${size} h${height} at ${a.x},${a.y},${a.z}`
}

function buildHouse (bot, material, w, l, h, a) {
  const x1 = a.x; const y1 = a.y; const z1 = a.z
  const x2 = a.x + w - 1; const y2 = a.y + h - 1; const z2 = a.z + l - 1
  // floor
  fill(bot, x1, y1, z1, x2, y1, z2, material)
  // solid shell up to roof
  fill(bot, x1, y1, z1, x2, y2, z2, material)
  // hollow interior
  fill(bot, x1 + 1, y1 + 1, z1 + 1, x2 - 1, y2 - 1, z2 - 1, 'air')
  // flat roof
  fill(bot, x1, y2, z1, x2, y2, z2, material)
  // doorway (2 high) centred on the -z wall
  const dx = Math.floor((x1 + x2) / 2)
  setblock(bot, dx, y1 + 1, z1, 'air')
  setblock(bot, dx, y1 + 2, z1, 'air')
  // a couple of window holes on the +x / -x walls
  setblock(bot, x1, y1 + 2, Math.floor((z1 + z2) / 2), 'glass')
  setblock(bot, x2, y1 + 2, Math.floor((z1 + z2) / 2), 'glass')
  return `house: ${material} ${w}x${l}x${h} at ${x1},${y1},${z1} (door on -z side)`
}

// Eat the best food in inventory so the bot doesn't starve. Returns a status
// string. Safe to call often - no-ops if already full or no food on hand.
// ONE eating policy: the ranking (filling-safe first, risky food only when starving or
// critically hurt) lives in provision.eatBestFood, shared with the secureFood chain.
async function eatFood (bot) { return provision.eatBestFood(bot) }

// Natural ground a torch may be auto-placed on. Anchored/explicit so crafted or
// build blocks (planks, bricks, wool, glass, concrete...) never qualify - the
// auto-torch reflex must light natural terrain, never decorate someone's build.
const TORCH_GROUND = /grass_block|^dirt$|coarse_dirt|podzol|rooted_dirt|^stone$|deepslate$|^tuff$|^andesite$|^diorite$|^granite$|^sand$|^red_sand$|^gravel$|^netherrack$|^cobblestone$|moss_block|^mud$|^sandstone$|^snow_block$|^calcite$|^basalt$|^blackstone$|grass_path|dirt_path/

// Place ONE torch on natural ground next to the bot (for the opt-in auto-torch
// reflex). Returns a status string; safe to call often - no-ops cleanly if there's
// no torch in hand-reach inventory or no suitable natural spot adjacent.
async function placeTorchNearby (bot) {
  const items = bot.inventory ? bot.inventory.items() : []
  const torch = items.find(i => i.name === 'torch')
  if (!torch) return 'no torch in inventory'
  const b = blockPos(bot)
  let ref = null
  for (let r = 1; r <= 2 && !ref; r++) {
    for (let dx = -r; dx <= r && !ref; dx++) {
      for (let dz = -r; dz <= r && !ref; dz++) {
        if (dx === 0 && dz === 0) continue // not under our own feet
        const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1, b.z + dz))
        const above = bot.blockAt(new Vec3(b.x + dx, b.y, b.z + dz))
        if (ground && TORCH_GROUND.test(ground.name) && above && above.name === 'air') ref = ground
      }
    }
  }
  if (!ref) return 'no natural ground nearby for a torch'
  await bot.equip(torch, 'hand').catch(() => {})
  await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
  try {
    await bot.placeBlock(ref, new Vec3(0, 1, 0))
  } catch (e) {
    // Paper/creative sometimes doesn't echo the blockUpdate in time even though the
    // torch WAS placed - read the spot back before reporting failure, so the reflex
    // doesn't log a false "couldn't place" (and then retry-spam).
    const placed = bot.blockAt(ref.position.offset(0, 1, 0))
    if (!placed || !/torch/.test(placed.name)) return `couldn't place torch: ${e.message}`
  }
  return `placed torch at ${ref.position.x},${ref.position.y + 1},${ref.position.z}`
}

// Pick the best tool in inventory for a block (axe/pickaxe/shovel, best material).
function bestTool (bot, blockName) {
  const items = bot.inventory ? bot.inventory.items() : []
  let kind = null
  if (/_log$|_wood$|plank|_stem$|fence|door|chest|crafting|bookshelf|barrel|sign|ladder|wooden/.test(blockName)) kind = 'axe'
  else if (/stone|ore|cobble|deepslate|granite|diorite|andesite|obsidian|brick|furnace|anvil|concrete|terracotta|netherrack|basalt|blackstone|amethyst|raw_|rail|iron_block|gold_block/.test(blockName)) kind = 'pickaxe'
  else if (/dirt|grass_block|sand|gravel|clay|soul_|mud|path|farmland|snow|podzol|mycelium/.test(blockName)) kind = 'shovel'
  if (!kind) return null
  const tools = items.filter(i => i.name.endsWith('_' + kind))
  const order = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
  for (const m of order) { const t = tools.find(i => i.name.startsWith(m)); if (t) return t }
  return tools[0] || null
}

// Which body slot an item is WORN in (so armor is put on, not just held). Returns
// 'head'|'torso'|'legs'|'feet' for armor, else null. mineflayer's bot.equip needs
// this destination - equipping armor to 'hand' only holds it (the "put it on did
// nothing" bug). Covers every armor material + turtle helmet, elytra, pumpkin hat.
function armorSlot (name) {
  if (/_helmet$|^turtle_helmet$|^carved_pumpkin$/.test(name)) return 'head'
  if (/_chestplate$|^elytra$/.test(name)) return 'torso'
  if (/_leggings$/.test(name)) return 'legs'
  if (/_boots$/.test(name)) return 'feet'
  return null
}
// Best armor piece among candidates for one slot (strongest material wins).
function bestArmor (pieces) {
  const order = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather', 'turtle']
  for (const m of order) { const p = pieces.find(i => i.name.startsWith(m)); if (p) return p }
  return pieces[0] || null
}
// Material rank for a standard armor piece (same preference order as bestArmor); an empty slot or a
// non-standard piece (elytra/carved_pumpkin) ranks 0 so it's never a downgrade target.
const ARMOR_MAT = /^(netherite|diamond|iron|chainmail|golden|leather|turtle)_/
const ARMOR_RANK = { turtle: 1, leather: 2, golden: 3, chainmail: 4, iron: 5, diamond: 6, netherite: 7 }
function armorRank (name) { const m = ARMOR_MAT.exec(name || ''); return m ? (ARMOR_RANK[m[1]] || 0) : 0 }
// FIX #19 (EQUIP_CARRIED_ARMOR): wear STRICTLY-BETTER armor already in the pack, per slot. This is
// CARRIED-ONLY - it never treks/gathers/crafts (that's provisionArmor/armorup). Equipping is an
// instant inventory op (no move/dig/nav, zero grief risk), so the index.js reflex runs it even
// while the body is BUSY - the reason a respawned/graved bot built naked with iron in the pack.
// Only fills an empty slot or up-tiers a lower-material piece; never touches a special piece
// (elytra/carved_pumpkin) worn in a slot. Returns the newly-worn piece names.
async function equipCarriedArmor (bot) {
  if (!bot || !bot.entity || !bot.inventory) return []
  if (bot.currentWindow) return [] // a chest/crafting GUI is mid-transaction - don't clobber slots
  const inv = bot.inventory.items ? bot.inventory.items() : []
  const worn = wornArmor(bot)
  const wore = []
  for (const slot of ['head', 'torso', 'legs', 'feet']) {
    const cur = worn[slot]
    if (cur && !ARMOR_MAT.test(cur)) continue // a special piece (elytra/pumpkin) - leave it
    const curRank = armorRank(cur)
    const cand = bestArmor(inv.filter(i => armorSlot(i.name) === slot && ARMOR_MAT.test(i.name)))
    if (!cand || armorRank(cand.name) <= curRank) continue // nothing strictly better carried
    try { await bot.equip(cand, slot); wore.push(cand.name) } catch { /* transient - retry next tick */ }
  }
  return wore
}

// Leather-armor pieces in PROTECTION-PER-LEATHER order, so a partial haul still
// guards the most valuable slots first: chestplate (3 armor / 8 leather) beats
// leggings (2/7) beats helmet (1/5) beats boots (1/4). Leather armor is the
// from-NOTHING tier - the recipes are pure leather (no sticks/planks), so the only
// crafting prerequisite is a table.
const LEATHER_PIECES = [
  { item: 'leather_chestplate', slot: 'torso', leather: 8 },
  { item: 'leather_leggings', slot: 'legs', leather: 7 },
  { item: 'leather_helmet', slot: 'head', leather: 5 },
  { item: 'leather_boots', slot: 'feet', leather: 4 }
]

// Get the bot ARMORED from nothing, using what THIS biome actually offers: wear any
// armor already in the pack, then (a) craft leather ONLY if cows are actually around,
// else (b) bootstrap IRON (mine -> smelt -> craft -> wear) via the resource model -
// the reliable path in a no-animal biome. The old leather-only version dead-ended
// ("no cows/leather around here") and left the bot naked for hours while iron sat
// mineable under its feet (live, 07-13). Only fills EMPTY slots - never downgrades
// iron->leather. BOUNDED: every branch makes what it can and returns. Returns a
// short HONEST status string. Never throws fatally.
async function provisionArmor (bot, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const restore = opts.restoreMovements || (() => setupMovements(bot))
  const mcData = require('minecraft-data')(bot.version)
  const inv = () => (bot.inventory ? bot.inventory.items() : [])
  const bareSlots = () => Object.entries(wornArmor(bot)).filter(([, v]) => !v).map(([k]) => k)
  const wore = []
  // 1) Wear anything already in the pack for a bare slot (best material first).
  for (const slot of ['head', 'torso', 'legs', 'feet']) {
    if (wornArmor(bot)[slot]) continue
    const pick = bestArmor(inv().filter(i => armorSlot(i.name) === slot))
    if (pick) { try { await bot.equip(pick, slot); wore.push(pick.name) } catch { /* transient */ } }
  }
  if (!bareSlots().length) return wore.length ? `armored up: ${wore.join(', ')}` : 'already wearing armor in every slot'

  // 1.5) RAID THE BANK before hunting/mining for NEW armor. Live: the bot ran the full iron
  //     grind (mine -> smelt -> craft) while a finished set sat in its own chest. Withdraw the
  //     best banked piece for each still-bare slot and WEAR it - covers every material
  //     (leather/iron/diamond/...), so the expensive leather-hunt/iron-bootstrap below only
  //     runs for slots the bank genuinely can't cover. Best-effort: a chest hiccup just skips it.
  if (bareSlots().length && !isStopped()) {
    try {
      const chests = (provision.listInfra ? provision.listInfra('chest', bot) : []) || []
      for (const e of chests) {
        if (!bareSlots().length || isStopped()) break
        let blk = null; try { blk = bot.blockAt(new Vec3(e.x, e.y, e.z)) } catch {}
        if (!blk || !/chest/.test(blk.name || '')) continue
        let counts = {}
        try { counts = await provision.chestCounts(bot, blk) } catch { continue }
        for (const slot of bareSlots()) {
          const cand = Object.keys(counts).filter(n => counts[n] > 0 && armorSlot(n) === slot).map(n => ({ name: n }))
          const pick = bestArmor(cand)
          if (!pick) continue
          try {
            const got = await provision.withdrawItem(bot, blk, pick.name, 1)
            if (got > 0) { const it = inv().find(i => i.name === pick.name); if (it) { await bot.equip(it, slot); wore.push(pick.name + ' (from bank)') } }
          } catch { /* transient - leave the slot for the leather/iron path */ }
        }
      }
    } catch (e) { say(`(bank-armor check skipped: ${e.message})`) }
    if (!bareSlots().length) return `armored up from the bank: ${wore.join(', ')}`
  }

  // 2) LEATHER only when cows are VERIFIABLY here (entity check, not hope) - never
  //    roam-hunt a biome with no animals; that roam was the old dead end.
  const cowsAround = !!bot.entity && Object.values(bot.entities || {}).some(e => e && e.position && /^(cow|mooshroom)$/.test((e.name || '').toLowerCase()) && e.position.distanceTo(bot.entity.position) <= 48)
  if (cowsAround && !isStopped()) {
    const stillMissing = LEATHER_PIECES.filter(p => !wornArmor(bot)[p.slot])
    const have = () => provision.inventoryCounts(bot).leather || 0
    const needLeather = stillMissing.reduce((s, p) => s + p.leather, 0)
    if (have() < needLeather) {
      say(`no armor on me - hunting cows for leather (${have()}/${needLeather})`)
      try { await provision.gatherLeather(bot, needLeather - have(), { say, isStopped, restoreMovements: restore, home: opts.home, maxRoam: opts.maxRoam, maxExplores: opts.maxExplores, timeMs: opts.timeMs }) }
      catch (e) { say(`(leather hunt cut short: ${e.message})`) }
    }
    // Ensure a crafting table exists (leather armor needs only leather + a table).
    if (!isStopped() && have() >= LEATHER_PIECES[LEATHER_PIECES.length - 1].leather) {
      try { await provision.ensureTable(bot, { say, isStopped }) }
      catch {
        try {
          const wood = provision.detectWood(bot) || 'oak'
          const plan = provision.planProvision(mcData, { crafting_table: 1 }, provision.inventoryCounts(bot), { primaryWood: wood })
          if (plan.tasks.length) await provision.runPlan(bot, plan, { say, isStopped, restoreMovements: restore })
        } catch (e) { say(`(no table and couldn't make one: ${e.message})`) }
      }
    }
    // Craft + wear whatever the leather affords, best slots first.
    for (const p of stillMissing) {
      if (isStopped() || wornArmor(bot)[p.slot] || have() < p.leather) continue
      try {
        await provision.runCraft(bot, p.item, 1, true, { say, isStopped, restoreMovements: restore })
        const made = inv().find(i => i.name === p.item)
        if (made) { await bot.equip(made, p.slot); wore.push(p.item) }
      } catch (e) { say(`(couldn't make ${p.item}: ${e.message})`) }
    }
  }

  // 3) IRON fallback: slots still bare and leather wasn't on offer (or fell short) ->
  //    mine/smelt/craft/wear the iron set. The ONE viable armor path where cows don't
  //    exist. opts.ironFallback === false opts out (autoBuild's camp flow runs its own
  //    pass with build-tuned budgets; survivalPrep must not front-load an iron grind
  //    onto every trek).
  let ironNote = ''
  if (bareSlots().length && !isStopped() && opts.ironFallback !== false) {
    const r = await ironArmorBootstrap(bot, { say, isStopped, restoreMovements: restore, at: opts.at, avoid: opts.avoid, keepDirt: opts.keepDirt, force: opts.forceIron })
    if (r.msg) ironNote = ` (iron path: ${r.msg})`
  }
  restore()
  const bare = bareSlots()
  const wornNow = Object.values(wornArmor(bot)).filter(Boolean)
  if (!bare.length) return `armored up - full set on (${wornNow.join(', ')})`
  if (wornNow.length) return `partly armored (${wornNow.join(', ')}) - still bare: ${bare.join(', ')}${ironNote}`
  return `still no armor - no cows here for leather${ironNote || ' and the iron path was skipped'}`
}

// IRON ARMOR BOOTSTRAP: mine -> smelt -> craft -> wear the iron pieces for every bare
// slot, via the resource model (banked iron/ingots/pieces count BEFORE any mining).
// Extracted from autoBuild's camp flow so `armorup` (and the idle gear-up reflex) can
// reach iron too - the leather-only dead end trapped a naked bot for hours (live).
// Keeps the persisted CONVERGENCE BACK-OFF: repeated fruitless attempts (patrol-
// interdicted site, no exposed iron) must not re-run the same death-march every call;
// any real progress (new piece worn, net iron gained) resets the window. Returns
// { progressed, msg } - msg is an honest, human-readable outcome.
async function ironArmorBootstrap (bot, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const restore = opts.restoreMovements || (() => setupMovements(bot))
  const at = opts.at || (bot.entity && bot.entity.position)
  if (!at) return { progressed: false, msg: 'not spawned yet' }
  const avoid = opts.avoid || null
  const primaryWood = provision.detectWood(bot) || 'oak'
  const bareCount = () => Object.values(wornArmor(bot)).filter(v => !v).length
  if (!bareCount()) return { progressed: false, msg: 'already armored in every slot' }
  const gb = provision.gearupState && provision.gearupState()
  if (!opts.force && gb && gb.until > Date.now()) {
    const min = Math.max(1, Math.round((gb.until - Date.now()) / 60000))
    return { progressed: false, msg: `iron grind cooling off after ${gb.fails} fruitless tries - retrying in ~${min} min` }
  }
  const ironScore = () => { const c = provision.inventoryCounts(bot); return (c.raw_iron || 0) + (c.iron_ingot || 0) * 2 }
  const bareBefore = bareCount(); const ironBefore = ironScore()
  let failReason = null
  // INCREMENTAL, CHEAPEST-FIRST (operator: graceful degradation). Gathering all 24 iron
  // before crafting anything meant ZERO armor worn until the whole set landed - an all-or-
  // nothing cliff that could take an hour+. Instead craft+WEAR one piece at a time, cheapest
  // first (boots 4 -> helmet 5 -> leggings 7 -> chestplate 8), so partial protection goes
  // on ASAP and an interrupt (night/death/stop) still leaves the finished pieces WORN.
  const IRON_PIECES = [
    { item: 'iron_boots', slot: 'feet' },
    { item: 'iron_helmet', slot: 'head' },
    { item: 'iron_leggings', slot: 'legs' },
    { item: 'iron_chestplate', slot: 'torso' }
  ]
  const NEED = { feet: 4, head: 5, legs: 7, torso: 8 } // ingots per iron piece
  const homeXYZ = { x: Math.round(at.x), y: Math.floor(at.y), z: Math.round(at.z) }
  const runOpts = { say, isStopped, restoreMovements: restore, homeY: Math.floor(at.y), home: homeXYZ, avoid }
  const bareList = () => IRON_PIECES.filter(p => !wornArmor(bot)[p.slot])
  try {
    // stage 1: a stone pick to mine with AND a sword to defend - the deep iron grind is a
    // naked cave dive where zombie+skeleton ambushes kept killing the bot (it had no weapon
    // at all - gearup only made a pickaxe). A cheap wooden sword gives the auto-defend reflex
    // something better than fists when a mob corners it mid-retreat.
    const items0 = () => (bot.inventory ? bot.inventory.items() : [])
    const needPick = !items0().some(i => /(stone|iron|diamond)_pickaxe/.test(i.name))
    const needSword = !items0().some(i => /_sword$/.test(i.name))
    if (needPick || needSword) {
      const want = {}
      if (needPick) want.stone_pickaxe = 1
      if (needSword) want.wooden_sword = 1
      const pprec = await resources.reconcile(bot, want, { near: at, planOpts: { primaryWood } })
      if (pprec.withdraws.length || pprec.plan.tasks.length) await resources.runReconciled(bot, pprec, runOpts)
    }
    // stage 2: ONE batch gather for all the iron the bare slots need (banked iron counts
    // first). A single excursion amortizes the walk-out/descend overhead and earns a real
    // wall-clock budget (deadline scales with count) - per-piece 4-iron gathers each got a
    // ~2min budget mostly eaten by travel and never finished a piece.
    if (!isStopped()) {
      const totalIron = bareList().reduce((s, p) => s + NEED[p.slot], 0)
      const rawRec = await resources.reconcile(bot, { raw_iron: totalIron }, { near: at, planOpts: { primaryWood, furnacesNearby: provision.countFurnacesNear(bot) } })
      if (Object.keys(rawRec.plan.unobtainable || {}).length) { failReason = 'unobtainable: ' + Object.keys(rawRec.plan.unobtainable).join(', '); dbg('iron bootstrap: raw_iron unobtainable ' + JSON.stringify(rawRec.plan.unobtainable)) }
      else if (rawRec.plan.tasks.length || rawRec.withdraws.length) {
        say('no cows around for leather - mining iron for real armor')
        dbg('iron bootstrap gather: ' + rawRec.plan.tasks.map(t => `${t.type}:${t.item || t.output}x${t.count || t.crafts || ''}`).join(' > '))
        await resources.runReconciled(bot, rawRec, runOpts)
      }
    }
    // stage 3: smelt+craft+WEAR cheapest-first from whatever the excursion produced. A
    // partial haul still armors the cheap slots NOW (operator: graceful degradation) -
    // boots(4) -> helmet(5) -> leggings(7) -> chestplate(8). Stop at the first piece we
    // can't yet afford (its reconcile would want to GATHER more) and let a later pass
    // finish it; the iron already mined is banked and counts next time.
    for (const p of IRON_PIECES) {
      if (isStopped()) break
      if (wornArmor(bot)[p.slot]) continue
      const rec = await resources.reconcile(bot, { [p.item]: 1 }, { near: at, planOpts: { primaryWood, furnacesNearby: provision.countFurnacesNear(bot) } })
      // needs a fresh GATHER -> we're short on iron for this piece; don't start another
      // mining excursion this pass (that's the next pass's job) - stop here.
      if ((rec.plan.tasks || []).some(t => t.type === 'gather')) { dbg('iron bootstrap: short of iron for ' + p.item + ' - stopping, will finish next pass'); if (!failReason) failReason = 'short of iron for ' + p.item; break }
      if (rec.plan.tasks.length || rec.withdraws.length) {
        dbg('iron bootstrap ' + p.item + ' craft: ' + rec.plan.tasks.map(t => `${t.type}:${t.item || t.output}x${t.count || t.crafts || ''}`).join(' > '))
        await resources.runReconciled(bot, rec, runOpts)
      }
      const r = await handle(bot, 'wear')
      dbg('iron bootstrap: after ' + p.item + ' -> ' + r + ' | worn: [' + Object.values(wornArmor(bot)).filter(Boolean).join(', ') + ']')
      if (!wornArmor(bot)[p.slot]) { dbg('iron bootstrap: ' + p.item + ' craft did not land - stopping this pass'); break }
    }
  } catch (e) { failReason = e.message; dbg('iron bootstrap failed (' + e.message + ') - continuing bare') }
  // score the attempt: worn a new piece or netted iron = progress (reset back-off);
  // else widen the back-off so the next passes work the job instead of re-flailing
  const progressed = bareCount() < bareBefore || ironScore() > ironBefore
  try { provision.gearupResult && provision.gearupResult(progressed) } catch {}
  // BANK the gear-up progress: loose iron in the pack dies with the bot (the ~12
  // ingots' worth mined "across attempts" all evaporated in graves, live). Worn
  // armor is in equipment slots - depositing touches only the loose surplus.
  try { const c = provision.inventoryCounts(bot); if ((c.raw_iron || 0) + (c.iron_ingot || 0) > 0) await resources.autoBank(bot, { near: { x: Math.round(at.x), y: Math.floor(at.y), z: Math.round(at.z) }, keepDirt: opts.keepDirt || 16, isStopped }) } catch {}
  restore()
  const bareNow = bareCount()
  const msg = !bareNow ? 'full set on'
    : progressed ? `progress (${4 - bareNow}/4 slots covered, iron banked) - ${bareNow} slot(s) still bare`
      : `no progress${failReason ? ': ' + failReason : ' - no reachable iron this attempt'}`
  return { progressed, msg }
}

// SURVIVAL PREP before a long trek to a far build site. The bot spawns with NOTHING and the
// site is often ~600 blocks away - trekking there naked/unarmed/starving is where it kept
// dying. So FIRST, near spawn (safer, and the gather flow shelters/eats itself), secure the
// survival basics, THEN travel equipped: (1) a wooden SWORD + pickaxe + axe (fight + tools),
// (2) a little food (hunt animals), (3) leather armor if cows are around. All bounded - if a
// resource isn't available it makes what it can and moves on (never blocks the build). The
// tool/armor bootstraps inside autoBuild then no-op (they check hasKind/wornArmor). Idempotent,
// so it's also safe to re-run after a death mid-trek strips the gear.
async function survivalPrep (bot, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const restore = opts.restoreMovements || (() => setupMovements(bot))
  const mcData = require('minecraft-data')(bot.version)
  const primaryWood = provision.detectWood(bot) || 'oak'
  const hasKind = k => (bot.inventory ? bot.inventory.items() : []).some(i => i.name.endsWith('_' + k))
  // 1) tools + a SWORD (chop wood -> planks/sticks/table -> tools). The sword is the key add -
  //    auto-defend with bare fists barely dents a mob; with a sword it kills what hunts it.
  if (!isStopped() && (!hasKind('pickaxe') || !hasKind('axe') || !hasKind('sword'))) {
    const want = {}
    if (!hasKind('pickaxe')) want.wooden_pickaxe = 1
    if (!hasKind('axe')) want.wooden_axe = 1
    if (!hasKind('sword')) want.wooden_sword = 1
    say(`gearing up before the trip - ${Object.keys(want).map(t => t.replace('wooden_', '')).join(' + ')}`)
    try {
      const p = provision.planProvision(mcData, want, provision.inventoryCounts(bot), { primaryWood })
      if (p.tasks.length) await provision.runPlan(bot, p, { say, isStopped, restoreMovements: restore })
    } catch (e) { say(`(couldn't make tools yet: ${e.message})`) }
  }
  // 2) food for the road - hunt a couple animals for meat (auto-eat feeds on it, raw is fine).
  if (!isStopped() && !provision.hasFood(bot)) {
    say('grabbing some food for the road')
    try { for (let i = 0; i < 3 && !provision.hasFood(bot) && !isStopped(); i++) { if (!await provision.huntForFood(bot, { isStopped })) break } } catch { /* no animals - travel-phase hunt covers it */ }
  }
  // 3) leather armor if cows/leather are around (bounded; proceeds naked if not - the shelter
  //    reflex covers a still-naked bot at night). NO iron fallback here: the iron grind is a
  //    long cave dive and the camp flow runs it AFTER the hut/bank/farm (operator order) -
  //    front-loading it onto every trek would starve the camp steps out again.
  if (!isStopped() && Object.values(wornArmor(bot)).some(v => !v)) {
    try { const r = await provisionArmor(bot, { say, isStopped, restoreMovements: restore, ironFallback: false }); if (r) say(r) } catch (e) { say(`(armor prep: ${e.message})`) }
  }
  restore()
  return { armed: hasKind('sword'), fed: provision.hasFood(bot), armored: !Object.values(wornArmor(bot)).some(v => !v) }
}

// Walk onto nearby dropped items to pick them up (so "I dropped it, put it on"
// works). Grabs up to `max` drops within `radius`, bounded by a deadline. Returns
// the count collected. Best-effort - never throws.
async function collectNearbyDrops (bot, { radius = 8, max = 6, deadlineMs = 12000 } = {}) {
  const start = Date.now()
  let got = 0
  for (let n = 0; n < max; n++) {
    if (Date.now() - start > deadlineMs) break
    let target = null; let best = radius
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e.name !== 'item') continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d < best) { best = d; target = e }
    }
    if (!target) break
    try { await gotoTimed(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 0), 8000) } catch { break }
    await new Promise(r => setTimeout(r, 400)) // let the pickup register in inventory
    got++
  }
  return got
}

// ---- command dispatch ------------------------------------------------------

async function handle (bot, line, opts = {}) {
  const parts = String(line).trim().split(/\s+/)
  const cmd = (parts[0] || '').toLowerCase()
  const a = parts.slice(1)

  switch (cmd) {
    case '':
      return 'ok'
    case 'help':
      return [
        'commands:',
        ' perception:',
        '  state                    full self+world snapshot (JSON)',
        '  scan [radius=6]          tally nearby block types + ground height',
        '  find <block> [radius=32] locate nearest block of a type',
        '  block <x> <y> <z>        name of block at a coord',
        '  entities [radius=24]     nearby mobs/items/players',
        '  inventory', '  look <x> <y> <z>',
        ' movement:',
        '  come [player]            walk to a player (nearest if omitted)',
        '  goto <x> <y> <z> | goto <waypoint>', '  follow <player>', '  stop',
        '  turn <around|left|right|north|south|east|west>',
        '  remember <name>          save current spot as a waypoint',
        '  forget <name> | waypoints   manage saved places',
        ' survival/actions:',
        '  mine|break [block|x y z]  break a block; bare "break" chops nearest tree',
        '  gather <item> [count<=64] gather natural resources until count reached',
        '  collect                   pick up nearby dropped items',
        '  plant <item>              place a sapling on grass/dirt',
        '  place <item> [x y z]      place a block on a solid surface',
        '  craft <item> [count]      craft (walks to a table if needed)',
        '  hunt [animal]             kill a nearby animal for food',
        '  sleep | wake              sleep in a nearby bed / wake up',
        '  attack | defend           fight nearest hostile (flees creepers)',
        '  eat | drop <item> [n] | equip <item>',
        '  wear [armor]              put on armor you have (grabs dropped armor nearby first)',
        '  armorup                   get armor from nothing (hunt cows -> craft leather set)',
        '  planarmor                 armorup via the re-planning goal driver (A/B seam)',
        '  huttidy                   clean the hut interior (dig stray dirt, remove duplicate stations, reconcile registry)',
        ' building (op):',
        '  setblock <x> <y> <z> <block>',
        '  fill <x1 y1 z1 x2 y2 z2> <block>',
        '  wall <material> <length> <height>',
        '  tower <material> [height=10] [size=3]',
        '  house <material> [w=7] [l=7] [h=4]',
        '  schematic load <url|file>   load a .schem (direct link or local file)',
        '  schematic materials         list blocks the loaded build needs',
        '  schematic build [here|x y z]  build it in SURVIVAL from inventory (asks for materials)',
        '   (operators can also just SAY "build <name>" in chat - no ! needed)',
        '  provision [run]             plan/execute gathering+crafting the whole bill of materials',
        '  clear [radius=8]', '  give <item> [count]',
        ' admin:  tp <x> <y> <z> | gamemode <mode> | say <msg>'
      ].join('\n')

    case 'say': {
      // CHAT ONLY. mineflayer runs a leading "/" as a server command, and the
      // bot is op - so a brain-issued "say /stop" or "say /op x" would escape
      // normal play into server admin. Strip leading slashes so say can only
      // ever produce plain chat, never a command. Also bound the length.
      const msg = a.join(' ').replace(/^[\s/]+/, '').replace(/[\r\n]/g, ' ').trim()
      if (!msg) return 'nothing to say'
      bot.chat(msg.slice(0, 256)); return 'said'
    }

    case 'state':
      return JSON.stringify(state(bot))

    case 'block': {
      const [x, y, z] = a.map(Number)
      if ([x, y, z].some(Number.isNaN)) return 'usage: block <x> <y> <z>'
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) return 'unknown (chunk not loaded)'
      // blockstate properties too (facing/open/hinge...) - a bare name can't ground-truth
      // orientation bugs (the sideways-hung hut door hid behind 'oak_door' for hours)
      let props = ''
      try { const pr = b.getProperties(); if (pr && Object.keys(pr).length) props = ' ' + JSON.stringify(pr) } catch {}
      return b.name + props
    }

    case 'scan': {
      // Tally block types in a cube around the bot + report ground height.
      const r = Math.min(parseInt(a[0] || '6', 10), 12)
      const b = blockPos(bot)
      const counts = {}
      let minGroundY = Infinity; let maxGroundY = -Infinity
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          let surface = null
          for (let dy = r; dy >= -r; dy--) {
            const bl = bot.blockAt(new Vec3(b.x + dx, b.y + dy, b.z + dz))
            if (!bl || bl.name === 'air' || bl.name === 'cave_air' || bl.name === 'void_air') continue
            counts[bl.name] = (counts[bl.name] || 0) + 1
            if (surface === null) { surface = b.y + dy; minGroundY = Math.min(minGroundY, surface); maxGroundY = Math.max(maxGroundY, surface) }
          }
        }
      }
      const top = Object.entries(counts).sort((a2, b2) => b2[1] - a2[1]).slice(0, 8)
      return JSON.stringify({
        center: b, radius: r,
        groundY: minGroundY === Infinity ? null : { min: minGroundY, max: maxGroundY },
        blocks: Object.fromEntries(top)
      })
    }

    case 'find': {
      const name = a[0]
      if (!name) return 'usage: find <block> [radius=32]'
      const maxDistance = Math.min(parseInt(a[1] || '32', 10), 64)
      const mcData = require('minecraft-data')(bot.version)
      const def = mcData.blocksByName[name]
      if (!def) return `unknown block: ${name}`
      const found = bot.findBlock({ matching: def.id, maxDistance, count: 1 })
      if (!found) return `no ${name} within ${maxDistance}`
      const d = found.position.distanceTo(bot.entity.position)
      return `${name} at ${found.position.x},${found.position.y},${found.position.z} (dist ${d.toFixed(1)})`
    }

    case 'entities':
      return JSON.stringify(summariseEntities(bot, parseInt(a[0] || '24', 10)))

    case 'inventory':
      return JSON.stringify((bot.inventory ? bot.inventory.items() : []).map(i => `${i.name} x${i.count}`))

    case 'look': {
      // look at a point (updates lookingAt / blockAtCursor for surveying)
      const [x, y, z] = a.map(Number)
      if ([x, y, z].some(Number.isNaN)) return 'usage: look <x> <y> <z>'
      await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
      return `looking at ${x},${y},${z}`
    }

    case 'turn':
    case 'lookbehind': {
      // rotate the view: around/back, left, right, or a cardinal direction.
      // mineflayer yaw: 0=south, PI/2=west, PI=north, 3PI/2=east.
      const dir = (a[0] || 'around').toLowerCase()
      const cur = bot.entity.yaw
      const cardinals = { south: 0, west: Math.PI / 2, north: Math.PI, east: 3 * Math.PI / 2 }
      let yaw
      if (dir in cardinals) yaw = cardinals[dir]
      else if (['around', 'behind', 'back'].includes(dir)) yaw = cur + Math.PI
      // yaw increases south->west->north->east, so a right turn ADDS pi/2
      else if (dir === 'left') yaw = cur - Math.PI / 2
      else if (dir === 'right') yaw = cur + Math.PI / 2
      else return 'usage: turn <around|left|right|north|south|east|west>'
      bot.pathfinder.setGoal(null) // stop following so the turn isn't snapped back
      await bot.look(yaw, 0, true)
      return `turned ${dir} (now facing ${facing(bot.entity.yaw)})`
    }

    case 'give': {
      // creative material grab (for physical placement / survival-style builds)
      const item = a[0]
      const count = parseInt(a[1] || '64', 10)
      if (!item) return 'usage: give <item> [count]'
      bot.chat(`/give ${bot.username} ${item} ${count}`)
      return `gave ${count} ${item}`
    }

    case 'eat': return await eatFood(bot)
    case 'huntat': {
      // Operator points it at animals: "there are animals at 335 63 47" -> trek there and
      // hunt (the site DOES have sheep/pigs, just outside perception range). Remembers the
      // spot as a pasture so future famines return. Coords like travel.
      const x = Number(a[0]); const y = Number(a[1]); const z = Number(a[2])
      if ([x, y, z].some(n => Number.isNaN(n))) return 'huntat needs x y z'
      buildAbort = false; beginActivity('huntat', `${x},${y},${z}`)
      try {
        const say = m => bot.chat(String(m).slice(0, 200))
        say(`heading to ${x},${y},${z} to hunt`)
        try { await travelFar(bot, { x, y, z }, { isStopped: () => buildAbort, say }) } catch (e) { dbg('huntat travel: ' + e.message) }
        let kills = 0
        for (let k = 0; k < 6 && !buildAbort; k++) { if (!await provision.huntForFood(bot, { isStopped: () => buildAbort, range: 40 })) break; kills++ }
        if (kills > 0) { try { provision.rememberInfra('pasture', bot.entity.position) } catch {} }
        endActivity(kills > 0, `hunted ${kills} at ${x},${z}`)
        return kills > 0 ? `hunted ${kills} animal(s) at ${x},${y},${z} - remembered the pasture` : `got to ${x},${y},${z} but found no animals in range`
      } catch (e) { endActivity(false, e.message); return `couldn't get to ${x},${y},${z}: ${e.message}` }
    }
    case 'waterat': {
      // Operator points it at water: trek there + record it as 'water' infra so the wheat
      // farm / fishing use it. Coords like travel.
      const x = Number(a[0]); const y = Number(a[1]); const z = Number(a[2])
      if ([x, y, z].some(n => Number.isNaN(n))) return 'waterat needs x y z'
      buildAbort = false
      try {
        const say = m => bot.chat(String(m).slice(0, 200))
        say(`noting water at ${x},${y},${z}`)
        try { await travelFar(bot, { x, y, z }, { isStopped: () => buildAbort, say }) } catch (e) { dbg('waterat travel: ' + e.message) }
        try { provision.rememberInfra('water', { x, y, z }) } catch {}
        return `remembered water at ${x},${y},${z} - i'll farm/fish there when i need to`
      } catch (e) { return `couldn't get to ${x},${y},${z}: ${e.message}` }
    }
    case 'getfood':
    case 'securefood':
    case 'feed': {
      // Operator "there's food in your chest" / "go eat": deterministic bank-check-and-eat -
      // walk to the bank, FRESH-open it (never trust a stale empty), withdraw food, cook raw
      // at the furnace, eat. The autonomous secureFood chain, triggered on command; bypasses
      // the confined brain. Runs even while a secureFood lock is active only via this operator
      // path (the lock's guard returns fast if one's already running - honest, not silent).
      const before = bot.food
      const home = (provision.knownBed && provision.knownBed()) || undefined
      try { await provision.secureFood(bot, { home, threshold: 18, canHold: false, say: m => bot.chat(String(m).slice(0, 200)) }) } catch (e) { return `tried to get food but hit an error: ${e.message}` }
      const now = bot.food
      return now > before ? `got food and ate (food ${before} -> ${now})` : (provision.hasFood(bot) ? 'got food from the chest' : `checked the bank/food sources - nothing available right now (food ${now})`)
    }

    case 'drop':
    case 'toss': {
      // toss REAL items from inventory (not duped) - the legit way to share
      const name = a[0]
      if (!name) return 'usage: drop <item> [count]'
      const items = bot.inventory ? bot.inventory.items() : []
      const item = items.find(i => i.name === name) || items.find(i => i.name.includes(name))
      if (!item) return `no ${name} in inventory`
      let count = item.count
      if (a[1]) { const n = parseInt(a[1], 10); if (Number.isFinite(n) && n > 0) count = Math.min(n, item.count) }
      await bot.toss(item.type, null, count)
      return `dropped ${count} ${item.name}`
    }

    case 'equip':
    case 'wear':
    case 'armor':
    case 'armour':
    case 'hold': {
      // Hold OR wear an item. Armor pieces are routed to their body slot (head/
      // torso/legs/feet) so they're actually WORN, not just held; a shield goes to
      // the off-hand; everything else to the hand. "wear"/"armor" with no item (or
      // "equip armor"/"wear all") puts on EVERY armor piece you have - and first
      // picks up any armor a player just dropped nearby, so "put it on" just works.
      const arg = (a[0] || '').toLowerCase()
      const argAll = a.join(' ').toLowerCase() // the whole request, not just the first word
      // Treat as "put on ALL armor" when the request is about armor generally rather
      // than one specific piece. The local LLM phrases this many ways - "wear",
      // "wear armor", "wear iron_armor" (a made-up id), "equip gear", "wear my set",
      // "put it on" - so the WHOLE arg string mentioning armo(u)r/gear/set/kit/suit/
      // all/it counts, as does a bare wear/armor. A real piece ("wear diamond_helmet")
      // does NOT match (no such word) and still takes the single-item path below.
      const isArmorWord = /armo|gear|\bset\b|\bkit\b|\bsuit\b|\ball\b|everything|\bit\b/.test(argAll)
      const wantAll = cmd === 'armor' || cmd === 'armour' || // the verb itself means "armor up"
                      (cmd === 'wear' && !arg) ||             // bare "wear"
                      isArmorWord                            // any "...armor/gear/set..." phrasing
      if (wantAll) {
        await collectNearbyDrops(bot, { radius: 8 }) // grab dropped armor first
        const inv = bot.inventory ? bot.inventory.items() : []
        const worn = []
        let hadCandidate = false
        for (const slot of ['head', 'torso', 'legs', 'feet']) {
          const current = bot.inventory.slots[bot.getEquipmentDestSlot(slot)] || null
          const candidates = inv.filter(i => armorSlot(i.name) === slot)
          if (candidates.length) hadCandidate = true
          if (current) candidates.push(current) // keep what's on unless we can beat it
          const pick = bestArmor(candidates)
          // skip if nothing to wear, or the best is already the piece we're wearing
          // (never DOWNGRADE by putting on a weaker loose piece over a better worn one)
          if (!pick || (current && pick.name === current.name)) continue
          try { await bot.equip(pick, slot); worn.push(pick.name) } catch { /* slot busy / transient */ }
        }
        if (worn.length) return `put on ${worn.join(', ')}`
        return hadCandidate ? 'already wearing my best armor' : "no armor to put on - i don't have any"
      }
      const name = a[0]
      if (!name) return 'usage: equip <item>  (or "wear armor" to put on all your armor)'
      const items = bot.inventory ? bot.inventory.items() : []
      const item = items.find(i => i.name === name) || items.find(i => i.name.includes(name))
      if (!item) return `no ${name} in inventory (have: ${items.map(i => i.name).join(', ') || 'nothing'})`
      const slot = armorSlot(item.name)
      const dest = slot || (/shield/.test(item.name) ? 'off-hand' : 'hand')
      await bot.equip(item, dest)
      return slot ? `put on ${item.name}` : `equipped ${item.name}`
    }
    case 'planarmor': // force the PLANNER gear-up path (A/B seam - same job, re-planning driver)
    case 'armorup':
    case 'gearup': {
      // Actively GET armored from nothing: wear what we have; leather only if cows are
      // actually around, else the IRON bootstrap (mine -> smelt -> craft -> wear).
      // Unlike `wear` (which only equips armor already in the pack), this ACQUIRES it.
      // Marks the body BUSY for the duration: the iron grind is a real job and the
      // brain's side-trips (goto trader, wander) must not yank the pathfinder mid-mine
      // - that tug-of-war is exactly the old naked-at-the-hut carousel.
      if (isBusy()) return 'busy with a job - armor has to wait its turn'
      buildAbort = false // a previous stop must not abort this fresh request
      provisioning = true
      beginActivity('gearup', 'armor')
      try {
        // anchor the grind at HOME when home is nearby (bank + furnace live there);
        // far afield, anchor where we stand and let the resource model do its thing
        const kb = provision.knownBed && provision.knownBed()
        const at = (kb && bot.entity && Math.hypot(kb.x - bot.entity.position.x, kb.z - bot.entity.position.z) <= 64) ? kb : undefined
        // SEAM: the RE-PLANNING goal driver (bot/planner.js) OWNS gear-up now - it
        // re-routes around blocked steps (hut apron, unreachable iron), regroups to open
        // ground to craft, and gears up cheapest-piece-first (boots ASAP) instead of the
        // fixed bootstrap script that declared failure and backed off 20 minutes. Verified
        // end-to-end naked->armor on the test server (slices 1/1.1/1.2). It is the DEFAULT
        // for armorup/gearup (and therefore the idle gear reflex); `planarmor` also forces
        // it. The old ironArmorBootstrap/provisionArmor path stays reachable for rollback
        // via PLANNER_GEARUP=0.
        const usePlanner = cmd === 'planarmor' || process.env.PLANNER_GEARUP !== '0'
        const sayFn = m => bot.chat(String(m).slice(0, 256))
        const r = usePlanner
          ? (await planner.gearUp(bot, { say: sayFn, isStopped: () => buildAbort, at, restoreMovements: () => setupMovements(bot) })).msg
          : await provisionArmor(bot, { say: sayFn, isStopped: () => buildAbort, at })
        endActivity(!/still no armor|no progress|cooling off/.test(r), r)
        return r
      } catch (e) { endActivity(false, e.message); throw e } finally { provisioning = false }
    }

    case 'huttidy':
    case 'tidyhut':
    case 'cleanhut': {
      // INTERIOR CLEANUP with a verified postcondition: dig every stray dirt/filler in the
      // hut interior (floor piles + head-height pillar remnants), remove duplicate in-hut
      // stations (one table + one furnace), fill floor holes, RE-RUN until a fresh world
      // read confirms it's clean, then reconcile the (corrupted) infra registry against the
      // world. Operator-triggerable to fix a dirty live hut. Marks the body busy so no
      // reflex re-clutters mid-sweep (the arbiter maneuver + isBusy both hold).
      if (isBusy()) return 'busy with a job - hut cleanup has to wait its turn'
      buildAbort = false
      provisioning = true
      beginActivity('huttidy', 'hut interior')
      try {
        const say = m => bot.chat(String(m).slice(0, 256))
        const r = await provision.cleanupHutInterior(bot, null, { say, isStopped: () => buildAbort })
        const msg = r.ok
          ? `hut is tidy - dug ${r.dug} stray block(s), removed ${r.removedDupes} duplicate station(s) in ${r.passes} pass(es); registry reconciled`
          : `hut cleanup incomplete after ${r.passes} pass(es) - still: ${r.remaining.join(', ')} (dug ${r.dug}, removed ${r.removedDupes})`
        endActivity(r.ok, msg)
        return msg
      } catch (e) { endActivity(false, e.message); throw e } finally { provisioning = false }
    }

    case 'come': {
      const t = findPlayer(bot, a[0])
      if (!t) return `no player ${a[0] || 'nearby'}`
      // FAR player? Stage-travel toward them first (a single pathfind can't cross
      // hundreds of blocks - unloaded chunks + A* budget), bridging/climbing en route,
      // then do the precise arrival. Re-reads their live position after travelling.
      const me = bot.entity.position
      if (Math.hypot(t.position.x - me.x, t.position.z - me.z) > 80) {
        buildAbort = false
        beginActivity('come', a[0] || 'player')
        const r = await travelFar(bot, { x: t.position.x, y: t.position.y, z: t.position.z }, { isStopped: () => buildAbort, say: m => bot.chat(String(m).slice(0, 256)) })
        if (!r.ok && r.dist > 80) { endActivity(false, r.reason); return `couldn't get to ${a[0] || 'you'}: ${r.reason} (~${Math.round(r.dist)} blocks off)` }
        endActivity(true, 'reached travel range')
      }
      // Robust arrival: retries + settles for the nearest reachable spot instead of
      // freezing at a wall. Blocks until done so the brain doesn't wander off mid-walk.
      return await comeToPlayer(bot, a[0])
    }
    case 'recover':
    case 'getstuff': {
      // MUTEX: two concurrent recovers (brain fired twice + an operator one) raced each
      // other's inventory diffs - "gained 90" that wasn't real, ledger marked done, 50
      // oak despawned in the still-standing grave (live). One recovery at a time.
      if (recovering) return 'already recovering - give me a second'
      recovering = true
      try { return await doRecover() } finally { recovering = false }
      async function doRecover () {
      // Go back to the most VALUABLE unretrieved grave and actually reclaim it. SAFE: never
      // returns to a lava/fire death, bails if lava/fire has since appeared. Stage-travels
      // if far. HONEST: verifies items actually landed in the pack before marking the grave
      // done (it used to say "grabbed what i could" after picking up nothing, forever).
      const d = bestGrave()
      if (!d) {
        const burned = deathLedger.find(x => !x.retrieved && x.dangerous)
        if (burned) { burned.retrieved = true; persistDeath(); return `i died in lava/fire at ${burned.x},${burned.y},${burned.z} - my stuff burned up, not walking back into that` }
        const junk = deathLedger.find(x => !x.retrieved && !x.dangerous)
        if (junk) { junk.retrieved = true; persistDeath(); return `i died with nothing worth going back for - letting it go` }
        return "i haven't died recently - nothing to go get"
      }
      // NOTE: recover deliberately does NOT touch the global buildAbort. Resetting it
      // ("so an old stop doesn't kill the fresh recover") UN-ABORTED every zombie flow
      // mid-flight - three trek loops resurrected and fought over the bot (live, 20:47).
      // Recovery's own travels ignore stop; it's short and the operator can wait it out.
      // NIGHT GATE: a naked corpse-run in the dark is how death carousels start (the brain
      // fires `recover` the moment it sees the grave, respawn is at night, armor is IN the
      // grave). Sleep/shelter first - BUT (task #18) AxGraves graves despawn on a timer, they do
      // NOT keep: a near, about-to-despawn grave (urgent/critical tier within GRAVE_NEAR_LADDER)
      // is grabbed FIRST - arm's reach IS the survival move (same S1 near-override argument) - and
      // the rest happens after. Far + night + under-armored still rests (the night trek IS the loop).
      const meNight = bot.entity && bot.entity.position
      const graveDistNight = meNight ? Math.hypot(d.x - meNight.x, d.z - meNight.z) : Infinity
      const urgentNear = process.env.GRAVE_URGENT !== '0' && graveUrgency(d).tier !== 'safe' && graveDistNight <= Number(process.env.GRAVE_NEAR_LADDER || 32)
      if (provision.isNight(bot) && provision.underArmored(bot) && !urgentNear) {
        try { bot.chat('night and no gear - resting before i go get my stuff') } catch {}
        try { await provision.restUntilSafe(bot, { isStopped: () => false }) } catch {}
      } else if (urgentNear && provision.isNight(bot) && provision.underArmored(bot)) {
        try { bot.chat("grave's about to despawn and it's right here - grabbing it before it's gone, then i'll rest") } catch {}
      }
      const me = bot.entity.position
      if (Math.hypot(d.x - me.x, d.z - me.z) > 80) {
        beginActivity('recover', `${d.x},${d.y},${d.z}`)
        const r = await travelFar(bot, { x: d.x, y: d.y, z: d.z }, { isStopped: () => false, say: m => bot.chat(String(m).slice(0, 256)) })
        if (!r.ok && r.dist > 24) { endActivity(false, r.reason); return `couldn't get back to where i died (${d.x},${d.y},${d.z}): ${r.reason}` }
        endActivity(true, 'reached death site')
      }
      try { await gotoTimedDA(bot, new goals.GoalNear(d.x, d.y, d.z, 2), 20000) } catch {} // full ladder - graves end up in pits/caves
      // Safety re-check: if lava/fire is right here now, don't dive in for a few items.
      const here = bot.entity.position.floored()
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const b = bot.blockAt(new Vec3(here.x + dx, here.y + dy, here.z + dz))
        if (b && /lava|fire/.test(b.name)) { return `there's lava where i died - leaving my stuff, not worth dying again` }
      }
      const invTotal = () => { try { return bot.inventory.items().reduce((s, i) => s + i.count, 0) } catch { return 0 } }
      const before = invTotal()
      // 1) loose VANILLA drops first (this must work on any server, graves plugin or not).
      //    A full-inventory death scatters 30+ stacks down slopes/water - sweep wide and
      //    keep sweeping until the area is clean, not the old 6-stacks-and-quit.
      await collectNearbyDrops(bot, { radius: 12, max: 40, deadlineMs: 45000 })
      // TASK #18 REVISIT LOOP (GRAVE_URGENT, default on): the #1 live partial cause is the AxGraves
      // GUI auto-close race / zero-progress break ending a visit at 2 of ~140 items while the grave is
      // STILL PRESENT under the bot's feet - the old "going back for it" then delegated to a cooldown
      // that lost the despawn race. Wrap the scan->interact->loot->verdict block below in a bounded
      // in-place revisit: on an honest partial with the grave still present and pack room, re-open it
      // NOW. Triple-bounded: <= GRAVE_REVISIT_TRIES re-opens, a GRAVE_RECOVER_MS whole-visit wall
      // clock, PLUS the inner fix-#12 pass/time/zero-progress bounds. GRAVE_URGENT=0 -> 0 revisits =
      // ONE pass = byte-equivalent to today (the loop runs exactly once and returns as before).
      const GRAVE_URGENT_ON = process.env.GRAVE_URGENT !== '0'
      const GRAVE_REVISIT_TRIES = GRAVE_URGENT_ON ? Number(process.env.GRAVE_REVISIT_TRIES || 2) : 0
      const GRAVE_RECOVER_MS = Number(process.env.GRAVE_RECOVER_MS || 90000)
      const recoverStart = Date.now()
      for (let visit = 0; visit <= GRAVE_REVISIT_TRIES; visit++) { // body below is one visit; `before` (cumulative gain) stays captured above
      // 2) the GRAVE: AxGraves graves are ENTITIES (item/text displays + an interaction
      //    entity), NOT blocks - the old activateBlock at the death coords never opened one
      //    (verified live: an uncollected grave with tools stood for hours). Right-click
      //    every display-ish entity near the death point; if a grave GUI opens, empty it.
      //
      //    HARDENED (live: "my grave is right here but it won't open" + "0 grave-candidate
      //    entities" at real graves): (a) entities STREAM IN after chunk load - re-scan for
      //    up to 5s instead of trusting the first instant's empty list; (b) AxGraves
      //    listens for PlayerInteractAtEntity - a plain 'interact' packet can be ignored,
      //    so try interact_at (position-qualified) first, then plain interact, then a
      //    PUNCH (AxGraves' instant-pickup path) - it's the bot's own grave. Each attempt
      //    is verified by a window opening or items landing; stop at the first that works.
      const graveScan = () => Object.values(bot.entities || {}).filter(e => e && e.position &&
        Math.abs(e.position.y - d.y) <= 3 && Math.hypot(e.position.x - d.x, e.position.z - d.z) <= 4 &&
        /armor_stand|item_display|block_display|text_display|interaction|item_frame|glow_item_frame/.test(e.name || ''))
      let cands = graveScan()
      if (visit === 0) { for (let w = 0; w < 10 && !cands.length; w++) { await new Promise(r => setTimeout(r, 500)); cands = graveScan() } }
      else { await new Promise(r => setTimeout(r, 500)); cands = graveScan() } // revisit: brief settle + single rescan (already standing at the grave)
      dbg('recover: ' + cands.length + ' grave-candidate entities near ' + d.x + ',' + d.y + ',' + d.z + (cands.length ? ' (' + cands.map(e => e.name).join(',') + ')' : ''))
      // fix #12 (GRAVE_LOOT_VERIFY, default on): a single unverified GUI sweep silently abandoned
      // raced shift-clicks (212 looted, 2 stragglers left, grave marked done forever). Sweep each
      // grave window up to GRAVE_LOOT_PASSES times, re-reading filled slots between passes, and
      // mark retrieved only when the window empties + a FRESH entity re-scan confirms it's gone
      // (or a bounded junk-only remainder no retry could move). GRAVE_LOOT_VERIFY=0 rolls back to
      // HEAD's single sweep + recorded*0.5 heuristic byte-equivalently. DESIGN-fix12-grave-stragglers.md.
      const GRAVE_LOOT_VERIFY_ON = process.env.GRAVE_LOOT_VERIFY !== '0'
      const GRAVE_LOOT_PASSES = Number(process.env.GRAVE_LOOT_PASSES || 4)
      const GRAVE_LOOT_MS = Number(process.env.GRAVE_LOOT_MS || 25000)
      let sawWindow = false      // any cand opened a GUI
      let allEmptied = true      // every opened window ended empty (AND across cands)
      const remaining = []       // {name,count} left in windows at close (concat across cands)
      let lootExhausted = false  // a pass loop burned its retry budget with slots still filled
      let lootPasses = 0         // total sweep passes (dbg suffix)
      for (const g of cands) {
        // no early-exit on item gain: a coincidental pickup (the operator dropped food
        // mid-recovery, live) aborted the loop before the grave was ever CLICKED
        try { await gotoTimed(bot, new goals.GoalNear(g.position.x, g.position.y, g.position.z, 2), 10000) } catch {}
        const invBefore = invTotal()
        const openedOrLooted = () => !!bot.currentWindow || invTotal() > invBefore
        for (const how of ['interact_at', 'interact', 'attack']) {
          try { await bot.lookAt(g.position.offset ? g.position.offset(0, 0.4, 0) : g.position, true) } catch {}
          try {
            if (how === 'interact_at' && typeof bot.activateEntityAt === 'function') await bot.activateEntityAt(g, g.position)
            else if (how === 'interact') await bot.activateEntity(g)
            else if (how === 'attack') await bot.attack(g)
          } catch (e) { dbg('recover: ' + how + ' on ' + g.name + ' failed (' + e.message + ')') }
          await new Promise(r => setTimeout(r, 700))
          if (openedOrLooted()) { dbg('recover: grave responded to ' + how + (bot.currentWindow ? ' (GUI open)' : ' (items popped)')); break }
        }
        // grave GUI variant: shift-click every filled container slot into the pack
        const w = bot.currentWindow
        if (w) {
          const end = w.inventoryStart != null ? w.inventoryStart : w.slots.length - 36
          const filled = () => { const out = []; for (let s = 0; s < end; s++) if (w.slots[s]) out.push(s); return out }
          if (!GRAVE_LOOT_VERIFY_ON) {
            // ROLLBACK (GRAVE_LOOT_VERIFY=0): today's single unverified sweep, byte-equivalent to HEAD.
            try {
              for (let s = 0; s < end; s++) { if (w.slots[s]) { try { await bot.clickWindow(s, 0, 1) } catch {} ; await new Promise(r => setTimeout(r, 120)) } }
            } finally { try { bot.closeWindow(w) } catch {} }
          } else {
            // BOUNDED retry loop: same shift-click + close, re-reading filled slots between passes so
            // a raced/refused click is retried. Triple-bounded (pass count, wall clock, two
            // zero-progress passes) - can never spin on a stuck grave.
            sawWindow = true
            const loopStart = Date.now()
            let zeroProgress = 0
            let prevRemain = filled().length
            let emptiedHere = false
            try {
              while (true) {
                if (bot.currentWindow !== w) break // AxGraves auto-closes the GUI when it empties/despawns
                const cur = filled()
                if (cur.length === 0) { emptiedHere = true; break }
                let free = 36; try { free = bot.inventory.emptySlotCount() } catch {}
                if (free <= 0) break // capacity stop - the verdict handles it
                if (lootPasses >= GRAVE_LOOT_PASSES) break
                if ((Date.now() - loopStart) > GRAVE_LOOT_MS) break
                if (zeroProgress >= 2) break // server is refusing these exact slots - a 5th pass is churn
                for (const s of cur) { if (w.slots[s]) { try { await bot.clickWindow(s, 0, 1) } catch {} ; await new Promise(r => setTimeout(r, 120)) } }
                lootPasses++
                await new Promise(r => setTimeout(r, 300)) // let server slot re-syncs land before re-reading
                const after = (bot.currentWindow === w) ? filled().length : 0
                let freeNow = 36; try { freeNow = bot.inventory.emptySlotCount() } catch {}
                dbg('recover: loot pass ' + lootPasses + ': ' + cur.length + ' -> ' + after + ' slots remain (free ' + freeNow + ')')
                if (after >= prevRemain) zeroProgress++; else zeroProgress = 0
                prevRemain = after
              }
              // record plain data for the verdict (READ before closing the window)
              if (bot.currentWindow === w) {
                const rem = filled()
                if (rem.length === 0) { emptiedHere = true } else {
                  for (const s of rem) { const it = w.slots[s]; if (it) remaining.push({ name: it.name, count: it.count }) }
                }
                if (rem.length > 0 && (lootPasses >= GRAVE_LOOT_PASSES || (Date.now() - loopStart) > GRAVE_LOOT_MS || zeroProgress >= 2)) lootExhausted = true
              } else if (prevRemain > 0) {
                // window vanished mid-pass with slots unread: emptied only if the last read was 0
                emptiedHere = false
              } else { emptiedHere = true }
              if (!emptiedHere) allEmptied = false
            } finally { try { bot.closeWindow(w) } catch {} }
          }
        }
        await collectNearbyDrops(bot, { radius: 12, max: 40, deadlineMs: 30000 })
      }
      // 3) legacy block-grave fallback (player heads etc.)
      const graveBlk = bot.blockAt(new Vec3(d.x, d.y, d.z)) || bot.blockAt(new Vec3(d.x, d.y + 1, d.z))
      if (invTotal() === before && graveBlk && graveBlk.name !== 'air') { try { await bot.activateBlock(graveBlk) } catch {} ; await collectNearbyDrops(bot, { radius: 12, max: 40, deadlineMs: 30000 }) }
      const gained = invTotal() - before
      const looseNearby = Object.values(bot.entities || {}).some(e => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 8)
      // Success means getting the GEAR back, not just any items: the operator dropping
      // food mid-recovery produced "+20 items" while the armor stayed in the grave, and
      // the grave got marked retrieved (live). Require at least one recorded notable.
      const wantNotable = d.items && d.items.notable && d.items.notable.length
      const gotNotable = !wantNotable || (bot.inventory ? bot.inventory.items() : []).some(i => d.items.notable.includes(i.name))
      const recorded = (d.items && d.items.count) || 0
      if (!GRAVE_LOOT_VERIFY_ON) {
        // ROLLBACK (GRAVE_LOOT_VERIFY=0): today's stale-cands presence + the recorded*0.5
        // heuristic, byte-equivalent to HEAD ba413bb.
        const stillSomething = cands.length > 0 || looseNearby
        dbg('recover: gained ' + gained + ' items, notable recovered: ' + gotNotable + ' (grave still present: ' + stillSomething + ')')
        if (gained > 0 && gotNotable) {
          if (stillSomething && recorded > 0 && gained < recorded * 0.5) {
            return `got some of my stuff at ${d.x},${d.y},${d.z} (+${gained} of ~${recorded}) - the grave still has the rest, going back for it` // NOT retrieved
          }
          d.retrieved = true; persistDeath()
          const left = unretrievedGraves()
          return `got my stuff back at ${d.x},${d.y},${d.z} (+${gained} items)${left ? ` - ${left} more grave${left > 1 ? 's' : ''} to visit` : ''}`
        }
        if (gained > 0 && stillSomething) return `picked up ${gained} loose items at ${d.x},${d.y},${d.z} but my gear is still in the grave - it won't open` // NOT retrieved
        if (!stillSomething) {
          d.retrieved = true; persistDeath()
          return `nothing left where i died at ${d.x},${d.y},${d.z} - it's gone`
        }
        return `my grave at ${d.x},${d.y},${d.z} is right here but it won't open - my stuff's stuck in it` // NOT marked retrieved - worth another try
      }
      // GRAVE_LOOT_VERIFY on: verify emptiness by a FRESH entity re-scan (give AxGraves a tick to
      // despawn an emptied grave's display entities), then let the pure verdict decide marking.
      await new Promise(r => setTimeout(r, 1000))
      const graveAfter = graveScan()
      const stillSomething = graveAfter.length > 0 || looseNearby
      let freeSlots = 36; try { freeSlots = bot.inventory.emptySlotCount() } catch {}
      const remainingCount = remaining.reduce((s, r) => s + (r.count || 0), 0)
      dbg('recover: gained ' + gained + ' items, notable recovered: ' + gotNotable + ' (grave still present: ' + stillSomething + ') (window emptied: ' + allEmptied + ', remaining: ' + remainingCount + ', passes: ' + lootPasses + ')')
      const verdict = graveLootVerdict({ sawWindow, emptied: allEmptied, remaining, exhausted: lootExhausted, freeSlots, gained, recorded, gotNotable, gravePresent: graveAfter.length > 0, looseNearby })
      // TASK #18: an honest PARTIAL with the grave STILL PRESENT and pack room -> re-open it IN PLACE
      // right now (bounded), instead of walking away and racing the despawn timer via a cooldown.
      // loose-only/unopened get ONE re-try (an entity that ignored 3 interact modes twice won't open
      // on the 4th); capacity is excluded by freeSlots>0; full/writeoff/gone are excluded by mark.
      if (GRAVE_URGENT_ON && visit < GRAVE_REVISIT_TRIES && graveAfter.length > 0 && freeSlots > 0 && !verdict.mark &&
          (Date.now() - recoverStart) < GRAVE_RECOVER_MS) {
        const revisitable = verdict.kind === 'partial' || ((verdict.kind === 'loose-only' || verdict.kind === 'unopened') && visit === 0)
        if (revisitable) {
          dbg('recover: ' + verdict.kind + ' + grave still present (' + graveAfter.length + ' ent) - re-opening in place (revisit ' + (visit + 1) + '/' + GRAVE_REVISIT_TRIES + ')')
          await new Promise(r => setTimeout(r, 2000)) // settle before the re-interact
          continue
        }
      }
      if (gained > 0 && gotNotable) {
        if (verdict.kind === 'capacity') return `got some of my stuff at ${d.x},${d.y},${d.z} (+${gained}) - pack's full, the grave still has the rest, going back for it` // NOT retrieved - come back after off-loading
        if (verdict.kind === 'writeoff-junk') {
          d.retrieved = true; persistDeath()
          const left = unretrievedGraves()
          return `got my stuff back at ${d.x},${d.y},${d.z} (+${gained} items) - left ${remainingCount} junk bits i couldn't pull${left ? ` - ${left} more grave${left > 1 ? 's' : ''} to visit` : ''}`
        }
        if (verdict.kind === 'loose-only') return `picked up ${gained} loose items at ${d.x},${d.y},${d.z} but my gear is still in the grave - it won't open` // NOT retrieved
        if (verdict.mark) {
          d.retrieved = true; persistDeath()
          const left = unretrievedGraves()
          return `got my stuff back at ${d.x},${d.y},${d.z} (+${gained} items)${left ? ` - ${left} more grave${left > 1 ? 's' : ''} to visit` : ''}`
        }
        // honest partial (gear/bulk left, window not emptied): NOT retrieved - the scheduler's 300s
        // cooldown re-dispatches and finishes it, exactly as today's <50% path.
        return `got some of my stuff at ${d.x},${d.y},${d.z} (+${gained} of ~${recorded}) - the grave still has the rest, going back for it`
      }
      // no recorded-notable back / gained 0: today's honest tails (:1570/:1571/:1575), fresh presence.
      if (gained > 0 && stillSomething) return `picked up ${gained} loose items at ${d.x},${d.y},${d.z} but my gear is still in the grave - it won't open` // NOT retrieved
      if (!stillSomething) {
        d.retrieved = true; persistDeath()
        return `nothing left where i died at ${d.x},${d.y},${d.z} - it's gone`
      }
      return `my grave at ${d.x},${d.y},${d.z} is right here but it won't open - my stuff's stuck in it` // NOT marked retrieved - worth another try
      } // end revisit loop (every path above returns or `continue`s; the last allowed visit always returns)
      return `my grave at ${d.x},${d.y},${d.z} - couldn't fully clear it, i'll try again` // defensive: unreachable while GRAVE_REVISIT_TRIES >= 0 (NOT marked retrieved)
      } // end doRecover
    }
    case 'goto': {
      // a named waypoint ("goto home") or explicit coords ("goto 10 -60 4")
      if (a[0] && Number.isNaN(Number(a[0]))) {
        const wp = memory.getWaypoint(a[0])
        if (!wp) {
          // Not a waypoint - maybe the brain meant a PLAYER ("goto Steve"). Match an
          // online player (tolerate a leading dot/@ the brain sometimes prepends) and
          // just come to them instead of erroring.
          const pname = a[0].replace(/^[.@]+/, '')
          const t = findPlayer(bot, pname)
          if (t) {
            buildAbort = false
            const me = bot.entity.position
            if (Math.hypot(t.position.x - me.x, t.position.z - me.z) > 80) {
              const r = await travelFar(bot, { x: t.position.x, y: t.position.y, z: t.position.z }, { isStopped: () => buildAbort, say: m => bot.chat(String(m).slice(0, 256)) })
              if (!r.ok && r.dist > 80) return `couldn't get to ${pname}: ${r.reason} (~${Math.round(r.dist)} blocks off)`
            }
            return await comeToPlayer(bot, pname)
          }
          return `no waypoint "${a[0]}" (known: ${memory.waypointNames().join(', ') || 'none'})`
        }
        try { await gotoTimedDA(bot, new goals.GoalNear(wp.x, wp.y, wp.z, 1), 20000) } catch (e) { return `couldn't reach ${a[0]}: ${e.message}` }
        // gotoTimed can resolve without actually arriving (pathfinder settles at the
        // closest reachable node) - verify the real distance so we never claim a lie.
        { const dp = bot.entity.position; const dd = Math.hypot(dp.x - wp.x, dp.z - wp.z); if (dd > 3) return `couldn't reach ${a[0]} - blocked ~${Math.round(dd)} blocks short` }
        return `arrived at ${a[0].toLowerCase()} (${wp.x},${wp.y},${wp.z})`
      }
      const [x, y, z] = a.map(Number)
      if ([x, y, z].some(Number.isNaN)) return 'usage: goto <x> <y> <z> | goto <waypoint>'
      // FAR targets can't be reached by one pathfind (unloaded chunks + A* budget),
      // so stage the trip: walk there in hops until close, then a precise approach.
      const me0 = bot.entity.position
      if (Math.hypot(x - me0.x, z - me0.z) > 80) {
        buildAbort = false // a previous "stop" must not abort this fresh trip
        const r = await travelFar(bot, { x, y, z }, { isStopped: () => buildAbort, say: m => bot.chat(String(m).slice(0, 256)) })
        if (!r.ok) return `couldn't get to ${x},${y},${z}: ${r.reason} (~${Math.round(r.dist)} blocks away)`
      }
      try { await gotoTimedDA(bot, new goals.GoalNear(x, y, z, 1), 20000) } catch (e) { return `got near ${x},${y},${z} but couldn't settle: ${e.message}` }
      // Verify we ACTUALLY arrived - gotoTimed can resolve at the closest reachable node
      // (walled off / no path) without reaching the goal; claiming "arrived" then would
      // feed the brain a false success.
      { const dp = bot.entity.position; const dd = Math.hypot(dp.x - x, dp.z - z); if (dd > 3) return `couldn't reach ${x},${y},${z} - blocked ~${Math.round(dd)} blocks away` }
      return `arrived at ${x},${y},${z}`
    }
    case 'travel': {
      // explicit long-distance walk (staged). Handy on its own and used before a
      // far-away build. Same staged logic goto uses for distant targets.
      // The brain writes "travel 244,64,169" (commas) - accept both separators.
      const [x, y, z] = a.join(' ').split(/[\s,]+/).filter(Boolean).slice(0, 3).map(Number)
      if ([x, y, z].some(Number.isNaN)) return 'usage: travel <x> <y> <z>'
      buildAbort = false
      beginActivity('travel', `${x},${y},${z}`)
      const r = await travelFar(bot, { x, y, z }, { isStopped: () => buildAbort, say: m => bot.chat(String(m).slice(0, 256)) })
      if (!r.ok) { endActivity(false, r.reason); return `couldn't get to ${x},${y},${z}: ${r.reason} (~${Math.round(r.dist)} blocks away)` }
      try { await gotoTimedDA(bot, new goals.GoalNear(x, y, z, 2), 20000) } catch {} // final approach may need a door (travel into the hut)
      endActivity(true, `arrived near ${x},${y},${z}`)
      return `arrived near ${x},${y},${z}`
    }
    case 'remember':
    case 'savepoint': {
      // save the bot's current spot as a named waypoint (persists across restarts)
      const name = a[0]
      if (!name) return 'usage: remember <name>  (saves your current location)'
      const wp = memory.setWaypoint(name, bot.entity.position)
      return wp ? `remembered "${name.toLowerCase()}" at ${wp.x},${wp.y},${wp.z}` : 'usage: remember <name>'
    }
    case 'forget': {
      const name = a[0]
      if (!name) return 'usage: forget <name>'
      return memory.removeWaypoint(name) ? `forgot "${name.toLowerCase()}"` : `no waypoint "${name}"`
    }
    case 'waypoints':
    case 'places': {
      const wps = memory.listWaypoints()
      const names = Object.keys(wps)
      if (!names.length) return 'no waypoints saved yet (use "remember <name>")'
      return JSON.stringify(Object.fromEntries(names.map(n => [n, `${wps[n].x},${wps[n].y},${wps[n].z}`])))
    }
    case 'follow': {
      const t = findPlayer(bot, a[0])
      if (!t) return `no player ${a[0] || 'nearby'}`
      followTarget = t.username // remember for sticky-follow (resume after interruptions)
      bot.pathfinder.setGoal(new goals.GoalFollow(t, FOLLOW_RANGE), true)
      return `following ${a[0] || 'nearest player'}`
    }
    case 'stop': {
      followTarget = null // end persistent follow - "stop" means stop
      buildAbort = true // also halts an in-progress schematic build
      resumeJob = null; buildInterrupted = false; resumeDeaths = 0 // drop the in-memory job; halt NOW
      bot.pathfinder.setGoal(null)
      if (!STOP_KEEPS_BUILD) { clearPersistedResume(); return 'stopped' } // rollback: today's destructive stop
      // stop = PAUSE, not destroy: keep the saved build (operator intent) and stamp a hold, so
      // a confused brain (instructed to emit `stop` when wedged) can never erase the castle -
      // autonomy resumes it after RESUME_HOLD_MS; only cancelbuild throws it away.
      const savedStop = persistedResume()
      if (!savedStop) return 'stopped'
      // A supervisor UNSTICK (frozen-vitals nudge: stop->recover) must NOT pause the build for the
      // full operator 15min - it only clears the wedged body so `recover` can run, then autonomy
      // resumes promptly. Label it distinctly (so it never reads as an operator stop) and use the
      // short hold. A real operator stop is unchanged (15min, "operator stop").
      const bySupervisor = opts.source === 'supervisor'
      const holdMs = bySupervisor ? SUPERVISOR_RESUME_HOLD_MS : RESUME_HOLD_MS
      markResumePaused(bySupervisor ? 'supervisor unstick' : 'operator stop', bySupervisor ? holdMs : null)
      const holdMin = Math.round(holdMs / 60000)
      return `stopped ("${savedStop.name}" stays saved - resuming in ~${holdMin}min; "resumebuild" to continue now, "cancelbuild" to drop it)`
    }

    case 'attack':
    case 'defend': {
      const me = bot.entity.position
      let target = null; let best = 16
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || e === bot.entity) continue
        if (e.type !== 'mob' && e.type !== 'hostile') continue // never players/animals/objects
        if (!HOSTILE.test(e.name || '') || /creeper/.test(e.name || '')) continue // never melee creepers
        const d = e.position.distanceTo(me)
        if (d < best) { best = d; target = e }
      }
      if (!target) return 'no hostile mobs nearby'
      const items = bot.inventory ? bot.inventory.items() : []
      const weapon = items.find(i => i.name.endsWith('_sword')) || items.find(i => i.name.endsWith('_axe'))
      if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
      await bot.lookAt(target.position.offset(0, 1, 0), true).catch(() => {})
      bot.attack(target)
      return `attacking ${target.name || 'mob'} (dist ${best.toFixed(1)})`
    }

    case 'mine':
    case 'break':
    case 'dig': {
      const mcData = require('minecraft-data')(bot.version)
      let target = null
      let requested = null // a SPECIFIC block/coords was asked for
      const nums = a.slice(0, 3).map(Number)
      if (a.length >= 3 && !nums.some(Number.isNaN)) {
        requested = 'there'
        target = bot.blockAt(new Vec3(nums[0], nums[1], nums[2]))
        if (target && target.name === 'air') target = null
      } else if (a[0] && Number.isNaN(Number(a[0]))) {
        requested = a[0]
        // anchored so crafted variants (polished_deepslate, deepslate_bricks,
        // raw_iron_block, moss_carpet, polished_blackstone...) don't leak in
        const MINABLE = /_log$|_wood$|_stem$|_ore$|ancient_debris|^stone$|^cobblestone$|^deepslate$|^dirt$|^coarse_dirt$|grass_block|^gravel$|^sand$|^red_sand$|^clay$|^andesite$|^diorite$|^granite$|^tuff$|^calcite$|^netherrack$|^basalt$|^blackstone$|^obsidian$|^moss_block$|^mud$|^pumpkin$|^melon$/
        const all = Object.values(mcData.blocksByName).filter(b => b.name === a[0] || b.name.includes(a[0]))
        const natural = all.filter(b => MINABLE.test(b.name))
        // natural resources -> search far; crafted/built blocks (planks/glass/...) ->
        // only break ones RIGHT HERE (<=4), so "break these planks" works but it
        // never wanders off to tear into a distant build.
        if (natural.length) target = bot.findBlock({ matching: natural.map(b => b.id), maxDistance: 32 })
        else if (all.length) target = bot.findBlock({ matching: all.map(b => b.id), maxDistance: 4 })
        else return `I don't recognize the block "${a[0]}"`
      }
      // If a SPECIFIC block was requested but not found, STOP - never fall back to
      // breaking whatever the bot happens to look at (that's how it broke a window).
      if (requested && !target) return `no ${requested === 'there' ? 'block there' : requested + ' nearby'}`
      if (!target && typeof bot.blockAtCursor === 'function') {
        const look = bot.blockAtCursor(5)
        if (look && look.name !== 'air') target = look // bare "break": the block we're looking at
      }
      if (!target) { // bare "break": default to the nearest tree
        const logIds = Object.values(mcData.blocksByName).filter(b => /_log$|_stem$/.test(b.name)).map(b => b.id)
        if (logIds.length) target = bot.findBlock({ matching: logIds, maxDistance: 16 })
      }
      if (!target || target.name === 'air') return 'no block or tree to break nearby'
      const isTree = /_log$|_stem$/.test(target.name)
      const logIds = Object.values(mcData.blocksByName).filter(b => /_log$|_stem$/.test(b.name)).map(b => b.id)
      let broke = 0
      let cur = target
      do {
        // re-pick the right tool for EACH block (auto-eat/defend may have swapped
        // the held item mid-chop). Only equip if not already holding it.
        const tool = bestTool(bot, cur.name)
        if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
        if (bot.entity.position.distanceTo(cur.position) > 4) {
          try { await gotoTimed(bot, new goals.GoalNear(cur.position.x, cur.position.y, cur.position.z, 2), 15000) } catch { break }
        }
        if (bot.canDigBlock && !bot.canDigBlock(cur)) break
        if (broke === 0) lastBrokeAt = cur.position.clone() // remember the base, for replanting
        try { await bot.dig(cur) } catch (e) { return broke ? `broke ${broke} log(s)` : `couldn't break ${cur.name}: ${e.message}` }
        broke++
        cur = isTree ? bot.findBlock({ matching: logIds, maxDistance: 5 }) : null // chop the whole tree
      } while (cur && broke < 8) // bounded so the brain isn't blocked too long (creeper exposure)
      return `broke ${broke} ${isTree ? 'log(s)' : target.name}`
    }

    case 'collect':
    case 'pickup': {
      // walk onto the nearest dropped item to pick it up (auto-collected on contact)
      let target = null; let best = 32
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position) continue
        if (e.name !== 'item') continue // real drops only (the 'item' entity type, not item_frames)
        const d = e.position.distanceTo(bot.entity.position)
        if (d < best) { best = d; target = e }
      }
      if (!target) return 'no dropped items nearby'
      try { await gotoTimed(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 0), 15000) } catch (e) { return `couldn't reach item: ${e.message}` }
      return 'went to pick up nearby items'
    }

    case 'plant': {
      const name = a[0]
      if (!name) return 'usage: plant <item>'
      const items = bot.inventory ? bot.inventory.items() : []
      const item = items.find(i => i.name === name) || items.find(i => i.name.includes(name))
      if (!item) return `no ${name} in inventory`
      const PLANTABLE = /grass_block|^dirt$|podzol|coarse_dirt|rooted_dirt|mud|moss_block|mycelium/
      let ref = null
      // 1) explicit coords
      const nums = a.slice(1, 4).map(Number)
      if (a.length >= 4 && !nums.some(Number.isNaN)) {
        const g = bot.blockAt(new Vec3(nums[0], nums[1] - 1, nums[2]))
        if (g && PLANTABLE.test(g.name)) ref = g
      }
      // 2) where we last chopped -> "plant where you broke the tree" (only if it's
      // still nearby, so a bare plant doesn't path back to an old, distant spot)
      if (!ref && lastBrokeAt && bot.entity.position.distanceTo(lastBrokeAt) < 12) {
        const g = bot.blockAt(lastBrokeAt.offset(0, -1, 0))
        const above = bot.blockAt(lastBrokeAt)
        if (g && PLANTABLE.test(g.name) && above && above.name === 'air') ref = g
      }
      // 3) nearest suitable ground to the bot
      if (!ref) {
        const b = blockPos(bot)
        for (let r = 1; r <= 4 && !ref; r++) {
          for (let dx = -r; dx <= r && !ref; dx++) {
            for (let dz = -r; dz <= r && !ref; dz++) {
              if (dx === 0 && dz === 0) continue
              const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1, b.z + dz))
              const above = bot.blockAt(new Vec3(b.x + dx, b.y, b.z + dz))
              if (ground && PLANTABLE.test(ground.name) && above && above.name === 'air') ref = ground
            }
          }
        }
      }
      if (!ref) return 'no grass/dirt with open space nearby to plant on'
      if (bot.entity.position.distanceTo(ref.position) > 4) { try { await gotoTimed(bot, new goals.GoalNear(ref.position.x, ref.position.y, ref.position.z, 2), 15000) } catch {} }
      await bot.equip(item, 'hand').catch(() => {})
      await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
      try { await bot.placeBlock(ref, new Vec3(0, 1, 0)) } catch (e) { return `couldn't plant ${item.name}: ${e.message}` }
      return `planted ${item.name} at ${ref.position.x},${ref.position.y + 1},${ref.position.z}`
    }

    case 'place': {
      // general physical placement onto any solid surface (torches, blocks, table...)
      const name = a[0]
      if (!name) return 'usage: place <item> [x y z]'
      const items = bot.inventory ? bot.inventory.items() : []
      const item = items.find(i => i.name === name) || items.find(i => i.name.includes(name))
      if (!item) return `no ${name} in inventory`
      let ref = null
      const nums = a.slice(1, 4).map(Number)
      if (a.length >= 4 && !nums.some(Number.isNaN)) ref = bot.blockAt(new Vec3(nums[0], nums[1] - 1, nums[2]))
      if (!ref) {
        const b = blockPos(bot)
        for (let r = 1; r <= 4 && !ref; r++) {
          for (let dx = -r; dx <= r && !ref; dx++) {
            for (let dz = -r; dz <= r && !ref; dz++) {
              if (dx === 0 && dz === 0) continue
              const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1, b.z + dz))
              const above = bot.blockAt(new Vec3(b.x + dx, b.y, b.z + dz))
              if (ground && ground.boundingBox === 'block' && above && above.name === 'air') ref = ground
            }
          }
        }
      }
      if (!ref) return 'no solid surface with open space nearby'
      await bot.equip(item, 'hand').catch(() => {})
      await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
      try { await bot.placeBlock(ref, new Vec3(0, 1, 0)) } catch (e) { return `couldn't place ${item.name}: ${e.message}` }
      return `placed ${item.name}`
    }

    case 'craft': {
      const name = a[0]
      if (!name) return 'usage: craft <item> [count]'
      const mcData = require('minecraft-data')(bot.version)
      const def = mcData.itemsByName[name] // recipesFor needs an ITEM id (block ids differ)
      if (!def) return `can't craft "${name}" (unknown item)`
      const count = Math.max(1, parseInt(a[1] || '1', 10))
      const tableId = mcData.blocksByName.crafting_table && mcData.blocksByName.crafting_table.id
      let table = tableId ? bot.findBlock({ matching: tableId, maxDistance: 4 }) : null
      let recipe = bot.recipesFor(def.id, null, 1, table)[0]
      if (!recipe && tableId) { // need a table - walk to the nearest one
        table = bot.findBlock({ matching: tableId, maxDistance: 48 })
        if (table) {
          try { await gotoTimed(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 15000) } catch {}
          recipe = bot.recipesFor(def.id, null, 1, table)[0]
        }
      }
      if (!recipe) return `can't craft ${name}${table ? ' (missing materials)' : ' (need a crafting table / materials)'}`
      try { await bot.craft(recipe, count, table) } catch (e) { return `couldn't craft ${name}: ${e.message}` }
      return `crafted ${count}x ${name}`
    }

    case 'hunt': {
      // kill a passive animal (for food/resources). Defaults to common food mobs.
      const want = (a[0] || '').toLowerCase()
      const FOOD = /cow|pig|chicken|sheep|rabbit|mooshroom|goat/
      let target = null; let best = 24
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || (e.type !== 'mob' && e.type !== 'animal')) continue
        const n = (e.name || '').toLowerCase()
        if (want ? !n.includes(want) : !FOOD.test(n)) continue
        const d = e.position.distanceTo(bot.entity.position); if (d < best) { best = d; target = e }
      }
      if (!target) return `no ${want || 'animal'} nearby`
      const weapon = (bot.inventory ? bot.inventory.items() : []).find(i => i.name.endsWith('_sword')) || (bot.inventory ? bot.inventory.items() : []).find(i => i.name.endsWith('_axe'))
      if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      let hits = 0
      while (target.isValid && hits < 8) { // bounded so the brain isn't frozen too long
        if (bot.entity.position.distanceTo(target.position) <= 3.5) {
          await bot.lookAt(target.position.offset(0, (target.height || 1) * 0.7, 0)).catch(() => {})
          bot.attack(target); hits++
        }
        await new Promise(r => setTimeout(r, 600))
      }
      bot.pathfinder.setGoal(null)
      return target.isValid ? `chasing ${want || 'animal'}` : `hunted ${want || 'animal'}`
    }

    case 'sleep': {
      const mcData = require('minecraft-data')(bot.version)
      const bedIds = Object.values(mcData.blocksByName).filter(b => /_bed$/.test(b.name)).map(b => b.id)
      const bed = bedIds.length ? bot.findBlock({ matching: bedIds, maxDistance: 48 }) : null // 16 was so tight 'go sleep' failed 19 blocks from the bed
      if (!bed) {
        // no bed in scan range - but if we REMEMBER our bed, go sleep in it like a player
        // (night only: nightRest's fallback digs a pit, which makes no sense at noon)
        const kb = provision.knownBed && provision.knownBed()
        if (kb && provision.isNight(bot)) { const ok = await provision.nightRest(bot, { say: m => bot.chat(String(m).slice(0, 200)) }); return ok ? 'slept in my own bed' : `couldn't make it to my bed at ${kb.x},${kb.y},${kb.z}` }
        if (kb) return `no bed nearby (mine's at ${kb.x},${kb.y},${kb.z} - i'll head there at night)`
        return 'no bed nearby'
      }
      if (bot.entity.position.distanceTo(bed.position) > 3) { try { await gotoTimed(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 30000) } catch {} }
      try { await bot.sleep(bed) } catch (e) {
        // Can't sleep now (daytime / mobs) - but USING the bed still sets the respawn
        // point in modern MC, which is usually what the operator wants ("set your spawn
        // there"). Do that instead of just failing.
        try { await bot.activateBlock(bed); provision.rememberBed(bed.position); return `can't sleep now (${e.message}) - but i set my spawn at this bed` } catch {}
        return `can't sleep: ${e.message}`
      }
      provision.rememberBed(bed.position) // bed memory: nights head here first from now on
      return 'sleeping (spawn set here)'
    }
    case 'fish': {
      // fish until a few meals are in the pack (rod crafted from sticks+string if needed)
      beginActivity('fish', 'nearest water')
      const ok = await provision.fishForFood(bot, { isStopped: () => buildAbort, say: m => bot.chat(String(m).slice(0, 200)) })
      endActivity(ok, ok ? 'caught dinner' : 'no luck')
      return ok ? 'got some fish in the pack' : "couldn't fish here (no rod/string, no water, or no bites)"
    }

    case 'shove':
    case 'nudge': {
      // DIRECT-CONTROL escape hatch for drivers (operator/Sonnet shepherd): face the
      // given x z and jump+sprint at it for ~2s, no pathfinder involved. This is the
      // manual maneuver that breaks physical wedges the planner can't solve (1-deep
      // water, terrain lips, own-orchard pins - all seen live tonight).
      const nx = Number(a[0]); const nz = Number(a[1])
      if (Number.isNaN(nx) || Number.isNaN(nz)) return 'usage: shove <x> <z>'
      const p0 = bot.entity.position.clone()
      try {
        bot.pathfinder.setGoal(null)
        await bot.lookAt(new Vec3(nx, bot.entity.position.y + 1, nz), true)
        bot.setControlState('jump', true); bot.setControlState('forward', true); bot.setControlState('sprint', true)
        await new Promise(r => setTimeout(r, 2000))
      } finally { bot.clearControlStates() }
      const p1 = bot.entity.position
      const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z)
      return `shoved ${moved.toFixed(1)} blocks toward ${nx},${nz}`
    }

    case 'wake':
    case 'wakeup': {
      try { await bot.wake() } catch (e) { return `couldn't wake: ${e.message}` }
      return 'awake'
    }

    case 'setblock': {
      const [x, y, z] = a.slice(0, 3).map(Number)
      const block = a[3]
      if (!block || [x, y, z].some(Number.isNaN)) return 'usage: setblock <x> <y> <z> <block>'
      setblock(bot, x, y, z, block); return `setblock ${block} @ ${x},${y},${z}`
    }
    case 'fill': {
      const n = a.slice(0, 6).map(Number)
      const block = a[6]
      if (!block || n.some(Number.isNaN)) return 'usage: fill <x1 y1 z1 x2 y2 z2> <block>'
      fill(bot, ...n, block); return `filled ${block}`
    }
    case 'wall': {
      const material = a[0] || 'stone'
      const length = parseInt(a[1] || '5', 10)
      const height = parseInt(a[2] || '3', 10)
      return buildWall(bot, material, length, height, anchorInFront(bot))
    }
    case 'tower': {
      const material = a[0] || 'stone'
      const height = parseInt(a[1] || '10', 10)
      const size = parseInt(a[2] || '3', 10)
      return buildTower(bot, material, height, size, anchorInFront(bot))
    }
    case 'house': {
      const material = a[0] || 'oak_planks'
      const w = parseInt(a[1] || '7', 10)
      const l = parseInt(a[2] || '7', 10)
      const h = parseInt(a[3] || '4', 10)
      return buildHouse(bot, material, w, l, h, anchorInFront(bot, 2))
    }
    case 'clear': {
      const r = parseInt(a[0] || '8', 10)
      const b = blockPos(bot)
      fill(bot, b.x - r, b.y, b.z - r, b.x + r, b.y + r, b.z + r, 'air')
      return `cleared r${r} around ${b.x},${b.y},${b.z}`
    }
    case 'schem':
    case 'schematic': {
      // Load and physically build a schematic IN SURVIVAL (real blocks from
      // inventory, placed by hand - no /fill or creative). Operator-only (in
      // CHEAT_CMDS) so the autonomous brain can't fetch URLs / build on its own.
      const sub = (a[0] || '').toLowerCase()
      if (sub === 'load') {
        const src = a[1]
        if (!src) return 'usage: schematic load <url|file>  (url must be a DIRECT .schem link, e.g. buildingguide.app/schematics/<name>.schem)'
        try {
          if (/^https?:\/\//i.test(src)) {
            const buf = await schematic.download(src)
            const name = schematic.nameFromUrl(src)
            schematic.saveLocal(name, buf) // cache locally so a rebuild needs no re-download
            loadedSchem = { schem: await schematic.readSchematic(buf, bot.version), name }
          } else {
            loadedSchem = { schem: await schematic.loadFile(src, bot.version), name: src }
          }
        } catch (e) { return `couldn't load schematic: ${e.message}` }
        const s = loadedSchem.schem.size
        const m = schematic.materialsSummary(loadedSchem.schem)
        // Anything taller than ~3 blocks needs scaffolding to reach - the bot
        // pillars up with cheap filler blocks (verified live: no dirt = no roof).
        const scaffold = s.y > 3 ? ' - and a stack of dirt/cobblestone so I can scaffold up to reach the top' : ''
        return `loaded "${loadedSchem.name}" (${s.x}x${s.y}x${s.z}). Bring me - ${m.text}${scaffold}`
      }
      if (sub === 'materials' || sub === 'mats' || sub === 'bom') {
        if (!loadedSchem) return 'no schematic loaded - schematic load <url|file> first'
        return schematic.materialsSummary(loadedSchem.schem).text
      }
      if (sub === 'build') {
        if (!loadedSchem) return 'no schematic loaded - schematic load <url|file> first'
        if (building) return 'already building - say "stop" to cancel first'
        // Origin: "here" (bot's feet) or explicit coords. Optional trailing "clear"
        // flattens the footprint first so the build completes on unflat ground.
        const rest = a.slice(1)
        const doClear = rest.some(t => t.toLowerCase() === 'clear')
        let originArgs = rest.filter(t => t.toLowerCase() !== 'clear')
        // "center" makes the reference point (coords, or "here" = bot's feet) the
        // MIDDLE of the footprint instead of the origin corner. The natural-language
        // "build it here" path uses this so the build is centred on where you stand.
        let center = false
        if (originArgs[0] && originArgs[0].toLowerCase() === 'center') { center = true; originArgs = originArgs.slice(1) }
        let at
        if (!originArgs.length || originArgs[0] === 'here') { const p = blockPos(bot); at = new Vec3(p.x, p.y, p.z) } else {
          const n = originArgs.slice(0, 3).map(Number)
          if (n.some(Number.isNaN)) return 'usage: schematic build [here | [center] <x> <y> <z>] [clear]'
          at = new Vec3(n[0], n[1], n[2])
        }
        // Centre horizontally on the reference point; keep Y as the base so the
        // build rises from the ground (centring Y too would bury the lower half).
        if (center) {
          const st = loadedSchem.schem.start(); const en = loadedSchem.schem.end()
          at = new Vec3(
            at.x - Math.floor((st.x + en.x) / 2),
            at.y - st.y,
            at.z - Math.floor((st.z + en.z) / 2)
          )
        }
        at = snapToGround(bot, loadedSchem.schem, at) // sit it on the ground, never floating
        building = true; buildAbort = false
        // Long-running (minutes) - run detached, chat progress, and return the
        // kickoff line now so the command/HTTP call doesn't block for the whole build.
        schematic.buildSurvival(bot, loadedSchem.schem, at, {
          say: throttledSay(bot),
          isStopped: () => buildAbort,
          restoreMovements: () => setupMovements(bot),
          clear: doClear
        }).then(r => {
          building = false
          bot.chat(`build ${r.stopped ? 'stopped' : 'done'}: ${r.placed}/${r.total} placed${r.skipped ? `, ${r.skipped} skipped` : ''}`)
        }).catch(e => {
          building = false; setupMovements(bot)
          bot.chat(`build error: ${e.message}`)
        })
        return `building "${loadedSchem.name}" at ${at.x},${at.y},${at.z} in survival${doClear ? ' (clearing the site first)' : ''} - I'll ask for materials as I go. Say "stop" to cancel.`
      }
      if (sub === 'clear') {
        // Flatten a build site by hand: empty the loaded schematic's whole box.
        if (!loadedSchem) return 'no schematic loaded - schematic load <url|file> first'
        if (building) return 'already building - say "stop" to cancel first'
        const rest = a.slice(1)
        let at
        if (!rest.length || rest[0] === 'here') { const p = blockPos(bot); at = new Vec3(p.x, p.y, p.z) } else {
          const n = rest.slice(0, 3).map(Number)
          if (n.some(Number.isNaN)) return 'usage: schematic clear [here | <x> <y> <z>]'
          at = new Vec3(n[0], n[1], n[2])
        }
        building = true; buildAbort = false
        schematic.clearVolume(bot, loadedSchem.schem, at, { isStopped: () => buildAbort })
          .then(rm => { building = false; setupMovements(bot); bot.chat(`cleared ${rm} block(s) - site flat at ${at.x},${at.y},${at.z}, ready to build`) })
          .catch(e => { building = false; setupMovements(bot); bot.chat(`clear error: ${e.message}`) })
        return `clearing the build site at ${at.x},${at.y},${at.z} in survival - say "stop" to cancel.`
      }
      return 'usage: schematic <load <url|file> | materials | build [here | [center] x y z] [clear] | clear [here|x y z]>'
    }

    case 'gather': {
      // Gather natural resources by hand (chop trees / mine natural blocks) until
      // a count is reached. Natural-player action, so brain-accessible - but
      // capped per call so it can't strip a landscape on one decision.
      const item = a[0]
      const count = Math.min(parseInt(a[1] || '16', 10) || 16, 64)
      if (!item) return `usage: gather <item> [count<=64]  (know how: ${Object.keys(provision.GATHER_SOURCES).join(', ')})`
      if (!provision.GATHER_SOURCES[item]) return `I don't know how to gather ${item} (know: ${Object.keys(provision.GATHER_SOURCES).join(', ')})`
      buildAbort = false // a PREVIOUS stop must not abort this fresh gather
      beginActivity('gather', `${count}x ${item}`)
      const r = await provision.runGather(bot, item, count, { isStopped: () => buildAbort, restoreMovements: () => setupMovements(bot), homeY: Math.floor(bot.entity.position.y) })
      endActivity(r.gathered >= count, `${r.gathered}/${count} ${item}: ${r.reason}`)
      return `gathered ${r.gathered}/${count} ${item} (${r.reason})`
    }

    case 'provision': {
      // Plan (and run) acquiring the loaded schematic's ENTIRE bill of materials
      // from nothing: gather -> craft tools/basics -> mine -> smelt -> strip ->
      // craft finals. Operator-only like schematic - a long autonomous action.
      if (!loadedSchem) return 'no schematic loaded - schematic load <url|file> first'
      const mcData = require('minecraft-data')(bot.version)
      const bom = { ...schematic.billOfMaterials(loadedSchem.schem).counts }
      // scaffold dirt for anything the bot can't reach from the ground - verified
      // live: without pillar blocks the roof of even a 3-tall box is unreachable
      if (loadedSchem.schem.size.y > 2) bom.dirt = (bom.dirt || 0) + 8 + 2 * loadedSchem.schem.size.y
      const plan = provision.planProvision(mcData, bom, provision.inventoryCounts(bot), { furnacesNearby: provision.countFurnacesNear(bot) })
      const planLines = plan.tasks.map(t =>
        t.type === 'gather' ? `gather ${t.count}x ${t.item}${t.tool ? ` [${t.tool}]` : ''}`
          : t.type === 'craft' ? `craft ${t.crafts * t.perCraft}x ${t.item}${t.needsTable ? ' (table)' : ''}`
            : t.type === 'smelt' ? `smelt ${t.count}x ${t.output}`
              : t.type === 'strip' ? `strip ${t.count}x ${t.output}`
                : JSON.stringify(t))
      const unob = Object.entries(plan.unobtainable).map(([n, c]) => `${c}x ${n}`)
      if ((a[0] || '').toLowerCase() !== 'run') {
        if (!plan.tasks.length && !unob.length) return 'inventory already covers the bill of materials - ready to build'
        return `plan (${plan.tasks.length} steps): ${planLines.join('; ')}${unob.length ? ` | CAN'T OBTAIN: ${unob.join(', ')}` : ''} - "provision run" to execute`
      }
      if (provisioning) return 'already provisioning - say "stop" to cancel first'
      if (unob.length) return `can't provision: no way to obtain ${unob.join(', ')}`
      if (!plan.tasks.length) return 'inventory already covers the bill of materials - ready to build'
      provisioning = true; buildAbort = false
      beginActivity('provision', `${plan.tasks.length} steps`)
      // long-running: run detached (like schematic build), chat progress
      provision.runPlan(bot, plan, {
        say: throttledSay(bot),
        isStopped: () => buildAbort,
        restoreMovements: () => setupMovements(bot)
      }).then(results => {
        provisioning = false
        const bad = results.filter(r => !r.ok)
        endActivity(!bad.length, bad.length ? bad.map(r => `${r.task.item || r.task.output}: ${r.note}`).join('; ') : 'have everything', { detached: true })
        bot.chat(bad.length
          ? `provisioning stopped: ${bad.map(r => `${r.task.type} ${r.task.item || r.task.output}: ${r.note}`).join('; ')}`.slice(0, 256)
          : 'provisioning done - I have everything, ready to build')
      }).catch(e => { provisioning = false; endActivity(false, e.message, { detached: true }); bot.chat(`provisioning error: ${e.message}`.slice(0, 250)) })
      return `provisioning ${plan.tasks.length} steps - I'll gather and craft everything myself. Say "stop" to cancel.`
    }

    case 'autobuild': {
      // Full self-provisioned build: gather/craft/smelt the whole bill of materials
      // (stashing in a chest), then build. "Build it from nothing." Operator-only
      // (in CHEAT_CMDS). Long-running - runs detached and chats progress.
      if (!loadedSchem) return 'no schematic loaded - schematic load <url|file> first'
      if (building) return 'already building - say "stop" to cancel first'
      const rest = a // NOTE: unlike `schematic build`, autobuild has NO subcommand - a[0] is
      // already the first real arg (center/clear/coords). a.slice(1) here dropped `center`,
      // landing a centred castle ~20 blocks off the operator's point (offset build = grief).
      const doClear = rest.some(t => t.toLowerCase() === 'clear')
      let originArgs = rest.filter(t => t.toLowerCase() !== 'clear')
      let center = false
      if (originArgs[0] && originArgs[0].toLowerCase() === 'center') { center = true; originArgs = originArgs.slice(1) }
      let at
      if (!originArgs.length || originArgs[0] === 'here') { const p = blockPos(bot); at = new Vec3(p.x, p.y, p.z) } else {
        const n = originArgs.slice(0, 3).map(Number)
        if (n.some(Number.isNaN)) return 'usage: autobuild [here | [center] x y z] [clear]'
        at = new Vec3(n[0], n[1], n[2])
      }
      if (center) {
        const st = loadedSchem.schem.start(); const en = loadedSchem.schem.end()
        at = new Vec3(at.x - Math.floor((st.x + en.x) / 2), at.y - st.y, at.z - Math.floor((st.z + en.z) / 2))
      }
      at = snapToGround(bot, loadedSchem.schem, at) // sit it on the ground, never floating
      building = true; buildAbort = false; buildInterrupted = false; resumeDeaths = 0
      beginActivity('autobuild', loadedSchem.name)
      resumeJob = { schem: loadedSchem.schem, at } // remembered so a death can't lose the build
      persistResume(loadedSchem.name, at) // ...and on DISK so a process restart can't either
      autoBuild(bot, loadedSchem.schem, at, {
        say: throttledSay(bot),
        isStopped: () => buildAbort,
        restoreMovements: () => setupMovements(bot),
        clear: doClear
      }).then(r => {
        building = false; setupMovements(bot); provision.setBuildZone(null)
        if (buildInterrupted) { // died mid-build: keep resumeJob for the respawn handler, consume the flag
          buildInterrupted = false
          dbg('autobuild unwound after death - keeping resumeJob (deaths=' + resumeDeaths + ')')
          endActivity(false, 'interrupted by death - resuming after respawn', { detached: true })
          return
        }
        resumeJob = null
        const disp = STOP_KEEPS_BUILD ? finishDisposition(r) : (!r.stopped ? 'clear' : 'keep')
        if (disp === 'clear') clearPersistedResume() // done for real - nothing to resume
        else if (disp === 'pause') { markResumePaused(`shortfall: ${r.placed}/${r.total} placed, ${r.skipped} skipped`); bot.chat(`build ended short (${r.placed}/${r.total}, ${r.skipped} skipped) - keeping it saved; "cancelbuild" drops it`.slice(0, 256)) } // "0/2350 all-skipped" pauses, never clears
        endActivity(!r.stopped, `${r.placed}/${r.total} placed${r.stopped ? ' (stopped)' : ''}`, { detached: true })
        bot.chat(`autobuild ${r.stopped ? 'stopped' : 'done'}: ${r.placed}/${r.total} placed${r.skipped ? `, ${r.skipped} skipped` : ''}`.slice(0, 256))
      }).catch(e => {
        building = false; setupMovements(bot); provision.setBuildZone(null)
        if (buildInterrupted) { buildInterrupted = false; dbg('autobuild errored after death - keeping resumeJob:', e.message); endActivity(false, `interrupted by death (${e.message})`, { detached: true }); return }
        resumeJob = null; endActivity(false, e.message, { detached: true }); bot.chat(`autobuild error: ${e.message}`.slice(0, 256))
      })
      return `building "${loadedSchem.name}" from scratch at ${at.x},${at.y},${at.z} - I'll gather everything myself, stash it in a chest, then build. Say "stop" to cancel.`
    }

    case 'resumebuild':
    case 'resume-build': {
      // Pick up a build that a process RESTART lost (kick-restart, GUI stop/start,
      // reboot): reload the schematic named in resume-job.json and run the full
      // resume flow (gear up, travel back with retries, re-provision, finish).
      const saved = persistedResume()
      if (!saved) return 'no saved build to resume'
      if (saved.pausedAt) persistResume(saved.name, saved.at) // explicit resume clears the pause hold
      try { loadedSchem = { schem: await schematic.loadFile(saved.name, bot.version), name: saved.name } } catch (e) { return `couldn't reload schematic "${saved.name}": ${e.message}` }
      resumeJob = { schem: loadedSchem.schem, at: new Vec3(saved.at.x, saved.at.y, saved.at.z) }
      resumeDeaths = 0; buildAbort = false; buildInterrupted = false
      resumeBuild(bot).then(r => {
        if (r && !r.stopped && !r.deferred) bot.chat(`resumed build done: ${r.placed}/${r.total} placed`.slice(0, 200))
      }).catch(e => bot.chat(`resume failed: ${e.message}`.slice(0, 200)))
      return `resuming "${saved.name}" at ${saved.at.x},${saved.at.y},${saved.at.z} - heading back to finish it`
    }

    case 'cancelbuild':
    case 'abandonbuild': {
      // The ONLY intended delete of a saved build. Operator-authenticated (opts.source) AND
      // blocked from the brain's /cmd path by CHEAT_CMDS - two independent gates, either
      // suffices. Undefined source FAILS CLOSED. Two-step 60s confirm; ARCHIVE (rename) rather
      // than unlink, so a fat-fingered confirm is recoverable (rename back + resumebuild).
      if (opts.source !== 'operator') return 'cancelbuild is operator-only'
      const saved = persistedResume()
      if (!saved) { cancelArmedAt = 0; return 'no saved build to cancel' }
      const confirmed = /^confirm$/i.test(a[0] || '') && (Date.now() - cancelArmedAt) <= 60000
      if (!confirmed) {
        cancelArmedAt = Date.now() // (re-)arm; a bare "confirm" with no fresh arm lands here too
        return `this deletes the saved build "${saved.name}" at ${saved.at.x},${saved.at.y},${saved.at.z} for good - say "cancelbuild confirm" within 60s`
      }
      cancelArmedAt = 0
      buildAbort = true; resumeJob = null; buildInterrupted = false; resumeDeaths = 0 // halt any running build
      bot.pathfinder.setGoal(null)
      try { try { fs.unlinkSync(RESUME_FILE + '.cancelled') } catch {} ; fs.renameSync(RESUME_FILE, RESUME_FILE + '.cancelled') } catch (e) { dbg('cancelbuild archive failed: ' + e.message) }
      return `cancelled "${saved.name}" - the save is archived, not resumable`
    }

    case 'stash': {
      // deposit all build materials into a nearby/crafted chest (keeps tools/food)
      try {
        const chest = await provision.ensureChest(bot, {})
        const n = await provision.depositMaterials(bot, chest, { keepDirt: 8 })
        return `stashed ${n} item(s) in the chest at ${chest.position.x},${chest.position.y},${chest.position.z}`
      } catch (e) { return `couldn't stash: ${e.message}` }
    }
    case 'unstash': {
      // withdraw <item> [count] from a nearby chest
      const name = a[0]
      if (!name) return 'usage: unstash <item> [count]'
      const count = Math.max(1, parseInt(a[1] || '64', 10))
      const mcData = require('minecraft-data')(bot.version)
      const chestId = mcData.blocksByName.chest && mcData.blocksByName.chest.id
      const chest = chestId ? bot.findBlock({ matching: chestId, maxDistance: 8 }) : null
      if (!chest) return 'no chest within reach'
      try { const got = await provision.withdrawItem(bot, chest, name, count); return got ? `took ${got} ${name}` : `no ${name} in the chest` } catch (e) { return `couldn't unstash: ${e.message}` }
    }

    case 'clearinv': {
      // wipe the bot's own inventory (op /clear) - for clean provisioning tests
      bot.chat(`/clear ${bot.username}`); return 'cleared inventory'
    }
    case 'tp': {
      const [x, y, z] = a.map(Number)
      if ([x, y, z].some(Number.isNaN)) return 'usage: tp <x> <y> <z>'
      bot.chat(`/tp ${bot.username} ${x} ${y} ${z}`); return `tp -> ${x},${y},${z}`
    }
    case 'gamemode':
      bot.chat(`/gamemode ${a[0] || 'creative'} ${bot.username}`); return `gamemode ${a[0]}`

    default:
      return `unknown command: ${cmd} (try "help")`
  }
}

// facing / summariseEntities / biomeName / nearestThreat / nearbyPlayers / wornArmor now
// live in perception.js (destructured at the top of this file).

// Rich self+world snapshot so any brain can reason about what to do.
function state (bot) {
  const ent = bot.entity
  const p = ent ? ent.position : null
  const below = p ? bot.blockAt(p.offset(0, -1, 0)) : null
  // blockAtCursor ray-traces nearby entities and throws if one lacks a position
  // (e.g. just after join, before the world settles) - never let that break /state
  let looking = null
  try { if (typeof bot.blockAtCursor === 'function') looking = bot.blockAtCursor(6) } catch { looking = null }
  const biome = p ? biomeName(bot, p) : null
  const players = nearbyPlayers(bot)
  // Ground truth about what the BODY is doing right now, so the brain's idle-hold
  // can tell when a goal silently died and skip inferences during long autonomous
  // flows instead of assuming "the body is still executing my last behaviour".
  const pf = bot.pathfinder
  const moving = pf && typeof pf.isMoving === 'function' ? pf.isMoving() : false
  const goal = pf && pf.goal ? ((pf.goal.constructor && pf.goal.constructor.name) || 'goal') : null

  return {
    name: bot.username,
    pos: p ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) } : null,
    facing: ent ? facing(ent.yaw) : null,
    health: bot.health,
    food: bot.food,
    oxygen: bot.oxygenLevel,
    gameMode: bot.game ? bot.game.gameMode : null,
    dimension: bot.game ? bot.game.dimension : null,
    biome,
    timeOfDay: bot.time ? bot.time.timeOfDay : null,
    isDay: bot.time ? bot.time.timeOfDay < 13000 : null,
    isRaining: bot.isRaining,
    blockBelow: below ? below.name : null,
    lookingAt: looking ? { name: looking.name, pos: { x: looking.position.x, y: looking.position.y, z: looking.position.z } } : null,
    heldItem: bot.heldItem ? bot.heldItem.name : null,
    wearing: wornArmor(bot),      // armor actually equipped {head,torso,legs,feet}, so the brain never claims armor it isn't wearing
    // the best grave to go back for + how many stand unretrieved (so the brain can choose
    // to `recover`). NOTE (task #18): AxGraves graves DESPAWN on the server's timer - they do NOT
    // keep; urgency (bestGrave/graveUrgency) prioritizes at-risk ones. A VALUABLE grave is surfaced
    // for up to 6h here; a worthless naked-death one only 15 min (surfacing != the despawn budget).
    died: (() => {
      const g = bestGrave()
      if (!g || Date.now() - g.at > (graveValue(g) > 0 ? 6 * 3600000 : 900000)) return null
      return { x: g.x, y: g.y, z: g.z, dangerous: g.dangerous, items: (g.items && g.items.notable && g.items.notable.length) ? g.items.notable.slice(0, 6) : undefined, graves: unretrievedGraves() }
    })(),
    inventory: (bot.inventory ? bot.inventory.items() : []).map(i => `${i.name} x${i.count}`),
    players,
    alone: players.length === 0, // no OTHER players nearby (you are never in this list)
    threat: nearestThreat(bot),   // nearest hostile, or null
    moving,                       // is the body currently pathing somewhere?
    goal,                         // current pathfinder goal type (GoalFollow/GoalNear/...) or null
    busy: isBusy(),               // an operator build/provision is driving the body - the brain should hold
    maneuver: (() => { try { const m = arbiter.topManeuver(); return m ? { label: m.label, tier: arbiter.priName(m.pri) } : null } catch { return null } })(), // the priority-arbiter's current body owner (a navigation in progress), so goal-thrash is visible in /state

    // OBSERVABILITY so the brain can spot + break out of stuck/failed/hazardous states:
    activity: activity ? { name: activity.name, detail: activity.detail, forSec: Math.round((Date.now() - activity.startedAt) / 1000) } : null, // a long op still running from a past turn
    progress: { agoSec: Math.round((Date.now() - bodyProgress.at) / 1000), by: bodyProgress.by, stalled: bodyProgress.stalled }, // S7 verified-progress clock (last verified touch + the nudge's stalled flag)
    buildProgress, // REAL numbers (material have/need) - the brain answers progress questions from THIS
    checklist: jobList ? { step: jobList.current, n: jobList.steps.indexOf(jobList.current) + 1, of: jobList.steps.length, steps: jobList.steps } : null, // the job's step-by-step plan + where it is (operator order: goals get checklists)
    lastResult: (lastOutcome && Date.now() - lastOutcome.at < 180000) // how the last long/detached/failed op ended (results that don't come back via /cmd)
      ? { action: lastOutcome.action, ok: lastOutcome.ok, detail: lastOutcome.detail, ageSec: Math.round((Date.now() - lastOutcome.at) / 1000) }
      : null,
    stuck: stuckSince ? { forSec: Math.round((Date.now() - stuckSince) / 1000) } : null, // body trying to move but not progressing
    hazards: hazards(bot),        // { underground, onFire, inLava, inWater, drowning } - immediate dangers
    waypoints: memory.waypointNames(), // named places you can "goto <name>"
    entities: summariseEntities(bot)
  }
}

// isWaterlogged / hazards now live in perception.js (destructured at the top of this file).

function setupMovements (bot) {
  const m = new Movements(bot)
  m.allowFreeMotion = true
  m.canDig = false            // NEVER break blocks to make a path (was griefing builds)
  m.allow1by1towers = false   // don't pillar up
  m.canOpenDoors = true       // open doors instead of getting stuck / breaking them
  m.allowParkour = true
  if ('scafoldingBlocks' in m) m.scafoldingBlocks = [] // don't place blocks to bridge
  // PATHFINDER FIX: mineflayer-pathfinder only auto-opens fence GATES (its "openable"
  // set is built from block names containing "gate"). Plain doors are never added, so
  // with digging off a door reads as an impassable WALL - the bot detours to a nearby
  // solid block (the "ran to the glass" bug) and gives up. Add wooden doors + trapdoors
  // to the openable set so it routes THROUGH them. Iron doors need redstone, so they
  // stay walls. Keyed by block id to match how the lib tests `openable.has(block.type)`.
  try {
    for (const b of bot.registry.blocksArray) {
      const n = b.name.toLowerCase()
      if (n.includes('door') && !n.includes('trapdoor') && !n.includes('iron')) m.openable.add(b.id)
    }
  } catch (e) { /* registry shape changed - fall back to gates-only */ }
  bot.pathfinder.setMovements(m)
}

// busy = a long autonomous flow (schematic build / provisioning) is running;
// idle reflexes (auto-collect...) must not steal the bot's movement meanwhile.
// buildReqActive covers an operator BUILD REQUEST end-to-end - including the
// travel-to-site phase BEFORE autobuild flips `building` - so the brain's /cmd
// stop is gated for the whole trip, not just the placing. Without it the brain
// stopped the walk to the site 500 blocks out and the build never began.
let buildReqActive = false
function setBuildReqActive (v) { buildReqActive = !!v }
function isBusy () { return building || provisioning || buildReqActive }
function isEscaping () { return escaping }

// Sticky-follow reflex (called on a timer by the body). If the bot was told to
// follow someone but the follow goal got replaced by a transient brain action
// (attack/goto/scan) and the body is now IDLE, re-issue the follow goal so it keeps
// trailing them - the "why did it stop following me" fix. No-op while a follow/other
// goal is active (won't fight the brain), while busy building, or if the target is
// out of view. Cleared by `stop`. Returns a status string when it resumed, else null.
function maybeResumeFollow (bot) {
  if (!followTarget || isBusy()) return null
  if (!bot || !bot.entity || !bot.pathfinder) return null
  if (bot.pathfinder.goal) return null // already pathing (following or busy) - leave it be
  if (arbiter.maneuverActive(arbiter.PRIORITY.PROGRESS)) return null // a navigation maneuver owns the body - don't reclaim it mid-goto (the door-loop class)
  const t = findPlayer(bot, followTarget)
  if (!t) return null // can't see them right now - try again next tick
  bot.pathfinder.setGoal(new goals.GoalFollow(t, FOLLOW_RANGE), true)
  return `resumed following ${followTarget}`
}

// Highest SOLID (non-air, non-leaf) block Y at a column - the ground surface. Used to
// sit a build on the ground instead of floating a block up (a floating foundation has
// nothing to place against, so the whole build fails - verified: 0/44 when floating).
function surfaceYAt (bot, x, z, fromY) {
  for (let y = Math.floor(fromY) + 6; y > fromY - 48; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (b && b.boundingBox === 'block' && !/air$|_leaves$/.test(b.name)) return y
  }
  return null
}

// Snap the build origin so its bottom solid layer rests on the ground at the footprint's
// CENTRE column - kills "Y one block too high -> floating dud" builds. No-op if the
// surface can't be read (chunk not loaded), so it can never make things worse.
// PARTIAL-BUILD GUARD: if the schematic already visibly matches the world at the
// REQUESTED origin (a prior run placed part of it), keep that origin - snapping would
// sit the "ground" on the half-built walls and start a second, misaligned copy 2 up
// (verified live: re-running a 29/44 stonebox snapped y79 -> y81).
function snapToGround (bot, schem, at) {
  const st = schem.start(); const en = schem.end()
  try {
    let matches = 0
    for (let y = st.y; y <= en.y && matches < 5; y++) {
      for (let x = st.x; x <= en.x && matches < 5; x++) {
        for (let z = st.z; z <= en.z && matches < 5; z++) {
          const want = schem.getBlock(new Vec3(x, y, z))
          if (!want || !want.name || /^(air|cave_air|void_air)$/.test(want.name)) continue
          const got = bot.blockAt(new Vec3(at.x + x, at.y + y, at.z + z))
          if (got && got.name === want.name) matches++
        }
      }
    }
    if (matches >= 5) return at // enough of the build already stands here - resume in place
  } catch { /* schematic read hiccup - fall through to the normal snap */ }
  // GROUND LEVEL, least clearing (operator: "find the Y with the least clearing - still
  // ground level, not buried, not floating"): sample the surface across the WHOLE
  // footprint and sit the base at the MEDIAN. The median is normal ground - hilltops
  // above it get shaved by clearVolume, dips below get dirt-filled - so we never carve a
  // build deep into a mountain (origin below surface) nor leave it floating on a spike.
  const surfs = []
  const sx = Math.max(1, Math.floor((en.x - st.x) / 4))
  const sz = Math.max(1, Math.floor((en.z - st.z) / 4))
  for (let x = st.x; x <= en.x; x += sx) {
    for (let z = st.z; z <= en.z; z += sz) {
      const s = surfaceYAt(bot, at.x + x, at.z + z, at.y + st.y)
      if (s != null) surfs.push(s)
    }
  }
  if (!surfs.length) return at
  surfs.sort((a, b) => a - b)
  const med = surfs[Math.floor(surfs.length / 2)]
  return new Vec3(at.x, med + 1 - st.y, at.z) // bottom layer lands on median-surface + 1
}

// Full self-provisioned build ("sent off with nothing -> builds it"): if we already
// have the whole bill of materials, just build. Otherwise set up a CHEST by the site,
// gather/craft/smelt the materials in BATCHES - depositing each finished batch so the
// 36-slot pack never overflows on a 2000+ block build - then build, pulling materials
// back out of the chest on demand. Long-running; chats progress. Returns build result.
async function autoBuild (bot, schem, at, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const restore = opts.restoreMovements || (() => setupMovements(bot))
  const mcData = require('minecraft-data')(bot.version)
  const bom = schematic.billOfMaterials(schem).counts
  // Keep-out box for the TREE FARM: footprint + canopy margin. Threaded into every
  // gather so replants/groves never put a future tree inside (or leaning over) the build.
  const avoid = (() => { const st = schem.start(); const en = schem.end(); return { x1: at.x + st.x - 6, z1: at.z + st.z - 6, x2: at.x + en.x + 6, z2: at.z + en.z + 6 } })()
  provision.setBuildZone(avoid) // shelters must dig OUTSIDE this while the build is active (cleared by the callers' settle handlers)
  if (!jobList) checklistBegin(JOB_STEPS) // resume pre-begins (its 'travel to site' step is already done)
  checklistStep('survey the site')
  // DIFF the BOM against what already STANDS at the site: a resume/re-run of a partial
  // build must only provision the MISSING blocks (the raw BOM sent the bot back into the
  // caves for 44 stone when 5 were missing - ten times the death exposure for nothing).
  // Chunk not loaded -> blockAt null -> nothing subtracted, so it can never under-plan.
  try {
    const st = schem.start(); const en = schem.end()
    let standing = 0
    for (let y = st.y; y <= en.y; y++) {
      for (let z = st.z; z <= en.z; z++) {
        for (let x = st.x; x <= en.x; x++) {
          const want = schem.getBlock(new Vec3(x, y, z))
          if (!want || !want.name || /^(air|cave_air|void_air)$/.test(want.name)) continue
          const got = bot.blockAt(new Vec3(at.x + x, at.y + y, at.z + z))
          if (got && got.name === want.name && bom[want.name] > 0) { bom[want.name]--; standing++ }
        }
      }
    }
    for (const k of Object.keys(bom)) if (bom[k] <= 0) delete bom[k]
    if (standing > 0) dbg('bom diffed vs world:', standing, 'blocks already standing ->', JSON.stringify(bom))
  } catch { /* schematic read hiccup - provision the full BOM */ }
  // ITEMS vs CELLS: a door/bed occupies TWO schematic cells but is ONE inventory item -
  // the raw cell count sent the loop hunting a second bed that can't exist as an item
  // (the camp/hut path already normalized this; the generic path never did).
  for (const k of Object.keys(bom)) if (/_door$|_bed$/.test(k)) bom[k] = Math.ceil(bom[k] / 2)
  // SCAFFOLD DIRT must be PROVISIONED, not just reserved - a from-nothing bot arrives with 0
  // dirt, so without adding it to the BOM the builder either can't reach upper layers (build
  // finishes short + clears the resume) or cannibalises the BOM's own cobble as scaffold ->
  // a shortfall that hangs in waitForMaterial. Mirror the standalone `provision` command.
  if (schem.size.y > 2) bom.dirt = (bom.dirt || 0) + 8 + 2 * schem.size.y
  const KEEP_DIRT = schem.size.y > 2 ? Math.min(200, 16 + 3 * schem.size.y) : 4 // scaffold reserve
  // Use whatever WOOD is actually growing nearby for generic tool/fuel needs (so a
  // savanna gathers acacia, not oak it can't find). null -> planner falls back to oak.
  const primaryWood = provision.detectWood(bot)
  if (primaryWood && primaryWood !== 'oak') say(`(using ${primaryWood} wood - it's what's around)`)

  // Already have everything? Just build.
  const inv0 = provision.inventoryCounts(bot)
  if (!Object.entries(bom).some(([n, c]) => (inv0[n] || 0) < c)) {
    say('i have all the materials - building')
    checklistStep('build')
    return await schematic.buildSurvival(bot, schem, at, { say, isStopped, restoreMovements: restore, clear: opts.clear })
  }
  say('gonna gather everything myself first...')

  // TOOL BOOTSTRAP: if we're starting with no digging tools (e.g. we died and lost our
  // whole kit in lava), craft the basics FIRST - chop wood -> planks/table/sticks ->
  // wooden pickaxe + axe - BEFORE trying to provision any build material. Without this a
  // gearless bot reaches a stone material with no pickaxe and just spins (mining stone
  // bare-handed drops nothing). The per-material planner also pulls in tools, but doing
  // it up front makes a from-NOTHING (or lost-everything) run reliable.
  checklistStep('basic tools')
  const hasKind = k => (bot.inventory ? bot.inventory.items() : []).some(i => i.name.endsWith('_' + k))
  const bomNeedsMining = Object.keys(bom).some(n => provision.GATHER_TOOL[n] || provision.SMELT_MAP[n])
  if (!isStopped() && bomNeedsMining && (!hasKind('pickaxe') || !hasKind('axe') || !hasKind('sword'))) {
    const want = {}
    if (!hasKind('pickaxe')) want.wooden_pickaxe = 1
    if (!hasKind('axe')) want.wooden_axe = 1
    // A SWORD too: naked from-nothing, the bot has to survive mobs while it gathers/smelts
    // for hours. auto-defend with bare fists barely scratches a zombie; a wooden sword lets
    // it actually kill what's hunting it (it died to a creeper at a mob-heavy site unarmed).
    if (!hasKind('sword')) want.wooden_sword = 1
    say(`no tools on me - setting up a ${Object.keys(want).map(t => t.replace('wooden_', '')).join(' + ')} first`)
    try {
      // reconcile: tool wood comes out of the BANK when it's there (it chopped fresh
      // birch for a pickaxe while a hundred oak logs sat in its chest, live test)
      const trec = await resources.reconcile(bot, want, { near: at, planOpts: { primaryWood } })
      if (trec.withdraws.length || trec.plan.tasks.length) await resources.runReconciled(bot, trec, { say, isStopped, restoreMovements: restore, homeY: Math.floor(at.y), avoid })
    } catch (e) { say(`(couldn't make tools yet: ${e.message})`) }
    if (!hasKind('pickaxe')) say("still couldn't get a pickaxe - is there any wood around here?")
  }
  // STONE-PICK UPGRADE: with a wooden pick + a big cobble mine ahead, a stone pickaxe (3
  // cobble + 2 sticks) mines 2x faster and lasts 131 vs 59 blocks - fewer mid-run breaks
  // (each break forces a whole re-plan round). Big net win over a from-nothing stone build.
  checklistStep('stone pickaxe')
  const hasStonePick = () => (bot.inventory ? bot.inventory.items() : []).some(i => /^(stone|iron|diamond|netherite)_pickaxe$/.test(i.name))
  if (!isStopped() && process.env.STONE_PICK !== '0' && bomNeedsMining && hasKind('pickaxe') && !hasStonePick()) {
    say('quick stone pickaxe first - it mines way faster')
    try {
      const sprec = await resources.reconcile(bot, { stone_pickaxe: 1 }, { near: at, planOpts: { primaryWood } })
      if (sprec.withdraws.length || sprec.plan.tasks.length) await resources.runReconciled(bot, sprec, { say, isStopped, restoreMovements: restore, homeY: Math.floor(at.y), home: { x: Math.round(at.x), y: Math.floor(at.y), z: Math.round(at.z) }, avoid })
    } catch (e) { say(`(stone pick skipped: ${e.message})`) }
  }

  // ARMOR BOOTSTRAP: a from-nothing / just-respawned bot is NAKED, and a long survival
  // build runs through nights - it nearly died to mobs with no armor. So if we're bare
  // in any slot, craft leather armor (hunting cows for leather) BEFORE the long haul.
  // Bounded - if there are no cows it makes what it can (or nothing) and proceeds; the
  // build isn't blocked on it. Only when we've got the tools to survive the hunt.
  // OPPORTUNISTIC + bounded: armor is optional (the night-shelter covers a naked bot), so we
  // do NOT chase a full set - only hunt if cows are actually VISIBLE near the site, take one
  // tight local pass (fenced to 48b, ~1 explore, 60s), and craft whatever partial armor the
  // leather affords. This stops the bot roaming 150 blocks for a full leather set (the #1
  // reason a from-nothing build never converged).
  // The chest is created LAZILY - only once we actually have materials to stash
  // (crafting one needs planks the from-nothing bot doesn't have up front) and only
  // when the pack is filling up. Small builds that fit in 36 slots never make one.
  let chest = null
  async function stash () {
    try {
      if (!chest) chest = await provision.ensureChest(bot, { isStopped })
      await resources.autoBank(bot, { near: home, keepDirt: KEEP_DIRT, isStopped })
    } catch (e) { say(`(couldn't stash yet: ${e.message})`) }
  }

  // BASE CAMP (operator rule): a 500+-block build means days of on-site living - set up
  // the essentials AT THE SITE before the long grind: chest (banking - carrying the haul
  // lost 102 logs to one death), furnace (cooked food/smelting), bed if none is in range
  // (nights + spawn), and torches if we have them (spawn-proofing). Each step best-effort
  // and idempotent - a missing ingredient skips that piece, never blocks the build.
  const totalBom = Object.values(bom).reduce((s, n) => s + n, 0)
  if (!isStopped() && totalBom >= 500 && process.env.SITE_CAMP !== '0') {
    say('big build - setting up camp first (chest, furnace, bed)')
    dbg('camp: BOM total ' + totalBom + ' >= 500 - establishing site camp')
    checklistStep('camp: chest/furnace/bed')
    try {
      // a chest needs 8 planks - craft them from carried logs first (live: camp skipped
      // the chest with "need 8 planks" while holding 22 raw logs)
      const invC = provision.inventoryCounts(bot)
      const plankCount = Object.entries(invC).filter(([n]) => /_planks$/.test(n)).reduce((s, [, c]) => s + c, 0)
      if (plankCount < 8) {
        const logName = Object.keys(invC).find(n => /_log$/.test(n) && invC[n] >= 2)
        if (logName) await handle(bot, `craft ${logName.replace('_log', '_planks')} 8`).catch(() => {})
      }
      chest = await provision.ensureChest(bot, { isStopped, home: { x: at.x, y: at.y, z: at.z } })
    } catch (e) { dbg('camp: chest skipped (' + e.message + ')') }
    try { await provision.ensureFurnace(bot, { isStopped, home: { x: at.x, y: at.y, z: at.z } }) } catch (e) { dbg('camp: furnace skipped (' + e.message + ')') }
    try {
      // BED (resource-aware): PLACE a bed the bot already carries before anything else. The old
      // step gated placement behind "no known bed nearby" AND a wool check, so a recovered bed
      // rode around unplaced - it logged "no bed and no wool" while holding a white_bed (that's
      // how we kept losing the spawn). Order now: if a real bed already stands nearby, done; else
      // if we're holding one, place it; else craft from wool and place that.
      let bedItem = (bot.inventory ? bot.inventory.items() : []).find(i => /_bed$/.test(i.name))
      const kb = provision.knownBed && provision.knownBed()
      // Trust remembered-bed ONLY if a bed block is ACTUALLY there - memory goes stale the moment
      // a rebuild/flatten breaks it, which is exactly what stranded this one.
      let bedNear = false
      if (kb && Math.hypot(kb.x - at.x, kb.z - at.z) <= 120) {
        const bb = bot.blockAt(new Vec3(kb.x, kb.y, kb.z))
        bedNear = !!(bb && /_bed$/.test(bb.name))
      }
      if (!bedNear && !bedItem) {
        // nothing placed and nothing carried - craft one if the pack affords it (3 wool + 3 planks)
        const inv = provision.inventoryCounts(bot)
        const woolName = Object.keys(inv).find(n => /_wool$/.test(n) && inv[n] >= 3)
        if (woolName && (inv.oak_planks || 0) + (inv.birch_planks || 0) + (inv.spruce_planks || 0) >= 3) {
          const r = await handle(bot, 'craft white_bed 1').catch(() => null)
          dbg('camp: bed craft -> ' + r)
          bedItem = (bot.inventory ? bot.inventory.items() : []).find(i => /_bed$/.test(i.name))
        }
      }
      if (bedNear) {
        dbg('camp: bed already in range at ' + kb.x + ',' + kb.z)
      } else if (bedItem) {
        try {
          await provision.dumpJunk(bot).catch(() => {})
          await bot.equip(bedItem, 'hand')
          const spot = bot.blockAt(bot.entity.position.floored().offset(2, -1, 0))
          if (spot && spot.boundingBox === 'block') {
            await bot.placeBlock(spot, new Vec3(0, 1, 0))
            const placed = bot.blockAt(spot.position.offset(0, 1, 0))
            if (placed && /_bed$/.test(placed.name) && provision.rememberBed) { try { provision.rememberBed(placed.position) } catch {} }
            await handle(bot, 'sleep').catch(() => {}) // sets spawn at the bed (works at day on this server)
          } else dbg('camp: bed - no solid spot right here to set it on')
        } catch (e) { dbg('camp: bed place failed (' + e.message + ')') }
      } else dbg('camp: no bed and no wool for one - sleeping arrangements deferred (bed hunt is v2)')
    } catch (e) { dbg('camp: bed step failed (' + e.message + ')') }
    try {
      const torch = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'torch')
      if (torch && placeTorchNearby) { await placeTorchNearby(bot).catch(() => {}) }
    } catch {}
    // SAFEHOUSE HUT (operator order): 500+ builds get a real building - a 5x4x5 plank
    // shell (71 planks, ONE gather trip, zero smelting; operator: "simple so it can
    // build it fast") next to the bed, so the bed/chest/furnace stop living in the open.
    checklistStep('camp: safehouse hut')
    // FURNISHED HUT, VERIFIED (operator: "furniture part of the schematic so we stop these
    // issues" + "grounded in what's ACTUALLY on the server, not what it thinks it did").
    // The schematic now holds the whole hut - walls, door, furnace, table, bed, and the
    // bank chest - so the DETERMINISTIC builder places everything (the thing that always
    // worked), and we retire the fragile reach-based furnish/apron/migration hacks. On a
    // mismatch we do a clean rebuild: empty the bank -> clear old furniture too -> build
    // the schematic -> refill the bank, counting items before/after so nothing is lost.
    try {
      if (process.env.SITE_HUT !== '0') {
        const hutSchem = await schematic.loadFile('hut.schem', bot.version)
        const st = hutSchem.start(); const en = hutSchem.end()
        const AIRRE = /^(air|cave_air|void_air)$/
        const known = (provision.listInfra ? provision.listInfra('hut', bot) : []).find(e => Math.hypot(e.x - at.x, e.z - at.z) <= 150)
        let hutAt
        if (known) hutAt = new Vec3(known.x, known.y, known.z)
        else {
          const kb = provision.knownBed && provision.knownBed()
          hutAt = snapToGround(bot, hutSchem, new Vec3(kb ? kb.x + 3 : Math.round(at.x) - 16, kb ? kb.y - 1 : Math.floor(at.y), kb ? kb.z - 2 : Math.round(at.z)))
        }
        // GROUNDED mismatch count - furniture cells INCLUDED (real block reads). #37: also tally
        // solidTotal (non-air schematic cells) in the SAME loop (one extra counter, no new pass),
        // and choose the classifier by flag - tolerant cellMismatch under the flag so a birch-plank
        // patch on an oak cell isn't counted as permanent damage; the exact match is kept under =0.
        const ndRepair = process.env.NONDESTRUCTIVE_REPAIR !== '0' // default ON; =0 = today byte-for-byte
        let bad = 0
        let solidTotal = 0
        for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
          const w = hutSchem.getBlock(new Vec3(x, y, z)); const g = bot.blockAt(new Vec3(hutAt.x + x, hutAt.y + y, hutAt.z + z))
          const wantName = (w && w.name) || 'air'
          if (!AIRRE.test(wantName)) solidTotal++
          if (!g) continue
          if (ndRepair) { if (hutModel.cellMismatch(wantName, g.name)) bad++ }
          else { const wantAir = !w || !w.name || AIRRE.test(w.name); if (wantAir ? !AIRRE.test(g.name) : g.name !== w.name) bad++ }
        }
        // schematic furniture cells (world coords) - found by scanning the schematic
        const findCell = re => { for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) { const w = hutSchem.getBlock(new Vec3(x, y, z)); if (w && re.test(w.name)) return new Vec3(hutAt.x + x, hutAt.y + y, hutAt.z + z) } return null }
        if (!ndRepair && bad > 3) {
          // NONDESTRUCTIVE_REPAIR=0 -> TODAY'S EXACT PATH: empty the bank + clearFurniture
          // teardown + rebuild on ANY bad>3. Kept intact byte-for-byte for rollback; the whole
          // block below is unchanged from the pre-#37 code.
          say(`building my safehouse properly (${bad} cells off) - one clean pass`)
          // 1) EMPTY the bank into the pack (verified reads) so the rebuild can clear old
          //    furniture without dropping the treasury. Count what we pulled.
          const saved = {}
          for (const c of (provision.listInfra('chest', bot) || [])) {
            if (Math.hypot(c.x - hutAt.x, c.z - hutAt.z) > 10) continue
            const cb = bot.blockAt(new Vec3(c.x, c.y, c.z)); if (!cb || !/chest/.test(cb.name)) continue
            try {
              const cont = await bot.openContainer(cb)
              for (const it of cont.containerItems()) saved[it.name] = (saved[it.name] || 0) + it.count
              for (const it of cont.containerItems().slice()) { try { await cont.withdraw(it.type, it.metadata, it.count) } catch {} }
              cont.close()
            } catch (e) { dbg('camp: bank empty failed (' + e.message + ')') }
          }
          const savedN = Object.values(saved).reduce((s, n) => s + n, 0)
          dbg('camp: emptied bank -> ' + savedN + ' items held before rebuild')
          // (Operator: don't fret over the bot breaking its OWN placed stuff - only the
          //  player's. The hut is all bot-built, so we rebuild freely; any item the empty
          //  couldn't hold drops and gets collected, then re-deposited below.)
          // 2) provision the hut BOM (planks + furniture ITEMS; door/bed are 1 item = 2 blocks)
          const hutBom = schematic.billOfMaterials(hutSchem).counts
          if (hutBom.oak_door) hutBom.oak_door = 1
          if (hutBom.white_bed) hutBom.white_bed = 1
          // Only the BED can't be crafted (needs wool/string) - so the chest/furnace/table/
          // door get PROVISIONED FRESH (cheap: planks/cobble), which is reliable, and only
          // the bed is credited to the one we already have + recover (relying on recovery
          // for the chests made the build skip them when the collect missed - live).
          let hasBedPlaced = false
          for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
            const g = bot.blockAt(new Vec3(hutAt.x + x, hutAt.y + y, hutAt.z + z))
            if (g && /_bed$/.test(g.name)) hasBedPlaced = true
          }
          // RECONCILE against TOTAL holdings (pack + verified bank), withdraw -> craft ->
          // gather - the old pack-only plan sent the bot to chop trees while its own bank
          // held a hundred logs.
          const hrec = await resources.reconcile(bot, hutBom, {
            near: hutAt,
            planOpts: { primaryWood },
            credit: hasBedPlaced ? { white_bed: 1 } : {} // reuse the bed we'll recover
          })
          if (Object.keys(hrec.plan.unobtainable || {}).length) { dbg('camp: hut BOM unobtainable ' + JSON.stringify(hrec.plan.unobtainable)) }
          else {
            if (hrec.withdraws.length || hrec.plan.tasks.length) await resources.runReconciled(bot, hrec, { say, isStopped, restoreMovements: restore, homeY: hutAt.y, home: { x: hutAt.x, y: hutAt.y, z: hutAt.z }, avoid })
            // 3) clean rebuild - clears the old messy furniture (bot's own) and places the
            //    whole hut deterministically: walls, door, furnace, table, bed, double chest.
            //    fetch = the resource model: a missing piece gets WITHDRAWN or CRAFTED on the
            //    spot (it once begged players for a door while holding 109 planks + a table).
            const hutFetch = async (n, cnt) => { await resources.acquire(bot, n, cnt || 1, { near: hutAt, isStopped, say, batch: 32, planOpts: { primaryWood } }) }
            const hr = await schematic.buildSurvival(bot, hutSchem, hutAt, { say, isStopped, restoreMovements: restore, clear: true, clearFurniture: true, fetch: hutFetch })
            dbg('camp: hut rebuilt -> ' + (hr && hr.placed) + '/' + (hr && hr.total) + ' at ' + hutAt.x + ',' + hutAt.y + ',' + hutAt.z)
            provision.rememberInfra && provision.rememberInfra('hut', hutAt)
            // fill the doorstep so the exit is flush ground, not a fall into the natural drop-off
            // in front (the recurring "hole at the front door"); idempotent, self-heals each pass
            try { await provision.ensureHutApron(bot, hutAt, { isStopped, say }) } catch (e) { dbg('camp: apron fill failed (' + e.message + ')') }
            try { await handle(bot, 'collect') } catch {} // grab any bank items that dropped when the old chest was cleared
            // 4) refill the bank into the schematic's chest cell; count to prove nothing lost
            const chestCell = findCell(/chest/)
            if (chestCell) { provision.rememberInfra('chest', chestCell); const cb = bot.blockAt(chestCell); if (cb && /chest/.test(cb.name)) { try { const back = await provision.depositMaterials(bot, cb, { keepDirt: 8, all: true }); dbg('camp: bank refilled (' + savedN + ' saved, ' + (back || '?') + ' redeposited)') } catch (e) { dbg('camp: bank refill failed (' + e.message + ') - items are safe in my pack') } } }
            // 5) set spawn on the schematic bed
            const bedCell = findCell(/_bed$/)
            if (bedCell) { const bb = bot.blockAt(bedCell); if (bb && /_bed$/.test(bb.name)) { try { await bot.activateBlock(bb); provision.rememberBed(bedCell) } catch {} } }
            try { await handle(bot, 'remember hut') } catch {}
            // VERIFY_SUCCESS_MSG (fix #36): don't CLAIM "built clean" unless the world actually
            // matches the schematic now. Re-run the SAME grounded mismatch scan (furniture cells
            // included) AFTER the full rebuild+bed+bank; only bad2===0 earns the success line, else
            // say the honest count and leave the repair unsatisfied so the next camp pass retries
            // (bad is recomputed fresh each pass, so nothing else needs resetting).
            let bad2 = 0
            if (process.env.VERIFY_SUCCESS_MSG !== '0') {
              for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
                const w = hutSchem.getBlock(new Vec3(x, y, z)); const g = bot.blockAt(new Vec3(hutAt.x + x, hutAt.y + y, hutAt.z + z))
                if (!g) continue
                const wantAir = !w || !w.name || AIRRE.test(w.name)
                if (wantAir ? !AIRRE.test(g.name) : g.name !== w.name) bad2++
              }
            }
            const builtClean = process.env.VERIFY_SUCCESS_MSG === '0' || (bad2 === 0 && hr && hr.total && hr.placed >= hr.total)
            if (builtClean) say('safehouse built clean - walls, door, bed, furnace, bank all in place')
            else { dbg('camp: rebuild NOT clean - ' + bad2 + ' cell(s) still off, placed ' + (hr && hr.placed) + '/' + (hr && hr.total)); say('patched the safehouse but ' + bad2 + ' cell(s) still off - will retry') }
          }
        } else if (ndRepair) {
          // ---- #37 NON-DESTRUCTIVE HUT REPAIR (default ON) --------------------------------
          // restoreBank(): the treasury guard - escalating targets, NEVER throws (all I/O is
          // guarded). (a) schematic chest cell standing -> deposit; (b/c) else ensureChest (places
          // a chest at the interior cell or recalls a remembered chest) -> deposit; (d) else keep
          // it in the pack, say LOUDLY, and latch a pending restore so the NEXT pass re-deposits
          // FIRST. This is what makes "never strand the bank" hold on every exit path (invariant 1).
          const restoreBank = async () => {
            let target = null
            const cc = findCell(/chest/)
            if (cc) { const cb = bot.blockAt(cc); if (cb && /chest/.test(cb.name)) target = cb }
            if (!target) { try { target = await provision.ensureChest(bot, { home: hutAt, isStopped }) } catch (e) { dbg('camp: restore ensureChest failed (' + e.message + ')') } }
            if (target && target.position) {
              try {
                const back = await provision.depositMaterials(bot, target, { keepDirt: 8, all: true })
                provision.rememberInfra('chest', target.position)
                dbg('camp: bank restored (' + (back != null ? back : '?') + ' redeposited)')
                hutPendingRestore = null
                return true
              } catch (e) { dbg('camp: bank restore deposit failed (' + e.message + ') - items safe in my pack') }
            }
            say('WARNING: could not re-deposit the treasury into a chest - it is safe in my pack, I will restore it first next pass')
            hutPendingRestore = { ts: Date.now() }
            return false
          }
          // Treasury LEFT in the pack from a prior failed pass is re-deposited BEFORE any repair
          // logic (invariant 1: never begin a pass on a pack-only bank).
          if (hutPendingRestore) { dbg('camp: pending bank restore from a prior pass - restoring the treasury first'); try { await restoreBank() } catch (e) { dbg('camp: pending restore failed (' + e.message + ')') } }
          const decision = hutModel.decideHutRepair({ bad, solidTotal, lastBad: hutRepairLatch.lastBad, lastAction: hutRepairLatch.lastAction })
          dbg('camp: hut repair decision=' + decision + ' (bad=' + bad + '/' + solidTotal + ' solid, lastBad=' + hutRepairLatch.lastBad + ' lastAction=' + hutRepairLatch.lastAction + ')')
          if (decision === 'patch') {
            // COMMON CASE: SKIP the destructive teardown entirely. provision.maintainHome (below)
            // runs repairHutStructure - re-places missing planks bottom-up, the door from OUTSIDE,
            // and missing furniture at their exact cells (materials via the resource model), and
            // NEVER opens/empties/digs the bank. Latch the pre-repair count so a pass that improves
            // nothing can never escalate to the destructive rebuild.
            say('damage on my safehouse (' + bad + ' cells off) - patching in place, bank untouched')
            hutRepairLatch = { lastBad: bad, lastAction: 'patch', ts: Date.now() }
          } else if (decision === 'rebuild') {
            // CATASTROPHIC only (hut genuinely unrecognizable). Reordered so nothing irreversible
            // happens before it's funded, and the treasury is protected by construction.
            say('safehouse critically damaged (' + bad + ' of ' + solidTotal + ' cells off) - one hardened rebuild')
            // 1) PROVISION FIRST, bank untouched: reconcile the BOM + unobtainable check BEFORE
            //    opening any chest. Unobtainable -> abort with the bank never opened (kills the
            //    "empty, then find out you can't build" stranding path), fall back to patch.
            const hutBom = schematic.billOfMaterials(hutSchem).counts
            if (hutBom.oak_door) hutBom.oak_door = 1
            if (hutBom.white_bed) hutBom.white_bed = 1
            let hasBedPlaced = false
            for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
              const g = bot.blockAt(new Vec3(hutAt.x + x, hutAt.y + y, hutAt.z + z))
              if (g && /_bed$/.test(g.name)) hasBedPlaced = true
            }
            const hrec = await resources.reconcile(bot, hutBom, { near: hutAt, planOpts: { primaryWood }, credit: hasBedPlaced ? { white_bed: 1 } : {} })
            if (Object.keys(hrec.plan.unobtainable || {}).length) {
              dbg('camp: hut BOM unobtainable ' + JSON.stringify(hrec.plan.unobtainable) + ' - aborting rebuild (bank untouched), patching instead')
              say('can\'t source the full rebuild - leaving the bank sealed and patching what I can')
              hutRepairLatch = { lastBad: bad, lastAction: 'patch', ts: Date.now() }
            } else {
              if (hrec.withdraws.length || hrec.plan.tasks.length) await resources.runReconciled(bot, hrec, { say, isStopped, restoreMovements: restore, homeY: hutAt.y, home: { x: hutAt.x, y: hutAt.y, z: hutAt.z }, avoid })
              // 2) VERIFIED EMPTY, or DON'T tear down (healBankDouble pattern, provision.js:7554-
              //    7563): withdraw per-name via withdrawItem, RE-READ chestCounts, and if any chest
              //    still holds items (pack full) ABORT the rebuild -> restore + fall back to patch,
              //    exactly like bank heal's "chest still holds ... aborting, nothing lost". This
              //    kills the clearFurniture spill: we never dig a chest with anything inside.
              const bankChests = (provision.listInfra('chest', bot) || []).filter(c => Math.hypot(c.x - hutAt.x, c.z - hutAt.z) <= 10)
              let emptied = true
              const saved = {}
              for (const c of bankChests) {
                const cb = bot.blockAt(new Vec3(c.x, c.y, c.z)); if (!cb || !/chest/.test(cb.name)) continue
                let counts = {}
                try { counts = await provision.chestCounts(bot, cb) } catch (e) { dbg('camp: bank read failed (' + e.message + ')'); continue }
                for (const n of Object.keys(counts)) { saved[n] = (saved[n] || 0) + counts[n]; try { await provision.withdrawItem(bot, cb, n, counts[n]) } catch {} }
                let left = {}
                try { left = await provision.chestCounts(bot, cb) } catch { left = { unknown: 1 } }
                if (Object.keys(left).length) { emptied = false; dbg('camp: bank chest at ' + c.x + ',' + c.y + ',' + c.z + ' still holds ' + Object.keys(left).join(',') + ' (pack full?)'); break }
              }
              const savedN = Object.values(saved).reduce((s, n) => s + n, 0)
              if (!emptied) {
                dbg('camp: bank NOT fully emptied - aborting rebuild, nothing lost, patching instead')
                say('pack too full to safely clear the bank - not tearing the hut down; restoring + patching')
                await restoreBank()
                hutRepairLatch = { lastBad: bad, lastAction: 'patch', ts: Date.now() }
              } else {
                dbg('camp: bank verified empty -> ' + savedN + ' items held in pack for the rebuild')
                // 3) try/finally TREASURY GUARD: a throw anywhere in build/refill still runs
                //    restoreBank() (kills the "throw -> outer catch -> refill skipped" path).
                let hr = null
                try {
                  const hutFetch = async (n, cnt) => { await resources.acquire(bot, n, cnt || 1, { near: hutAt, isStopped, say, batch: 32, planOpts: { primaryWood } }) }
                  hr = await schematic.buildSurvival(bot, hutSchem, hutAt, { say, isStopped, restoreMovements: restore, clear: true, clearFurniture: true, fetch: hutFetch })
                  dbg('camp: hut rebuilt -> ' + (hr && hr.placed) + '/' + (hr && hr.total) + ' at ' + hutAt.x + ',' + hutAt.y + ',' + hutAt.z)
                  provision.rememberInfra && provision.rememberInfra('hut', hutAt)
                  try { await provision.ensureHutApron(bot, hutAt, { isStopped, say }) } catch (e) { dbg('camp: apron fill failed (' + e.message + ')') }
                  try { await handle(bot, 'collect') } catch {}
                  const bedCell = findCell(/_bed$/)
                  if (bedCell) { const bb = bot.blockAt(bedCell); if (bb && /_bed$/.test(bb.name)) { try { await bot.activateBlock(bb); provision.rememberBed(bedCell) } catch {} } }
                  try { await handle(bot, 'remember hut') } catch {}
                } finally {
                  await restoreBank() // ALWAYS re-deposit the treasury (never strand the bank)
                }
                // 4) VERIFY with the SHARED tolerant classifier (composes with #36). Success only
                //    when placed>=total && bad2===0; on partial, latch bad2 so a pass that improved
                //    nothing cannot re-enter 'rebuild'.
                let bad2 = 0
                if (process.env.VERIFY_SUCCESS_MSG !== '0') {
                  for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
                    const w = hutSchem.getBlock(new Vec3(x, y, z)); const g = bot.blockAt(new Vec3(hutAt.x + x, hutAt.y + y, hutAt.z + z))
                    if (!g) continue
                    if (hutModel.cellMismatch((w && w.name) || 'air', g.name)) bad2++
                  }
                }
                const builtClean = process.env.VERIFY_SUCCESS_MSG === '0' || (bad2 === 0 && hr && hr.total && hr.placed >= hr.total)
                if (builtClean) { say('safehouse rebuilt clean - walls, door, bed, furnace, bank all in place'); hutRepairLatch = { lastBad: 0, lastAction: 'rebuild', ts: Date.now() } }
                else { dbg('camp: rebuild NOT clean - ' + bad2 + ' cell(s) still off, placed ' + (hr && hr.placed) + '/' + (hr && hr.total)); say('rebuilt the safehouse but ' + bad2 + ' cell(s) still off - no destructive retry until it improves'); hutRepairLatch = { lastBad: bad2, lastAction: 'rebuild', ts: Date.now() } }
              }
            }
          }
          // decision === 'none' -> nothing here; the liveability chain (maintainHome) still runs.
        }
        // LIVEABILITY - runs EVERY camp pass, even when no rebuild is due (bad <= 3). The
        // doorstep-fill and bed placement used to live INSIDE the bad>3 rebuild, so once the
        // hut was built they never ran again: the front-door pit stayed open (the bot couldn't
        // path in, so it fell back to an open-field chest and never entered) and a recovered bed
        // rode around unplaced (no spawn -> night-death carousel). Both self-heal here now,
        // decoupled from the rebuild. Idempotent: a filled apron / placed bed is a fast no-op.
        // ONE code path shared with the survival HOME-REPAIR reflex (index.js): apron -> bed
        // -> bank double-heal -> spawn re-assert -> structural repair + interior tidy ->
        // consolidate field chests. Extracted to provision.maintainHome so a creeper-damaged
        // base self-heals during ordinary idle survival too, not only on a full camp BOM.
        // Each step still no-ops fast when its piece is intact - behaviour identical here.
        try { await provision.maintainHome(bot, hutAt, { isStopped, say }) } catch (e) { dbg('camp: home maintenance failed (' + e.message + ')') }
      }
    } catch (e) { dbg('camp: hut failed (' + e.message + ') - continuing') }
    // (The old reach-based bank-migration + furnish + threshold-apron are RETIRED: the
    //  furnished schematic + verified rebuild above place the bank/furnace/table/bed/door
    //  deterministically. Operator: "furniture part of the schematic so we stop these issues".)
    // WHEAT FARM (operator order): renewable food at the camp - the region can run dry
    // of animals and the bot starved to death working. Water-edge plot, best-effort.
    checklistStep('camp: wheat farm')
    try { const ok = await provision.ensureWheatFarm(bot, { x: at.x, z: at.z }, { isStopped, say, avoid }); dbg('camp: wheat farm -> ' + ok) } catch (e) { dbg('camp: wheat farm failed (' + e.message + ')') }
    // REMEMBER the camp as a PLACE (operator rule): a named waypoint in persistent memory
    // - the brain sees it in /state waypoints and can `goto camp`; it survives restarts.
    try { const r = await handle(bot, 'remember camp'); dbg('camp: waypoint -> ' + r) } catch {}
    dbg('camp: setup pass done')
  }
  // ARMOR AFTER CAMP (operator order: "set up the hut FIRST"): camp is minutes of safe
  // surface work; the iron grind is a long death-prone cave dive that kept restarting
  // the job before the camp step ever ran - hut repair/bank/farm were starved out all
  // morning. The farm camp builds also feeds the miner, so armor converges FASTER here.
  checklistStep('armor up')
  const anyBare = () => Object.values(wornArmor(bot)).some(v => !v)
  const cowsNear = () => Object.values(bot.entities || {}).some(e => e && e.position && /^(cow|mooshroom)$/.test((e.name || '').toLowerCase()) && Math.hypot(e.position.x - at.x, e.position.z - at.z) <= 48)
  if (!isStopped() && process.env.ARMOR_BOOTSTRAP !== '0' && anyBare() && cowsNear()) {
    // leather pass only (cows verified nearby); iron runs as its own tuned pass below
    try { const r = await provisionArmor(bot, { say, isStopped, restoreMovements: restore, home: { x: at.x, z: at.z }, maxRoam: 48, maxExplores: 1, timeMs: 60000, ironFallback: false }); if (r) say(r) }
    catch (e) { say(`(armor bootstrap skipped: ${e.message})`) }
  }
  // IRON BOOTSTRAP (the root fix for the naked death-churn: a pillager patrol interdicted
  // the site for hours and leather needs cows that don't exist here). Mine/smelt/craft
  // the iron set - the planner handles the whole chain (raw_iron gather -> iron_ingot
  // smelt -> armor crafts), bounded by the plan's own budgets + the persisted
  // convergence back-off inside ironArmorBootstrap. The build continues regardless.
  if (!isStopped() && process.env.IRON_BOOTSTRAP !== '0' && anyBare()) {
    const r = await ironArmorBootstrap(bot, { say, isStopped, restoreMovements: restore, at, avoid, keepDirt: KEEP_DIRT })
    dbg('iron bootstrap: ' + r.msg)
    if (r.progressed) say('armor status: ' + r.msg)
  }
  const slotsUsed = () => (bot.inventory ? bot.inventory.items().length : 0)
  // Total holdings via the RESOURCE MODEL: pack + every world-verified site chest,
  // cached+persisted reads (a failed open or a restart no longer zeroes the bank tally
  // and sends the bot out to re-gather wood it owns - the oak sawtooth, live).
  const totalHave = async (name) => resources.totalHave(bot, name, { near: home, maxDist: 32 })

  // 1) provision each material, batch by batch; stash to the chest when the pack fills.
  // `skip` collects materials we can't fully get (unobtainable / no-progress / stuck) so the
  // BUILD phase drops those placements instead of hanging forever begging for them.
  checklistStep('gather materials')
  const skip = new Set()
  const BATCH = 96
  const home = { x: Math.round(at.x), y: Math.floor(at.y), z: Math.round(at.z) } // roam-fence anchor
  const MATERIAL_MS = parseInt(process.env.AUTOBUILD_MATERIAL_MS || '720000', 10) // wall-clock budget per material
  for (const [name, need] of Object.entries(bom)) {
    let noProgress = 0
    let lastHave = -1
    let badRounds = 0 // failed rounds with no gain - allow ONE retry (placement/pathing failures are transient)
    const matDeadline = Date.now() + MATERIAL_MS
    while (!isStopped()) {
      const have = await totalHave(name)
      if (have >= need) break
      // Hard wall-clock budget per material: a trickle of progress each round resets the
      // no-progress counter, so without this a slow/roamy gather grinds for an hour. Take
      // what we have and let the build phase skip the shortfall.
      if (Date.now() > matDeadline) { say(`out of time on ${name} at ${have}/${need} - building with what i have`); if (have < need) skip.add(name); break }
      // Give up only when we stop MAKING PROGRESS (a partial/slow smelt is fine as long
      // as each round adds some), not after a fixed number of rounds - a fixed guard
      // quit a slow 44-stone smelt at ~11 and then "built" with too little.
      if (have <= lastHave) { if (++noProgress >= 4) { say(`giving up on ${name} at ${have}/${need}`); if (have < need) skip.add(name); break } } else noProgress = 0
      lastHave = have
      // Round-start upkeep via the resource model: eat from the BANK before starving
      // (it died at 1hp with cooked food in its chest), and free pack slots BEFORE the
      // 36/36 deadlock (a full pack can't even craft - no output slot). ensurePackRoom
      // dumps junk first, then banks materials, so it replaces the plain dumpJunk.
      try { const fed = await resources.ensureFood(bot, { near: home, threshold: 16 }); if (fed) say('grabbed food from my chest') } catch {} // 16 ~ auto-eat's 17: restock before it grumbles
      // Bank empty AND starving? Run the whole food chain (hunt/farm/fish/scout/hold)
      // BEFORE the round - a round is minutes of work and the site can be eaten bare.
      if (provision.needsFood(bot)) { try { await provision.secureFood(bot, { isStopped, say, home, canHold: true }) } catch (e) { dbg('material food chain failed (' + e.message + ')') } }
      // HURT + ENDANGERED at round start? Shelter-and-heal BEFORE marching back into the mob
      // field (the hp12->0.77 treadmill: the loop only checked food and re-entered the dark
      // hurt). The latch makes this inline entry and the index.js hp-crisis reflex mutually
      // exclusive, so they never double-shelter.
      // Also covers the LIVELOCK state the arbiter heal need misses (hp<12, no hostile, day - not
      // "critical" and not "endangered"): lowHpCalm catches it so the bank-side recover (pack just
      // topped up by ensureFood above) gets a shot before the round marches back out hurt.
      { const sn = provision.survivalNeed(bot); if ((sn && sn.need === 'heal') || provision.lowHpCalm(bot)) { try { await provision.recoverHp(bot, { isStopped, say }) } catch (e) { dbg('material hp recover failed (' + e.message + ')') } } }
      try { await resources.ensurePackRoom(bot, 6, { near: home, keepDirt: KEEP_DIRT, isStopped }) } catch {}
      // START EACH ROUND FROM THE SITE, ON THE SURFACE. A failed gather can leave the bot
      // stranded deep in a cave 40+ blocks off (verified live: cobble round ended at y=61,
      // climb-out only reached y=62, and the NEXT round's log gather then started underground
      // and was doomed -> two bad rounds -> stone skipped -> 0/44 build). Recover first.
      const meY = Math.floor(bot.entity.position.y)
      if (meY < home.y - 6 && provision.hasSolidCeiling(bot)) {
        dbg('material', name, 'starting round buried at y=' + meY + ' - climbing to surface first')
        try { await provision.climbToSurface(bot, home.y, { isStopped }) } catch {}
      }
      // Walk home ONLY when there's a reason: pack full enough to stash, or the last
      // round made no progress (reset from a known-good anchor). Unconditionally walking
      // back every round made the bot COMMUTE hundreds of blocks between the site and
      // the forest for every batch (operator watched it shuttle for an hour, furious).
      const distHome = Math.hypot(bot.entity.position.x - home.x, bot.entity.position.z - home.z)
      const wantHome = slotsUsed() >= parseInt(process.env.AUTOBUILD_STASH_SLOTS || '28', 10) || noProgress > 0
      if (distHome > 24 && wantHome) {
        dbg('material', name, 'starting round ' + Math.round(distHome) + 'b from home - returning to ' + (noProgress > 0 ? 'reset' : 'stash'))
        try { await travelFar(bot, { x: home.x, y: home.y, z: home.z }, { isStopped, say: () => {}, gather: false }) } catch {}
      } else if (distHome > 24) {
        dbg('material', name, 'starting round ' + Math.round(distHome) + 'b out - CONTINUING from here (no reason to commute)')
      }
      const batch = Math.min(BATCH, need - have)
      buildProgress = { phase: 'gathering materials', material: name, have, need, materialsDone: Object.keys(bom).indexOf(name), materialsTotal: Object.keys(bom).length }
      say(`need ${name}: ${have}/${need} - gathering ${batch}`)
      // RECONCILE the batch against TOTAL holdings (pack + bank): banked ingredients get
      // WITHDRAWN, craftables CRAFTED, and only the true remainder gathered - the old
      // pack-only plan re-gathered logs for sticks while the bank held a hundred. The
      // target item itself is HIDDEN: `batch` is already the shortfall net of everything
      // owned, so crediting it again emits an empty plan (verified: dirt 8/14 stuck).
      // INV_TOOLBANK: a pick that dug ONE block is no longer "fresh" today -> planner sees 0 picks
      // and crafts more. Count picks with real durability left instead (threshold = needReTool's low).
      // Flag off => the old strictly-unworn count (byte-for-byte).
      const freshPicks = (bot.inventory ? bot.inventory.items() : []).filter(i => i.name === 'wooden_pickaxe' && ((process.env.INV_DISCIPLINE !== '0' && process.env.INV_TOOLBANK !== '0') ? mining.toolUsesLeft('wooden_pickaxe', i.durabilityUsed || 0) >= Number(process.env.INV_PICK_MIN_USES || 20) : !(i.durabilityUsed > 0))).length
      const rec = await resources.reconcile(bot, { [name]: batch }, { near: home, hide: [name], planOpts: { primaryWood, freshPickaxes: freshPicks, furnacesNearby: provision.countFurnacesNear(bot) } })
      const plan = rec.plan
      dbg('material', name, have + '/' + need, '-> withdraw:', rec.withdraws.map(w => `${w.count} ${w.item}`).join(',') || 'none', '| plan:', plan.tasks.map(t => `${t.type}:${t.item || t.output}`).join(',') || '(empty)', '| unobtainable:', Object.keys(plan.unobtainable || {}).join(',') || 'none')
      if (Object.keys(plan.unobtainable || {}).length) { say(`can't obtain ${name} - skipping`); skip.add(name); break }
      if (!plan.tasks.length && !rec.withdraws.length) { dbg('material', name, 'EMPTY PLAN but have', have, '< need', need, '- breaking'); break }
      const before = await totalHave(name)
      // homeY = the build-site SURFACE (the ground-snapped origin), a persistent anchor
      // so strip-mining measures depth from the real surface and can't ratchet the bot
      // down toward lava across batches.
      const results = await resources.runReconciled(bot, rec, { say, isStopped, restoreMovements: restore, homeY: Math.floor(at.y), home, avoid })
      const STASH_AT = parseInt(process.env.AUTOBUILD_STASH_SLOTS || '28', 10) // slots-used before offloading (tunable)
      // BANK BY VALUE, not just slots: 103 oak logs fit in TWO slots, so the slot
      // threshold never fired all evening - the bot carried its whole fortune into a
      // skeleton chase and the grave despawned with it (oak 103 -> 1, live). Any
      // meaningful pile of build material gets deposited whenever we're at the site;
      // a death now costs at most one round's haul.
      const invPile = (provision.inventoryCounts(bot)[name] || 0)
      if (slotsUsed() >= STASH_AT || invPile >= 48) await stash()
      const bad = results.filter(r => !r.ok)
      if (bad.length && (await totalHave(name)) <= before) {
        // One free retry: a failed round with no gain is often a TRANSIENT placement/pathing
        // miss ("nowhere to place a crafting table", "No path to the goal!") that succeeds
        // from the bot's next position - instantly skipping the material doomed whole builds.
        if (++badRounds >= 2) { say(`stuck getting ${name}: ${bad[0].note}`); if ((await totalHave(name)) < need) skip.add(name); break }
        say(`(retrying ${name}: ${bad[0].note})`)
      } else badRounds = 0
    }
    if (isStopped()) return { stopped: true, phase: 'provision', placed: 0, total: 0 }
  }

  // 2) build. Every build gets the resource-model fetch: a missing material is
  // WITHDRAWN from the bank or CRAFTED from holdings on the spot - waitForMaterial
  // only ever begs a player for things the bot truly cannot obtain itself.
  checklistStep('build')
  buildProgress = { phase: 'placing blocks', material: null, have: 0, need: 0 }
  let lastRestock = 0
  const fetch = async (n, cnt) => {
    await resources.acquire(bot, n, cnt || 1, { near: home, isStopped, say, batch: 128, planOpts: { primaryWood } })
    // MULTI-MATERIAL BATCHING (throughput): we walked to the bank for `n` - while we're here,
    // top up the OTHER low, banked, still-needed BOM materials in the SAME visit, so a castle
    // phase doesn't trek back to the bank every time the placement order switches block type.
    // Throttled (a bank trip is expensive; not every fetch) and withdraw-only (never gathers).
    if (Date.now() - lastRestock > 30000) {
      lastRestock = Date.now()
      try { const extra = await resources.restockFromBank(bot, bom, { near: home, isStopped }); if (extra) dbg('build: batched restock of +' + extra + ' items in one bank visit') } catch (e) { dbg('build: batched restock failed (' + e.message + ')') }
    }
  }
  // SELF-GATHER a mid-build shortfall (the bot NEVER begs). Same reconcile chain + params as the
  // phase-1 material loop: hide the target (batch is the true shortfall), fence to home, carry the
  // build keep-out box (avoid) so it never digs/chops inside the footprint - no new dig paths. A
  // BOUNDED batch (16..64), gated on BUILD_SELF_GATHER. Returns 'unobtainable' | 'gained' | 'none'.
  const gatherShort = async (name, cnt) => {
    const batch = Math.min(64, Math.max(cnt || 1, 16)) // never one-block-at-a-time
    // INV_TOOLBANK: durability-aware fresh-pick count (see the material loop). Flag off => old count.
    const freshPicks = (bot.inventory ? bot.inventory.items() : []).filter(i => i.name === 'wooden_pickaxe' && ((process.env.INV_DISCIPLINE !== '0' && process.env.INV_TOOLBANK !== '0') ? mining.toolUsesLeft('wooden_pickaxe', i.durabilityUsed || 0) >= Number(process.env.INV_PICK_MIN_USES || 20) : !(i.durabilityUsed > 0))).length
    const rec = await resources.reconcile(bot, { [name]: batch }, { near: home, hide: [name], planOpts: { primaryWood, freshPickaxes: freshPicks, furnacesNearby: provision.countFurnacesNear(bot) } })
    if (Object.keys(rec.plan.unobtainable || {}).length) return 'unobtainable'
    const before = provision.inventoryCounts(bot)[name] || 0
    try { await resources.runReconciled(bot, rec, { say, isStopped, restoreMovements: restore, homeY: Math.floor(at.y), home, avoid }) } catch (e) { dbg('build gatherShort ' + name + ' failed (' + e.message + ')') }
    return (provision.inventoryCounts(bot)[name] || 0) > before ? 'gained' : 'none'
  }
  if (chest || resources.verifiedChests(bot, home, 32).length) {
    await stash()
    const invDirt = provision.inventoryCounts(bot).dirt || 0
    if (invDirt < KEEP_DIRT) await resources.withdrawItems(bot, 'dirt', KEEP_DIRT - invDirt, { near: home }).catch(() => {})
    say('materials stashed - building now')
  } else say('got the materials - building now')
  const gather = process.env.BUILD_SELF_GATHER !== '0' ? gatherShort : undefined // flag off -> silent wait + skip, still never begs
  try { return await schematic.buildSurvival(bot, schem, at, { say, isStopped, restoreMovements: restore, fetch, gather, clear: opts.clear, skip }) } finally { buildProgress = null }
}

// Called by the body when the bot DIES mid-build: just stop the running loop. resumeJob
// is KEPT because the build's .then/.catch below skip clearing it when a death is fresh
// (a flag would race the loop's own rejection; a "died in the last few seconds?" check
// is order-independent since recordDeath runs synchronously in the death event).
// Called by the body on DEATH: abort the running loop AND flag that its termination is an
// interruption (not a stop). The flag - not a "died in the last 5s" window - is what the
// unwinding promise checks: the real unwind took 33s live (smelt stall-detection latency),
// blowing past any time window, so the old diedJustNow() check cleared resumeJob and
// reported "stopped 0/0" on a genuine death. The flag is CONSUMED (set false) by whichever
// settle-handler observes it, exactly once.
function markBuildInterrupted () {
  buildAbort = true
  if (resumeJob) { buildInterrupted = true; resumeDeaths++; dbg('death: build interrupted (resumeDeaths=' + resumeDeaths + ', building=' + building + ')') }
}
// Set the resume job EARLY (at build-request time, before the trek) so a death DURING the
// long travel to the site still resumes - the most likely death window for a naked bot.
// Uses the loaded schematic + the requested point (approximate origin); autoBuild later
// overwrites `at` with the precise ground-snapped origin.
function setResumeJob (pt) { if (loadedSchem && pt) { resumeJob = { schem: loadedSchem.schem, at: new Vec3(pt.x, pt.y, pt.z) }; resumeDeaths = 0; persistResume(loadedSchem.name, pt) } }

// DISK-PERSISTED resume: the in-memory resumeJob dies with the process (restart/crash/
// reboot), which lost the castle job twice live. Save {schematic name, origin} so a
// fresh process can pick the build back up via the `resumebuild` command.
const RESUME_FILE = process.env.RESUME_FILE || path.join(__dirname, 'resume-job.json') // env-overridable (test isolation)
function persistResume (name, at) {
  try { fs.writeFileSync(RESUME_FILE, JSON.stringify({ name, at: { x: at.x, y: at.y, z: at.z }, savedAt: new Date().toISOString() })) } catch (e) { dbg('persistResume FAILED: ' + e.message) }
}
function clearPersistedResume () { try { fs.unlinkSync(RESUME_FILE) } catch {} }
function persistedResume () {
  try { return JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8')) } catch { return null }
}
// PAUSE the saved job in place (operator stop / shortfall finish / death give-up): stamp
// pausedAt so the resume machinery holds off for RESUME_HOLD_MS, then autonomy picks it back
// up. NOT a delete - operator intent survives; only cancelbuild or a real finish removes it.
function markResumePaused (why, holdMs) {
  try {
    const saved = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'))
    saved.pausedAt = Date.now(); saved.pausedWhy = String(why || '')
    // optional per-pause hold (supervisor unstick = short); absent -> resumeHoldRemaining uses RESUME_HOLD_MS
    if (holdMs != null && Number(holdMs) > 0) saved.pauseHoldMs = Number(holdMs); else delete saved.pauseHoldMs
    fs.writeFileSync(RESUME_FILE, JSON.stringify(saved))
  } catch (e) { dbg('markResumePaused failed: ' + e.message) }
}
// PURE: ms left on a pause hold (0 = resume now). No file / no pausedAt / malformed pausedAt
// all -> 0 (fail OPEN to resume, the safe direction - a saved build must not stall forever).
function resumeHoldRemaining (saved, now) {
  const paused = saved && Number(saved.pausedAt)
  if (!paused || Number.isNaN(paused)) return 0
  const hold = (saved && Number(saved.pauseHoldMs) > 0) ? Number(saved.pauseHoldMs) : RESUME_HOLD_MS
  return Math.max(0, paused + hold - now)
}
// PURE: what to do with the saved build when a build loop settles (DESIGN §5). Clear ONLY a
// genuine finish; shortfall/all-skipped -> pause (keep the job); errored/deferred/aborted -> keep.
function finishDisposition (r) {
  if (!r) return 'keep'                    // errored/undefined - never delete on a throw
  if (r.deferred) return 'keep'            // resume deferred (old loop still unwinding)
  if (r.stopped) return 'keep'             // aborted, not finished
  if ((r.skipped || 0) > 0) return 'pause' // "done" but blocks/materials are still owed - shortfall
  return 'clear'                           // placed everything it set out to place
}

// Resume an interrupted build after respawn. Travels back to the site (we respawn far
// away), then re-runs autoBuild - which RE-PROVISIONS whatever we lost (even if we
// couldn't get our items back: it re-gathers/crafts from scratch, or pulls from the
// build's chest if it survived) and Build diffs world-vs-schematic, so it just finishes
// the missing blocks. Returns the result, or null if there's nothing to resume.
async function resumeBuild (bot) {
  if (!resumeJob) { buildInterrupted = false; return null } // nothing to do; clear any stale flag
  // Give-up guard: N consecutive deaths without reaching the site = a death loop (lethal
  // respawn area / unreachable site). Say so, clear the job, stop retrying - else every
  // respawn restarts the same naked death-march forever.
  if (resumeDeaths > RESUME_MAX_DEATHS) {
    dbg('resume: gave up after', resumeDeaths, 'consecutive deaths (job stays on disk - send "resumebuild" to try again)')
    bot.chat(`i keep dying trying to get back (${resumeDeaths}x) - giving up on that build for now`)
    recordOutcome('autobuild resume', false, `gave up after ${resumeDeaths} deaths - "resumebuild" restarts it`)
    // Stop RETRYING but keep the job ON DISK: giving up used to clearPersistedResume(),
    // which erased the castle from existence and left "resumebuild" with nothing to load
    // (had to hand-recreate the file, live). The auto-retry loop ends here; a human (or a
    // calmer future respawn) can still say "resumebuild". Stamp the pause so the re-arm loop
    // honors a real hold instead of the old ~2-min breather (resumebuild resets resumeDeaths).
    if (STOP_KEEPS_BUILD) markResumePaused('gave up after ' + resumeDeaths + ' deaths')
    resumeJob = null; buildInterrupted = false; resumeDeaths = 0
    return null
  }
  // #41 P0.1 (THE core inversion): after a death, RECOVERY owns the bot and OUTRANKS build-resume.
  // While the post-death latch is set and recovery is not yet complete (recoveryReady, P4), the build
  // WAITS - kept on disk, NEVER driving the naked bot back into the death cell (fixes RC-A). No
  // building=true, no trek. recoveryReadyNow re-checks vitals/gear + clears the latch when ready.
  if (isPostDeathRecovery()) {
    let ready = true
    try { ready = await provision.recoveryReadyNow(bot) } catch { ready = true }
    let gate = 'proceed'
    try { gate = require('./scheduler.js').resumeGate({ postDeathRecovery: isPostDeathRecovery(), ready }) } catch {}
    if (gate === 'wait') { dbg('resume: post-death recovery in progress - holding the build (kept on disk)'); return { deferred: true, recovering: true } }
  }
  // #41 P5c anti-spiral: during a death SPIRAL, don't march the build back into a recent death
  // cluster (defer that leg; the build stays saved). Only fires under a real spiral (>=SPIRAL_N
  // deaths in 20 min) AND when the site itself sits inside the cluster. RESILIENT_RECOVERY=0 -> off.
  if (process.env.RESILIENT_RECOVERY !== '0' && resumeJob) {
    try {
      const S = require('./scheduler.js')
      const now = Date.now()
      const recent = deathLedger.filter(d => d && now - (d.at || 0) < 20 * 60000)
      if (recent.length >= Number(process.env.SPIRAL_N || 3) && S.withinDeathZone(resumeJob.at, recent.map(d => ({ x: d.x, z: d.z })))) {
        dbg('resume: death spiral + build site in a recent death cluster - holding the build (kept on disk)')
        return { deferred: true, recovering: true }
      }
    } catch {}
  }
  // Wait until the OLD loop is FULLY out: its settle-handler sets building=false and
  // consumes buildInterrupted in one synchronous block, so building===false proves the
  // handler already ran (resumeJob preserved, activity ended). Bounded 90s (a mid-smelt
  // death took ~33s to unwind live); if it's STILL unwinding, NEVER proceed concurrently
  // - defer and let the respawn handler retry. (The old 12s-then-proceed-anyway version
  // ran TWO autoBuilds at once and its buildAbort=false un-aborted the dying loop.)
  for (let i = 0; i < 180 && building; i++) await new Promise(r => setTimeout(r, 500))
  if (building) { dbg('resume: old build still unwinding after 90s - deferring'); return { deferred: true } }
  if (!resumeJob) return null // finished/stopped while we waited
  const job = resumeJob
  const say = throttledSay(bot)
  buildInterrupted = false // consumed: we ARE the resume now
  building = true; buildAbort = false // safe: the old loop is provably gone
  beginActivity('autobuild', `resume @ ${job.at.x},${job.at.y},${job.at.z}`)
  checklistBegin(JOB_STEPS)
  checklistStep('travel to site') // covers rest-first + grave detour + the trek itself
  let result = null
  let travelBlocked = false // so the finally reports "unreachable", not a phantom death
  try {
    // Only claim a death when one actually happened - this same flow also runs after a
    // plain process restart, and "i died" with no death confused the operator (live).
    const justDied = lastDeath && Date.now() - (lastDeath.at || 0) < 120000
    // "back online" only on a GENUINE reconnect (first resume this process); a re-arm retry on an
    // already-online bot stays quiet so it doesn't spam the line every 2 min. A death always announces.
    if (justDied) say(`i died - heading back to finish the build at ${job.at.x},${job.at.y},${job.at.z}`)
    else if (!resumeAnnounced) { say(`back online - picking up my build at ${job.at.x},${job.at.y},${job.at.z}`); resumeAnnounced = true }
    // NIGHT-FIRST: a fresh respawn is naked; prepping/trekking at night IS the death loop
    // (verified live: 3 deaths in 90s at spawn). We respawn AT the bed - sleep in it (or
    // pit as fallback) until morning, THEN gear up and go.
    if (provision.isNight(bot) && provision.underArmored(bot)) {
      dbg('resume: night + no armor - resting till morning before heading back (BLOCKING)')
      try { await provision.restUntilSafe(bot, { isStopped: () => buildAbort, say }) } catch {}
    }
    if (buildAbort) return (result = { stopped: true, placed: 0, total: 0 })
    // SPAWN FIRST when the anchor is known WRONG (survival tier - the world-spawn
    // carousel root): BEFORE any grave detour or site trek, get home and re-anchor the
    // bed. A deep corpse-run on a broken anchor is how one death became an all-night
    // spiral (die -> respawn 430b out -> die trekking -> repeat). The grave is fetched AFTER the
    // anchor (task #18: AxGraves DOES despawn on a timer, so recover's own urgency/cooldowns race
    // it - but a broken anchor is the bigger loss). Food/sword near the respawn first (bounded), then
    // the trek home; failure is retried on the next respawn (the flag is persisted).
    if (spawnIsSuspect()) {
      dbg('resume: spawn anchor is SUSPECT - going home to re-anchor before anything else')
      try { await survivalPrep(bot, { say, isStopped: () => buildAbort }) } catch (e) { dbg('resume: prep before spawn-recovery failed (' + e.message + ')') }
      if (buildAbort) return (result = { stopped: true, placed: 0, total: 0 })
      try {
        const ok = await provision.recoverSpawnAnchor(bot, { isStopped: () => buildAbort, say })
        if (ok) spawnSuspect = false
        dbg('resume: spawn-recovery ' + (ok ? 'RESTORED the anchor' : 'did not restore the anchor - continuing, will retry next respawn'))
      } catch (e) { dbg('resume: spawn-recovery failed (' + e.message + ')') }
      if (buildAbort) return (result = { stopped: true, placed: 0, total: 0 })
    }
    // GET THE STUFF BACK first when it's safe: a recovery detour beats re-gathering the whole kit.
    // NOTE (task #18): the live AxGraves plugin DESPAWNS graves on a timer - recover itself now
    // prioritizes urgent graves and back-off is verdict-classed, so the sooner this fires the better.
    // Skipped for lava/void deaths and best-effort - a failed recovery must never block the resume.
    const grave = bestGrave()
    if (grave) {
      // WRITE OFF worthless or suicidal graves instead of trekking: a naked-death grave
      // holds nothing (tonight's carousel made 5 pointless recovery treks), and a naked
      // corpse-run to a deep cave through the mobs that just killed you is how death
      // carousels happen (verified live: died at y=4, then died AGAIN going back).
      // (bestGrave already filters out worthless deaths - dying with 1 dirt never
      // triggers a corpse run at all; only gear/real loot is worth the trek.)
      const deep = grave.y < job.at.y - 15
      const naked = !(bot.inventory ? bot.inventory.items() : []).some(i => /_(pickaxe|axe|sword)$|_chestplate$/.test(i.name))
      if (deep && naked) {
        grave.retrieved = true; persistDeath()
        say("my stuff's too deep in that cave - not worth dying for, moving on")
      } else {
        try { const r = await handle(bot, 'recover'); dbg('resume: recover -> ' + String(r).split(String.fromCharCode(10))[0]) } catch (e) { dbg('resume: recover failed (' + e.message + ')') }
        if (buildAbort) return (result = { stopped: true, placed: 0, total: 0 })
      }
    }
    const me = bot.entity.position
    let near = Math.hypot(job.at.x - me.x, job.at.z - me.z) <= 40
    if (!near) {
      // A post-death respawn is just as NAKED as first spawn - re-secure sword/food/armor
      // near the respawn point BEFORE the trek back. Idempotent + bounded. The trek gets
      // a couple of retries - one blocked/aborted leg must NOT fall through to autoBuild
      // 600 blocks from the site (verified live: it "finished" 0/2350 all-skipped from
      // the respawn point and CLEARED the castle job).
      try { await survivalPrep(bot, { say, isStopped: () => buildAbort }) } catch (e) { say(`(prep: ${e.message})`) }
      for (let attempt = 0; attempt < 3 && !near && !buildAbort; attempt++) {
        const tr = await travelFar(bot, { x: job.at.x, y: job.at.y, z: job.at.z }, { isStopped: () => buildAbort, say })
        near = (tr && tr.ok) || Math.hypot(job.at.x - bot.entity.position.x, job.at.z - bot.entity.position.z) <= 40
        if (!near && !buildAbort) dbg('resume: travel attempt ' + (attempt + 1) + ' fell short (' + (tr && tr.reason) + ') - retrying')
      }
    }
    if (buildAbort) return (result = { stopped: true, placed: 0, total: 0 }) // died/stopped mid-travel
    if (!near) {
      // Still can't reach the site: KEEP the job for the next respawn/attempt instead of
      // "building" from here - autoBuild far from the site skips everything and reports done.
      say("can't reach the build site right now - i'll try again")
      travelBlocked = true
      buildInterrupted = true // route the finally through the keep-the-job branch
      return (result = { stopped: true, placed: 0, total: 0 })
    }
    resumeDeaths = 0; dbg('resume: back at the site - death counter reset')
    // SPAWN GUARANTEE: while we're home, make sure the respawn anchor really is the hut
    // bed. Forced when the last respawn landed far from it (server anchor lost - bed
    // broken/obstructed/moved) - the fix for the world-spawn death carousel: without
    // this every future death respawns at 0,0 naked and the job never converges.
    try {
      const ok = await provision.ensureSpawnBed(bot, { isStopped: () => buildAbort, say, force: spawnIsSuspect() })
      if (ok) spawnSuspect = false
      dbg('resume: spawn bed ' + (ok ? 'asserted' : 'NOT asserted (no bed reachable)'))
    } catch (e) { dbg('resume: spawn assert failed (' + e.message + ')') }
    result = await autoBuild(bot, job.schem, job.at, {
      // FLATTEN THE FOOTPRINT (operator: "if there's a mountain in the way, build inside
      // it? flatten and make even terrain with dirt first"): empty the build box of any
      // intruding terrain and fill holes under the floor with dirt before placing.
      say, isStopped: () => buildAbort, restoreMovements: () => setupMovements(bot), clear: true
    })
    return result
  } finally {
    building = false; setupMovements(bot)
    if (buildInterrupted) { // interrupted (death or unreachable site): keep the job
      buildInterrupted = false
      const why = travelBlocked ? 'site unreachable - will retry' : 'died again mid-resume - will retry after respawn'
      dbg('resume: ' + (travelBlocked ? 'site unreachable' : 'died again mid-resume') + ' - keeping resumeJob (deaths=' + resumeDeaths + ')')
      endActivity(false, why, { detached: true })
    } else {
      resumeJob = null
      const disp = STOP_KEEPS_BUILD ? finishDisposition(result) : (result && !result.stopped ? 'clear' : 'keep')
      if (disp === 'clear') clearPersistedResume() // resumed to a real finish
      else if (disp === 'pause') { markResumePaused(`shortfall: ${result.placed}/${result.total} placed, ${result.skipped} skipped`); try { bot.chat(`build ended short (${result.placed}/${result.total}, ${result.skipped} skipped) - keeping it saved; "cancelbuild" drops it`.slice(0, 256)) } catch {} }
      endActivity(!!result && !result.stopped, result ? `${result.placed}/${result.total} placed${result.stopped ? ' (stopped)' : ''}` : 'no result', { detached: true })
    }
  }
}

module.exports = { handle, state, setupMovements, travelMovements, eatFood, placeTorchNearby, isBusy, isEscaping, maybeResumeFollow, recordDeath, markBuildInterrupted, resumeBuild, trackTick, recordOutcome, setBuildReqActive, survivalPrep, setResumeJob, setLogger, persistedResume, flagSpawnSuspect, worthwhileGrave, shouldChaseGrave, graveLootVerdict, gravesSnapshot, graveUrgency, graveCompare, equipCarriedArmor, activityInfo, preemptForSurvival, setDebugSink, finishDisposition, resumeHoldRemaining, markResumePaused, touchProgress, progressInfo, markStalled, _resetProgress, recentOutcomes, setPostDeathRecovery, isPostDeathRecovery, clearPostDeathRecovery, postDeathRecoveryHeldMs }
