# DESIGN S3: pure `bot/scheduler.js` + `bot/maintain.js` (decision modules + offline tests)

Status: design for implementation. Slice **S3** of `REDESIGN-proactive-survival.md`
(§3.2, §3.3, §4.1, §5, §6, §7, §9). **Zero live risk: this slice adds FOUR NEW files and
MODIFIES NO EXISTING FILE.** Pure decision functions + their offline unit tests only. No
wiring into `index.js`/`provision.js`/`commands.js` — that is S4+.

Flags: the two modules read their thresholds from env (documented per-constant below) but
have no master on/off of their own — they are dormant until S4 calls them. The redesign's
`SCHEDULER=0` / `MAINTAIN=0` kill-switches live at the S4 *call sites*, not here.

New files (all four, nothing else):
- `bot/scheduler.js` — pure, ~250 lines. Style-mirror of `bot/arbiter.js`.
- `bot/schedulertest.js` — `t(name, fn)` + `assert` harness (mirrors `bot/arbitertest.js`).
- `bot/maintain.js` — pure buffer model, ~90 lines.
- `bot/maintaintest.js` — same harness.

All existing-code line numbers are as of the current working tree (HEAD `d60c95e`; the
REDESIGN doc was written against `f0696d4`, so every reused symbol below has been
re-grounded against HEAD). The purpose of grounding them here is so the **S4** builder can
wire each pure input to a real producer — S3 itself touches none of them.

---

## 0. Grounding: the real symbols these pure modules will be fed in S4

These are NOT called by S3 (the modules are pure — plain data in, decision out). They are
listed so (a) the snapshot field spec below is honest about where each value comes from, and
(b) the S4 builder wires `provision.schedulerState(bot)` to real producers. Confirmed at
HEAD:

| snapshot field / concept | real producer (S4 wires this) | current location |
|---|---|---|
| survival authority (`jobSurvivalNeed`) | `arbiter.jobSurvivalNeed(state, opts)` | `arbiter.js:119`; wrapped by `provision.survivalNeed(bot)` at `provision.js:3844`, `mayDoProgress` at `provision.js:3851` |
| survival snapshot builder to extend | `provision.survivalState(bot)` | `provision.js:3791` (schedulerState = its superset, §3.2) |
| food-points classifier | `foodTier(name)` (0 ready / 1 raw / 2 bad) | `food.js:27`, exported `food.js:105`; already reused in `resources.js:377,403` and `provision.js:3996` |
| armor pieces worn (0–4) | `provision.armorPieceCount(bot)` | `provision.js:1925` |
| under-armored boolean | `provision.underArmored(bot)` | `provision.js:1919` |
| home anchor (XZ) | `provision.hutAnchor()` (else `knownBed()` `provision.js:3013`) | `provision.js:2625` |
| bank food points (CACHED) | `resources.totalCounts(bot, { cachedOnly:true, near, maxDist })` then sum `foodsByName[n].foodPoints * c` | `resources.js:149`; live example of the sum at `provision.js:4039-4042` |
| standing farm exists | `provision.hasStandingFarm()` | `provision.js:3674` |
| orchard `harvestReadyAt` | `loadWorldMem().orchard` | written `provision.js:4626`, renewed `provision.js:5189` |
| gearup back-off `until` | `provision.gearupState()` → `{ fails, until }` | `provision.js:2990`; back-off written by `gearupResult` `provision.js:2991`; banked-iron bypass `planner.js:469-483` |
| graves snapshot source | `commands` death ledger + `commands.worthwhileGrave()` / a new `commands.gravesSnapshot()` (S4 adds the plural exporter) | ledger `commands.js:65`; `bestGrave` `commands.js:116`; `worthwhileGrave()` `commands.js:125`; `graveWorthIt` `commands.js:108`; `shouldChaseGrave` `commands.js:133` |
| GRAVE_NEAR constant | `Number(process.env.GRAVE_NEAR || 16)` | used at `commands.js:152`, `index.js:1579` |
| night / nightStuck | `provision.isNight` `provision.js:1930`, `provision.nightStuck` `provision.js:1952` |
| drowning / inLava | in `survivalState` already (`provision.js:3827/3835`) |
| preempt latch | `commands.preemptForSurvival()` (sets `buildAbort`) | `commands.js:46`; build resumes via `persistedResume` |
| the busy-gate this replaces | the `bodyBusy && !readOnly` block + `survivalAdmissible(bot)` | `index.js:1573-1676` (regex whitelist `index.js:1645`) |

**GRAVES-SNAPSHOT SOURCE (called out explicitly per the deliverable):** the death ledger is
`deathLedger` in `commands.js:65`, persisted by `persistDeath()` (`commands.js:66`). Today
`commands.js` exposes `worthwhileGrave()` (singular richest grave, `commands.js:125`) and
`shouldChaseGrave(...)` (pure gate, `commands.js:133`) — both in the `module.exports` at
`commands.js:3200`. The `graves[]` array the snapshot needs (per-grave
`{dist,value,dangerous,hasGear}`) does NOT exist yet; **S4** adds `commands.gravesSnapshot()`
(REDESIGN §9 commands.js bullet: "Expose `gravesSnapshot()`"). S3's scheduler consumes the
`graves[]` shape as specified below; the test files construct it as plain fixtures.

