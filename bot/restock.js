'use strict'
// MULTI-MATERIAL RESTOCK (pure): while the builder is AT the bank fetching one material, which
// OTHER build materials should it top up in the same visit? The castle BOM has many block
// types; fetching one-at-a-time per block means a bank round-trip every time the placement
// order switches material (stone -> stairs -> stone ...). Topping up several low materials in
// ONE visit minimizes those trips. PURE (the remaining BOM + pack + bank counts in, a withdraw
// list out - no bot) so it is offline-testable (bot/restocktest.js).
//
// Picks materials that are (a) still needed by the BOM, (b) actually banked, and (c) running
// LOW in the pack - most-needed first, each capped, up to maxItems types (a bounded visit).
function restockPlan (bom, packCounts, bankCounts, opts = {}) {
  const perItem = opts.perItem != null ? opts.perItem : 64  // top up to at most this many of each
  const lowAt = opts.lowAt != null ? opts.lowAt : 16        // only top up a material the pack has fewer than this of
  const maxItems = opts.maxItems != null ? opts.maxItems : 8
  const pack = packCounts || {}
  const bank = bankCounts || {}
  const out = []
  const names = Object.keys(bom || {}).sort((a, b) => (bom[b] || 0) - (bom[a] || 0)) // most-needed first
  for (const n of names) {
    if (out.length >= maxItems) break
    const need = bom[n] || 0
    if (need <= 0) continue
    const have = pack[n] || 0
    const banked = bank[n] || 0
    if (have >= lowAt || banked <= 0) continue // already stocked, or the bank hasn't got it
    const target = Math.min(perItem, need)     // never pull more than the build still needs
    const want = Math.min(target - have, banked)
    if (want > 0) out.push({ item: n, count: want })
  }
  return out
}

module.exports = { restockPlan }
