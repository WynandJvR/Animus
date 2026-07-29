'use strict'
// ==== THE CAPABILITY CONTRACT TEST ========================================================
// This is the part that makes the "exists but unreachable" bug class extinct.
//
// The class (AUDIT 2026-07-29): a planner NAMES something - a rung action, a job, an item -
// and nothing guarantees a producer EXISTS for the things that planner can name. The miss is
// always SILENT: a `continue` past a missing executor, a bare `return` past an unknown job, a
// "don't know how to gather X" nobody reads. Four defects were fixed in one session that were
// all this one defect (see bot/capabilities.js for the roll-call).
//
// So this file does not SAMPLE. It ENUMERATES: it drives each planner over the full cartesian
// product of the snapshot dimensions that planner actually reads, collects every distinct thing
// it can emit, and asserts a producer exists for each one. A capability gap becomes a red test
// instead of a bot standing still.
//
// PURE: no bot, no server, no clock. Source-pinned assertions read index.js as text because the
// tick's dispatch table is a chain of `if`s, not data - the pin is what keeps it honest.
//
// AMBIENT-PROOFED (trap 2 of the plan): this dev machine exports DYNAMIC_CORE=1,
// GRAVE_NEAR_LADDER=96, WATER_ESCAPE=1, ROD_SUPPLY=1, NAV_TERRAIN_PROFILE=1, FARM_FLAT_MIN=0.2
// at user level, so the live bot has never run the configuration a naive test asserts. Every
// enumeration below runs under EXPLICIT env configurations, including the cleared defaults.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const caps = require('./capabilities.js')
const S = require('./scheduler.js')
const core = require('./scheduler-core.js')
const { RUNG_EXECUTORS } = require('./provision-recovery.js')

let fails = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fails++ } }
function withEnv (vars, fn) {
  const old = {}
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v }
  try { return fn() } finally { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v } }
}
const srcOf = f => fs.readFileSync(path.join(__dirname, f), 'utf8')

// ---- the enumerator ----------------------------------------------------------------------
// Full cartesian product over a {dimension: [values]} spec. Each value is a PARTIAL snapshot
// that is merged over the base, so one dimension can move several correlated fields at once
// (armour worn + armour in the pack; hp + food) without multiplying the space with states that
// cannot physically occur.
const BASE = {
  hp: 20, food: 20, vitalsKnown: true, packFoodPts: 0, packArmorPieces: 0,
  armorPieces: 4, underArmored: false,
  threatDist: null, creeperDist: null, isNight: false, nightStuck: false,
  drowning: false, onFire: false, inLava: false,
  graves: [], homeDist: null, homeReachable: false, bankFoodPts: 0, bankArmorPieces: 0,
  bankHasPick: false, bankHasSword: false,
  farm: { exists: false }, orchard: {}, tools: { pick: true, sword: true },
  gearupBackoffUntil: 0, deathsRecent: 0, debt: null,
  activeJob: null, brainJobPending: false, persistedBuild: false, maintainNeeded: false,
  postDeathRecovery: false, spawnAnchored: true, spawnSuspect: false
}
function * product (spec) {
  const keys = Object.keys(spec)
  const idx = new Array(keys.length).fill(0)
  for (;;) {
    const s = Object.assign({}, BASE)
    for (let i = 0; i < keys.length; i++) Object.assign(s, spec[keys[i]][idx[i]])
    yield s
    let i = keys.length - 1
    while (i >= 0 && ++idx[i] >= spec[keys[i]].length) { idx[i] = 0; i-- }
    if (i < 0) return
  }
}
function sizeOf (spec) { return Object.values(spec).reduce((n, v) => n * v.length, 1) }

