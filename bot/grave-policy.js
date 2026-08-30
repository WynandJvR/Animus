'use strict'
// GRAVE POLICY (pure): is a grave worth going back for, how urgently, and did a loot
// attempt actually empty it. Split out of commands.js unchanged - these are the decisions
// that used to sit in the middle of the command layer's mutable build/telemetry state,
// where they could only be exercised by standing up the whole module.
//
// PURE by construction: every function here takes plain data (a ledger entry, a snapshot,
// an attempt outcome) and returns plain data. No bot handle, no fs, no module state, no
// clock except an injectable `now`. That is what makes them offline-testable, and it is
// why they were the safe half to move first - the STATEFUL half (deathLedger, bestGrave,
// gravesSnapshot, recordDeath) stays in commands.js, which still owns the ledger.
//
// Thresholds are read from env LIVE (per call), matching the house pattern, so an operator
// override takes effect without a restart.

// Crude value score: gear counts for far more than bulk, so a grave with a pickaxe outranks
// a pile of dirt. Used for ordering, never as a worth-it gate on its own.
function graveValue (d) { const it = d.items || {}; return (it.notable ? it.notable.length * 10 : 0) + (it.count || 0) }

// A grave is WORTH a corpse run only if it holds gear (tools/armor/ingots) or a real pile
// of loot. Dying with 1 dirt = let it go, like a player would - the trek itself is the risk.
function graveWorthIt (d) {
  const it = d.items || {}
  // Wooden/stone tools cost less to recraft than the trek into whatever killed you -
  // only REAL gear (iron+, any armor) or genuine bulk justifies a corpse run.
  const realGear = (it.notable || []).some(n => /^(iron|diamond|netherite|golden)_|_(helmet|chestplate|leggings|boots)$/.test(n))
  // #98 GRAVE_TOOL_WORTH (default on): ANY tool makes the grave worth a run. "Wooden tools cost
  // less to recraft than the trek" assumes a world with wood - on this deforested map the bot's
  // only hoe died 7b from home and the fetch was refused as junk, orphaning the food bootstrap
  // (live 11:30Z: graves=0 with the hoe grave on the surface next door). Distance/danger stay
  // gated by the reach bands; worth just says "a tool is never litter".
  const toolWorth = process.env.GRAVE_TOOL_WORTH !== '0' && (it.notable || []).some(n => /_(hoe|pickaxe|sword|axe|shovel)$/.test(n))
  // FIX #16 (GRAVE_BUILD_WORTH, default on): a meaningful stash of BUILD materials (logs, planks,
  // cobble, stone) is worth a corpse run even below the generic count>=10 bulk bar - the bot used
  // to abandon a grave holding a big stack of wood. GRAVE_BUILD_MIN (default 6, below the count bar
  // so it genuinely widens) keeps trivial single items out. GRAVE_BUILD_WORTH=0 -> gear+count only.
  const buildWorth = process.env.GRAVE_BUILD_WORTH !== '0' && (it.build || 0) >= Number(process.env.GRAVE_BUILD_MIN || 6)
  return realGear || toolWorth || (it.count || 0) >= 10 || buildWorth
}

// GRAVE DESPAWN CLOCK (task #18). AxGraves graves on the live server sit on a plugin despawn
// timer; GRAVE_DESPAWN_S is the operator-set despawn-time (seconds) and the ledger `at` is the
// death time = that timer's t0. Classify how much budget is left so at-risk graves are
// prioritized before they're lost. GRAVE_URGENT=0, or GRAVE_DESPAWN_S unset/0 -> no clock known ->
// everything reports 'safe' and NOTHING downstream changes (fail-safe: a mis-set clock only ever
// costs one walk to an already-empty site, never a silent write-off).
//   -> { ageMs, remainMs, tier: 'safe' | 'urgent' | 'critical' | 'expired' }
//      urgent: remain <= 60% window   critical: remain <= 25% window OR < 120s   expired: age >= 1.5x window
function graveUrgency (d, now) {
  const at = (d && d.at) || 0
  const t = now != null ? now : Date.now()
  const windowS = Number(process.env.GRAVE_DESPAWN_S || 0)
  const ageMs = at ? Math.max(0, t - at) : 0
  if (process.env.GRAVE_URGENT === '0' || !(windowS > 0) || !at) return { ageMs, remainMs: Infinity, tier: 'safe' }
  const windowMs = windowS * 1000
  const remainMs = windowMs - ageMs
  let tier
  if (ageMs >= windowMs * 1.5) tier = 'expired'
  else if (remainMs <= windowMs * 0.25 || remainMs < 120000) tier = 'critical'
  else if (remainMs <= windowMs * 0.6) tier = 'urgent'
  else tier = 'safe'
  return { ageMs, remainMs, tier }
}

