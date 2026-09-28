'use strict'
// Cross-module names: every `<alias>.<name>` a bot2 module uses from a sibling it requires must be that sibling's export.
// node --check cannot see it - director called shelter.enclosedHere, which shelter never exported, and the first dim
// dawn with mobs about would have thrown inside decide (2026-09-28). Exit 1 on any miss.
// usage: node xmodcheck.js [bot2 dir]   (NODE_PATH must reach the bot's node_modules)
const fs = require('fs')
const path = require('path')
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'bot2'))
const lib = path.join(dir, 'lib')
process.env.BOT2_LOG_FILE = process.env.BOT2_LOG_FILE || path.join(require('os').tmpdir(), 'xmodcheck.log')
const files = fs.readdirSync(lib).filter(f => f.endsWith('.js')).map(f => path.join(lib, f)).concat([path.join(dir, 'main.js')])
const exportsOf = {}
const load = mod => {
  if (mod in exportsOf) return exportsOf[mod]
  try { exportsOf[mod] = require(path.join(lib, mod + '.js')) } catch (e) { exportsOf[mod] = null; console.log(`WARN can't load ${mod}: ${e.message.split('\n')[0]}`) }
  return exportsOf[mod]
}
let misses = 0
for (const f of files) {
  if (f.endsWith('main.js')) continue // (main starts the bot on require; its lib uses are covered where they are defined)
  const raw = fs.readFileSync(f, 'utf8')
  // (comments and string/template text blanked, lengths kept so line numbers hold: 'boat.js' in a comment is no use)
  const blank = t => t.replace(/[^\n]/g, ' ')
  const src = raw
    .replace(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, t => /^'\.\/[\w-]+'$/.test(t) ? t : blank(t))
    .replace(/\/\/[^\n]*/g, blank)
  const alias = {}
  // TOP-LEVEL only (column 0): const x = require('./mod')  |  const x = () => require('./mod') - a function's own
  // `const b = ...` is a local, and so is every other short name that shadows one
  for (const m of raw.matchAll(/^(?:const|let)\s+(\w+)\s*=\s*(\(\)\s*=>\s*)?require\('\.\/([\w-]+)'\)/gm)) alias[m[1]] = { mod: m[3], lazy: !!m[2] }
  for (const [a, { mod, lazy }] of Object.entries(alias)) {
    const ex = load(mod); if (!ex) continue
    const re = lazy ? new RegExp(`\\b${a}\\(\\)\\.(\\w+)`, 'g') : new RegExp(`(?<![\\w.])${a}\\.(\\w+)`, 'g')
    const seen = new Set()
    for (const m of src.matchAll(re)) {
      const name = m[1]; if (seen.has(name)) continue; seen.add(name)
      if (!(name in ex)) { misses++; const line = src.slice(0, m.index).split('\n').length; console.log(`MISSING ${path.basename(f)}:${line} ${a}.${name} - ${mod}.js does not export it`) }
    }
  }
  // require('./mod').name   (inline)
  for (const m of src.matchAll(/require\('\.\/([\w-]+)'\)\.(\w+)/g)) {
    const ex = load(m[1]); if (!ex) continue
    if (!(m[2] in ex)) { misses++; const line = src.slice(0, m.index).split('\n').length; console.log(`MISSING ${path.basename(f)}:${line} require('./${m[1]}').${m[2]} - not exported`) }
  }
}
console.log(misses ? `${misses} cross-module name(s) missing` : 'cross-module names OK')
process.exit(misses ? 1 : 0)
