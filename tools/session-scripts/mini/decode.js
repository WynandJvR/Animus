// decode a litematic region into {size, palette, blocks: Int32Array of palette indices, idx=(y*sz+z)*sx+x}
const nbt = require('prismarine-nbt'), fs = require('fs')
module.exports = async function decode (file) {
  const { parsed } = await nbt.parse(fs.readFileSync(file))
  const s = nbt.simplify(parsed); const r = Object.values(s.Regions)[0]
  const sx = Math.abs(r.Size.x), sy = Math.abs(r.Size.y), sz = Math.abs(r.Size.z), n = sx * sy * sz
  const pal = r.BlockStatePalette, bits = Math.max(2, Math.ceil(Math.log2(pal.length)))
  const longs = r.BlockStates.map(([hi, lo]) => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)), mask = (1n << BigInt(bits)) - 1n
  const blocks = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const bit = i * bits, li = Math.floor(bit / 64), off = BigInt(bit % 64)
    let v = longs[li] >> off
    if (Number(off) + bits > 64) v |= longs[li + 1] << (64n - off)
    blocks[i] = Number(v & mask)
  }
  return { sx, sy, sz, pal, blocks, tiles: r.TileEntities }
}
if (require.main === module) module.exports(process.argv[2]).then(({ sx, sy, sz, pal, blocks }) => {
  const c = {}; for (const b of blocks) { const nm = pal[b].Name.replace('minecraft:', ''); c[nm] = (c[nm] || 0) + 1 }
  delete c.air; const tot = Object.values(c).reduce((a, b) => a + b, 0)
  console.log('size', sx, sy, sz, 'non-air', tot, 'distinct', Object.keys(c).length)
  for (const [k, v] of Object.entries(c).sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), k)
})
