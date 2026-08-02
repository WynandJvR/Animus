'use strict'
// OFFLINE structural test: every cross-module import in bot/ must RESOLVE.
// No bot, no world. Run: cd bot && node importresolvetest.js
//
// WHY THIS EXISTS: the facade shrink (commits 11aed47..3aabb63) moved ~117 names off
// provision.js's public surface and rewrote the call sites it knew about. Three files
// were missed, and every one of them failed SILENTLY:
//
//   - resources.js called provision.chestCounts / withdrawItem / ensureChest /
//     depositMaterials / inventoryCounts. All undefined. The TypeError landed in the
//     catch that exists to survive a mob interrupting a chest open, so the bank read as
//     empty, every chest earned a failure strike, and the bot re-gathered what it owned.
//   - perception.js called provision.hasSolidCeiling -> `underground` reported FALSE
//     everywhere, in the snapshot the survival tier reads.
//   - scaffold.js called provision.farmFootprintHas -> the farm-footprint guard answered
//     "not farm" for every cell, disarming the anti-grief check over the crops.
//
// The suite was 58/58 green through all of it, because a name that no longer exists is
// not a syntax error and not a load error - it is `undefined`, and this codebase is full
// of defensive catches that turn a TypeError into a shrug. So the check has to be
// STRUCTURAL: resolve every import against what the target module actually exports.
//
// Covers the three shapes the codebase uses:
//   1. alias.name            const provBank = require('./provision-bank.js'); provBank.foo()
//   2. { a, b } = alias      const { chestCounts } = provBank
//   3. require('./m.js').n   the lazy inline form used to dodge require cycles
//
// Entry points (index.js, run.js, brain-llm.js, index-bedrock.js) are SCANNED as call
// sites but never require()d - loading them opens a control port and dials the server.

const fs = require('fs')
const path = require('path')