// Dimensions the RECOVERY LADDER reads (scheduler.recoveryPlan + rungFeasible). Vitals, armour,
// the hour, home, graves, owned supply, the bank, tools, the death ratchet, pack food.
const LADDER_DIMS = {
  vitals: [{ hp: 20, food: 20 }, { hp: 5, food: 5 }, { hp: 2, food: 0 }, { hp: 20, food: 5 }],
  armor: [{ armorPieces: 4, underArmored: false }, { armorPieces: 0, underArmored: true },
    { armorPieces: 0, underArmored: true, packArmorPieces: 2 }],
  hour: [{ isNight: false }, { isNight: true }, { isNight: true, nightStuck: true }],
  home: [{ homeDist: null, homeReachable: false }, { homeDist: 4, homeReachable: true }, { homeDist: 300, homeReachable: false }],
  graves: [{ graves: [] }, { graves: [{ dist: 8, value: 40, dangerous: false, hasGear: true }] },
    { graves: [{ dist: 80, value: 40, dangerous: false, hasGear: true, tier: 'urgent' }] }],
  supply: [{}, { farm: { exists: true } }, { orchard: { dist: 40 } }, { farm: { exists: true }, orchard: { dist: 40 } }],
  bank: [{}, { bankArmorPieces: 4, bankHasPick: true, bankHasSword: true, bankFoodPts: 10 }],
  tools: [{ tools: { pick: true, sword: true } }, { tools: { pick: false, sword: false } }],
  deaths: [{ deathsRecent: 0 }, { deathsRecent: 3 }],
  packFood: [{ packFoodPts: 0 }, { packFoodPts: 3 }]
}

// Dimensions the CHOOSERS read (scheduler.pickJob + scheduler-core.chooseActivity). Same
// survival surface plus the acute-danger axis (which routes through needProducer) and the
// progress/maintain era the chooser weighs against it.
const CHOOSER_DIMS = {
  // 10 and 8 are deliberate: they raise a CLEAN 'food'/'heal' need without also tripping
  // isDegraded (hp<=6 / food<=6), which is the only way the single-producer path (secureFood /
  // recoverHp) is reachable at all - every worse value routes to the ladder instead.
  vitals: [{ hp: 20, food: 20 }, { hp: 5, food: 5 }, { hp: 2, food: 0 }, { hp: 20, food: 5 }, { hp: 20, food: 10 }, { hp: 8, food: 20 }],
  danger: [{}, { inLava: true }, { onFire: true }, { drowning: true }, { threatDist: 3 }, { creeperDist: 5 }],
  armor: [{ armorPieces: 4, underArmored: false }, { armorPieces: 0, underArmored: true }],
  hour: [{ isNight: false }, { isNight: true }, { isNight: true, nightStuck: true }],
  home: [{ homeDist: null }, { homeDist: 4, homeReachable: true }, { homeDist: 300 }],
  graves: [{ graves: [] }, { graves: [{ dist: 8, value: 40, dangerous: false, hasGear: true }] }],
  era: [{}, { persistedBuild: true }, { brainJobPending: true }, { activeJob: { name: 'autobuild', cls: 'progress' } }],
  maintain: [{}, { maintainNeeded: true }],
  debt: [{}, { debt: { n: 12, value: 90, best: { dist: 20, n: 4, kind: 'dirt' } } }],
  deaths: [{ deathsRecent: 0 }, { deathsRecent: 3 }],
  death: [{}, { postDeathRecovery: true, spawnAnchored: false, spawnSuspect: true }],
  tools: [{ tools: { pick: true, sword: true } }, { tools: { pick: false, sword: false } }]
}

// The env configurations every enumeration runs under. `null` clears an ambient override so the
// DEFAULT is genuinely exercised; the second row is the live dev/prod ambient; the third is the
// documented rollback. The contract must hold in all of them - a capability that is only
// reachable under one flag setting is exactly the hole this file exists to close.
const ENV_MATRIX = [
  { label: 'defaults (ambient cleared)', env: { GRAVE_NEAR_LADDER: null, GRAVE_URGENT_DIST: null, RESILIENT_RECOVERY: null, DEGRADED_GRAVE_REACHABLE: null, DEATH_RATCHET_DAY_RELEASE: null, LADDER_REARM_REAL: null } },
  { label: 'live ambient (GRAVE_NEAR_LADDER=96)', env: { GRAVE_NEAR_LADDER: '96', GRAVE_URGENT_DIST: null, RESILIENT_RECOVERY: null, DEGRADED_GRAVE_REACHABLE: null, DEATH_RATCHET_DAY_RELEASE: null, LADDER_REARM_REAL: null } },
  { label: 'RESILIENT_RECOVERY=0 rollback', env: { GRAVE_NEAR_LADDER: null, GRAVE_URGENT_DIST: null, RESILIENT_RECOVERY: '0', DEGRADED_GRAVE_REACHABLE: null, DEATH_RATCHET_DAY_RELEASE: null, LADDER_REARM_REAL: null } }
]