function graveUrgencyRank (tier) { return tier === 'critical' ? 2 : (tier === 'urgent' ? 1 : 0) }

// PURE ordering for bestGrave (M1 urgency priority): among worthwhile graves an urgent/critical one
// outranks a richer SAFE one ONLY when GRAVE_URGENT is on (a rich safe grave can wait; a poor dying
// one can't). Falls back to today's value-first, then newest. <0 => a sorts first. GRAVE_URGENT=0
// (or no despawn clock) -> byte-equivalent to today's sort.
// ...AND, GIVEN WHERE THE BODY IS, THE SAME SCORE THE CHOOSER USES (2026-08-30). The scheduler ranks
// its snapshot rows by graveScore (net value over distance) and picked "near grave 2b"; this ranker
// was value-only, so the handler it dispatched walked toward a richer grave 164b away at dusk. One
// ranker: urgency first (a despawning grave does not keep), then net value per block of trek.
function graveCompare (a, b, now, pos) {
  if (process.env.GRAVE_URGENT !== '0') {
    const ru = graveUrgencyRank(graveUrgency(b, now).tier) - graveUrgencyRank(graveUrgency(a, now).tier)
    if (ru) return ru
  }
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
    const sc = g => graveScore({ value: graveValue(g), salvage: g.salvage, dist: Math.hypot(g.x - pos.x, g.z - pos.z) })
    const ds = sc(b) - sc(a)
    if (ds) return ds
  }
  return (graveValue(b) - graveValue(a)) || ((b.at || 0) - (a.at || 0))
}

// SURVIVAL GATE for the respawn grave chase. The live death spiral:
// on a far respawn (bed creeper-destroyed -> WORLD SPAWN ~380b from home) the handler sent a
// NAKED, empty-pack bot on a long trek to chase dropped gear - it STARVED (food 20->0) and got
// beaten to death en route, then respawned and repeated, bleeding gear every loop. A grave is
// only worth chasing when the bot is SAFE + FED and the grave is reasonably reachable. No bot
// handle - just data - so the "is it safe to go?" decision is unit-tested without a world.
// Returns { chase, reason }. Distances are XZ ("far" is horizontal; respawn Y varies).
function shouldChaseGrave ({ grave, pos, food, threat, escaping, home, maxDist, dangerous } = {}) {
  if (!grave || !pos) return { chase: false, reason: 'no grave or position' }
  const dngr = dangerous != null ? dangerous : !!(grave && grave.dangerous)
  // ACTIVE-HAZARD defers ALWAYS, at any distance: a hostile on the bot, an in-progress flee, or
  // a grave sitting in/over lava/void is never worth walking into for a few items.
  if (escaping) return { chase: false, reason: 'fleeing a hazard - defer grave' }
  if (threat) return { chase: false, reason: `hostile ${threat.type || 'mob'} ${threat.dist != null ? threat.dist + 'b' : 'near'} - defer grave until safe` }
  if (dngr) return { chase: false, reason: 'grave is in/over a hazard (lava/void) - defer, not worth dying for' }
  const dBot = Math.hypot(grave.x - pos.x, grave.z - pos.z)
  // Reachable if the grave is within MAXD of where we ARE, or of HOME (a grave near base is
  // fine to fetch even mid-trek; a grave far across hostile ground from both is written off).
  const dHome = home ? Math.hypot(grave.x - home.x, grave.z - home.z) : Infinity
  const near = Math.min(dBot, dHome)
  // NEAR-GRAVE OVERRIDE (S1 hotfix, invariant I3): a non-dangerous,
  // no-threat grave within GRAVE_NEAR IS the survival move itself - free armor + often food at
  // arm's reach, ~zero trek risk - so it is chased REGARDLESS of food/hp. Distance is classified
  // FIRST; the food gate below only guards a genuine FAR trek. The old order ran the food gate
  // BEFORE distance, so a 3b grave was deferred *because* the corpse-run had made the bot hungry
  // - and each death ratcheted the bot into a strictly weaker respawn. S1_HOTFIX=0 rolls back.
  const GRAVE_NEAR = Number(process.env.GRAVE_NEAR || 16)
  if (process.env.S1_HOTFIX !== '0' && near <= GRAVE_NEAR) return { chase: true, reason: `grave ${Math.round(near)}b away (<= ${GRAVE_NEAR}) - free gear at arm's reach, chasing regardless of food/hp` }
  // FAR grave: a starving bot must NOT trek - the trek is what drains 20->0 and kills it. Defer,
  // eat/gear up near home, retry when fed. food==null (not spawned yet) is treated as -> defer.
  const FOOD_MIN = Number(process.env.GRAVE_MIN_FOOD || 12)
  if (food == null || food < FOOD_MIN) return { chase: false, reason: `too hungry to trek (food ${food == null ? '?' : food} < ${FOOD_MIN}) - defer grave until fed` }
  const MAXD = Number(maxDist != null ? maxDist : (process.env.GRAVE_MAX_DIST || 96))
  if (near > MAXD) return { chase: false, reason: `grave ${Math.round(near)}b away (> ${MAXD}) across open ground - defer/write off, not worth starving for` }
  return { chase: true, reason: `safe + fed (food ${food}), grave ${Math.round(near)}b within reach` }
}

