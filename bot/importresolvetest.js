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

// ---- CALL SHAPE: never pass more arguments than the target accepts ------------------------
// Resolving a NAME is not the same as calling it correctly, and this repo has shipped that bug
// before (3aabb63: "a call-shape bug that HAD already shipped"). Arity OVERFLOW - more args than
// the callee declares, with no rest param - is near-always a real defect: the caller believes a
// different signature, so its trailing arguments are silently dropped.
//
// UNDERFLOW is deliberately NOT asserted. The house style declares trailing params bare and
// defaults them inside (`maxAgeMs || MAX_AGE_MS`, `opts = {}`, `if (tag)`), so 112 production
// call sites legitimately pass fewer - every one audited on 2026-08-02 and all guarded.
{
  // Blank comments and string CONTENT to '~' (not spaces, or a lone string arg counts as zero
  // args) while preserving offsets, so prose and filenames cannot look like code.
  const scrubAll = s => {
    let out = '', i = 0
    while (i < s.length) {
      const c = s[i], d = s[i + 1]
      if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') { out += ' '; i++ } continue }
      if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); const stop = e < 0 ? s.length : e + 2; for (let k = i; k < stop; k++) out += s[k] === '\n' ? '\n' : ' '; i = stop; continue }
      if (c === "'" || c === '"' || c === '`') {
        const q = c; out += '~'; i++
        while (i < s.length && s[i] !== q) { if (s[i] === '\\') { out += '~'; i++ } out += s[i] === '\n' ? '\n' : '~'; i++ }
        out += '~'; i++; continue
      }
      out += c; i++
    }
    return out
  }
  const splitTop = str => {
    const out = []; let d = 0, cur = ''
    for (const c of str) {
      if ('([{'.includes(c)) d++
      else if (')]}'.includes(c)) d--
      if (c === ',' && d === 0) { out.push(cur); cur = ''; continue }
      cur += c
    }
    if (cur.trim()) out.push(cur)
    return out.filter(x => x.trim() !== '')
  }
  // null => unknowable (spread / unbalanced); else the argument count
  const argCount = (s, open) => {
    let d = 0, i = open
    for (; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (!d) break } }
    if (d !== 0) return null
    const inner = s.slice(open + 1, i)
    if (!inner.trim()) return 0
    let depth = 0, commas = 0
    for (let k = 0; k < inner.length; k++) {
      const c = inner[k]
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) depth--
      else if (c === ',' && depth === 0) commas++
      else if (depth === 0 && inner.slice(k, k + 3) === '...') return null
    }
    return commas + 1
  }

  const cleanOf = {}
  for (const f of all) cleanOf[f] = scrubAll(fs.readFileSync(path.join(BOT, f), 'utf8').split(String.fromCharCode(13)).join(''))

  const SIG = {}
  for (const f of files) {
    const s = cleanOf[f]; SIG[f] = {}
    const rx = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g
    let m
    while ((m = rx.exec(s))) {
      const open = s.indexOf('(', m.index + m[0].length - 1)
      let d = 0, i = open
      for (; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (!d) break } }
      const parts = splitTop(s.slice(open + 1, i))
      if (!SIG[f][m[1]]) SIG[f][m[1]] = { total: parts.length, rest: parts.some(p => p.trim().startsWith('...')) }
    }
  }

  const overflow = []
  for (const f of all) {
    const s = cleanOf[f]
    const rawSrc = fs.readFileSync(path.join(BOT, f), 'utf8').split(String.fromCharCode(13)).join('')
    // aliases come from the RAW source: scrubbing blanks the './module.js' path
    const alias = {}
    let a
    const areq = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*'\.\/([\w.-]+)'\s*\)(?!\s*\.)/gm
    while ((a = areq.exec(rawSrc))) alias[a[1]] = norm(a[2])
    for (const [al, target] of Object.entries(alias)) {
      if (!SIG[target]) continue
      const rx = new RegExp('(?<![\\w$.])' + al.replace(/\$/g, '\\$') + '\\.([A-Za-z_$][\\w$]*)\\s*\\(', 'g')
      let m
      while ((m = rx.exec(s))) {
        const sig = SIG[target][m[1]]
        if (!sig || sig.rest) continue
        const n = argCount(s, m.index + m[0].length - 1)
        if (n !== null && n > sig.total) {
          overflow.push(`${f}:${s.slice(0, m.index).split('\n').length}  ${al}.${m[1]}(...) passes ${n}, ${target} declares ${sig.total}`)
        }
      }
    }
  }
  for (const o of overflow) console.log('     ' + o)
  eq(overflow.length, 0, 'no call passes more arguments than the target function accepts')
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