// ============ ITEM 1 - every action recoveryPlan can PLAN has a producer ==================
// The orchard rung was planned from S5 onward and never had an executor, so the ladder skipped
// it on every pass. deathlooptest.js pins that with three hand-written snapshots; this
// generalises it to the whole space, in both directions, under every flag configuration.
const plannedActions = new Set()
t('ITEM 1: every action recoveryPlan can PLAN has an executor that can RUN it', () => {
  let n = 0
  for (const cfg of ENV_MATRIX) {
    withEnv(cfg.env, () => {
      for (const s of product(LADDER_DIMS)) {
        n++
        const plan = S.recoveryPlan(s)
        assert(plan.length > 0, 'recoveryPlan must be TOTAL - it returned an empty plan for ' + JSON.stringify(s))
        for (const r of plan) {
          plannedActions.add(r.action)
          assert(caps.rungAction(r.action), `recoveryPlan can plan "${r.action}" but it is not in the capability registry (${cfg.label})`)
          assert(RUNG_EXECUTORS[r.action], `recoveryPlan can plan "${r.action}" but nothing can execute it (${cfg.label})`)
        }
      }
    })
  }
  assert(n === sizeOf(LADDER_DIMS) * ENV_MATRIX.length, 'the enumeration must be exhaustive, not sampled')
  assert(plannedActions.size >= 11, 'the spread must actually reach the whole ladder - only saw ' + [...plannedActions].join(', '))
})

t('ITEM 1 (converse): every registered rung action has an executor, and every executor is registered', () => {
  for (const a of caps.rungActionNames()) {
    assert(RUNG_EXECUTORS[a], `the registry declares rung action "${a}" but provision-recovery has no executor for it`)
  }
  for (const a of Object.keys(RUNG_EXECUTORS)) {
    assert(caps.rungAction(a), `provision-recovery has an executor for "${a}" that no planner can ever name - it is unreachable`)
  }
})

t('ITEM 1 (reach): the enumeration actually plans every registered action - none is dead data', () => {
  for (const a of caps.rungActionNames()) {
    assert(plannedActions.has(a), `"${a}" is registered and executable but NO snapshot in the whole space plans it - it is unreachable in practice`)
  }
})

t('ITEM 1 (one rule): "which actions set out" has ONE definition', () => {
  // OUTBOUND_RE is derived from the registry's `outbound` flag. Pin that it still governs the
  // three treks and nothing else - this rule is the most load-bearing survival rule in the
  // codebase and a second hand-written copy of it cost 20 deaths in one session.
  for (const a of caps.rungActionNames()) {
    assert.strictEqual(S.OUTBOUND_RE.test(a), caps.isOutboundAction(a), `outbound disagreement on "${a}"`)
  }
  const outbound = caps.rungActionNames().filter(a => caps.isOutboundAction(a)).sort()
  assert.deepStrictEqual(outbound, ['secureFood(hunt->fish->scout)', 'trekFarm+tend+harvest+courierHome', 'trekOrchard+harvest+courierHome'])
  assert(/scheduler\.isOutboundAction|scheduler\.OUTBOUND_RE/.test(srcOf('provision-recovery.js')), 'the ladder asks the shared definition, it does not re-derive one')
})

// ============ ITEM 2 - every job a chooser can RETURN has a dispatch branch ===============
// The tick used to be an if/else chain ending in a bare `return`. Both choosers can return
// 'flee' - reflex-owned, deliberately not dispatched - and that fell into the same bare return
// as a genuinely unwired job, so the deliberate no-op and the wiring bug were indistinguishable.
const SURVIVAL_BRANCHES = ['graveSweep', 'secureFood', 'recoverHp', 'nightShelter', 'recoveryLadder', 'homecoming', 'flee']
const NON_SURVIVAL_BRANCHES = ['maintenancePass', 'reclaim']
// Jobs the tick handles by NOT dispatching a survival executor: the build/resume/brain tail owns
// them (they are progress-class, so the tick's `pick.cls !== 'survival'` arm already returns).
const TAIL_JOBS = ['build', 'brainJob', 'autobuild', null]