// PURE grave-loot verdict (fix #12). Given the plain-data outcome of a grave-loot attempt, decide
// whether the grave is genuinely emptied (mark retrieved) or an honest partial (leave it - the
// scheduler's 300s cooldown re-dispatches and finishes it). The single unverified GUI sweep it
// replaces once looted 212 items, left 2 stragglers, and marked the grave done forever.
//   in : { sawWindow, emptied, remaining:[{name,count}], exhausted, freeSlots,
//          gained, recorded, gotNotable, gravePresent, looseNearby }
//   out: { mark, kind:'full'|'partial'|'capacity'|'writeoff-junk'|'loose-only'|'gone'|'unopened' }
function graveLootVerdict ({ sawWindow, emptied, remaining, exhausted, freeSlots, gained, recorded, gotNotable, gravePresent, looseNearby } = {}) {
  const rem = Array.isArray(remaining) ? remaining : []
  // notableTier = the verbatim recordDeath notable regex (gear/ingots/gems are NEVER written off).
  const notableTier = n => /_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$|_ingot$|^diamond|^emerald/.test(n || '')
  // rung 1: no recorded notable back in the pack -> never mark from here; the case site keeps
  // today's tails (and its own gone-mark) for the no-notable / gained-0 path.
  if (!gotNotable) return { mark: false, kind: 'partial' }
  if (sawWindow) {
    // rung 2: window emptied + a FRESH scan says the grave is gone -> genuinely full.
    if (gained > 0 && emptied && !gravePresent) return { mark: true, kind: 'full' }
    if (!emptied) {
      // rung 3: pack is full -> honest capacity stop (never a write-off), come back after off-loading.
      if (freeSlots <= 0) return { mark: false, kind: 'capacity' }
      // rung 4: reachable gear/ingots/gems left behind -> NEVER done, whatever the gained ratio.
      if (rem.some(r => notableTier(r.name))) return { mark: false, kind: 'partial' }
      const remCount = rem.reduce((s, r) => s + (r.count || 0), 0)
      // rung 5: retries exhausted, pack has room, only a handful of junk-tier slots the server
      // refuses -> bounded honest write-off (the <10 bulk line mirrors graveWorthIt).
      if (exhausted && freeSlots > 0 && remCount < 10) return { mark: true, kind: 'writeoff-junk' }
      // rung 6: still-loaded window, not a bounded junk write-off -> honest partial.
      return { mark: false, kind: 'partial' }
    }
    // emptied window but the grave is still present (AxGraves race) or nothing gained -> conservative partial.
    return { mark: false, kind: 'partial' }
  }
  // rung 7: no GUI (attack-path grave) - presence re-verified by the fresh scan, no ratio heuristic.
  if (gained > 0 && !gravePresent && !looseNearby) return { mark: true, kind: 'full' }
  if (gained > 0 && gravePresent) return { mark: false, kind: 'loose-only' }
  if (gained === 0 && !gravePresent && !looseNearby) return { mark: true, kind: 'gone' }
  return { mark: false, kind: 'unopened' }
}

