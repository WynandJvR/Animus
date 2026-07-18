'use strict'
// LOCAL_WOOD (default ON): make oak a RENEWABLE LOCAL supply so the build stops the
// 94-130b wild-oak treks that keep getting the bot killed (ranges far unarmored -> dies)
// and stall the castle. PURE decision helpers only - no bot/world side effects - so the
// grow-ready / gather-preference logic is unit-testable without a live server.
//
// LOCAL_WOOD=0 -> every helper returns the caller's TODAY behavior, so the wired call
// sites are byte-for-byte with the pre-feature code.

function localWoodOn () { return process.env.LOCAL_WOOD !== '0' }

// Wild-oak roam cap. Flag OFF (or a non-log gather): return the caller's default cap
// unchanged. Flag ON for a log gather: fence the WILD search to a bounded radius so the
// bot never bases its roam at 160b (the treeless-pocket bump that produced the 94-130b
// treks). The adaptive widenFence still stretches this for GENUINELY inaccessible wood.
function woodRoamCap (defaultCap, isLogGather, on = localWoodOn()) {
  if (!on || !isLogGather) return defaultCap
  const cap = parseInt(process.env.LOCAL_WOOD_ROAM || '96', 10)
  return Math.min(defaultCap, cap)
}

// Should we DIVERT to our own home orchard before ranging to the wild?
//   timerReady     - wall-clock grow timer elapsed (a cheap "maybe grown, worth a look").
//   hasBoneMeal    - we carry bone_meal, so we can FORCE instant growth on arrival.
//   saplingsPlanted- verified saplings the orchard was planted with (>0 == a real plot).
// Flag OFF: today's trigger (timer only). Flag ON: also divert when we can force-grow it
// with bone_meal (never stranded waiting on the wall clock), but only for a REAL plot.
function orchardWorthVisiting ({ orch, timerReady, hasBoneMeal, saplingsPlanted, on = localWoodOn() }) {
  if (!orch) return false
  if (!on) return !!timerReady
  if (timerReady) return true
  return !!hasBoneMeal && (saplingsPlanted == null || saplingsPlanted > 0)
}

// After chopping wild timber, should we CARRY the sapling home for the orchard instead of
// replanting it at the far grove where we chopped? Flag OFF: never (today: always replant
// on the spot). Flag ON: keep it when we're beyond LOCAL_WOOD_HOME_R of home - scattering
// saplings 94b out never grows a supply we can actually reach; the home orchard does.
function replantHome (distHome, on = localWoodOn()) {
  if (!on) return false
  const near = parseInt(process.env.LOCAL_WOOD_HOME_R || '48', 10)
  return distHome > near
}

// Should we ESTABLISH / top-up the home orchard NOW (proactively, not only on total wild
// dryness)? need = logs still required; saplings = saplings on hand; haveLiveOrchard = a
// grove already growing near home. Flag OFF: never (the caller keeps today's narrow gate).
function shouldEstablishOrchard ({ need, saplings, haveLiveOrchard, on = localWoodOn() }) {
  if (!on) return false
  if (haveLiveOrchard) return false
  return need >= 24 && saplings >= 4
}

module.exports = { localWoodOn, woodRoamCap, orchardWorthVisiting, replantHome, shouldEstablishOrchard }
