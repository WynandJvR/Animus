'use strict'
// PROACTIVE-BUFFER MODEL (slice S3): the pure "what's under floor" function behind a
// maintenancePass job. `needs(snapshot)` returns the ordered list of unmet buffers - FOOD
// before GEAR before TORCHES - so a maintain-class job (which can NEVER preempt progress,
// scheduler.js §3.2) only fires when a real buffer is genuinely low.
//
// PURE: require-only, no bot, no fs, no clock. It consumes PRE-SUMMED food points
// (snapshot.packFoodPts / snapshot.bankFoodPts, computed by the S4 snapshot builder via
// food.foodTier) - it does NOT walk inventory. Dormant until S4 calls it.
//
// HYSTERESIS without state (§3.3): a buffer is "needed" only below its FLOOR, and the S4 pass
// tops it up to its (higher) TARGET, so the next tick sees it satisfied. The floor/target gap
// IS the hysteresis band - a buffer sitting between floor and target is NOT re-triggered
// (anti-churn). Thresholds are read from env LIVE (per call) so an operator override takes
// effect without a restart.

// Default buffer bands (documentation / introspection). `needs` reads the same env keys LIVE
// so overrides apply per call; these defaults mirror what the env resolves to at load.
const BUFFERS = {
  packFood: { target: Number(process.env.MAINT_PACKFOOD_TARGET || (process.env.FOOD_SURVIVAL !== '0' ? 40 : 24)), floor: Number(process.env.MAINT_PACKFOOD_FLOOR || (process.env.FOOD_SURVIVAL !== '0' ? 24 : 12)) }, // pts (#40 F1: FOOD_SURVIVAL raises the excursion reserve 24/12 -> 40/24)
  bankFood: { target: Number(process.env.MAINT_BANKFOOD_TARGET || (process.env.BREAD_ENGINE !== '0' ? Number(process.env.BREAD_BANK_TARGET || 80) : 40)), floor: Number(process.env.MAINT_BANKFOOD_FLOOR || (process.env.BREAD_ENGINE !== '0' ? 40 : 16)) }, // pts (BREAD_ENGINE reserve 40/80)
  armor: { target: 4, floor: 4 }, // any missing (armorPieces < 4) is under floor
  tools: { members: ['pick', 'axe', 'sword', 'sparePick'] }, // any missing -> need
  torches: { target: Number(process.env.MAINT_TORCH_TARGET || 8), floor: Number(process.env.MAINT_TORCH_FLOOR || 4) },
  spareKit: { armor: 4, pick: 1, sword: 1 } // #41 RESILIENT_RECOVERY: ONE banked spare set (a post-death re-arm floor; mirrors bankFood)
}

