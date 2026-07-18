'use strict'
// LEGACY OPERATOR BUILD PRIMITIVES + small position/player helpers.
// Split out of commands.js unchanged.
//
// IMPORTANT - this is NOT how the bot builds. The real build path is PHYSICAL
// SURVIVAL placement: schematic.buildSurvival places real blocks from the bot's own
// inventory, one at a time, and provision.js acquires the materials first. Nothing in
// the autonomous path goes through here.
//
// What lives here is the small set of instant op-command builders exposed to an
// OPERATOR through the `wall` / `tower` / `house` / `fill` / `setblock` / `clear`
// commands. They emit `/fill` and `/setblock` over chat, so they need the bot to be op
// and they bypass reach, inventory and physics entirely. They exist because they are
// convenient for setting up a test scene by hand - not because the bot uses them.
//
// (commands.js's own header used to claim `/fill` + `/setblock` WAS the build path,
// which was true a long time ago and has been wrong for a while; the README carried
// the same stale claim. Keeping these in a file that says LEGACY on the tin makes the
// distinction hard to misread.)
//
// All functions are self-contained: they take `bot` (plus plain numbers/strings) and
// hold no module state.

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

module.exports = { blockPos, anchorInFront, fill, setblock, normName, findPlayer, buildWall, buildTower, buildHouse }
