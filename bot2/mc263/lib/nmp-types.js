'use strict'
// Minecraft 26.3 wire types that plain protodef JSON cannot express. Copied by patch-mc262.js into
// minecraft-protocol/src/datatypes/mc263-types.js and added to its compiler next to compiler-minecraft.js.
// Source of the formats: ViaVersion Protocol26_2To26_3 / ViaBackwards Protocol26_3To26_2 (EntityPacketRewriter26_3,
// BlockItemPacketRewriter26_3). Each read returns the 26.2 field names too, so mineflayer reads the packets unchanged.
const { types, utils: { PartialReadError } } = require('protodef')
const [readVarInt, writeVarInt, sizeOfVarInt] = types.varint
const readLI64 = types.li64[0]

function need (buffer, offset, n) { if (offset + n > buffer.length) throw new PartialReadError() }

// MOVE_ENTITY_POS(_ROT): varint props (bit 0 on ground, props >>> 1 = step count); no steps: three i16 deltas;
// else per step: varint tick delay, three i16 deltas. Read also gives dX/dY/dZ = the summed delta (26.2 meaning).
function readMoveSteps (buffer, offset) {
  const p = readVarInt(buffer, offset)
  let cursor = offset + p.size
  const value = { onGround: (p.value & 1) !== 0 }
  const n = p.value >>> 1
  if (n === 0) {
    need(buffer, cursor, 6)
    value.dX = buffer.readInt16BE(cursor); value.dY = buffer.readInt16BE(cursor + 2); value.dZ = buffer.readInt16BE(cursor + 4)
    return { value, size: cursor + 6 - offset }
  }
  value.steps = []
  let dX = 0; let dY = 0; let dZ = 0
  for (let i = 0; i < n; i++) {
    const d = readVarInt(buffer, cursor)
    cursor += d.size
    need(buffer, cursor, 6)
    const s = { delay: d.value, dX: buffer.readInt16BE(cursor), dY: buffer.readInt16BE(cursor + 2), dZ: buffer.readInt16BE(cursor + 4) }
    cursor += 6
    dX += s.dX; dY += s.dY; dZ += s.dZ
    value.steps.push(s)
  }
  Object.assign(value, { dX, dY, dZ })
  return { value, size: cursor - offset }
}
function writeMoveSteps (value, buffer, offset) {
  const steps = value.steps || []
  offset = writeVarInt((steps.length << 1) | (value.onGround ? 1 : 0), buffer, offset)
  const list = steps.length ? steps : [value]
  for (const s of list) {
    if (steps.length) offset = writeVarInt(s.delay || 0, buffer, offset)
    buffer.writeInt16BE(s.dX, offset); buffer.writeInt16BE(s.dY, offset + 2); buffer.writeInt16BE(s.dZ, offset + 4)
    offset += 6
  }
  return offset
}
function sizeOfMoveSteps (value) {
  const steps = value.steps || []
  let size = sizeOfVarInt((steps.length << 1) | (value.onGround ? 1 : 0))
  if (!steps.length) return size + 6
  for (const s of steps) size += sizeOfVarInt(s.delay || 0) + 6
  return size
}