t('ITEM 2: every job the choosers can RETURN has a dispatch branch in the tick', () => {
  const jobs = new Map() // job -> class
  let n = 0
  for (const cfg of ENV_MATRIX) {
    withEnv(cfg.env, () => {
      for (const s of product(CHOOSER_DIMS)) {
        n++
        const p1 = S.pickJob(s)
        if (p1) jobs.set(p1.job, p1.cls)
        const p2 = core.chooseActivity(s, {})
        if (p2) jobs.set(p2.job, p2.cls)
        // ...and with every candidate refused, which is the path FIX 4 opened and the one most
        // likely to surface a job nothing else does.
        const refused = new Map([['recoveryLadder', 'x'], ['graveSweep', 'x'], ['nightShelter', 'x'], ['maintenancePass', 'x'], ['build', 'x'], ['homecoming', 'x'], ['reclaim', 'x'], ['secureFood', 'x'], ['recoverHp', 'x']])
        const p3 = core.chooseActivity(s, { refused })
        if (p3) jobs.set(p3.job, p3.cls)
      }
    })
  }
  assert(n === sizeOf(CHOOSER_DIMS) * ENV_MATRIX.length, 'the enumeration must be exhaustive, not sampled')
  const src = srcOf('index.js')
  const unhandled = []
  for (const [job, cls] of jobs) {
    if (TAIL_JOBS.includes(job)) continue
    if (cls === 'survival') {
      if (!new RegExp("pick\\.job === '" + job + "'").test(src)) unhandled.push(job + ' (survival)')
    } else if (!NON_SURVIVAL_BRANCHES.includes(job) && !new RegExp("pick\\.job === '" + job + "'").test(src)) {
      unhandled.push(job + ' (' + cls + ')')
    }
  }
  assert.deepStrictEqual(unhandled, [], 'jobs a chooser can return with nothing in the tick to run them: ' + unhandled.join(', '))
  // and the spread must actually reach the interesting ones, or the assertion above proves nothing
  for (const j of ['recoveryLadder', 'nightShelter', 'homecoming', 'flee', 'maintenancePass', 'reclaim', 'graveSweep', 'secureFood', 'recoverHp']) {
    assert(jobs.has(j), `the chooser spread never produced "${j}" - widen the dimensions or this test is vacuous`)
  }
})

t('ITEM 2 (loud): an unhandled pick is a logged wiring bug, never a silent return', () => {
  const src = srcOf('index.js')
  assert(/has NO executor - nothing dispatched \(this is a wiring bug, not a decision\)/.test(src), 'the executor-resolution miss is loud')
  assert(/has NO branch for it - nothing dispatched \(this is a wiring bug, not a decision\)/.test(src), 'the job-name miss is loud')
  assert(!/\}\s*else return \/\/ unknown survival job name - do nothing/.test(src), 'the bare `else return` is gone')
  assert(/flee is REFLEX-owned/.test(src), 'the one job the tick deliberately does not run says so by name')
})

// ============ ITEM 3 - every NEED_PRODUCERS producer exists ===============================
t('ITEM 3: every need names a producer that is a real job class member or a named reflex owner', () => {
  const members = new Set(Object.values(S.JOB_CLASSES).flatMap(c => c.members))
  const reflex = new Set(S.REFLEX_OWNED)
  const orphans = []
  for (const need of Object.keys(S.NEED_PRODUCERS)) {
    const prod = S.needProducer(need)
    assert(prod, `need "${need}" is in NEED_PRODUCERS but needProducer returns nothing for it`)
    if (!members.has(prod) && !reflex.has(prod)) orphans.push(need + ' -> ' + prod)
  }
  assert.deepStrictEqual(orphans, [], 'needs whose named producer is neither a job nor a declared reflex: ' + orphans.join(', '))
})

