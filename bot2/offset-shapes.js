'use strict'
// ==== A BAMBOO STALK STANDS OFF ITS CELL'S MIDDLE (2026-11-15) ===============================
//
// Vanilla moves an XZ-offset block's shape by an offset drawn from its position
// (BlockBehaviour.OffsetType.XZ: Mth.getSeed(x, 0, z), up to 0.25 each way), and bamboo is the one
// such block that COLLIDES - its stalk is a 3/16 post wherever the hash puts it in the cell.
// minecraft-data carries ONE shape for every stalk, the one read at the origin (offset -0.25,-0.25:
// [0.15625..0.34375] is vanilla's 6.5..9.5/16 less 0.25). So the body's physics walked into stalks the
// server has elsewhere and missed the ones it has here: in a bamboo jungle on the way to a meadow the
// server answered with 12-36 position syncs every 2s ("PINNED by the server"), the walk stuck three
// legs running at -2583,68,-649 and the day's one allium trip went home with nothing, 2026-11-15 11:06.
// Each bamboo the body reads (bot.blockAt - prismarine-physics' own world, the pathfinder's too)
// gets its stalk where the server has it. Patched at load on the bot's own blockAt, like
// collision-margin.js on the AABB prototype: survives npm install.
// (pointed_dripstone is offset too, by up to 0.125; its shapes vary with thickness - not done here)

const OFFSET_SOLID = { bamboo: { box: [6.5 / 16, 0, 6.5 / 16, 9.5 / 16, 1, 9.5 / 16], max: 0.25 } }

// Mth.getSeed: (long)(x * 3129871) ^ (long)z * 116129781L ^ (long)y, then l * l * 42317861L + l * 11L, >> 16.
// The first product is Java INT arithmetic (it overflows before the cast), the rest long.
function seed (x, y, z) {
  let l = BigInt(Math.imul(x, 3129871)) ^ (BigInt(z) * 116129781n) ^ BigInt(y)
  l = BigInt.asIntN(64, l)
  l = BigInt.asIntN(64, l * l * 42317861n + l * 11n)
  return l >> 16n
}
// OffsetType.XZ: ((float)(seed & 15) / 15f - 0.5) * 0.5 for x, the same of (seed >> 8 & 15) for z, clamped to the block's max
function offsetXZ (x, z, max = 0.25) {
  const s = seed(x, 0, z)
  const f = v => Math.max(-max, Math.min(max, (Math.fround(Math.fround(Number(v & 15n)) / Math.fround(15)) - 0.5) * 0.5))
  return { x: f(s), z: f(s >> 8n) }
}
function shapeAt (name, x, z) {
  const o = OFFSET_SOLID[name]; if (!o) return null
  const d = offsetXZ(x, z, o.max); const b = o.box
  return [[b[0] + d.x, b[1], b[2] + d.z, b[3] + d.x, b[4], b[5] + d.z]]
}

function install (bot) {
  const wrap = () => {
    if (typeof bot.blockAt !== 'function') return false
    if (bot.blockAt.__offsetShapes) return true
    const orig = bot.blockAt
    const fixed = function (pos, extraInfos) {
      const b = orig.call(this, pos, extraInfos)
      if (b && OFFSET_SOLID[b.name] && b.position && Array.isArray(b.shapes) && b.shapes.length) b.shapes = shapeAt(b.name, b.position.x, b.position.z)
      return b
    }
    fixed.__offsetShapes = true
    bot.blockAt = fixed
    return true
  }
  const now = wrap(); if (!now) bot.once('login', wrap)
  return { installed: true, now, kinds: Object.keys(OFFSET_SOLID) }
}

// (PROBE, evidence only: is bamboo's offset clamped at 0.25 or 0.125? the data's origin box says 0.25, a memory of
//  BambooStalkBlock says 0.125 - audit 66(a). At a server correction with bamboo by the body: the place the server PUT the
//  body is one it allows, so a variant whose stalk overlaps that hitbox is disproved; the client's refused one is evidence for
//  the variant whose stalk it overlaps. One line, both variants)
function probe (bot, client, server) {
  try {
    const V = require('vec3').Vec3
    const hit = (p, c, sh) => p.x - 0.3 < c.x + sh[3] && p.x + 0.3 > c.x + sh[0] && p.z - 0.3 < c.z + sh[5] && p.z + 0.3 > c.z + sh[2] && p.y < c.y + 1 && p.y + 1.8 > c.y
    const out = []
    const cy0 = Math.floor(Math.min(client.y, server.y)); const seen = new Set()
    for (const q of [client, server]) {
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) {
        const c = { x: Math.floor(q.x) + dx, y: cy0 + dy, z: Math.floor(q.z) + dz }; const k = c.x + ',' + c.y + ',' + c.z
        if (seen.has(k)) continue; seen.add(k)
        const b = bot.blockAt(new V(c.x, c.y, c.z)); if (!b || b.name !== 'bamboo') continue
        const r = v => { const o = OFFSET_SOLID.bamboo; const d = offsetXZ(c.x, c.z, v); const sh = [o.box[0] + d.x, 0, o.box[2] + d.z, o.box[3] + d.x, 1, o.box[5] + d.z]; return (hit(client, c, sh) ? 'C' : '-') + (hit(server, c, sh) ? 'S' : '-') }
        const a = r(0.25); const b2 = r(0.125); if (a !== '--' || b2 !== '--') out.push(k + ' .25:' + a + ' .125:' + b2) // (only the stalks either variant puts in a box)
      }
    }
    return out.length ? '(probe) bamboo by the correction (C = the refused client box hits it, S = the allowed server box does): ' + out.join(' ') : ''
  } catch { return '' }
}

module.exports = { install, seed, offsetXZ, shapeAt, probe }
