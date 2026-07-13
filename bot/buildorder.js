'use strict'
// PLACEMENT ORDER (pure): order the placeable actions of a survival build so it goes
// BOTTOM-UP (a stable base; never place a high block before its support / reach up past
// nothing) and, within a layer, NEAREST-to-bot (local, minimal walking) - then guard against
// placing the cell the bot is standing in (walling/suffocating itself). PURE (positions +
// bot position in, order/boolean out - no bot, no Build lib) so it is offline-testable
// (bot/buildordertest.js). The mineflayer-builder Build already gates placeability (support
// exists); this decides the ORDER among the currently-placeable set.

function dist2 (pos, botPos) {
  const dx = pos.x + 0.5 - botPos.x
  const dy = pos.y + 0.5 - botPos.y
  const dz = pos.z + 0.5 - botPos.z
  return dx * dx + dy * dy + dz * dz
}

// Order actions (each with a `.pos` {x,y,z}) BOTTOM-UP then NEAREST. Stable, non-mutating.
function orderPlacements (actions, botPos) {
  return actions.slice().sort((a, b) => {
    if (a.pos.y !== b.pos.y) return a.pos.y - b.pos.y   // lower layer first (bottom-up)
    return dist2(a.pos, botPos) - dist2(b.pos, botPos)  // then nearest within the layer
  })
}

// Would placing a block at `pos` put it in the bot's OWN feet or head cell (trapping /
// suffocating it, or requiring it to place on itself)? Such an action is deferred until the
// bot has stepped off that column.
function isSelfCell (pos, botFeet) {
  return pos.x === botFeet.x && pos.z === botFeet.z && (pos.y === botFeet.y || pos.y === botFeet.y + 1)
}

module.exports = { orderPlacements, isSelfCell, dist2 }