t('ITEM 3 (converse): every need the survival authority can RAISE has a producer', () => {
  // arbiter.jobSurvivalNeed is the single need authority. Enumerate what it can actually return
  // and assert the map covers it - the other direction (a producer for a need nothing raises) is
  // documentation, but a need with NO producer is a bot that decides and then stands still.
  const arbiter = require('./arbiter.js')
  const raised = new Set()
  for (const cfg of ENV_MATRIX) {
    withEnv(cfg.env, () => {
      for (const s of product(CHOOSER_DIMS)) {
        const n = arbiter.jobSurvivalNeed(s)
        if (n && n.need) raised.add(n.need)
      }
    })
  }
  assert(raised.size >= 6, 'the spread must raise a real variety of needs - only saw ' + [...raised].join(', '))
  for (const need of raised) {
    assert(S.needProducer(need), `the arbiter can raise need "${need}" and NEED_PRODUCERS has no producer for it`)
  }
})

t('ITEM 3 (reflex owners are named, not implicit)', () => {
  assert(S.REFLEX_OWNED.length > 0, 'a reflex-owned producer must be declared, not inferred from a comment')
  for (const p of S.REFLEX_OWNED) {
    assert(Object.values(S.NEED_PRODUCERS).includes(p), `"${p}" is declared reflex-owned but no need names it - dead declaration`)
  }
})

// ============ the registry's own shape ====================================================
t('REGISTRY: every producer entry is well-formed and its views are faithful', () => {
  for (const item of caps.producedItems()) {
    const e = caps.producerFor(item)
    assert(e && e.via, item + ' has no producer kind')
    if (e.via === 'gather') {
      assert(Array.isArray(e.blocks) && e.blocks.length, item + ': a gather must name the blocks to mine')
      assert.deepStrictEqual(caps.GATHER_SOURCES[item], e.blocks, item + ': GATHER_SOURCES view drifted')
      assert.strictEqual(caps.GATHER_TOOL[item] || null, e.tool || null, item + ': GATHER_TOOL view drifted')
    } else if (e.via === 'smelt') {
      assert(e.input, item + ': a smelt must name its input')
      assert.strictEqual(caps.SMELT_MAP[item], e.input, item + ': SMELT_MAP view drifted')
    } else if (e.via === 'strip') {
      assert(e.input && e.tool, item + ': a strip must name its input log and the axe it needs')
      assert.strictEqual(caps.STRIP_MAP[item], e.input, item + ': STRIP_MAP view drifted')
    } else if (e.via === 'hunt') {
      assert(e.entity instanceof RegExp && e.drop instanceof RegExp, item + ': a hunt must name the mob and the drop as regexes')
      assert(Array.isArray(e.types) && e.types.length, item + ': a hunt must name the entity types to scan')
      assert(e.label, item + ': a hunt must name the mob in words, for the log line')
      assert(e.maxKills > 0, item + ': a hunt must be BOUNDED - an unbounded chase is a wandering side-quest')
      assert(e.drop.test(item) || e.family, item + ': the drop regex must match the item, or the entry must declare the family it really produces')
      assert.strictEqual(caps.HUNT_SOURCES[item], e, item + ': HUNT_SOURCES view drifted')
    } else assert.fail(item + ': unknown producer kind ' + e.via)
  }
  // and no view carries a key the registry does not
  for (const [view, name] of [[caps.GATHER_SOURCES, 'GATHER_SOURCES'], [caps.SMELT_MAP, 'SMELT_MAP'], [caps.STRIP_MAP, 'STRIP_MAP'], [caps.GATHER_TOOL, 'GATHER_TOOL'], [caps.HUNT_SOURCES, 'HUNT_SOURCES']]) {
    for (const k of Object.keys(view)) assert(caps.producerFor(k), name + ' has a key "' + k + '" with no registry entry')
  }
})

