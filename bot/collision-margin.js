'use strict'
// ==== THE HITBOX NEVER RESTS EXACTLY ON A BLOCK FACE (2026-08-26) ===========================
//
// prismarine-physics resolves a collision by moving the entity to EXACT contact with the block:
//   computeOffsetX: offsetX = min(this.minX - other.maxX, offsetX)
// In floating point "exact" is +-1e-16, so the hitbox routinely ends up overlapping the block by a
// rounding error (8.3 - 0.3 = 7.9999999999999996 < 8.0). Every server up to Paper 1.21.11 build
// 115 tolerated that: its intersection tests shrank the boxes by an epsilon. Build 116 ("Fix
// collision inconsistency with Vanilla - avoid performing intersection checks with the epsilon
// value when checking intersection against whole blocks ... I'm sure this is going to cause some
// collision problem") stopped tolerating it. From then on a bot standing flush against a block is
// INSIDE it as far as the server is concerned, and its next move is answered with a teleport back:
// live 2026-08-26, ~18 syncs/s with consecutive teleport ids, every jump onto a step refused,
// reproduced on a plugin-free lab server on build 132 and absent on build 69.
//
// So this body keeps a MARGIN: a collision lands the hitbox COLLISION_MARGIN short of the face,
// and an overlap smaller than the margin (the rounding error) is treated as contact and pushed
// back out instead of being read as "already inside, no clipping applies". The margin is far
// below anything the game can observe (a block is 1.0; the server's own tolerance for a claimed
// position is 0.25) and far above the rounding error it exists to absorb. Patched on the AABB
// PROTOTYPE that prismarine-physics itself uses, at load, so it survives npm install (the same
// durable-override pattern as index.js installDigTimeGuard).
const COLLISION_MARGIN = 1e-5

function install () {
  let AABB
  try { AABB = require('prismarine-physics/lib/aabb') } catch (e) { return { installed: false, why: e.message } }
  if (AABB.prototype.__marginInstalled) return { installed: true, already: true, margin: COLLISION_MARGIN }
  const M = COLLISION_MARGIN
  AABB.prototype.computeOffsetX = function (other, offsetX) {
    if (other.maxY > this.minY && other.minY < this.maxY && other.maxZ > this.minZ && other.minZ < this.maxZ) {
      if (offsetX > 0.0 && other.maxX <= this.minX + M) {
        offsetX = Math.min(this.minX - other.maxX - M, offsetX)
      } else if (offsetX < 0.0 && other.minX >= this.maxX - M) {
        offsetX = Math.max(this.maxX - other.minX + M, offsetX)
      }
    }
    return offsetX
  }
  AABB.prototype.computeOffsetY = function (other, offsetY) {
    if (other.maxX > this.minX && other.minX < this.maxX && other.maxZ > this.minZ && other.minZ < this.maxZ) {
      if (offsetY > 0.0 && other.maxY <= this.minY + M) {
        offsetY = Math.min(this.minY - other.maxY - M, offsetY)
      } else if (offsetY < 0.0 && other.minY >= this.maxY - M) {
        offsetY = Math.max(this.maxY - other.minY + M, offsetY)
      }
    }
    return offsetY
  }
  AABB.prototype.computeOffsetZ = function (other, offsetZ) {
    if (other.maxX > this.minX && other.minX < this.maxX && other.maxY > this.minY && other.minY < this.maxY) {
      if (offsetZ > 0.0 && other.maxZ <= this.minZ + M) {
        offsetZ = Math.min(this.minZ - other.maxZ - M, offsetZ)
      } else if (offsetZ < 0.0 && other.minZ >= this.maxZ - M) {
        offsetZ = Math.max(this.maxZ - other.minZ + M, offsetZ)
      }
    }
    return offsetZ
  }
  AABB.prototype.__marginInstalled = true
  return { installed: true, margin: COLLISION_MARGIN }
}

module.exports = { install, COLLISION_MARGIN }