// needs(snapshot) -> ordered array of { key, deficit, target }. Emit in the FIXED order food ->
// gear -> torches, each only when strictly under its floor. Returns [] when nothing is low.
function needs (snapshot) {
  const s = snapshot || {}
  const out = []

  // read floors/targets LIVE so env overrides apply without a restart (mirrors gravegate).
  // #40 F1: FOOD_SURVIVAL (default on) raises the pack-food band to a real excursion reserve
  // (floor 24 / target 40 = 3..5 meals) so the maintain need fires while the bot still holds
  // several meals; FOOD_SURVIVAL=0 restores the legacy 12/24. Explicit env always wins.
  const packFloor = Number(process.env.MAINT_PACKFOOD_FLOOR || (process.env.FOOD_SURVIVAL !== '0' ? 24 : 12))
  const packTarget = Number(process.env.MAINT_PACKFOOD_TARGET || (process.env.FOOD_SURVIVAL !== '0' ? 40 : 24))
  // BREAD_ENGINE (default on): raise the banked-food band to a real reserve (floor 40 / target
  // 80 = 8/16 loaves) so the courier/R2 have a post-death meal to withdraw; BREAD_ENGINE=0
  // restores the legacy 16/40. Explicit MAINT_BANKFOOD_FLOOR/TARGET always win.
  const engine = process.env.BREAD_ENGINE !== '0'
  const bankFloor = Number(process.env.MAINT_BANKFOOD_FLOOR || (engine ? 40 : 16))
  const bankTarget = Number(process.env.MAINT_BANKFOOD_TARGET || (engine ? Number(process.env.BREAD_BANK_TARGET || 80) : 40))
  const torchFloor = Number(process.env.MAINT_TORCH_FLOOR || 4)
  const torchTarget = Number(process.env.MAINT_TORCH_TARGET || 8)

  // 1. packFood - carried edible points.
  const packPts = s.packFoodPts || 0
  if (packPts < packFloor) out.push({ key: 'packFood', deficit: packTarget - packPts, target: packTarget })

  // 2. bankFood - home chest food points; only actionable when the bank is reachable (can't
  //    courier to an unreachable home).
  const bankPts = s.bankFoodPts || 0
  if (s.homeReachable && bankPts < bankFloor) out.push({ key: 'bankFood', deficit: bankTarget - bankPts, target: bankTarget })

  // 3. armor - any of the 4 pieces missing. Absent armorPieces => treat as fully armored (no
  //    spurious need); only an explicit count < 4 triggers.
  const armorPieces = s.armorPieces != null ? s.armorPieces : 4
  if (armorPieces < 4) out.push({ key: 'armor', deficit: 4 - armorPieces, target: 4 })

  // 4. tools - pick/axe/sword/sparePick; any false. Absent `tools` => not measured (no need).
  if (s.tools) {
    const missing = BUFFERS.tools.members.filter(m => !s.tools[m])
    if (missing.length) out.push({ key: 'tools', deficit: missing.length, target: 4 })
  }

  // 5. torches.
  const torches = s.torches != null ? s.torches : 0
  if (torches < torchFloor) out.push({ key: 'torches', deficit: torchTarget - torches, target: torchTarget })

  // 6. spareKit (#41 RESILIENT_RECOVERY): a banked spare set is the post-death re-arm floor. Emit a
  //    deficit ONLY when the bank LACKS the full spare (measured via the new bankArmorPieces/
  //    bankHasPick/bankHasSword snapshot fields) AND the bot has a surplus/dupe to donate (unworn
  //    armor in the pack, or a spare pick/sword) - never a demand to CRAFT a spare, only to bank one
  //    it already has. Gated on the bank fields being MEASURED (absent -> not measured -> no need),
  //    so today's snapshots (no bank-spare fields) never trigger it. SPAREKIT=0 / flag off -> off.
  const spareKitOn = process.env.RESILIENT_RECOVERY !== '0' && process.env.SPAREKIT !== '0'
  if (spareKitOn && s.bankArmorPieces != null) {
    // a DONATABLE dupe = UNWORN pack armor (worn armor is kept), or a SECOND sword (the bot keeps 1).
    // Deliberately NOT tools.sparePick: a 2nd pick is the bot's intended keep-2 loadout (safekeepPlan),
    // not surplus - only a 3rd+ pick is, which the courier plan banks opportunistically once triggered.
    const bankSpareComplete = (s.bankArmorPieces || 0) >= 4 && !!s.bankHasPick && !!s.bankHasSword
    const packSurplus = (s.packArmorPieces || 0) > 0 || !!s.spareSwordInPack
    if (!bankSpareComplete && packSurplus) out.push({ key: 'spareKit', deficit: 1, target: 1 })
  }

  return out
}

// ---- S6 PURE HELPERS (courier / safekeep / cadence) ------------------------------------
// All three are require-only, no bot/fs/clock (an injected `now` where cadence is involved).