// ENTITY_POSITION_SYNC: varint path type; 0 = linear: x y z f64; else varint step count, per step x y z f64 + varint tick
// offset. Read gives x/y/z = the last step and dx/dy/dz = (last - previous) / tick offset (ViaBackwards' estimate), 0 when linear.
function readPositionPath (buffer, offset) {
  const t = readVarInt(buffer, offset)
  let cursor = offset + t.size
  if (t.value === 0) {
    need(buffer, cursor, 24)
    const value = { pathType: 0, x: buffer.readDoubleBE(cursor), y: buffer.readDoubleBE(cursor + 8), z: buffer.readDoubleBE(cursor + 16), dx: 0, dy: 0, dz: 0 }
    return { value, size: cursor + 24 - offset }
  }
  const n = readVarInt(buffer, cursor)
  cursor += n.size
  const steps = []
  for (let i = 0; i < n.value; i++) {
    need(buffer, cursor, 24)
    const s = { x: buffer.readDoubleBE(cursor), y: buffer.readDoubleBE(cursor + 8), z: buffer.readDoubleBE(cursor + 16) }
    cursor += 24
    const tk = readVarInt(buffer, cursor)
    cursor += tk.size
    s.tickOffset = tk.value
    steps.push(s)
  }
  const last = steps[steps.length - 1] || { x: 0, y: 0, z: 0, tickOffset: 0 }
  const prev = steps.length > 1 ? steps[steps.length - 2] : null
  const k = prev && last.tickOffset > 0 ? last.tickOffset : 0
  const value = {
    pathType: t.value,
    steps,
    x: last.x,
    y: last.y,
    z: last.z,
    dx: k ? (last.x - prev.x) / k : 0,
    dy: k ? (last.y - prev.y) / k : 0,
    dz: k ? (last.z - prev.z) / k : 0
  }
  return { value, size: cursor - offset }
}
function writePositionPath (value, buffer, offset) {
  if (!value.pathType || !value.steps) {
    offset = writeVarInt(0, buffer, offset)
    buffer.writeDoubleBE(value.x, offset); buffer.writeDoubleBE(value.y, offset + 8); buffer.writeDoubleBE(value.z, offset + 16)
    return offset + 24
  }
  offset = writeVarInt(value.pathType, buffer, offset)
  offset = writeVarInt(value.steps.length, buffer, offset)
  for (const s of value.steps) {
    buffer.writeDoubleBE(s.x, offset); buffer.writeDoubleBE(s.y, offset + 8); buffer.writeDoubleBE(s.z, offset + 16)
    offset = writeVarInt(s.tickOffset || 0, buffer, offset + 24)
  }
  return offset
}
function sizeOfPositionPath (value) {
  if (!value.pathType || !value.steps) return 1 + 24
  let size = sizeOfVarInt(value.pathType) + sizeOfVarInt(value.steps.length)
  for (const s of value.steps) size += 24 + sizeOfVarInt(s.tickOffset || 0)
  return size
}

// java.util.BitSet on the wire (26.3 light masks, chat filter mask): varint byte count + little-endian bytes. Read gives
// the long-array form the 26.2 i64 arrays had (prismarine-chunk's BitArray.fromLongArray reads it unchanged).
function longsToBytes (value) {
  const bytes = []
  for (const l of value || []) {
    const b = Buffer.alloc(8)
    if (typeof l === 'bigint') b.writeBigInt64LE(l)
    else { b.writeInt32LE(l[1] | 0, 0); b.writeInt32LE(l[0] | 0, 4) }
    bytes.push(...b)
  }
  while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop() // BitSet.toByteArray trims trailing zero bytes
  return Buffer.from(bytes)
}
function readBitSet (buffer, offset) {
  const n = readVarInt(buffer, offset)
  const start = offset + n.size
  need(buffer, start, n.value)
  const padded = Buffer.alloc(Math.ceil(n.value / 8) * 8)
  buffer.copy(padded, 0, start, start + n.value)
  const value = []
  for (let i = 0; i < padded.length; i += 8) value.push(readLI64(padded, i).value)
  return { value, size: n.size + n.value }
}
function writeBitSet (value, buffer, offset) {
  const b = longsToBytes(value)
  offset = writeVarInt(b.length, buffer, offset)
  b.copy(buffer, offset)
  return offset + b.length
}
function sizeOfBitSet (value) {
  const b = longsToBytes(value)
  return sizeOfVarInt(b.length) + b.length
}

module.exports = {
  Read: {
    mc263MoveSteps: ['native', readMoveSteps],
    mc263PositionPath: ['native', readPositionPath],
    mc263BitSet: ['native', readBitSet]
  },
  Write: {
    mc263MoveSteps: ['native', writeMoveSteps],
    mc263PositionPath: ['native', writePositionPath],
    mc263BitSet: ['native', writeBitSet]
  },
  SizeOf: {
    mc263MoveSteps: ['native', sizeOfMoveSteps],
    mc263PositionPath: ['native', sizeOfPositionPath],
    mc263BitSet: ['native', sizeOfBitSet]
  }
}
