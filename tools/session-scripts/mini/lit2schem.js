// litematic -> Sponge .schem (MC 26.2) with the operator's substitutions (2026-09-27):
// nether/End-sourced blocks -> overworld look-alikes, mob heads dropped, everything else kept.
//   node lit2schem.js <in.litematic> <out.schem>
const NM = 'C:/mc-bot-lab/bot/node_modules/'
const fs = require('fs')
const { Vec3 } = require(NM + 'vec3')
const { Schematic } = require(NM + 'prismarine-schematic')
const V = '26.2'
const md = require(NM + 'minecraft-data')(V)
const Block = require(NM + 'prismarine-block')(V)
const decode = require('./decode.js')
const SUB = {
  glowstone: 'jack_o_lantern', // hidden floor lights under carpet: a full light block from a pumpkin
  soul_soil: 'coarse_dirt', soul_sand: 'coarse_dirt', nether_wart: 'poppy',
  crimson_trapdoor: 'mangrove_trapdoor', crimson_slab: 'mangrove_slab', warped_fence: 'dark_oak_fence',
  potted_crimson_fungus: 'potted_red_mushroom', polished_blackstone_button: 'stone_button',
  quartz_pillar: 'polished_diorite', end_rod: 'lightning_rod', lodestone: 'chiseled_stone_bricks',
  ender_chest: 'chest',
  // not reasonably obtainable in survival: quartz (nether), a village-only bell, pale-garden flowers, silk-touch ores
  daylight_detector: 'smooth_stone_slab', bell: 'lantern', closed_eyeblossom: 'white_tulip', open_eyeblossom: 'oxeye_daisy',
  potted_closed_eyeblossom: 'potted_white_tulip', potted_open_eyeblossom: 'potted_oxeye_daisy',
  coal_ore: 'stone', iron_ore: 'stone', deepslate_iron_ore: 'cobbled_deepslate'
}
const DROP = /^(wither_skeleton_skull|creeper_head|zombie_head|skeleton_skull|player_head|dragon_head|piglin_head)$|_wall_(skull|head)$|^(brewing_stand|cobweb|spore_blossom|cave_vines|cave_vines_plant)$/
decode(process.argv[2]).then(({ sx, sy, sz, pal, blocks }) => {
  const palette = [Block.fromProperties('air', {}, 0).stateId]; const out = new Array(sx * sy * sz).fill(0)
  const tally = {}; const dropped = {}; const subbed = {}
  const cache = new Map()
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const p = pal[blocks[(y * sz + z) * sx + x]]; const src = p.Name.replace('minecraft:', '')
    if (src === 'air' || src === 'cave_air' || src === 'void_air') continue
    if (DROP.test(src)) { dropped[src] = (dropped[src] || 0) + 1; continue }
    const name = SUB[src] || src
    if (SUB[src]) subbed[src + '->' + name] = (subbed[src + '->' + name] || 0) + 1
    const ck = name + JSON.stringify(p.Properties || {})
    let i = cache.get(ck)
    if (i == null) {
      if (!md.blocksByName[name]) throw new Error('no block ' + name)
      const def = Block.fromStateId(md.blocksByName[name].defaultState, 0).getProperties()
      const props = {}; for (const [k, v] of Object.entries(p.Properties || {})) if (k in def) props[k] = v === 'true' ? true : v === 'false' ? false : (/^\d+$/.test(v) ? +v : v)
      const b = Block.fromProperties(name, Object.assign({}, def, props), 0)
      i = palette.indexOf(b.stateId); if (i < 0) { palette.push(b.stateId); i = palette.length - 1 }
      cache.set(ck, i)
    }
    out[x + z * sx + y * sx * sz] = i
    tally[name] = (tally[name] || 0) + 1
  }
  return new Schematic(V, new Vec3(sx, sy, sz), new Vec3(0, 0, 0), palette, out).write().then(buf => {
    fs.writeFileSync(process.argv[3], buf)
    console.log('wrote', process.argv[3], sx, sy, sz, 'blocks', Object.values(tally).reduce((a, b) => a + b, 0))
    console.log('substituted', JSON.stringify(subbed)); console.log('dropped', JSON.stringify(dropped))
  })
})