// courierPlan(packItems, bankFoodPts, opts) -> [{ name, count }] to DEPOSIT into the bank.
//   packItems = [{ name, count, foodPoints, tier }] (caller pre-computes points/tier).
// Rules (§4.1): keep >= MAINT_PACKFOOD_TARGET (40 under FOOD_SURVIVAL, else 24) pts in the pack, preferring tier-0
//   (ready-to-eat) then highest points-per-item to STAY; ship the surplus until the bank
//   would reach MAINT_BANKFOOD_TARGET (40) or the surplus is exhausted; tier>=2 (rotten/
//   poison) is never a pack-keep and never ships; empty pack / full bank -> [].
function courierPlan (packItems, bankFoodPts, opts) {
  opts = opts || {}
  const packTarget = opts.packTarget != null ? opts.packTarget : Number(process.env.MAINT_PACKFOOD_TARGET || (process.env.FOOD_SURVIVAL !== '0' ? 40 : 24)) // #40 F1: keep >=40 pts on the bot (FOOD_SURVIVAL); FOOD_SURVIVAL=0 -> legacy 24
  const bankTarget = opts.bankTarget != null ? opts.bankTarget : Number(process.env.MAINT_BANKFOOD_TARGET || (process.env.BREAD_ENGINE !== '0' ? Number(process.env.BREAD_BANK_TARGET || 80) : 40))
  let bankPts = Number(bankFoodPts) || 0
  if (bankPts >= bankTarget) return [] // pantry already stocked
  // shippable = real food, tier<2. Everything else (rotten/poison/non-food) is ignored:
  // never counted toward the pack keep, never deposited.
  const shippable = (packItems || [])
    .filter(i => i && i.count > 0 && (i.foodPoints || 0) > 0 && (i.tier != null ? i.tier : 0) < 2)
    .map(i => ({ name: i.name, count: i.count, foodPoints: i.foodPoints, tier: i.tier != null ? i.tier : 0 }))
  if (!shippable.length) return []
  // KEEP the best food on the bot first: tier asc (ready-to-eat first), then points-per-item
  // desc, then name (determinism). Walk this order accumulating pts until the pack keep is met;
  // whatever is not needed to reach the keep is surplus.
  const keepOrder = shippable.slice().sort((a, b) => a.tier - b.tier || b.foodPoints - a.foodPoints || (a.name < b.name ? -1 : 1))
  let keptPts = 0
  const surplus = []
  for (const it of keepOrder) {
    let keepCount = 0
    if (keptPts < packTarget) {
      const stillNeed = packTarget - keptPts
      keepCount = Math.min(it.count, Math.ceil(stillNeed / it.foodPoints))
      keptPts += keepCount * it.foodPoints
    }
    const surplusCount = it.count - keepCount
    if (surplusCount > 0) surplus.push({ name: it.name, count: surplusCount, foodPoints: it.foodPoints, tier: it.tier })
  }
  // Deposit surplus WORST-first (keep the best food on the bot): tier desc, points-per-item asc.
  surplus.sort((a, b) => b.tier - a.tier || a.foodPoints - b.foodPoints || (a.name < b.name ? -1 : 1))
  const deposits = []
  for (const it of surplus) {
    if (bankPts >= bankTarget) break
    let n = 0
    while (n < it.count && bankPts < bankTarget) { bankPts += it.foodPoints; n++ }
    if (n > 0) deposits.push({ name: it.name, count: n })
  }
  return deposits
}

// ---- tool tiers (shared by safekeepPlan + toolIsJunk) --------------------------------
const TIER = { wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 }
const toolTier = name => { const m = /^(wooden|golden|stone|iron|diamond|netherite)_/.exec(name); return m ? (TIER[m[1]] || 0) : 0 }