// #85 DEATH_SPOT_COST - PURE: the per-block step cost near recent death spots. The cave openings
// around the farm (432-442, z21-32, y58-62) killed 5 bots in ~3h (and swallowed the first-ever
// iron boots): routes must BEND AROUND the columns that keep eating the bot. Cost-only (never a
// wall) like the crop/water exclusions; the y-window reaches UP past the death cell so the
// surface cells directly over a cave death (where the bot actually falls in) are priced too.
function deathSpotCost (p, spots, opts = {}) {
  if (!p || !spots || !spots.length) return 0
  const COST = opts.cost != null ? opts.cost : 40
  for (const s of spots) if (hazardBoxHas(p, s, opts)) return COST
  return 0
}

// PURE box test, extracted from deathSpotCost so hazard MEMORY (world-memory.js) and hazard
// ROUTING (deathSpotCost) agree on what "at this hazard" means by construction rather than by
// two copies of the same arithmetic. The y-window reaches UP past the death cell so the surface
// directly over a cave death - where the bot actually falls in - is inside the box.
function hazardBoxHas (p, s, opts = {}) {
  if (!p || !s || s.x == null) return false
  const R = opts.radius != null ? opts.radius : 4
  const UP = opts.up != null ? opts.up : 8
  const DOWN = opts.down != null ? opts.down : 2
  return Math.abs(p.x - s.x) <= R && Math.abs(p.z - s.z) <= R && (p.y - s.y) <= UP && (s.y - p.y) <= DOWN
}

// ---- #112 HAZARD_NOT_LURE: the cause taxonomy + the salvage decision ------------------
// The bot used to be able to represent exactly TWO ways the world kills it (lava and fire, via
// the hand-set `dangerous` flag on grave entries). A drowning trap was literally unrepresentable
// - which is why the "free gear" lure won twice in eight minutes over a pocket that had just
// drowned the bot. Every cause is nameable here, and `dangerous` is now DERIVED from the cause
// instead of hand-set in two branches of recoverGrave.

// The causes whose gear is GONE, not merely guarded: walking back buys nothing. These are the
// causes the old `dangerous` flag stood for, so deriving it from them is byte-equivalent.
const WRITEOFF_CAUSES = /^(lava|fire|void)$/
function causeWritesOff (cause) { return WRITEOFF_CAUSES.test(cause || '') }
// Causes with a MEDIUM the bot can read off a block name. A hard step-exclusion is only ever
// armed on these, and only on cells currently reading as the medium - so the exclusion RELEASES
// itself the moment the pocket drains, and can never become an unreleasable wall across terrain.
const HAZARD_MEDIUM = { drowning: /water$/, lava: /lava$|fire$|magma/, fire: /lava$|fire$|magma/ }
// N deaths at a cell with no survived traversal since => escalate from cost to forbid. A COUNT,
// deliberately not a duration: nothing in this file may de-escalate on elapsed time.
const HAZARD_HARD_DEATHS = 2
// Pathfinder drops any neighbour whose step cost exceeds 100 (movements.js "cost > 100 return"),
// so this is a genuine FORBID on the planner - not a big number that job selection can outbid,
// and not a dig instruction: an excluded cell is one A* will not step into, nothing more.
const HAZARD_FORBID = 1e6

// PURE: classify what killed the bot, from what the death handler can see at the death cell.
// Ordered by certainty of the reading. `headWater` is the grounded block read (the memory rule
// says oxygenLevel is unreliable on the live server, so it is only ever a corroborating signal).
function classifyDeathCause ({ y, hazardNear, headWater, feetWater, oxygen, fallDistance } = {}) {
  if (y != null && y < -60) return 'void'
  if (hazardNear) return 'lava'
  if (headWater || (feetWater && oxygen != null && oxygen <= 0)) return 'drowning'
  if (fallDistance != null && fallDistance >= 5) return 'fall'
  return 'unknown'
}

