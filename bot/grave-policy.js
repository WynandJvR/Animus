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
function graveCompare (a, b, now) {
  if (process.env.GRAVE_URGENT !== '0') {
    const ru = graveUrgencyRank(graveUrgency(b, now).tier) - graveUrgencyRank(graveUrgency(a, now).tier)
    if (ru) return ru
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
  const R = opts.radius != null ? opts.radius : 4
  const UP = opts.up != null ? opts.up : 8
  const DOWN = opts.down != null ? opts.down : 2
  const COST = opts.cost != null ? opts.cost : 40
  for (const s of spots) {
    if (s && s.x != null && Math.abs(p.x - s.x) <= R && Math.abs(p.z - s.z) <= R &&
        (p.y - s.y) <= UP && (s.y - p.y) <= DOWN) return COST
  }
  return 0
}

module.exports = { graveValue, graveWorthIt, graveUrgency, graveUrgencyRank, graveCompare, shouldChaseGrave, graveLootVerdict, deathSpotCost }
