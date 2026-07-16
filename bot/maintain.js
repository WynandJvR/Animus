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
  packFood: { target: Number(process.env.MAINT_PACKFOOD_TARGET || 24), floor: Number(process.env.MAINT_PACKFOOD_FLOOR || 12) }, // pts
  bankFood: { target: Number(process.env.MAINT_BANKFOOD_TARGET || 40), floor: Number(process.env.MAINT_BANKFOOD_FLOOR || 16) }, // pts
  armor: { target: 4, floor: 4 }, // any missing (armorPieces < 4) is under floor
  tools: { members: ['pick', 'axe', 'sword', 'sparePick'] }, // any missing -> need
  torches: { target: Number(process.env.MAINT_TORCH_TARGET || 8), floor: Number(process.env.MAINT_TORCH_FLOOR || 4) }
}

// needs(snapshot) -> ordered array of { key, deficit, target }. Emit in the FIXED order food ->
// gear -> torches, each only when strictly under its floor. Returns [] when nothing is low.
function needs (snapshot) {
  const s = snapshot || {}
  const out = []

  // read floors/targets LIVE so env overrides apply without a restart (mirrors gravegate).
  const packFloor = Number(process.env.MAINT_PACKFOOD_FLOOR || 12)
  const packTarget = Number(process.env.MAINT_PACKFOOD_TARGET || 24)
  const bankFloor = Number(process.env.MAINT_BANKFOOD_FLOOR || 16)
  const bankTarget = Number(process.env.MAINT_BANKFOOD_TARGET || 40)
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

  return out
}

module.exports = {
  needs,
  BUFFERS,
  _reset: () => {} // no state; present for test-harness parity
}