---

## 1. The design in one paragraph

Two pure modules answer, from a plain-data snapshot, the two questions the broken busy-gate
and the deleted `famineHold` could not: **which one job should own the body now, and is this
incoming command allowed to preempt.** `scheduler.js` classifies the real brain/operator
command vocabulary (`commandClass`), decides survival admissibility that can never be muzzled
by a body latch (`admissible`, invariant I1), picks the single owning job by class-order with
nearby-graves promoted to first-class survival even at food0/hp1 (`pickJob`, I3), maps any
"blocked on X" to the producer of X so there is never a busy-wait (`needProducer`, I2),
returns a TOTAL ordered recovery ladder R0–R5 in which distance only sequences and every hold
names a provable wake (`recoveryPlan`, S6/I5), and gives the danger-scaled forward-progress
verdict (`watchdog`, §6). `maintain.js` is the proactive-buffer model: `needs(snapshot)`
returns the ordered list of unmet buffers (food before gear before torches) with hysteresis
so a `maintain`-class job (which can never preempt `progress`) only fires when a real buffer
is under floor. Both are `require`-only, no bot handle, no fs, no pathfinder, `_setNow` test
seam — exactly the offline-testable shape of `arbiter.js`.

---

## 2. `bot/scheduler.js` — module shape

Mirror `arbiter.js` exactly:
- `'use strict'` header + a comment block explaining the module (like `arbiter.js:1-31`).
- `let dbgSink = null; function setDebugSink(fn)` + a `dbg(...)` gated on
  `process.env.BUILD_DEBUG` (copy `arbiter.js:32-38`).
- `let nowFn = () => Date.now(); function _setNow(fn) { nowFn = fn || (() => Date.now()) }`
  (copy `arbiter.js:44-46`). `watchdog` and any deadline math use `nowFn()` when `now` is not
  passed explicitly (see §2.7).
- Reuse tiers by requiring `arbiter.js` for `PRIORITY` ONLY if convenient; otherwise define
  a local `JOB_CLASSES` (below). **Do not** create a require cycle — `arbiter.js` must not
  require `scheduler.js`. Requiring `arbiter` from `scheduler` is fine (one-way).
- `module.exports = { pickJob, recoveryPlan, commandClass, admissible, needProducer,
  watchdog, JOB_CLASSES, _setNow, setDebugSink, _reset }` (add `_reset` for test hygiene
  even though the module is near-stateless — matches `arbiter.js:214`).

### 2.0 `JOB_CLASSES` (exported constant)

```
JOB_CLASSES = {
  survival: { rank: 3, members: ['recoveryLadder','graveSweep','secureFood','recoverHp','nightShelter'] },
  progress: { rank: 2, members: ['build','gearup','mine','gather','travel'] },
  maintain: { rank: 1, members: ['maintenancePass'] },
  idle:     { rank: 0, members: [] }
}
```
Ranks encode the §3.2 preemption table: `survival` preempts progress/maintain/idle;
`progress` preempts maintain/idle; `maintain` preempts idle only; `idle` preempts nothing.
A helper `classRank(cls)` returns `JOB_CLASSES[cls] ? JOB_CLASSES[cls].rank : -1`.

### 2.1 The snapshot (input to `pickJob`, `admissible`, `recoveryPlan`)

Plain data, all fields optional (absent = "not blocking / unknown"), superset of
`survivalState` (`provision.js:3791`). Enumerated from REDESIGN §3.2, with the consumer of
each field marked **[fn]**:

```js
{
  // vitals — pickJob, admissible, recoveryPlan, watchdog(via vitals arg)
  hp,                 // 0..20        [pickJob, admissible, recoveryPlan]
  food,               // 0..20        [pickJob, admissible, recoveryPlan]
  packFoodPts,        // edible points carried, sum over pack of foodsByName[n].foodPoints
                      //   for n with foodTier(n)<2 (food.js:27)   [pickJob, recoveryPlan]
  armorPieces,        // 0..4, provision.armorPieceCount           [pickJob, recoveryPlan]

  // immediate danger — mirror survivalState; consumed via arbiter.jobSurvivalNeed
  threatDist,         // blocks to nearest MELEE hostile | null    [admissible, pickJob]
  creeperDist,        // blocks to nearest creeper | null          [admissible, pickJob]
  isNight,            // bool                                      [recoveryPlan, pickJob]
  nightStuck,         // bool (frozen/eternal night)               [recoveryPlan]
  drowning,           // bool                                      [pickJob(defer graves), recoveryPlan(R0 outranked)]
  inLava,             // bool                                      [pickJob, recoveryPlan]

  // graves — pickJob (I3), recoveryPlan (R1)
  graves: [ { dist, value, dangerous, hasGear } ],  // per UNRETRIEVED worthwhile grave;
                      // dist = XZ min(botDist, homeDist) blocks; value = graveValue;
                      // dangerous = lava/void grave; hasGear = holds armor/tools/ingots

  // geography — recoveryPlan (R2/R3), pickJob(maintain gating)
  homeDist,           // XZ blocks to hutAnchor (provision.js:2625) | null
  bankFoodPts,        // CACHED chest food points at home (resources.totalCounts cachedOnly)
  farm:   { exists, dist, ripeLikely },   // recoveryPlan R3, maintain
  orchard:{ dist, readyAt },              // recoveryPlan R3, maintain (readyAt ms epoch)

  // progress / history
  gearupBackoffUntil, // ms epoch, provision.gearupState().until   [maintain gearup gating]
  deathsRecent,       // deaths in the last 20 min                 [pickJob, recoveryPlan sequencing]

  // the running job (for pickJob preemption + watchdog handoff)
  activeJob: { name, cls, startedAt, lastProgressAt, blockedOn } | null,
  brainJobPending,    // bool: the brain issued a job that is queued  [pickJob tie-break]
  persistedBuild      // bool: an operator build is saved on disk (commands.persistedResume)
}
```