// toolIsJunk(unit, ctx) -> bool. PURE. Classifies ONE tool unit as junk-to-toss.
//   unit = { name, usesLeft }              (usesLeft from mining.toolUsesLeft; undefined = assume working)
//   ctx  = { workingSameKind,              // count of OTHER working units of this kind in the pack
//            bestSameKindTier,             // best material tier of a WORKING same-kind tool in the pack
//            junkMinUses }                 // default 10; "working" = usesLeft >= junkMinUses
// JUNK iff:
//   worn:     usesLeft < junkMinUses AND workingSameKind >= 1   (never the last working one)
//   obsolete: tier(name) === wooden  AND bestSameKindTier >= stone (a better tool is held & working)
function toolIsJunk (unit, ctx) {
  unit = unit || {}; ctx = ctx || {}
  const junkMinUses = ctx.junkMinUses != null ? ctx.junkMinUses : 10
  const uses = unit.usesLeft == null ? Infinity : unit.usesLeft
  const workingSameKind = ctx.workingSameKind || 0
  if (uses < junkMinUses && workingSameKind >= 1) return true
  if (toolTier(unit.name) === TIER.wooden && (ctx.bestSameKindTier || 0) >= TIER.stone) return true
  return false
}

// spareKitCourierPlan(packItems, bankKit, opts) -> [{ name, count }] to DEPOSIT into the bank so a
// post-death respawn can withdraw + re-arm a SPARE set (rearmFromBank rung). Mirror of courierPlan /
// safekeepPlan: deposits ONLY surplus/dupe gear and NEVER the bot's only working kit. PURE.
//   packItems = [{ name, count, usesLeft? }]  - inventory.items() (worn armor is NOT here, so any
//               armor piece present is already a spare/dupe; usesLeft only meaningful for tools).
//   bankKit   = { armorPieces, hasPick, hasSword }  - what the bank already holds toward the spare.
// Rules: ship UNWORN armor to fill the bank's armor deficit (up to 4); donate exactly ONE spare
//   pick/sword only when the bank lacks it AND the pack holds >=2 of that kind (keep the best working
//   one on the bot). Target = ONE set (bounded); already-complete bank / no dupe -> [].
function spareKitCourierPlan (packItems, bankKit, opts) {
  opts = opts || {}
  const bank = bankKit || {}
  const items = (packItems || []).filter(i => i && i.count > 0)
  const deposits = []
  const add = (name, count) => { if (count > 0) deposits.push({ name, count }) }

  // ARMOR: fill the bank's shortfall toward 4 with UNWORN pack armor (all spares). Worst material
  // first so the best stays available to WEAR; capped at the deficit (never over-banks).
  const armorNeed = Math.max(0, 4 - (bank.armorPieces || 0))
  if (armorNeed > 0) {
    const armorUnits = []
    for (const it of items) { if (/_(helmet|chestplate|leggings|boots)$/.test(it.name)) for (let c = 0; c < it.count; c++) armorUnits.push(it.name) }
    armorUnits.sort((a, b) => toolTier(a) - toolTier(b) || (a < b ? -1 : 1)) // worst-first (toolTier maps the material prefix; 0 for leather/none)
    const byName = {}
    for (const nm of armorUnits.slice(0, armorNeed)) byName[nm] = (byName[nm] || 0) + 1
    for (const [nm, c] of Object.entries(byName)) add(nm, c)
  }

  // TOOLS: donate ONE spare pick / sword only if the bank lacks it and the pack holds MORE than the
  // bot's intended keep count (picks keep 2 - safekeepPlan's loadout; sword keeps 1). Donate the
  // best of the surplus so the banked spare is itself usable; the kept units are the best. This never
  // strips the working loadout (a keep-2/keep-1 bot ships nothing).
  const donateTool = (re, keep, bankHas) => {
    if (bankHas) return
    const units = []
    for (const it of items) { if (re.test(it.name)) for (let c = 0; c < it.count; c++) units.push({ name: it.name, usesLeft: it.usesLeft }) }
    if (units.length <= keep) return // only the intended loadout - never strip the kit
    const working = u => (u.usesLeft == null ? 1 : (u.usesLeft > 0 ? 1 : 0))
    units.sort((a, b) => working(b) - working(a) || ((b.usesLeft || 0) - (a.usesLeft || 0)) || (toolTier(b.name) - toolTier(a.name)))
    add(units[keep].name, 1) // keep units[0..keep-1] (best); bank units[keep] (best of the surplus)
  }
  donateTool(/_pickaxe$/, 2, !!bank.hasPick)
  donateTool(/_sword$/, 1, !!bank.hasSword)

  // merge duplicate deposit lines
  const merged = new Map()
  for (const d of deposits) merged.set(d.name, (merged.get(d.name) || 0) + d.count)
  return [...merged.entries()].map(([name, count]) => ({ name, count }))
}

