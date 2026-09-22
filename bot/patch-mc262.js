'use strict'
// Minecraft 26.2 support ahead of the npm releases (the live server moved to 26.2 on 2026-09-22;
// minecraft-data 3.117.0 stops at 26.1). Overlays the pc 26.2 data from upstream's `pc_26_2`
// branch onto the installed minecraft-data and adds 26.2 wherever the libraries list 26.1.
// Re-run after every npm install in bot/ (idempotent). Delete once minecraft-data/mineflayer ship 26.2.
//   node patch-mc262.js [dataCloneDir]
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const nm = path.join(__dirname, 'node_modules')
const pkg = path.join(nm, 'minecraft-data')
const data = path.join(pkg, 'minecraft-data', 'data')

function fetchData (dir) {
  if (fs.existsSync(path.join(dir, 'data', 'pc', '26.2', 'protocol.json'))) return dir
  console.log('[mc262] fetching pc_26_2 data from PrismarineJS/minecraft-data')
  fs.rmSync(dir, { recursive: true, force: true })
  const git = (...a) => cp.execFileSync('git', a, { stdio: 'inherit', env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }) })
  git('clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', '-b', 'pc_26_2', 'https://github.com/PrismarineJS/minecraft-data.git', dir)
  git('-C', dir, 'sparse-checkout', 'set', '--no-cone', '/data/pc/26.2/', '/data/pc/common/', '/data/dataPaths.json', '/data/pc/1.20.3/windows.json')
  return dir
}

function patchData (src) {
  const have = JSON.parse(fs.readFileSync(path.join(data, 'dataPaths.json'), 'utf8'))
  if (have.pc['26.2'] && fs.existsSync(path.join(data, 'pc', '26.2', 'protocol.json'))) { console.log('[mc262] minecraft-data already has 26.2'); return }
  fs.cpSync(path.join(src, 'data/pc/26.2'), path.join(data, 'pc/26.2'), { recursive: true })
  fs.mkdirSync(path.join(data, 'pc/1.20.3'), { recursive: true })
  fs.copyFileSync(path.join(src, 'data/pc/1.20.3/windows.json'), path.join(data, 'pc/1.20.3/windows.json'))
  for (const f of ['features.json', 'protocolVersions.json', 'versions.json']) fs.copyFileSync(path.join(src, 'data/pc/common', f), path.join(data, 'pc/common', f))
  have.pc['26.2'] = JSON.parse(fs.readFileSync(path.join(src, 'data/dataPaths.json'), 'utf8')).pc['26.2']
  fs.writeFileSync(path.join(data, 'dataPaths.json'), JSON.stringify(have, null, 2))
  cp.execFileSync(process.execPath, [path.join(pkg, 'bin', 'generate_data.js')], { cwd: pkg, stdio: 'inherit' })
  console.log('[mc262] minecraft-data patched')
}

// the libraries gate on version lists: 26.2 goes wherever 26.1 is listed
const EDITS = [
  ['prismarine-chunk/src/index.js', "26.1: require('./pc/1.18/chunk')\n", "26.1: require('./pc/1.18/chunk'),\n    26.2: require('./pc/1.18/chunk')\n"],
  ['prismarine-physics/lib/features.json', /"26\.1"\]/g, '"26.1", "26.2"]'],
  ['mineflayer/lib/version.js', "'26.1']", "'26.1', '26.2']"],
  ['minecraft-protocol/src/version.js', "'26.1']", "'26.1', '26.2']"]
]
function patchGates () {
  for (const [f, from, to] of EDITS) {
    const copies = [path.join(nm, f), ...fs.readdirSync(nm).map(d => path.join(nm, d, 'node_modules', f))].filter(p => fs.existsSync(p))
    if (!copies.length) throw new Error('[mc262] not installed: ' + f)
    for (const p of copies) {
      const s = fs.readFileSync(p, 'utf8')
      if (s.includes('26.2')) continue
      const t = s.replace(from, to)
      if (t === s) throw new Error('[mc262] pattern not found in ' + p)
      fs.writeFileSync(p, t)
      console.log('[mc262] patched', path.relative(nm, p))
    }
  }
}

const src = fetchData(process.argv[2] || path.join(__dirname, '.mc262-data'))
patchData(src)
patchGates()
delete require.cache[require.resolve(pkg)]
if (!require(pkg)('26.2')) throw new Error('[mc262] minecraft-data still has no 26.2')
console.log('[mc262] ok - 26.2 ready')