let failures = 0
function eq (got, want, label) {
  const ok = got === want
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`))
}

const BOT = __dirname
const ENTRY = new Set(['index.js', 'run.js', 'brain-llm.js', 'index-bedrock.js'])
const all = fs.readdirSync(BOT).filter(f => f.endsWith('.js'))
// PRODUCTION files only. A test that imports a name which no longer exists FAILS when the
// suite runs - it is self-verifying. Production code is the half that degrades silently,
// and it is where all four of the misses above lived. Scanning tests too only re-reports
// their deliberate absence assertions (`assert(!provision.gatherWool)`) as breakage.
const files = all.filter(f => !/test\.js$/.test(f))

// ---- what each module actually exports (entry points excluded: import-time side effects)
const exportsOf = {}
for (const f of files) {
  if (ENTRY.has(f) || /test\.js$/.test(f)) continue
  try {
    const m = require(path.join(BOT, f))
    exportsOf[f] = m && typeof m === 'object' ? new Set(Object.keys(m)) : null
  } catch (e) {
    exportsOf[f] = null
    console.log(`note  ${f} could not be loaded (${e.message.slice(0, 80)}) - skipped`)
  }
}

// Blank out comments, strings and regex literals so prose and filenames ("see provision.js")
// never read as member access. CRLF is stripped first: `.` does not match \r, so a trailing
// CR makes /\/\/.*$/ fail to strip the comment.
function scrub (line) {
  return line
    .split(String.fromCharCode(13)).join('')
    .replace(/\/\/.*/, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, '/RE/')
}
const norm = t => (t.endsWith('.js') ? t : t + '.js')

const unresolved = []

for (const f of files) {
  const raw = fs.readFileSync(path.join(BOT, f), 'utf8').split(String.fromCharCode(13)).join('')
  const lines = raw.split('\n')

  // local module aliases. The negative lookahead rejects `require('./m.js').fn(...)`,
  // where the binding is the RESULT of the call, not the module.
  // TOP-LEVEL declarations only (^const, no indent): planner.js holds a module alias
  // `const c = require('./commands.js')` inside one block and an unrelated local `const c =
  // inventoryCounts(bot)` inside another. A file-wide alias map would read the second one's
  // `c.raw_iron` as a missing commands.js export.
  const alias = {}
  const areq = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*'\.\/([\w.-]+)'\s*\)(?!\s*\.)/gm
  let a
  while ((a = areq.exec(raw))) alias[a[1]] = norm(a[2])

  // ---- shape 1: alias.name
  lines.forEach((line, i) => {
    const code = scrub(line)
    for (const [al, target] of Object.entries(alias)) {
      const ex = exportsOf[target]
      if (!ex) continue
      const use = new RegExp('(?<![\\w$.])' + al.replace(/\$/g, '\\$') + '\\.([A-Za-z_$][\\w$]*)', 'g')
      let u
      while ((u = use.exec(code))) {
        const name = u[1]
        if (name.startsWith('__')) continue // internal sibling bridge, not a public export
        if (!ex.has(name)) unresolved.push(`${f}:${i + 1}  ${al}.${name}  (${target} does not export it)`)
      }
    }
  })

  // ---- shape 2: const { a, b } = alias
  // The trailing lookahead matters: `let { keep } = hutModel.reconcileCells(...)` destructures
  // a RETURN VALUE, not the module, and must not be checked against the module's exports.
  const dre = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*([A-Za-z_$][\w$]*)\s*(?=$|[;\n]|\/\/)/gm
  let d
  while ((d = dre.exec(raw))) {
    const target = alias[d[2]]
    const ex = target && exportsOf[target]
    if (!ex) continue
    const lineNo = raw.slice(0, d.index).split('\n').length
    for (const piece of d[1].split(',')) {
      const nm = piece.replace(/\/\/[^\n]*/g, '').split(':')[0].trim()
      if (!/^[A-Za-z_$][\w$]*$/.test(nm)) continue
      if (!ex.has(nm)) unresolved.push(`${f}:${lineNo}  { ${nm} } = ${d[2]}  (${target} does not export it)`)
    }
  }

  // ---- shape 3: require('./m.js').name  (the lazy, cycle-dodging form)
  lines.forEach((line, i) => {
    const code = scrub(line)
    const ire = /require\(\s*'\.\/([\w.-]+)'\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g
    let m
    while ((m = ire.exec(code))) {
      const target = norm(m[1])
      const ex = exportsOf[target]
      if (!ex) continue
      if (m[2].startsWith('__')) continue
      if (!ex.has(m[2])) unresolved.push(`${f}:${i + 1}  require('./${m[1]}').${m[2]}  (not exported)`)
    }
  })
}

for (const u of unresolved) console.log('     ' + u)
eq(unresolved.length, 0, 'every cross-module import resolves to a real export')

// ---- the three call sites that were actually broken, pinned by name -----------------------
// Not redundant with the sweep above: these name the CONTRACT, so a future move that takes
// the sweep down with it (e.g. a module that stops loading) still fails loudly here.
{
  const provBank = require('./provision-bank.js')
  const provCore = require('./provision-core.js')
  const provHut = require('./provision-hut.js')
  const provFarm = require('./provision-farm.js')
  for (const n of ['chestCounts', 'withdrawItem', 'ensureChest', 'depositMaterials']) {
    eq(typeof provBank[n], 'function', `resources.js depends on provision-bank.${n}`)
  }
  eq(typeof provCore.inventoryCounts, 'function', 'resources.js depends on provision-core.inventoryCounts')
  eq(typeof provHut.hasSolidCeiling, 'function', 'perception.js depends on provision-hut.hasSolidCeiling')
  eq(typeof provFarm.farmFootprintHas, 'function', 'scaffold.js depends on provision-farm.farmFootprintHas')
}

// The resource model must reach the bank through a binding that EXISTS - the original bug was
// invisible precisely because `provision.chestCounts` was a legal expression that read undefined.
{
  const src = fs.readFileSync(path.join(BOT, 'resources.js'), 'utf8')
  eq(/provision\.(chestCounts|withdrawItem|ensureChest|depositMaterials|inventoryCounts)/.test(src), false,
    'resources.js no longer reaches the bank primitives through the shrunken provision facade')
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