// PURE: the per-step verdict for one candidate cell, replacing the cost-only closure. `name` is
// the candidate block's name (pathfinder hands the block in). `hazards` is plain data:
// [{ x, y, z, cause, hard }]. Returns 0, the soft cost, or HAZARD_FORBID.
//   - soft rung: a cell inside a remembered hazard's box that STILL READS AS THE MEDIUM that did
//     the killing (water for a drowning, lava/fire for a burn) costs COST - A* bends around it.
//   - hard rung: the same cell, once the hazard is armed (2 deaths, no survived traversal), is
//     FORBIDDEN.
// A cell that does not read as the medium costs NOTHING, whatever happened near it. The #85
// version priced EVERY cell in the box (cost 40, radius 4, +8/-2) - a mob death at spawn made
// every block of spawn cost 41 to walk on, and once a bare-hand stone dig was honestly priced at
// ~34 (nav-profile.js WILD_DIG_COST) the planner tunnelled through the crater wall rather than walk
// across its own death box; the operator watched it punch stone with a clear exit beside it
// (2026-08-26). A mob is not terrain: the ground did not kill the bot and the ground cannot be
// priced for it. A hazard with no readable medium (fall/mob/unknown/void) therefore prices
// nothing here (the fall ledger and the mob hazard escalation live elsewhere) and never forbids:
// a wall nothing can walk through is a wall nothing can prove safe again (§5).
function hazardStepCost (p, name, hazards, opts = {}) {
  if (!p || !hazards || !hazards.length) return 0
  const COST = opts.cost != null ? opts.cost : 40
  let out = 0
  for (const h of hazards) {
    if (!hazardBoxHas(p, h, opts)) continue
    const medium = HAZARD_MEDIUM[h.cause]
    if (!(medium && name && medium.test(name))) continue // the cell is not the killer: free
    if (h.hard) return HAZARD_FORBID
    out = COST
  }
  return out
}

// PURE: is this cell's escalation armed? Condition-gated - N deaths AND no survived traversal
// since the last of them. `markTraversed` (world-memory) is the only thing that sets the release,
// and it is set by evidence, never by a clock.
function hazardHardArmed (h) { return !!h && Array.isArray(h.deaths) && h.deaths.length >= HAZARD_HARD_DEATHS && !h.traversedSinceDeath }