Notes the builder must honor:
- **`packFoodPts` vs `food`:** `food` is the hunger bar; `packFoodPts` is CARRIED edible
  points (what R0 can consume). Both are needed — a bot at food 3 with packFoodPts 20 is one
  eat away from safe (R0), a bot at food 3 with packFoodPts 0 is not.
- **`graves[].dist` is already min(bot, home)** — the snapshot builder does the
  `Math.min(dBot, dHome)` that `shouldChaseGrave` does at `commands.js:141-145`; the
  scheduler just compares to `GRAVE_NEAR`.
- Absent `graves` ⇒ treat as `[]`. Absent `farm`/`orchard` ⇒ treat as `{ exists:false }` /
  `{}`.

### 2.2 `commandClass(line)` → `'survival' | 'progress' | 'perception' | 'chat'`

PURE string classifier of the REAL command vocabulary. GROUNDED against the `switch (cmd)`
in `commands.js:1045-2204` and the two gate regexes in `index.js` (read-only whitelist
`index.js:1645`; the current hard-coded survival list `index.js:1655`; the "one job at a
time" MOVE list `index.js:1682`). The builder MUST NOT invent commands — this is the true
set. `line` is a raw command line; take the first whitespace token, lowercase it, strip a
leading `!`/`/` if present, and match:

```
perception : state | scan | find | block | entities | inventory | look | turn | lookbehind
             | waypoints | places | help
             (these are the read-only whitelist index.js:1645 + the other non-acting reads;
              they are ALWAYS admissible — never gated)
chat       : say
survival   : recover | getstuff | eat | wear | equip | armor | armour | hold | armorup
             | gearup | planarmor | sleep | wake | wakeup | fish | getfood | securefood
             | feed | huntat | hunt | waterat
             (the moves that resolve a survival need: eat/heal/armor/shelter/food.
              index.js:1655's set — recover|getstuff|eat|wear|armorup|sleep — is the CORE;
              this widens it to the full food/gear/sleep vocabulary that classifies as
              survival for admissibility. armorup/gearup/planarmor are survival-classifiable
              because gearing IS the shelter/heal move for a naked bot — admissible(...) then
              decides if a need actually exists.)
progress   : come | goto | travel | follow | mine | break | dig | collect | pickup | plant
             | place | craft | gather | provision | build | house | wall | tower | schem
             | schematic | autobuild | resumebuild | resume-build | attack | defend | give
             | drop | toss | shove | nudge | stash | unstash | huttidy | tidyhut | cleanhut
             (everything that pursues the goal / moves the body for non-survival reasons;
              the MOVE-list at index.js:1682 — goto|travel|explore|collect|gather|mine|chop|
              dig|follow|come|build — is a subset)
default    : progress   (unknown/blank command -> treat as progress = most-restricted; it
                          will be held by the busy-gate rather than wrongly bypassing it)
```

Return contract: a single string. Provide the classification as data (an ordered list of
`{ re, cls }` the function scans) so the test can assert each real command name maps as
above. Case-insensitive, anchored on the first token (`/^recover\b/i` style, matching how
`index.js:1655` and `commands.js`'s `cmd` extraction work — `cmd` is the first token).

Out of scope for `commandClass` classification (operator-only / cheat commands blocked
before the gate at `index.js:1619`): `setblock|fill|clear|tp|gamemode|clearinv|remember|
savepoint|forget|cancelbuild|abandonbuild`. Classify them `progress` (harmless — they never
reach `commandClass` on the brain path because `CHEAT_CMDS` blocks them first), but note in a
comment that they are not part of the admissibility contract.

### 2.3 `admissible(cmdClass, snapshot)` → `{ allow, reason }`  (invariant I1)

Replaces the busy-gate regex + `survivalAdmissible(bot)` (`index.js:1573`). PURE.

```
perception | chat  -> { allow:true, reason:'read-only/chat always allowed' }
progress           -> { allow:true, reason:'progress admissibility is the busy-gate's job, not survival' }
                      // NOTE: admissible() does NOT re-implement the busy hold. The S4 call
                      // site keeps "progress held while busy / while a persisted build waits"
                      // verbatim (index.js:1682, REDESIGN §3.4). admissible only ADJUDICATES
                      // survival preemption. Returning allow:true here means "no survival
                      // objection"; the busy-gate still applies.
survival           -> allow iff a real survival need exists OR a worthwhile near grave:
   need = arbiter.jobSurvivalNeed(snapshot)      // reuse the ONE authority, arbiter.js:119
   if (need) return { allow:true, reason: need.reason || need.need }
   // near-grave override (I1 / I3): a non-dangerous worthwhile grave within GRAVE_NEAR IS
   // the survival move even with no vitals need (free armor at arm's reach).
   const GRAVE_NEAR = Number(process.env.GRAVE_NEAR || 16)
   if (!snapshot.threatDist-in-melee-range && graves.some(g => !g.dangerous && g.value>0 && g.dist <= GRAVE_NEAR))
       return { allow:true, reason:`grave ${round(dist)}b away - free gear at arm's reach` }
   return { allow:false, reason:'no survival need and no grave in reach - not interrupting the build' }
```

Ground the `jobSurvivalNeed` reuse: it takes the same `survivalState`-shaped object
(`arbiter.js:119`, fields `hp/food/threatDist/creeperDist/drowning/onFire/inLava/isNight/
underArmored/nightStuck`), all present in the snapshot. Pass `snapshot` straight through;
extra fields are ignored by `jobSurvivalNeed`. The "no threat gating" for the grave override
mirrors `survivalAdmissible` at `index.js:1578` (`!st.threat`) and `shouldChaseGrave`'s
`if (threat) defer` (`commands.js:139`) — a melee hostile in range means the grave waits.

Reason strings matter (they surface in `/log` as "PREEMPT (reason)" / "held (reason)" at
`index.js:1658/1663`) — keep them human and greppable.

### 2.4 `pickJob(snapshot)` → `{ job, cls, reason, preempt } | null`  (I3, §3.2, §5 entry)

The single owning-job selector. `null` ⇒ idle (nothing to do). `preempt` is `true` when the
returned job's class rank exceeds `snapshot.activeJob.cls`'s rank (the S4 dispatcher then sets
the victim's stop latch). Ordering (first match wins):

```
1. IMMEDIATE-DANGER / vitals survival need (arbiter authority):
   need = arbiter.jobSurvivalNeed(snapshot)
   if (need):
     map need.need -> job via needProducer (§2.6):
       'food'    -> secureFood        'heal'/'lava'/'fire'/'drowning'/'threat'/'creeper' -> recoverHp/flee-owned
       'shelter' -> nightShelter
     BUT: if the degraded-signature (below) also holds, return recoveryLadder instead of the
     single producer — the ladder sequences R0..R5 and re-plans. (recoveryLadder is the
     survival job for a COMPOUND degraded state; a single clean need -> its single producer.)
     cls='survival', preempt = rank(survival) > rank(activeJob.cls)

2. NEARBY GRAVE as first-class survival (I3) — even at food0/hp1:
   if no active melee threat/flee AND graves.some(g => !g.dangerous && g.value>0 && g.dist<=GRAVE_NEAR):
      return { job:'graveSweep', cls:'survival', reason:`grave ${round}b - free gear, zero trek`, preempt }
   (This sits BELOW the immediate-danger need but ABOVE everything else: at hp1/food0 with a
    grave 3b away, jobSurvivalNeed returns 'heal' -> step 1 would pick recoveryLadder, whose
    R1 IS the grave. The standalone graveSweep here covers the fed-but-naked case where step 1
    is null. Both routes reach the grave; test both.)

3. DEGRADED SIGNATURE -> recovery ladder (§5 opening):
   degraded = hp<=6 || food<=6 || (armorPieces===0 && graves.length>0) || deathsRecent>=2
   if (degraded) return { job:'recoveryLadder', cls:'survival', reason:'degraded - running the ladder', preempt }
   (Reached when step 1's need was null-but-degraded, e.g. armorPieces 0 with graves and food 12.)

4. ACTIVE PROGRESS job continues (single-goal discipline):
   if (activeJob && activeJob.cls==='progress') return { job: activeJob.name, cls:'progress', reason:'continuing', preempt:false }
   if (persistedBuild || brainJobPending) return { job:'build'|'brainJob', cls:'progress', ... }

5. MAINTAIN (only when NO progress job, NO survival need, and buffers unmet):
   // pickJob does not itself call maintain.needs — the S4 tick does and passes a flag; but to
   // keep pickJob total, accept snapshot.maintainNeeded (bool the S4 tick sets from maintain.needs).
   if (snapshot.maintainNeeded) return { job:'maintenancePass', cls:'maintain', reason:'buffers low', preempt:false }
   // maintain NEVER has preempt:true against progress (rank 1 < 2) -> structurally cannot interrupt (§3.2).

6. else return null   // idle
```

Key assertions this encodes (tested): a `maintain` result never carries `preempt:true` over
a `progress` activeJob; a nearby non-dangerous grave yields `survival`-class even at
food0/hp1; the live livelock snapshot (hp1/food0/naked/grave3b/busy=securingFood) returns a
survival job (`recoveryLadder` via step 1, whose R1 is the grave — OR `graveSweep` — the test
asserts the returned cls is `survival` and job ∈ {recoveryLadder, graveSweep}).

### 2.5 `recoveryPlan(snapshot)` → ordered rung list  (§5, S6 totality, I5 named wakes)

Returns a **non-empty** array of `{ rung, action, wake? }` for EVERY snapshot (S6). Each
entry is a plan step the S4 executor (`recoverFromDegraded`) runs first-feasible-then-replan.
Distance NEVER removes a rung — it only orders it. `wake` is present only on hold-type
actions and MUST name a provable condition.

Build the list by appending every rung whose PRECONDITION could ever apply, in R0→R5 order,
then guaranteeing non-emptiness with R5:

```
R0  consume: if packFoodPts>0 OR armorPieces<4-and-carrying-armor
        -> { rung:'R0', action:'eatPack+wearFromPack' }
    (drowning/inLava/threat are reflex-owned and outrank — noted, not a rung here)
R1  graves: for the nearest non-dangerous worthwhile grave with dist <= GRAVE_NEAR_LADDER (32):
        -> { rung:'R1', action:'recoverGrave', graveDist }
    (uses commands.handle('recover') in S4; night+camped hostile handled inside recover ->
     shelter-then-proceed, NOT a plan branch here)
R2  shelter+home cache: if homeDist != null && homeDist <= 48:
        -> { rung:'R2', action:'gotoHome+ensureFood(forceFresh)+cook+eat' }
        if isNight: append { rung:'R2', action:'sleepInBed', wake:'dawn' }   // provable wake
    else if isNight && exposed (no home in range):
        -> { rung:'R2', action:'digInForNight', wake:'dawn' }
R3  owned supply at ANY distance (sequenced AFTER R0-R2):
        if farm && farm.exists -> { rung:'R3', action:'trekFarm+tend+harvest+courierHome' }
        if orchard && orchard.dist!=null -> { rung:'R3', action:'trekOrchard+harvest+courierHome' }
        // distance changes duration, not inclusion (S6 "far supply 200b never disqualified")
R4  acquire new supply:
        -> { rung:'R4', action:'secureFood(hunt->fish->scout)' }   // secureFood steps 3-6, provision.js:4067-4102
R5  the ONLY hold (append ALWAYS, so the list is never empty):
        if nightStuck -> DO NOT hold; instead append { rung:'R5', action:'rerunLadderByNight' }
             (eternal night: waiting is non-terminating — same reasoning as arbiter.js:145-149)
        else if isNight && home/bed reachable -> { rung:'R5', action:'boundedHold:sleep', wake:'dawn', deadlineMs:90000 }
        else -> { rung:'R5', action:'boundedHold:sealPit', wake:'dawn|foodInPack|grave|animal<=24', deadlineMs:90000 }
```

Totality argument to encode as a test (S6): after building, if the array is empty (can only
happen if every earlier precondition was false), R5 still appended — so it is never empty.
Assert across the swept grid. Every `wake` string is one of the provable set:
`dawn | foodInPack | grave | animal<=24`; the test asserts no hold action lacks a `wake` and
no `wake` is outside that set (I5).

**Death-ratchet sequencing** (`deathsRecent >= 2`, §5): does NOT drop R3/R4; it re-orders so
R2 (shelter + spawn/bed re-assert) precedes R3/R4 and marks R3/R4 `dayGated:true`. Implement
as: when `deathsRecent>=2`, ensure the R2 entries are emitted before any R3/R4 entries (they
already are by R-order) AND tag R3/R4 actions with a `dayGated:true` field. Test: with
`deathsRecent:3`, the R2 rung index < R3 rung index, and R3/R4 carry `dayGated`.

`GRAVE_NEAR_LADDER = Number(process.env.GRAVE_NEAR_LADDER || 32)` (the ladder's wider band,
§5 R1) vs `GRAVE_NEAR` (16, the standing `pickJob` rule).

### 2.6 `needProducer(need)` → job name  (I2 producer map, §3.3)

PURE lookup. `need` is a string (`jobSurvivalNeed(...).need`, or a job's `blockedOn` tag).

```
food                 -> 'secureFood'
heal                 -> 'recoverHp'
shelter              -> 'nightShelter'
gear                 -> 'gearup'
iron                 -> 'mine'
wood | planks | tool -> 'acquire'     // resources.acquire chain: withdraw>craft>gather (resources.js:312)
lava|fire|drowning|threat|creeper -> 'flee'   // reflex-owned; the scheduler never schedules these as jobs
default              -> null          // unknown blockedOn -> null (S4 falls to next pickJob)
```

The map is a DAG by construction (I2): `secureFood`→(may block on)→`acquire`; `gearup`→`mine`
→`acquire`. If walking it would revisit a need (food needs a trek, trek needs heal, heal
needs food), that CYCLE is broken by `recoveryPlan` R0 (consume what exists / nearest win /
one bounded dawn-hold) — there is no other wait state. Test (schedulertest case b): given a
snapshot representing the cycle (food low, no pack food, hp low, far from supply), assert
`recoveryPlan(s)[0].rung === 'R0'` OR the plan's first feasible non-hold rung is R0/R1 — i.e.
the cycle resolves to consume/nearest-win, never to an unnamed wait. And assert
`needProducer('food')==='secureFood'`, etc., for the whole table.

### 2.7 `watchdog(activeJob, vitals, now)` → `'ok' | 'nudge' | 'fail-job'`  (§6)

PURE. `activeJob = { startedAt, lastProgressAt, cls, blockedOn, nudged? } | null`.
`vitals = { hp, food }`. `now` optional (defaults to `nowFn()`).

```
if (!activeJob) return 'ok'                       // nothing to watch
const idleMs = now - (activeJob.lastProgressAt || activeJob.startedAt || now)
// danger-scaled windows (§6):
let nudgeMs, failMs
if (vitals.hp <= 6 || vitals.food <= 2)      { nudgeMs=20000;  failMs=40000 }   // critical: seconds
else if (activeJob.cls === 'survival')       { nudgeMs=45000;  failMs=90000 }
else                                         { nudgeMs=120000; failMs=240000 } // patient when cheap
if (idleMs >= failMs) return 'fail-job'
if (idleMs >= nudgeMs) return 'nudge'
return 'ok'
```

Sequencing note (§6 escalation): the FIRST window crossing returns `'nudge'`; a SECOND
consecutive window (idle past `failMs`) returns `'fail-job'`. Because the windows are additive
thresholds on the same `idleMs`, a single call already distinguishes them (nudge at
`[nudgeMs, failMs)`, fail at `>= failMs`). The S4 interval calls this ~every 5s; the
"consecutive" damping (REDESIGN §6: "second consecutive window → fail") is achieved by the
`failMs = 2 × nudgeMs` spacing — a job must sit idle through the whole nudge window AND a
second equal window before failing. Tests assert the exact boundaries at each vitals tier and
that a fresh `lastProgressAt` (idleMs 0) is `'ok'`.

---

## 3. `bot/maintain.js` — the buffer model (§4.1)

PURE. `require`-only, no bot. Exports `{ needs, BUFFERS, _setNow?, _reset }`. No clock needed
unless the builder wants jitter (cadence/jitter is the S4 tick's job, NOT maintain's — keep
maintain a pure "what's under floor" function). `foodTier` for the food measure is REUSED
from `food.js:27` (`require('./food.js').foodTier`) — do NOT reinvent a tier/points helper;
the doc's food-points sum is `Σ foodsByName[n].foodPoints` over pack items with
`foodTier(n) < 2`, computed by the SNAPSHOT builder in S4 and delivered as
`snapshot.packFoodPts` / `snapshot.bankFoodPts`. `maintain.needs` consumes those numbers; it
does not walk inventory.

### 3.1 Buffer constants (env-overridable, §4.1 table)

```
BUFFERS = {
  packFood:  { target: Number(env.MAINT_PACKFOOD_TARGET  || 24), floor: Number(env.MAINT_PACKFOOD_FLOOR  || 12) }, // pts
  bankFood:  { target: Number(env.MAINT_BANKFOOD_TARGET  || 40), floor: Number(env.MAINT_BANKFOOD_FLOOR  || 16) }, // pts
  armor:     { target: 4, floor: 4 },                 // any missing (armorPieces < 4) is under floor
  tools:     { /* pick+axe+sword+spare-pick; any missing -> need */ },
  torches:   { target: Number(env.MAINT_TORCH_TARGET || 8), floor: Number(env.MAINT_TORCH_FLOOR || 4) }
}
```
Tools measure: the snapshot supplies `tools: { pick, axe, sword, sparePick }` booleans (S4
derives from `provision.bestPick` `provision.js:1254` / `miningPicks` `provision.js:1249` and
inventory counts); `maintain` just checks any-false.

### 3.2 `needs(snapshot)` → ordered array of `{ key, deficit, target }`

Ordering: **food before gear before torches** (§4.1). Emit in this fixed order, each only
when under its floor (hysteresis, §3.3 below):

```
1. packFood   if snapshot.packFoodPts < BUFFERS.packFood.floor
2. bankFood   if snapshot.bankFoodPts < BUFFERS.bankFood.floor   (needs home reachable; snapshot.homeReachable)
3. armor      if snapshot.armorPieces < 4
4. tools      if any of snapshot.tools.{pick,axe,sword,sparePick} is false
5. torches    if snapshot.torches < BUFFERS.torches.floor
```
Return `[]` when nothing is under floor (the common fed/armed case — `maintainNeeded` false in
pickJob step 5).

### 3.3 Hysteresis (don't churn)

A buffer that is BEING serviced must not re-trigger until it climbs back to `target`, not just
past `floor`. Since `maintain.needs` is pure/stateless, model hysteresis as a **band**: a
buffer is "needed" when below `floor`, and the S4 pass tops it up to `target` (well above
`floor`), so the next tick sees it satisfied. Encode the band in the test: assert a snapshot
at `floor-1` yields the need, a snapshot at `target` does not, and a snapshot BETWEEN floor
and target (e.g. packFoodPts 18 with floor 12/target 24) does NOT yield the need (it's in the
satisfied band — this is the anti-churn property). This makes the floor/target gap itself the
hysteresis, no state required.

---

## 4. Tests

House style: copy the harness from `arbitertest.js:12-16` verbatim —
```
let failures = 0
function t (name, fn) { S._reset(); S._setNow(() => Date.now()); try { fn(); console.log('PASS  '+name) } catch (e) { failures++; console.log('FAIL  '+name+'\n      '+e.message) } }
```
`require('assert')`, end with `process.exit(failures ? 1 : 0)` (match `routememtest.js` /
`arbitertest.js` tail). Run: `cd bot && node schedulertest.js` / `node maintaintest.js`.
Build small fixture factories (`snap(overrides)` returning a full snapshot with safe
defaults; `grave(dist, {dangerous,value,hasGear})`).

### 4.1 `bot/schedulertest.js` — concrete cases (from §9 list + §7 invariants)

**(a) The live livelock snapshot (the headline fixture).**
`s = snap({ hp:1, food:0, packFoodPts:0, armorPieces:0, graves:[grave(3,{value:30,hasGear:true})], activeJob:{name:'secureFood',cls:'survival'} })`
- `pickJob(s).cls === 'survival'` and `pickJob(s).job` ∈ `{'recoveryLadder','graveSweep'}`.
- `admissible('survival', s).allow === true` (a `recover` command is admitted — the muzzle is
  gone). reason mentions grave or heal.
- `recoveryPlan(s)` contains an `R1` `recoverGrave` rung (the 3b grave), and R0 before it
  only if packFoodPts>0 (here 0, so R0 may be absent — assert R1 present regardless).

**(b) Blocked-on chains resolve to producers; cycle breaks to R0.**
- `needProducer('food')==='secureFood'`, `'heal'->'recoverHp'`, `'shelter'->'nightShelter'`,
  `'gear'->'gearup'`, `'iron'->'mine'`, `'wood'/'planks'/'tool'->'acquire'`, unknown→null.
- Cycle fixture: `snap({ hp:5, food:4, packFoodPts:0, farm:{exists:true,dist:200}, homeDist:200, graves:[] })`
  → `recoveryPlan` first non-hold feasible rung is R0 or (R0 absent → R2/R4); assert the plan
  is non-empty and its ONLY hold rung is R5 with a named wake (no unnamed wait anywhere).

**(c) maintain never preempts progress.**
`s = snap({ activeJob:{name:'build',cls:'progress',lastProgressAt:Date.now()}, maintainNeeded:true, hp:20, food:20, armorPieces:4 })`
→ `pickJob(s).job==='build'` (progress continues) — the maintain need does NOT surface;
assert no returned job has `cls:'maintain'` while a progress job is active. Also directly:
a snapshot with no active job but `maintainNeeded:true` and no survival need →
`pickJob.cls==='maintain'` with `preempt:false`.

**(d) recoveryPlan totality sweep (S6) — the core safety test.**
Sweep the grid: `hp ∈ {1,6,12,20}`, `food ∈ {0,6,12,20}`, `armorPieces ∈ {0,4}`,
`graveDist ∈ {none,3,32,200}`, `homeDist ∈ {5,48,200}`, `isNight ∈ {false,true}`,
`nightStuck ∈ {false,true}`, `deathsRecent ∈ {0,3}`. For EVERY combination:
- `recoveryPlan(s).length >= 1` (non-empty).
- every entry with an `action` starting `boundedHold` (or `sleepInBed`/`digInForNight`) has a
  `wake` ∈ `{dawn,foodInPack,grave,animal<=24}` or a `|`-joined subset thereof.
- no entry has a `wake` and an empty/missing action.
- **"far supply never disqualified":** for the `homeDist:200, graveDist:200, farm dist 200`
  cases assert an R3 (or R4) rung is still present (distance did not remove it).
- **nightStuck:** assert no `boundedHold:sleep`/`:sealPit` with an infinite intent — R5 is
  `rerunLadderByNight` when `nightStuck` (no dawn hold on eternal night).
- **deathsRecent 3:** R2 rung index < first R3/R4 index; R3/R4 carry `dayGated:true`.

**(e) watchdog danger-scaled windows + nudge→fail sequencing.**
For `job = { startedAt:0, lastProgressAt:0, cls }` and `now` swept:
- critical (`vitals hp:6` or `food:2`): `now=19999`→'ok', `20000`→'nudge', `39999`→'nudge',
  `40000`→'fail-job'.
- survival cls (vitals fine): boundaries 45000/90000.
- else: boundaries 120000/240000.
- `lastProgressAt=now` (idle 0) → 'ok'; `activeJob=null` → 'ok'.

**(f) every hold carries a valid wake** — a focused restatement of (d)'s wake assertion over a
handful of hand-picked hold-forcing snapshots (night + nothing reachable; night + bed at 5b;
nightStuck).

**(g) commandClass vocabulary** — table test: assert each real command maps to its class:
`recover/eat/wear/armorup/sleep/fish/securefood → survival`;
`build/gather/mine/come/goto/follow/craft/place/attack → progress`;
`state/scan/find/block/entities/inventory/look/waypoints → perception`; `say → chat`;
`''`/unknown → progress.

**(h) admissible survival gating** — `admissible('survival', snap({hp:20,food:20,armorPieces:4,graves:[]}))`
→ `allow:false` (no need, no grave — must NOT interrupt a build, per §3.4/I1 second half);
`admissible('progress', anything).allow===true`; `admissible('perception',_).allow===true`.

### 4.2 `bot/maintaintest.js`

- **ordering:** a snapshot under floor on packFood, armor, and torches → `needs()` returns
  keys in order `['packFood','armor','torches']` (food before gear before torches).
- **each floor triggers independently** at `floor-1`, and NOT at `target`.
- **hysteresis band:** packFoodPts between floor and target (18, floor 12/target 24) →
  packFood NOT in needs; at 11 → present; at 24 → absent.
- **all-satisfied → `[]`** (fed/armed/stocked snapshot).
- **env override:** set `MAINT_PACKFOOD_FLOOR=20`, assert packFoodPts 18 now triggers (and
  restore the env in a finally, like `gravegatetest.js:76-94`).
- **bankFood needs home reachable:** with `homeReachable:false`, bankFood deficit is NOT
  emitted (can't courier to an unreachable bank).

---

## 5. Safety / scope

- **No existing file changes.** S3 adds `scheduler.js`, `schedulertest.js`, `maintain.js`,
  `maintaintest.js`. Nothing requires these yet, so behavior on the live bot is byte-identical
  to today. `node --check` on the two new modules + `node schedulertest.js` +
  `node maintaintest.js` green is the whole gate (no live smoke — there is nothing live to
  smoke; per the build-agent light-gate memory, pure modules are unit-tested only).
- **Purity contract:** no `require` of `mineflayer`, `pathfinder`, `fs`, or `provision`/
  `commands`/`index`. `scheduler.js` MAY `require('./arbiter.js')` for `jobSurvivalNeed`/
  `PRIORITY` (one-way, no cycle) — or, to stay fully standalone, inline the small
  `jobSurvivalNeed` reuse by requiring it; requiring arbiter is preferred (single authority,
  §3.1). `maintain.js` MAY `require('./food.js')` for `foodTier` if it needs the classifier,
  but per §3 the points are pre-summed in the snapshot, so maintain likely needs no require at
  all.
- **Non-regression:** every existing `bot/*test.js` (`arbitertest`, `gravegatetest`,
  `foodtest`, `miningtest`, `routememtest`, `plannertest`, `sheltertest`, …) stays green —
  they can't be affected (no shared file touched), but run them as the check.
- These modules make NO decision the bot acts on until S4 wires them. A bug here is a failing
  unit test, never a live misbehavior.

---

## 6. Definition of done

1. Four new files exist; NO existing file is modified (`git status` shows only additions).
2. `node --check bot/scheduler.js bot/maintain.js` clean; `node bot/schedulertest.js` and
   `node bot/maintaintest.js` exit 0.
3. `scheduler.js` exports exactly `pickJob, recoveryPlan, commandClass, admissible,
   needProducer, watchdog, JOB_CLASSES, _setNow` (+ `setDebugSink, _reset` for hygiene).
4. `maintain.js` exports `needs, BUFFERS` (+ `_reset`).
5. The live-livelock snapshot test (4.1a) passes: `pickJob` → survival job, `admissible`
   → allow. The S6 totality sweep passes with zero empty plans and zero unnamed waits.
6. `commandClass` maps the real vocabulary (4.1g) — no invented commands.
7. All existing test suites still green.

---

## 7. Out of scope / deferred (this slice)

- ALL wiring: the busy-gate rework (`index.js:1573-1676`), the scheduler tick,
  `provision.schedulerState(bot)`, `provision.maintenancePass`, `provision.recoverFromDegraded`,
  `provision.boundedHold`, the `commands.gravesSnapshot()` exporter, the `shouldChaseGrave`
  ladder-routing, the watchdog interval, the heartbeat writer, the run.js supervisor — all S4+
  (REDESIGN §9/§10). S3 only makes the pure decisions those wirings will call.
- Any change to `arbiter.jobSurvivalNeed` thresholds, `foodTier`, `armorPieceCount`,
  `gearupState`, or the death ledger — reused as-is, unchanged.
- Buffer-number tuning, cadence/jitter, the courier/home-cache behavior, farm-trampling and
  minimal-loadout safekeeping (REDESIGN §11 deferred) — none belong in the pure modules.
- Exact reason/dbg wording — builder's call, but reason strings must be greppable and human
  (they surface in `/log`).
