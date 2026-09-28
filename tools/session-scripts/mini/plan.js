const NM = 'C:/mc-bot-lab/bot2/node_modules/'
const fs = require('fs'); const { Schematic } = require(NM + 'prismarine-schematic')
const md = require(NM + 'minecraft-data')('26.2')
const mats = require('C:/mc-bot-lab/bot2/lib/materials.js')
Schematic.read(fs.readFileSync(process.argv[2]), "26.2").then(async s => {
  const needs = {}; const noItem = {}
  await s.forEach((b) => { if (b.name === 'air') return
    let it = b.name === 'grass_block' ? 'dirt' : md.itemsByName[b.name] ? b.name : md.itemsByName[b.name.replace(/(^|_)wall_/, '$1')] ? b.name.replace(/(^|_)wall_/, '$1') : /^potted_/.test(b.name) ? 'flower_pot' : null
    if (/_door$/.test(b.name) && b.getProperties().half === 'upper') return
    if (/_bed$/.test(b.name) && b.getProperties().part === 'head') return
    if (/^(tall_grass|large_fern|rose_bush|lilac|peony|sunflower)$/.test(b.name) && b.getProperties().half === 'upper') return
    if (!it) { noItem[b.name] = (noItem[b.name] || 0) + 1; return }
    needs[it] = (needs[it] || 0) + 1 })
  const p = mats.makePlanner(md).plan(needs)
  console.log('NO ITEM:', JSON.stringify(noItem))
  console.log('RAW:', Object.entries(p.raw).sort((a, b) => b[1] - a[1]).map(([k, v]) => v + ' ' + k + (p.unknown.includes(k) ? '*' : '')).join(', '))
  console.log('SMELTS', p.smeltTotal); if (process.argv[3]) for (const c of p.crafts) console.log('  craft', c.item, 'x' + c.crafts, JSON.stringify(c.per))
})