// FOOD_FLOOR F2/F3: how many spare fishing_rod to ship to the bank so it holds the emergency
// reserve (default 1) that the food floor withdraws post-death, WITHOUT stripping the bot's own
// working rod (keep 1 on hand). PURE arithmetic (mirrors the courier/spareKit reserve model);
// the FOOD_FLOOR gate + the actual deposit live at the call site (courierFoodToBank).
function rodReserveTopUp (bankRods, packRods, opts = {}) {
  const target = opts.target != null ? opts.target : Number(process.env.MAINT_BANKROD_TARGET || 1)
  const keep = opts.keep != null ? opts.keep : 1
  const need = Math.max(0, target - (bankRods || 0))
  const shippable = Math.max(0, (packRods || 0) - keep)
  return Math.min(need, shippable)
}

// craftBudgetForSpace(needed, freeSlots, stackSize, reserve=1) -> count to craft NOW so the
// output fits (conservative: ignores slots freed by consumed ingredients / partial stacks - it
// under-crafts at worst and the caller's re-plan round tops up). PURE, never negative.
function craftBudgetForSpace (needed, freeSlots, stackSize, reserve = 1) {
  const usable = Math.max(0, (freeSlots || 0) - reserve)
  return Math.max(0, Math.min(needed || 0, usable * (stackSize || 1)))
}