t('REGISTRY: provision.js reads the registry rather than owning a second copy of it', () => {
  const src = srcOf('provision.js')
  assert(/require\('\.\/capabilities\.js'\)/.test(src), 'provision.js must source the tables from the registry')
  assert(!/^const GATHER_SOURCES = \{$/m.test(src), 'the hand-maintained GATHER_SOURCES literal is gone')
  assert(!/^const SMELT_MAP = \{$/m.test(src), 'the hand-maintained SMELT_MAP literal is gone')
  const provision = require('./provision.js')
  assert.strictEqual(provision.GATHER_SOURCES, caps.GATHER_SOURCES, 'provision re-exports the SAME object, not a copy')
  assert.strictEqual(provision.SMELT_MAP, caps.SMELT_MAP)
  assert.strictEqual(provision.STRIP_MAP, caps.STRIP_MAP)
  assert.strictEqual(provision.GATHER_TOOL, caps.GATHER_TOOL)
})

// ============ ITEM 4 - every item any planner can REQUEST resolves, or says it cannot =====
// The whole point, stated as one rule: a plan may never lose a material silently. For every
// BOM the bot can actually be handed, planProvision must account for every requested item -
// it is produced by a task, it is already held, or it is named in `unobtainable`. Silence is
// the failure mode; "unobtainable" is a perfectly good answer.
//
// The BOMs are read from the REAL schematics on disk and derived from the REAL tool/armour
// tree rather than copied into this file, so the test tracks what the bot can be asked to
// build instead of a stale snapshot of it.
const MC_VERSION = process.env.MC_DATA_VERSION || '1.21.11'
const mcData = require('minecraft-data')(MC_VERSION)
const provision = require('./provision.js')

const TOOL_TREE = {}
for (const mat of ['wooden', 'stone', 'iron']) for (const kind of ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']) TOOL_TREE[mat + '_' + kind] = 1
const ARMOUR_TREE = {}
for (const mat of ['leather', 'iron']) for (const slot of ['helmet', 'chestplate', 'leggings', 'boots']) ARMOUR_TREE[mat + '_' + slot] = 1
// What the bot provisions for itself outside a schematic: the spawn anchor, the bank, the
// farm, the kitchen, light, and the fishing kit. Every one of these has stranded live at
// least once for want of a producer.
const SURVIVAL_BOMS = {
  bed: { white_bed: 1 },
  bank: { chest: 2, crafting_table: 1, furnace: 1 },
  farm: { wooden_hoe: 1, wheat_seeds: 3, water_bucket: 1 },
  light: { torch: 16 },
  fishing: { fishing_rod: 1 },
  toolTree: TOOL_TREE,
  armourTree: ARMOUR_TREE
}

// items a task in the plan actually PRODUCES
function producedBy (plan) {
  const out = new Set()
  for (const task of plan.tasks) out.add(task.item || task.output)
  return out
}
function unaccounted (plan, bom, inventory) {
  const produced = producedBy(plan)
  return Object.keys(bom).filter(n => !produced.has(n) && !((inventory || {})[n] > 0) && !plan.unobtainable[n])
}

async function schematicBoms () {
  const { Schematic } = require('prismarine-schematic')
  const { Vec3 } = require('vec3')
  const dir = path.join(__dirname, 'schematics')
  const out = {}
  const unreadable = []
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.schem'))) {
    try {
      const s = await Schematic.read(fs.readFileSync(path.join(dir, f)), MC_VERSION)
      const bom = {}
      for (let y = 0; y < s.size.y; y++) for (let z = 0; z < s.size.z; z++) for (let x = 0; x < s.size.x; x++) {
        const b = s.getBlock(new Vec3(x, y, z))
        if (!b || b.name === 'air') continue
        bom[b.name] = (bom[b.name] || 0) + 1
      }
      if (Object.keys(bom).length) out[f.replace(/\.schem$/, '')] = bom
    } catch (e) { unreadable.push(f + ' (' + e.message + ')') }
  }
  return { out, unreadable }
}

async function item4 () {
  const { out: schems, unreadable } = await schematicBoms()
  // A schematic this test could not read is NOT quietly skipped - an unread BOM is an unchecked
  // BOM, and pretending otherwise is the same silence this file exists to kill.
  if (unreadable.length) console.log('NOTE  ' + unreadable.length + ' schematic(s) unreadable and therefore UNCHECKED: ' + unreadable.join(', '))

  t('ITEM 4: the real schematics on disk are readable and include the big ones', () => {
    for (const n of ['castle', 'hut']) assert(schems[n], `schematics/${n}.schem must load - it is a BOM the bot is actually handed`)
  })

  const ALL = Object.assign({}, SURVIVAL_BOMS, schems)
  t('ITEM 4: every item any planner can request is produced, held, or explicitly unobtainable', () => {
    const lost = []
    for (const [label, bom] of Object.entries(ALL)) {
      const plan = provision.planProvision(mcData, bom, {})
      for (const n of unaccounted(plan, bom, {})) lost.push(label + ':' + n)
      // and the plan must be internally honest: every task input it names is itself planned
      for (const s of plan.smelts) {
        if (!producedBy(plan).has(s.input) && !plan.unobtainable[s.input]) lost.push(label + ':' + s.input + ' (smelt input)')
      }
      for (const s of plan.strips) {
        if (!producedBy(plan).has(s.input) && !plan.unobtainable[s.input]) lost.push(label + ':' + s.input + ' (strip input)')
      }
    }
    assert.deepStrictEqual(lost, [], 'items a plan neither produces nor reports as unobtainable: ' + lost.join(', '))
  })

  t('ITEM 4: "unobtainable" is data the caller can act on, not a swallowed silence', () => {
    // A genuinely impossible material must come back NAMED and COUNTED. diamond is the honest
    // example: the bot has no diamond-mining capability, so a diamond pickaxe is unobtainable -
    // and it says so, with the number, instead of emitting a plan that cannot work.
    const plan = provision.planProvision(mcData, { diamond_pickaxe: 1 }, {})
    assert(plan.unobtainable.diamond > 0, 'an impossible material is named and counted')
    const src = srcOf('commands.js')
    assert(/unobtainable/.test(src), 'and a caller actually reads it')
  })

  t('ITEM 4: a from-nothing BED is planned as a sheep hunt, not a dye chain', () => {
    // This is AUDIT FIX 16's defect stated as a contract. Before the `hunt` producer existed the
    // live plan was: lapis_block > lapis_lazuli > blue_dye > blue_wool > black_dye > black_wool >
    // bone_block > bone_meal > white_dye > white_wool - re-dyeing wool the bot did not own, in a
    // field of sheep - and then "acquire white_bed: not craftable from holdings". No bed ever,
    // therefore no spawn anchor ever.
    const plan = provision.planProvision(mcData, { white_bed: 1 }, {})
    const kinds = plan.tasks.map(t2 => t2.type + ':' + (t2.item || t2.output))
    assert(kinds.includes('hunt:white_wool'), 'the wool comes off a sheep: ' + kinds.join(' > '))
    assert(!kinds.some(k => /_dye$/.test(k)), 'and nothing in the plan re-dyes wool we do not have: ' + kinds.join(' > '))
    assert.deepStrictEqual(plan.unobtainable, {}, 'a bed is obtainable from nothing')
  })

  t('ITEM 4: EVERY wood the bot can stand in front of can be chopped', () => {
    // detectWood scans nine wood families and returns whichever is actually growing nearby as
    // the plan's primaryWood - every generic wood need (planks, sticks, tools, fuel, charcoal)
    // then resolves through it. pale_oak was in detectWood's list and in STRIP_MAP but NOT in
    // GATHER_SOURCES, so a bot in a pale-oak grove planned a whole build out of a log with no
    // producer and stranded every line of it as unobtainable. Three hand-kept lists that had to
    // agree and did not - the exact defect this registry exists to end.
    const detectSrc = srcOf('provision.js')
    const m = detectSrc.match(/const woods = \[([^\]]+)\]/)
    assert(m, 'detectWood must still declare the woods it scans for')
    const scanned = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
    for (const w of scanned) {
      assert(caps.GATHER_SOURCES[w + '_log'], `detectWood can pick "${w}" as the primary wood and ${w}_log has no producer`)
      assert(caps.STRIP_MAP['stripped_' + w + '_log'], `${w} is scanned for but stripped_${w}_log is not registered`)
    }
    // and the registry keeps ONE wood list: every wood it knows is both choppable and strippable
    for (const w of caps.WOODS) {
      assert(caps.GATHER_SOURCES[w + '_log'], w + ' is a registered wood with no gather producer')
      assert(caps.STRIP_MAP['stripped_' + w + '_log'], w + ' is a registered wood with no strip producer')
    }
    assert.deepStrictEqual(scanned.sort(), [...caps.WOODS].sort(), 'detectWood and the registry must scan the SAME nine woods')
  })

  t('ITEM 4: every registry producer names an item this Minecraft version actually has', () => {
    // A producer for an item that does not exist is unreachable in the other direction, and it
    // would resolve to a gather with zero block ids that spins and finds nothing.
    const missing = []
    for (const item of caps.producedItems()) {
      if (!mcData.itemsByName[item] && !mcData.blocksByName[item]) missing.push(item)
      const e = caps.producerFor(item)
      if (e.via === 'gather') for (const b of e.blocks) if (!mcData.blocksByName[b]) missing.push(item + ' <- block ' + b)
      if (e.via === 'smelt' && !mcData.itemsByName[e.input] && !mcData.blocksByName[e.input]) missing.push(item + ' <- smelt input ' + e.input)
      if (e.via === 'strip' && !mcData.blocksByName[e.input]) missing.push(item + ' <- strip input ' + e.input)
    }
    assert.deepStrictEqual(missing, [], 'registry entries with no counterpart in ' + MC_VERSION + ': ' + missing.join(', '))
  })

  // ============ THE SILENT SKIPS ARE GONE ================================================
  // Five sites turned a missing capability into nothing at all. With the contract above green
  // they are unreachable; if one is ever reached anyway, it must SAY so (DESIGN-PRINCIPLES §5
  // and §7: a decision that produces no action logs why, at the time).
  t('SILENT SKIPS: the recovery ladder shouts when a planned rung has no executor', () => {
    const src = srcOf('provision-recovery.js')
    assert(/WIRING BUG: rung .* was planned and has NO executor/.test(src), 'the skip is loud')
    assert(!/continue \/\/ no executor \(e\.g\. trekOrchard\) - skip, never binds/.test(src), 'the silent `continue` is gone')
  })
  t('SILENT SKIPS: "I don\'t know how to gather X" is replaced by the registry\'s real answer', () => {
    const gsrc = srcOf('provision.js')
    assert(!/don't know how to gather \$\{item\}/.test(gsrc), 'the flat refusal is gone')
    assert(/no producer for \$\{item\} in the capability registry/.test(gsrc), 'and the honest one names the registry')
    const csrc = srcOf('commands.js')
    // Match the RETURNED STRING, not the words: #115b cost five green tests on a clean checkout
    // because the source-pins were grepping their own tombstone comments.
    assert(!/return `I don't know how to gather/.test(csrc), 'the gather command no longer refuses from a hand-kept list')
    assert(/caps\.producerFor\(item\)/.test(csrc), 'it asks the registry')
    assert(/caps\.HUNT_SOURCES/.test(csrc), 'so `gather white_wool` is accepted, standing in a field of sheep')
  })
  t('SILENT SKIPS: runGather ROUTES by producer instead of assuming everything is mined', () => {
    const src = srcOf('provision.js')
    assert(/if \(cap && cap\.via === 'hunt'\)/.test(src), 'a mob drop goes to the hunt driver')
    assert(/type === 'hunt'/.test(src), 'and runPlan can execute a planned hunt')
  })
  t('SILENT SKIPS: acquireBed no longer hand-wires the one material somebody noticed', () => {
    const src = srcOf('provision-hut.js')
    assert(!/gatherWool/.test(src), 'the wool bolt-on is gone - wool is a registry producer like anything else')
    assert(/holdings changed during the attempt/.test(src), 'and the retry is CONDITIONED on holdings actually moving, not on the material being wool')
    assert(/planOpts, gather: true/.test(src), 'and the bootstrap caller is allowed to GATHER - a bot with nothing has no bank to withdraw from')
  })
  t('SILENT SKIPS: gatherWool the hand-written one-off is deleted, not merely unused', () => {
    assert(!provision.gatherWool, 'a named wrapper with no caller is the shape this registry exists to prevent')
    assert(typeof provision.huntForDrop === 'function', 'and the one generic driver took its place')
    const src = srcOf('provision-food.js')
    const chases = (src.match(/new goals\.GoalFollow\(tgt, 2\)/g) || []).length
    assert(chases <= 2, 'the mob-chase loop must not be copy-pasted per animal again (found ' + chases + ' copies)')
  })

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall capability contract tests passed')
  process.exit(fails ? 1 : 0)
}

item4().catch(e => { console.log('FAIL  ITEM 4 harness threw\n      ' + e.stack); process.exit(1) })
