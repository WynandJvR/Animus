// Fake chunk columns over a procedural blockAt, for world.findBlocks/scanBlocks: every section is a "direct palette"
// section whose data.get(i) reads the state id of the block there (so the real search code runs unchanged).
module.exports = function install (bot, { minY = 0, height = 128, md } = {}) {
  bot.game = Object.assign(bot.game || {}, { minY, height })
  const cols = new Map()
  bot.world = Object.assign(bot.world || {}, {
    getColumn (cx, cz) {
      const k = cx + ',' + cz
      if (!cols.has(k)) {
        const sections = []
        for (let s = 0; s < height / 16; s++) {
          const by = minY + s * 16
          sections.push({ data: { get: i => { const b = bot.blockAt({ x: cx * 16 + (i & 15), y: by + (i >> 8), z: cz * 16 + ((i >> 4) & 15) }); return b ? md.blocksByName[b.name].defaultState : 0 } } })
        }
        cols.set(k, { sections })
      }
      return cols.get(k)
    }
  })
}
