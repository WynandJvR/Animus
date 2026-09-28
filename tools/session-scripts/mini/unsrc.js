const NM = 'C:/mc-bot-lab/bot2/node_modules/'
const fs = require('fs'); const { Schematic } = require(NM + 'prismarine-schematic')
const md = require(NM + 'minecraft-data')('26.2')
const mats = require('C:/mc-bot-lab/bot2/lib/materials.js')
const world = require('C:/mc-bot-lab/bot2/lib/world.js'); world.data = () => md
mats.getPlanner({})
Schematic.read(fs.readFileSync(process.argv[2]), '26.2').then(async s => {
  const bad = {}; let tot = 0; let n = 0
  await s.forEach(b => { if (b.name === 'air') return; tot++
    const it = b.name === 'grass_block' ? 'dirt' : md.itemsByName[b.name] ? b.name : /^potted_/.test(b.name) ? 'flower_pot' : md.itemsByName[b.name.replace(/(^|_)wall_/, '$1')] ? b.name.replace(/(^|_)wall_/, '$1') : null
    if (it && mats.unsourced(it)) { bad[it] = (bad[it] || 0) + 1; n++ } })
  console.log('cells', tot, 'unsourced', n); console.log(JSON.stringify(bad))
})