// PURE: MAY the bot go salvage this grave, and what is the loot worth NET OF THE RISK of the
// place it is lying in? This is the whole point of Root E: `graveSweep` used to price a grave at
// gross gear value ("free gear") with the only counterweight a soft cost on the ROUTE. A grave
// is a candidate only if the bot can survive the MEDIUM that killed it there.
//   grave  - the ledger entry (or snapshot row)
//   hazard - worldMemory.hazardAt(grave) or null
//   caps   - what the bot can do about the medium RIGHT NOW. `dryStandpoint` is the seam for a
//            grounded approach-time probe (a reachable air-adjacent cell within reach of the
//            grave); until the vertical-water-escape rung exists (capability gap H, a later
//            slice) nothing sets it, so a drowning pocket stays deferred - and that is correct.
// go:false does NOT write the grave off - the ledger keeps the record and the value, and the
// verdict flips the moment the condition does. There is deliberately no "grab it anyway if
// urgent" bypass: that is the lure, and it is what re-drowned the bot.
function salvageVerdict (grave, hazard, caps = {}) {
  const deaths = (hazard && Array.isArray(hazard.deaths)) ? hazard.deaths.length : 0
  const discount = 1 / (1 + deaths) // value is NETTED, never gross
  // AN UNDERGROUND GRAVE IS NOT A NAKED BOT'S JOB (2026-08-27). The medium clauses below know
  // water and lava; they did not know the DARK. Live: the 41-log grave at 284,57,-291 sat in a
  // cave, the resume's grave detour walked a bot with no armour and hp 9.6 into it at dawn, a
  // skeleton took it to 1.6 and the next death was 30b away. Recorded at death time
  // (`underground` = a solid ceiling over the death cell), judged against what the bot wears
  // NOW (caps.armored) - so the verdict flips as soon as it wears armour, and a surface grave is
  // untouched by this clause. Deferred, never written off.
  // DEEP underground, not merely under a roof (2026-08-28 17:12): a grave 11 blocks below the camp,
  // in a pocket the bot walks into by daylight, held 40 logs and every tool and was deferred "while i
  // have no armour" - which this bot has never had. The record now carries the depth measured at
  // death (index.js); a shallow pocket (<= 12) is fetched, a deep cave (or an unknown depth) waits.
  if (grave && grave.underground && caps.armored === false && !(typeof grave.depth === 'number' && grave.depth <= 12)) return { go: false, why: `my grave at ${grave.x},${grave.y},${grave.z} is ${typeof grave.depth === 'number' ? grave.depth + ' deep' : 'underground (depth unknown)'} and i have no armour - deferred while i have no armour`, discount }
  if (!hazard) return { go: true, why: 'no hazard recorded here', discount: 1 }
  const cause = hazard.cause || 'unknown'
  // survived: the bot has stood in this cell alive and out of the medium since the last death
  // here, or the caller established a dry standpoint by a grounded read at approach time.
  const survived = !!hazard.traversedSinceDeath || caps.dryStandpoint === true
  if (causeWritesOff(cause)) return { go: false, why: `i died in ${cause} at ${hazard.x},${hazard.y},${hazard.z} - the stuff is gone`, discount }
  // A DAYLIGHT WALK AT FULL HEALTH TO AN OPEN-SKY GRAVE IS NOT A LURE (2026-08-28 18:00). The sinkhole
  // under the farm took three lives - two zombie nights and one four-block fall at hp 2 - and the
  // hard-arm then wrote off a 193-item grave (the whole hut BOM) lying open-sky, ten blocks from the
  // hut cell. The medium there is air; what killed was the hour and the hp. Fall/mob hazards stay
  // armed at night, hurt, or underground; by day at hp >= 16 in the open the walk is the walk any
  // player makes. Drowning/lava/fire keep the full rule - their medium IS the danger.
  const walkable = /^(fall|mob)$/.test(cause) && !!grave && !grave.underground && caps.night === false && typeof caps.hp === 'number' && caps.hp >= 16
  if (hazardHardArmed(hazard) && !survived && !walkable) return { go: false, why: `${deaths} deaths at ${hazard.x},${hazard.y},${hazard.z} and i have not got through there alive since`, discount }
  if (HAZARD_MEDIUM[cause] && !survived) return { go: false, why: `${cause} killed me at ${hazard.x},${hazard.y},${hazard.z} and i still cannot get out of that`, discount }
  return { go: true, why: `${deaths} death(s) here - worth ${Math.round(discount * 100)}% of face value`, discount }
}

// PURE: a grave's desire score, net of the risk of its location and of the trek. Replaces the
// pure nearest-first pick in both schedulers, so a rich grave in a cell that keeps killing the
// bot loses to a modest one in a safe cell instead of always winning on gross gear value.
function graveNetValue (g) { return (g && g.value > 0 ? g.value : 0) * ((g && g.salvage && g.salvage.discount != null) ? g.salvage.discount : 1) }
function graveScore (g) { return graveNetValue(g) / (1 + (g && g.dist != null ? g.dist : 0)) }
// PURE: has this snapshot row been ruled out by salvageVerdict? (Rows written before the gate
// existed carry no `salvage` and are treated as go - absence of a verdict is not a veto.)
function graveSalvageBlocked (g) { return !!(g && g.salvage && g.salvage.go === false) }

module.exports = {
  graveValue, graveWorthIt, graveUrgency, graveCompare, shouldChaseGrave, graveLootVerdict, deathSpotCost,
  hazardBoxHas, classifyDeathCause, causeWritesOff, hazardStepCost, hazardHardArmed, salvageVerdict,
  graveNetValue, graveScore, graveSalvageBlocked,
  HAZARD_MEDIUM, HAZARD_FORBID
}