// safekeepPlan(packItems, opts) -> [{ name, count }] to DEPOSIT. ALLOW-LIST by design: only
//   ships items it explicitly recognises as surplus (spare tools + build-material above an
//   allowance); everything else (food, armor, seeds, iron, unknowns) is kept. This is what
//   guarantees the working loadout is never stripped.
//   packItems = [{ name, count, usesLeft? }]  (usesLeft only meaningful for picks).
function safekeepPlan (packItems, opts) {
  opts = opts || {}
  const items = (packItems || []).filter(i => i && i.count > 0)
  const deposits = []
  const add = (name, count) => { if (count > 0) deposits.push({ name, count }) }

  // ---- TOOLS: never the last working one of a kind -------------------------------------
  // pickaxes: keep the best working + 1 spare working (2 working picks); axe/sword/shovel/hoe/
  // shears: keep the best 1. Surplus tools ship. (TIER/toolTier lifted to module scope.)
  const KIND = [
    { re: /_pickaxe$/, keep: 2, uses: true },
    { re: /_axe$/, keep: 1 },
    { re: /_sword$/, keep: 1 },
    { re: /_shovel$/, keep: 1 },
    { re: /_hoe$/, keep: 1 },
    { re: /^shears$/, keep: 1 }
  ]
  for (const k of KIND) {
    // expand to individual tool units (count is ~always 1 for tools, but be safe)
    const units = []
    for (const it of items) {
      if (!k.re.test(it.name)) continue
      for (let c = 0; c < it.count; c++) units.push({ name: it.name, usesLeft: it.usesLeft })
    }
    if (units.length <= k.keep) continue
    // rank best-first: for picks prefer WORKING (usesLeft>0, undefined=assume working) then more
    // uses; for all, higher material tier is better.
    const working = u => (u.usesLeft == null ? 1 : (u.usesLeft > 0 ? 1 : 0))
    units.sort((a, b) => working(b) - working(a) || ((b.usesLeft || 0) - (a.usesLeft || 0)) || (toolTier(b.name) - toolTier(a.name)))
    const surplusUnits = units.slice(k.keep)
    const byName = {}
    for (const u of surplusUnits) byName[u.name] = (byName[u.name] || 0) + 1
    for (const [name, cnt] of Object.entries(byName)) add(name, cnt)
  }

  // ---- BUILD-MATERIAL ALLOWANCES (the excursion loadout) -------------------------------
  const envKeep = (item, def) => { const v = process.env['MAINT_KEEP_' + item.toUpperCase()]; return v != null ? Number(v) : def }
  const count = name => items.filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
  const shipNamedExcess = (name, allow) => { const c = count(name); if (c > allow) add(name, c - allow) }
  shipNamedExcess('dirt', envKeep('dirt', 16))
  shipNamedExcess('cobblestone', envKeep('cobblestone', 16))
  shipNamedExcess('stick', envKeep('stick', 8))
  shipNamedExcess('torch', envKeep('torch', Number(process.env.MAINT_TORCH_TARGET || 8)))
  // planks / logs: per material name, allowance each.
  const plankAllow = envKeep('planks', 16); const logAllow = envKeep('logs', 8)
  const perNameGroups = {}
  for (const it of items) {
    if (/_planks$/.test(it.name)) perNameGroups[it.name] = { allow: plankAllow }
    else if (/_log$/.test(it.name)) perNameGroups[it.name] = { allow: logAllow }
  }
  for (const [name, g] of Object.entries(perNameGroups)) shipNamedExcess(name, g.allow)
  // coal + charcoal: a COMBINED fuel/torch buffer of 8; ship the excess, charcoal first.
  const fuelAllow = envKeep('coal', 8)
  const coal = count('coal'); const charcoal = count('charcoal')
  let fuelExcess = Math.max(0, (coal + charcoal) - fuelAllow)
  if (fuelExcess > 0) {
    const shipChar = Math.min(charcoal, fuelExcess); add('charcoal', shipChar); fuelExcess -= shipChar
    if (fuelExcess > 0) add('coal', Math.min(coal, fuelExcess))
  }
  // singleton utilities: keep 1 each, ship the rest.
  for (const name of ['crafting_table', 'furnace', 'chest', 'flint_and_steel', 'fishing_rod']) shipNamedExcess(name, 1)
  for (const it of items) { if (/_bucket$/.test(it.name) || it.name === 'bucket') { if (it.count > 1) add(it.name, it.count - 1) } }

  // merge duplicate deposit lines
  const merged = new Map()
  for (const d of deposits) merged.set(d.name, (merged.get(d.name) || 0) + d.count)
  return [...merged.entries()].map(([name, count]) => ({ name, count }))
}

// stepDue(state, key, intervalMs, now, jitterFrac=0.3) -> { due, nextAt }. Deterministic given
//   `now` + a seeded PRNG stored on `state` (so the chores read as chores, not a metronome).
//   When due, ARMS the next window at intervalMs*(1 +- jitterFrac); no re-fire inside it.
function _mulberry32 (state) {
  let a = (state.__rng == null ? (state.__rng = 0x9e3779b9 >>> 0) : state.__rng)
  a = (a + 0x6D2B79F5) >>> 0
  state.__rng = a
  let t = a
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
function stepDue (state, key, intervalMs, now, jitterFrac = 0.3) {
  state = state || {}
  const slot = state[key]
  if (slot && now < slot.nextAt) return { due: false, nextAt: slot.nextAt }
  const jitter = (_mulberry32(state) * 2 - 1) * jitterFrac // -jf..+jf
  const nextAt = now + Math.round(intervalMs * (1 + jitter))
  state[key] = { nextAt, jitter }
  return { due: true, nextAt }
}

module.exports = {
  needs,
  BUFFERS,
  courierPlan,
  safekeepPlan,
  spareKitCourierPlan,
  stepDue,
  TIER,
  toolTier,
  toolIsJunk,
  craftBudgetForSpace,
  rodReserveTopUp,
  _reset: () => {} // no state; present for test-harness parity
}
