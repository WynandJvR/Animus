# DESIGN S4: wire the survival tier — schedulerState + gravesSnapshot + class-based busy-gate + the scheduler tick

Status: design for implementation. Slice **S4** of `REDESIGN-proactive-survival.md`
(§3.4 busy-gate rework, §3.3 invariants I1–I4, §9 per-file list, §10 S4 scope, §11
double-fire + snapshot-cost risks). It WIRES the pure `bot/scheduler.js` /
`bot/maintain.js` committed in S3 (HEAD `9bcf584`) into the live bot. Master flag:
**`SCHEDULER`** (default ON; `SCHEDULER=0` restores the S1-hotfix wiring byte-for-byte —
the busy-gate takes the existing `survivalAdmissible` path, the tick never registers, and
the crisis reflexes run exactly as today).

Scope: `bot/provision.js` (new `schedulerState`), `bot/commands.js` (new `gravesSnapshot`
+ a tiny `activityInfo` accessor), `bot/index.js` (busy-gate rework + ONE scheduler tick +
three reflex delegations), `bot/loghistory.js` + `bot/statehistorytest.js` (4–5 new
time-series fields), `bot/gravegatetest.js` (extend) + NEW `bot/schedstatetest.js`.
**Untouched:** `scheduler.js`/`maintain.js` themselves (S3, already tested), `arbiter.js`,
`navigate.js`, `resources.js`, `mining.js`, `pathfix.js`, `scaffold.js`, `run.js` (S2
supervisor), all anti-grief movement profiles, `famineHold` (deleted only in S5).

All line numbers are as of HEAD `9bcf584` (clean tree, 2026-07-16). Every cited symbol
was re-opened at this HEAD.

### Hard constraints (restated, non-negotiable)

- **This deploys to the LIVE production bot** by restarting it (run.js brings it back and
  the persisted castle build auto-resumes via `commands.persistedResume`,
  commands.js:3019). Every new path below is bounded (cooldowns, latches, one dispatch at
  a time, reuse of already-bounded executors); `SCHEDULER=0` + restart is a clean, total
  rollback. Safe to run unattended.
- **Single-goal discipline (operator rule):** survival may preempt a build; nothing else
  interrupts one. The tick NEVER dispatches `progress` or `maintain` jobs over an active
  build — `pickJob`'s class ranks make `maintain` structurally unable to preempt
  (scheduler.js:39-45,199-201), and the tick additionally ignores every non-survival
  result (§6.3 step 4).
- **No new dig/build/grief paths.** Every dispatch reuses an existing, live-verified
  executor: `commands.handle(bot,'recover')`, `provision.secureFood`,
  `provision.recoverHp`.
- **Deferred, explicitly:** `famineHold` stays (provision.js:4105 call, 4200 body) —
  deleting it is S5. No `recoverFromDegraded`, no `boundedHold` (S5). No
  `maintenancePass` (S6). No watchdog interval / `touchProgress` / latch consolidation
  (S7). If `pickJob` returns `recoveryLadder` or `nightShelter`, S4 routes them to the
  narrow existing handling specified in §6.4 — it does not build the ladder.

---

## 1. Problem

S3 shipped the pure decision core; nothing calls it yet. The live bot still runs on:

- **S1's hard-coded busy-gate** (index.js:1652-1682): a fixed survival regex
  `^(recover|getstuff|eat|wear|armorup|sleep)` (index.js:1661) + the bot-handle
  `survivalAdmissible(bot)` (index.js:1573-1585) — a stand-in whose own comment says
  "Pre-scheduler this stands in for scheduler.admissible('survival', s)" (index.js:1572).
- **Three independent crisis timers** that each decide survival on their own trigger:
  SURVIVAL_HUNT (index.js:729-746), FOOD_CRISIS (index.js:779-796), HP_CRISIS
  (index.js:809-827). They are the ad-hoc "fires even while busy" mechanism the REDESIGN
  (§3.2) says the scheduler must replace as *the only* preemption mechanism.
- **No standing survival dispatcher**: a worthwhile grave 3 blocks away is only acted on
  at respawn time (one-shot) or when the brain happens to say `recover`. Invariant I3
  (graves re-evaluated every tick) has no body-side driver.
- **The time-series is blind to the failure signatures**: `loghistory.compactSample`
  (loghistory.js:21-41) records hp/food/pos/activity but not armor worn, pack food,
  water/underground hazard flags, or oxygen — so the naked-drowning / naked-starving
  signatures cannot be read out of `logs/state-history.jsonl` after the fact.

## 2. What S4 wires (root architecture, not a bug fix)

The pure API is already there and tested (all at HEAD `9bcf584`):

| pure fn | signature | where |
|---|---|---|
| `commandClass(line)` | → `'survival'│'progress'│'perception'│'chat'` | scheduler.js:64-73 (table 58-63) |
| `admissible(cls, snap)` | → `{ allow, reason }` | scheduler.js:137-156 |
| `pickJob(snap)` | → `{ job, cls, reason, preempt }│null` | scheduler.js:162-205 |
| `needProducer(need)` | → job name │ null | scheduler.js:97-100 (map 82-96) |
| `recoveryPlan(snap)` | → rung list (S5 consumes) | scheduler.js:213-275 |
| `watchdog(job,vitals,now)` | → verdict (S7 consumes) | scheduler.js:283-297 |
| `maintain.needs(snap)` | → unmet-buffer list | maintain.js:29-66 |

What is missing is the **snapshot builder** (the pure functions eat plain data), the
**graves exporter** (the `graves[]` shape does not exist — S3 doc §0 called this out as
an S4 deliverable), the **gate swap**, and the **one tick** that dispatches.

`admissible`/`pickJob` internally call `arbiter.jobSurvivalNeed(s)` with default opts
(scheduler.js:141,169 → arbiter.js:119; defaults foodThreshold **14** at arbiter.js:124,
hpCritical 6 at :121, hpLow 10 at :140). Two consequences the wiring must honor:

- At the **busy-gate**, threshold 14 matches the S1 path exactly — `survivalAdmissible`
  calls `provision.survivalNeed(bot)` (index.js:1574) whose default is also 14
  (`PROGRESS_FOOD_MIN`, provision.js:3846). No behavior change there.
- At the **tick**, `food 13` mid-build would surface `{need:'food', preempt:true}` — but
  today a busy job handles its own moderate hunger (the gather loop's critical bail is
  food ≤ 6; FOOD_CRISIS fired only at food ≤ 2). So the tick uses a separate
  **crisis-grade preemption gate** while the body is busy (§6.3 step 6) so S4 does not
  suddenly interrupt builds at food 13. Idle dispatch uses the default thresholds (which
  matches today's idle FOOD_TOPUP firing at food < 14, index.js:757).

## 3. The design in one paragraph

(1) `provision.schedulerState(bot)` (NEW, async) assembles the full scheduler snapshot as
a superset of `survivalState(bot)` (provision.js:3791-3841): spread survivalState, then
add pack food points (the provision.js:4040-4042 sum applied to the pack via
`foodSec.foodTier`, cf. :3996), worn/carried armor counts, `graves[]` + `deathsRecent`
from (2), home/bank/farm/orchard geography (bank strictly `cachedOnly` — resources
`totalCounts` opts, per REDESIGN §11: never walk the bot from a tick), gearup back-off,
the active-job descriptor, `persistedBuild`, and finally `maintainNeeded` computed by
feeding the just-built base snapshot to `maintain.needs` (the chicken/egg is resolved by
ordering: base first, flag last). (2) `commands.gravesSnapshot({pos,home})` (NEW) walks
the death ledger (commands.js:65) with the exact `min(botDist, homeDist)` XZ math of
`shouldChaseGrave` (commands.js:141-145) and the existing `graveWorthIt`/`graveValue`
classifiers, returning per-grave `{dist,value,dangerous,hasGear}` plus `deathsRecent`.
(3) The busy-gate (index.js:1649-1682) swaps its regexes for
`scheduler.commandClass(line)` + `scheduler.admissible('survival', await
provision.schedulerState(bot))` behind `SCHEDULER !== '0'`, preserving verbatim the
supervisor exemption, the stop-suppression, the persisted-build hold, the CHEAT gate, and
the one-job gate; `progress`-class commands are still simply *held* while busy — exactly
as scheduler.js:131-135 documents ("admissible only ADJUDICATES survival preemption").
(4) ONE ~15s-jittered tick builds the snapshot, calls `pickJob`, and — through a single
job-latch runner that also checks the existing `_securingFood`/`_recoveringHp`/`recover`
mutexes — dispatches ONLY survival-class jobs to the existing executors
(graveSweep→`recover`, secureFood→`provision.secureFood`, recoverHp→
`provision.recoverHp`), preempting a busy body only on a crisis-grade need or a near
grave via the same `commands.preemptForSurvival()` latch the S1 gate already proved
(commands.js:46, index.js:1665). The three reflexes that would double-fire —
SURVIVAL_HUNT, FOOD_CRISIS, HP_CRISIS — become one-line delegates (early-return when
`SCHEDULER` is on). (5) Observability: the tick `note()`s its decision on CHANGE (not
every tick), and `compactSample` gains armor / pack-edible / oxygen / inWater /
underground fields mapped from data `commands.state(bot)` already carries
(commands.js:2314,2324,2333,2350) — zero new plumbing.

---

## 4. Change 1 — `provision.schedulerState(bot)` (provision.js)

**Insertion point:** immediately after `mayDoProgress` (provision.js:3851), i.e. right
under the survivalState/survivalNeed block it extends. Export it from the
`module.exports` object at provision.js:6638 (add `schedulerState`).

**Signature:** `async function schedulerState (bot)` → plain-data snapshot (the shape
scheduler.js §2.1 consumes). Async because the bank read (`resources.totalCounts`) is
async — both call sites (`/cmd` handler and the tick) are already async contexts. Every
sub-read is individually `try/catch`-wrapped so a half-broken world state yields a
partial snapshot (absent field = "not blocking" per scheduler contract), never a throw.

**Field → source table (each verified at HEAD):**

| field | source | location |
|---|---|---|
| `hp, food, threatDist, creeperDist, drowning, inLava, onFire, isNight, underArmored, nightStuck` | spread of `survivalState(bot)` — build ONCE, spread, never duplicate the threat scan | provision.js:3791-3841 |
| `packFoodPts` | Σ `foodsByName[i.name].foodPoints * i.count` over `bot.inventory.items()` where `foodsByName[i.name]` exists and `foodSec.foodTier(i.name) < 2` — the exact sum pattern of the bank calc, applied to the pack | pattern provision.js:4040-4042; `foodSec.foodTier` use :3996 |
| `armorPieces` | `armorPieceCount(bot)` | provision.js:1925-1929 |
| `packArmorPieces` | count (Σ of item counts, in practice 1 each) of `bot.inventory.items()` whose name matches `/_(helmet|chestplate|leggings|boots)$/` — the armor-name regex already used for grave notables | regex mirror commands.js:88,112; consumed by recoveryPlan R0, scheduler.js:219,229 |
| `graves`, `deathsRecent` | `commands.gravesSnapshot({ pos, home })` (§5) — **lazy** `require('./commands.js')` inside the function; commands.js already requires provision.js, so a top-level require would be a cycle. Lazy inline require is the established pattern (cf. the inline `require('./resources.js')` at provision.js:4006,4039) | NEW, §5 |
| `homeDist` | XZ `Math.hypot` from `bot.entity.position` to `hutAnchor()` else `knownBed()`; `null` if neither | provision.js:2625, 3013 |
| `bankFoodPts` | `await resources.totalCounts(bot, { cachedOnly: true, near: anchor, maxDist: 64 })` then the foodPoints sum — **`cachedOnly` is mandatory** (REDESIGN §11 snapshot-cost: never walk the bot from a tick); `try/catch → 0` | exact live pattern provision.js:4039-4042 |
| `farm` | `{ exists: hasStandingFarm(), dist }` — dist = XZ to the wheatFarm anchor `{x,z}` (`loadWorldMem().wheatFarm`), `null` when absent | provision.js:3674; shape written :3553 (`{x,y,z,cells,at,maxed}`) |
| `orchard` | `loadWorldMem().orchard` → `{ dist: XZ to {x,z} │ null, readyAt: harvestReadyAt │ null }` | written provision.js:4626 (`{x,z,at,planted,harvestReadyAt}`) |
| `gearupBackoffUntil` | `gearupState().until` | provision.js:2990 |
| `activeJob` | `commands.activityInfo()` (NEW accessor, §5) → `{ name, cls, startedAt, lastProgressAt: null, blockedOn: null }` with `cls = scheduler.commandClass(name)` (top-level `require('./scheduler.js')` in provision is cycle-safe: scheduler requires only arbiter). If no commands activity: synthesize from the provision latches — `isSecuringFood()` → `{name:'secureFood', cls:'survival'}`, `isRecoveringHp()` → `{name:'recoverHp', cls:'survival'}`, `isResting()` → `{name:'nightShelter', cls:'survival'}` — else `null`. `lastProgressAt`/`blockedOn` stay `null` until S7 adds `touchProgress` | commands.js:188,190; provision.js:3965,4337,3264 |
| `persistedBuild` | `!!commands.persistedResume()` (small JSON read, fine at 15s) | commands.js:3019-3021 |
| `brainJobPending` | **omitted in S4** (no producer exists; absent = falsy, scheduler treats as "none" — pickJob step 4 then rests on `activeJob`/`persistedBuild`, scheduler.js:195-197) | — |
| `torches`, `homeReachable`, `tools` | for `maintain.needs`: `torches = countItem(bot,'torch')`; `homeReachable = homeDist != null && homeDist <= 48`; `tools` **omitted** in S4 (absent ⇒ "not measured", maintain.js:55-59 — the tool booleans arrive with S6) | maintain.js:48,55-63 |
| `maintainNeeded` | computed LAST: `maintain.needs(snap).length > 0` on the fully-assembled base snapshot (`const maintain = require('./maintain.js')` — pure, no cycle), then assigned onto it. S4 never dispatches maintain (§6.4); the field exists so pickJob is exercised with real data and S6 is a one-line enable | maintain.js:29-66; pickJob step 5 scheduler.js:201 |

**Activity-name classification note (honest quirk):** `commandClass('gearup')` returns
`'survival'` (scheduler.js:61 — gearing is survival-classifiable for *admissibility*).
So an `armorup`/`gearup` activity shows as a survival-class activeJob; the only effect is
`preempt:false` on a survival pick during a gearup (same rank) — harmless, since the
dispatch latches still apply. Do not special-case it.

**Tests:** NEW `bot/schedstatetest.js` (offline). `schedulerState` is bot-bound, so test
it with a MINIMAL stub bot (`entity.position`, `health`, `food`,
`inventory.items(): () => [...]` + `slots`/`getEquipmentDestSlot` stubs, `version` set to
the live-supported string so `minecraft-data` resolves, `entities: {}`, `blockAt: () =>
null`, `time: {timeOfDay}`) and **env isolation set BEFORE the requires**:
`WORLD_MEM_FILE` (provision.js:2409, exists exactly for test isolation) and `DEATH_FILE`
(commands.js:64) pointed at temp fixtures. Assert: (a) survivalState fields present;
(b) `packFoodPts` sums correctly for a stub pack (e.g. `bread x2` + `rotten_flesh x5` →
bread points only — tier gate works); (c) `packArmorPieces` counts an unworn
`iron_helmet`; (d) `homeDist` null on empty world-mem, numeric with a hut fixture;
(e) `graves` passthrough (via the ledger seam, §5) with `dist = min(bot,home)`;
(f) `persistedBuild`/`maintainNeeded` are booleans; (g) the whole call resolves (no
throw) on a barely-populated stub — the partial-snapshot guarantee.

## 5. Change 2 — `commands.gravesSnapshot()` + `commands.activityInfo()` (commands.js)

**Insertion point:** next to the other pure grave helpers, after `shouldChaseGrave`
(commands.js:161). Add both names to `module.exports` (commands.js:3200).

```
gravesSnapshot({ pos, home, now, ledger } = {}) -> { graves: [...], deathsRecent }
```

- `ledger` defaults to the module `deathLedger` (commands.js:65); the parameter is the
  **offline-test seam** (inject a fixture array, no fs / no recordDeath ceremony).
  `now` defaults to `Date.now()`.
- `graves`: for each entry `d` with `!d.retrieved && graveWorthIt(d) && now - (d.at||0) <
  24*3600*1000` (the same worth+age filter as `bestGrave`, commands.js:117 — but
  **including dangerous graves**, since the snapshot shape carries the flag and the
  scheduler filters on it, scheduler.js:114):
  - `dist` = `Math.min(hypot(d.x-pos.x, d.z-pos.z), home ? hypot(d.x-home.x, d.z-home.z)
    : Infinity)` — the exact XZ `min(bot, home)` of shouldChaseGrave
    (commands.js:141-145). Missing `pos` AND `home` ⇒ `dist: null` (the scheduler
    already skips null-dist graves, scheduler.js:115).
  - `value` = `graveValue(d)` (commands.js:105); `dangerous` = `!!d.dangerous`;
  - `hasGear` = `(d.items && d.items.notable || []).some(n =>
    /^(iron|diamond|netherite|golden)_|_(helmet|chestplate|leggings|boots)$/.test(n))` —
    the verbatim `realGear` regex from `graveWorthIt` (commands.js:112);
  - include `x,y,z,at` too (free, and the tick's log + S5 want them).
- `deathsRecent` = ledger entries with `now - (d.at||0) < 20*60000`, **regardless of
  retrieved** (a reclaimed grave was still a death — the ratchet signal). Honest caveat
  in a comment: after a process restart the load at commands.js:76 drops retrieved
  entries, so `deathsRecent` under-counts across restarts; acceptable (it only biases the
  degraded signature toward *less* aggressive, and S5's ladder re-derives).

```
activityInfo() -> { name, detail, startedAt } | null
```

One-liner over the module `activity` record (commands.js:188, set by `beginActivity`
commands.js:190) so `schedulerState` doesn't have to build the full heavyweight
`state(bot)` (blockAtCursor/entity summaries, commands.js:2291-2354) on every tick just
to read three fields.

**Tests:** extend `bot/gravegatetest.js` (same harness/style, commands already required
offline there — gravegatetest.js:15). Fixture ledger: (1) near iron grave (3b from home,
notable `['iron_pickaxe','iron_helmet']`) → `dist≈3, hasGear:true, value>0`; (2) far
grave 200b from both → `dist≈200` still LISTED (distance never filters, only sequences);
(3) `dangerous:true` grave → listed WITH the flag; (4) worthless grave (1 dirt,
`graveWorthIt` false) → NOT listed; (5) `retrieved:true` → not in `graves` but counted in
`deathsRecent` when fresh; (6) empty ledger → `{graves:[], deathsRecent:0}`; (7) `pos`
far / `home` near → `dist` uses home (the min). Plus a composed check: feed the result
into `scheduler.pickJob` as `snap.graves` and assert the headline livelock fixture
(hp1/food0/naked/grave3b) still yields a survival job — proving the REAL exporter shape
matches what schedulertest built by hand (schedulertest 4.1a).

## 6. Change 3+4 — index.js: the class-based busy-gate + the scheduler tick

Add `const scheduler = require('./scheduler.js')` next to the loghistory require
(index.js:30), and one module const near it:
`const SCHED_ON = process.env.SCHEDULER !== '0'`.

### 6.1 Busy-gate rework (index.js:1649-1682) — REDESIGN §3.4

Current shape (verbatim, at HEAD):

- 1649 `const bodyBusy = (commands.isBusy…) || (provision.isResting…) || (provision.isSecuringFood…)`
- 1651 `const readOnly = /^(state|scan|find|block|entities|inventory|look|say)\b/i.test(trimmedLine)`
- 1652 `if (bodyBusy && !readOnly && !fromSupervisor) {`
- 1661 `const survivalCmd = process.env.S1_HOTFIX !== '0' && /^(recover|getstuff|eat|wear|armorup|sleep)\b/i.test(trimmedLine)`
- 1662 `const adm = survivalCmd ? survivalAdmissible(bot) : null`
- 1663-1666 PREEMPT branch (`commands.preemptForSurvival()` + fall-through)
- 1667-1681 held branch (busy label, player-courtesy reply)

**The rework (three surgical lines, everything else byte-identical):**

1. **Line 1651** becomes class-driven when SCHEDULER is on:
   ```js
   const cls = SCHED_ON ? scheduler.commandClass(trimmedLine) : null
   const readOnly = SCHED_ON ? (cls === 'perception' || cls === 'chat')
                             : /^(state|scan|find|block|entities|inventory|look|say)\b/i.test(trimmedLine)
   ```
   Deliberate, documented widening: `commandClass`'s perception set adds
   `turn|lookbehind|waypoints|places|help` (scheduler.js:59) to the old whitelist — all
   read-only/head-only, per REDESIGN §3.4 "perception/chat → allow as today". Note it in
   the code comment.
2. **Lines 1661-1662** become:
   ```js
   const survivalCmd = SCHED_ON ? (cls === 'survival')
                                : (process.env.S1_HOTFIX !== '0' && /^(recover|getstuff|eat|wear|armorup|sleep)\b/i.test(trimmedLine))
   const adm = survivalCmd ? (SCHED_ON ? scheduler.admissible('survival', await provision.schedulerState(bot))
                                       : survivalAdmissible(bot)) : null
   ```
   (The `req.on('end', async …)` handler at index.js:1612 is already async — the await is
   legal.) `commandClass`'s survival vocabulary is wider than S1's regex (adds
   `equip/armor/hold/gearup/planarmor/wake/fish/getfood/securefood/feed/huntat/hunt/
   waterat`, scheduler.js:61) — safe because `admissible` still requires a REAL need or a
   near grave (scheduler.js:141-152): a whimsical `gearup` at full health while a build
   runs is still **held**, now with the scheduler's greppable reason.
3. **Lines 1663-1681 unchanged.** Same PREEMPT note wording, same
   `commands.preemptForSurvival()` latch (commands.js:46), same held/courtesy-reply path.

**How `progress` maps to today's held-while-busy (explicit, per the S3 contract):**
`scheduler.admissible('progress', s)` returns `allow:true` meaning only "survival raises
no objection" (scheduler.js:131-135,155) — so the gate NEVER consults `admissible` for
progress. A progress-class command while `bodyBusy` simply falls into the held branch
(1667-1681), exactly today's suppression; `commandClass`'s unknown→`'progress'` default
(scheduler.js:72) keeps unrecognized commands held rather than wrongly bypassing.

**Preserved exactly (verified positions):** the supervisor exemption `fromSupervisor`
(computed index.js:1622, honored at 1645 and 1652 — untouched); the CHEAT gate
(index.js:1625-1628, runs BEFORE everything, so the scheduler never sees cheat verbs —
matching the scheduler.js:54-57 comment); the persisted-build stop-hold
(index.js:1645-1648); the stop-suppression rationale block (1629-1644); the ONE-JOB gate
(index.js:1687-1691, its move-regex untouched — migrating it to `commandClass` is NOT S4:
its member set (`explore|chop`) differs from the class table and it guards operator
intent, not survival). `survivalAdmissible` (index.js:1573-1585) is KEPT as the
`SCHEDULER=0` fallback; delete it only when the flag retires.

### 6.2 Reflex delegation (the anti-double-fire edit) — REDESIGN §11

One line at the top of each interval body, so the flag structure and rollback stay
visible in the diff:

| reflex | env flag | interval body starts | add as FIRST line |
|---|---|---|---|
| SURVIVAL_HUNT | index.js:729 | :730-746 (calls `provision.secureFood`, :743) | `if (SCHED_ON) return // S4: the scheduler tick owns survival dispatch` |
| FOOD_CRISIS | index.js:779 | :780-796 (calls `provision.secureFood`, :792) | same |
| HP_CRISIS | index.js:809 | :810-827 (calls `provision.recoverHp`, :823) | same |

These three are the "fires even while busy / when starving" survival tier — exactly what
the tick replaces. **Deliberately NOT delegated in S4** (kept live, migrate in S6 per
REDESIGN §4.3): FOOD_TOPUP (index.js:755), FOOD_SUPPLY (index.js:835), GEAR_REFLEX
(index.js:896), NIGHT_SHELTER (index.js:860), HOME_REPAIR (index.js:939), auto-eat,
AUTO_COOK (index.js:710), flee/defend/drown reflexes. They cannot double-*drive* the
tick's executors: each is idle-gated on `commands.isBusy()` / `provision.isSecuringFood()`
(index.js:758-761, 838-841, 863-868, 898-904, 943-946) and the executors the tick
dispatches raise those exact latches (`_securingFood` provision.js:3968;
`_recoveringHp` :4343; `recover` runs under the `recovering` mutex commands.js:47 and a
maneuver). Residual overlap (e.g. FOOD_TOPUP arming during a tick-dispatched `recover`)
is the SAME exposure a brain-issued `recover` has today — no new risk class.

### 6.3 The scheduler tick (NEW block)

**Insertion point:** after the HOME_REPAIR block closes (index.js:965), before the
Anti-AFK block (index.js:967) — with the other body-side interval reflexes, where `bot`,
`note`, `commands`, `provision`, `navigate`, `arbiter` are all in scope.

Structure (design sketch — builder writes the real code):

```js
// SCHEDULER TICK (S4, REDESIGN §3.2/§10): ONE dispatcher for the survival tier. Replaces
// the three ad-hoc crisis timers above (they early-return when SCHEDULER is on). Builds a
// snapshot, asks the pure pickJob which ONE job should own the body, and dispatches ONLY
// survival-class jobs to the existing executors. SCHEDULER=0 removes it entirely.
let schedJob = null                 // the single job-latch (I4): one scheduler dispatch at a time
let schedLastLog = ''               // decision-change log throttle
let schedGraveCooldownUntil = 0     // failed grave recovery -> don't hammer an unreachable grave
let schedHpCooldownUntil = 0        // mirror of hpCrisisCooldownUntil (index.js:825)
let schedDeferNoted = ''            // one note per deferred job kind (nightShelter/maintain/ladder)
if (SCHED_ON) {
  const tick = async () => { …body below…; setTimeout(tick, 15000 + (Math.random()*6000 - 3000)) }
  setTimeout(tick, 15000)           // self-rescheduling => built-in jitter (REDESIGN cadence)
}
```

Tick body, in order:

1. **Guards (all cheap, mirror today's crisis reflexes):** return if `!bot.entity`, if
   `schedJob` (a dispatch is running), if `commands.isEscaping()` (index.js:785,815
   precedent), if `navigate.isRecovering() || navigate.isForceUnsticking()`
   (index.js:786,816), or if `bot.isSleeping` (index.js:819). Deliberately NOT gated on
   `arbiter.maneuverActive()` — a survival preempt must be able to interrupt a nav leg,
   same as FOOD_CRISIS today.
2. **Snapshot + decision:** `const s = await provision.schedulerState(bot);
   const pick = scheduler.pickJob(s)`.
3. **Observability (log on CHANGE):** build
   `key = (pick ? pick.job + '|' + pick.preempt : 'idle')`; when `key !== schedLastLog`,
   `note(\`(sched) pick=${job||'idle'}${preempt?' PREEMPT':''} reason="${reason}" | hp=${s.hp} food=${s.food} packPts=${s.packFoodPts} armor=${s.armorPieces} graves=${s.graves.length}${nearest?'(near '+Math.round(nearest.dist)+'b)':''} home=${s.homeDist==null?'?':Math.round(s.homeDist)+'b'}\`)`
   and set `schedLastLog = key`. Dispatches and their outcomes ALWAYS log (they're rare).
   `note()` (index.js:217) already feeds bot-events.log — the deciding fields
   (hp/food/packFoodPts/armorPieces/graves/homeDist) are exactly what the operator asked
   to see.
4. **Non-survival results are ignored:** `if (!pick || pick.cls !== 'survival') return` —
   `progress` picks mean the body/resume machinery already owns the goal (pickJob step 4
   only ever *continues*, scheduler.js:195-197); `maintain` dispatch is S6 (log once via
   `schedDeferNoted` when it first appears: `"(sched) maintain needed - deferred to S6"`).
5. **Resolve the executor (the dispatch map):**
   - `graveSweep` → `commands.handle(bot, 'recover', { source: 'scheduler' })` (the
     hardened AxGraves recover, entered at commands.js:1424; `handle`'s opts.source
     already exists — index.js:1696).
   - `secureFood` → `provision.secureFood(bot, { home: knownBed()||undefined, canHold: true, say })`
     (the exact FOOD_CRISIS call shape, index.js:791-792 — famineHold stays reachable
     through `canHold`, per the S5 deferral).
   - `recoverHp` → `provision.recoverHp(bot, { say })` (the exact HP_CRISIS call shape,
     index.js:823).
   - `nightShelter` → **no-op with a once-note** — the NIGHT_SHELTER reflex
     (index.js:860-887) stays the owner in S4 (REDESIGN §11 open question resolved
     "stays a reflex until S7").
   - `recoveryLadder` → **downgrade, do not build the ladder** (S5): re-read
     `const need = provision.survivalNeed(bot)` (provision.js:3844); if `need` →
     `scheduler.needProducer(need.need)` and dispatch `secureFood`/`recoverHp` per the
     rows above (`shelter`→nightShelter-no-op; `lava/fire/drowning/threat/creeper`→
     `'flee'`→no-op, reflex-owned per scheduler.js:80-81). If `need` is null (the
     degraded-only signature — e.g. naked + graves + food 12): if a non-dangerous
     worthwhile grave has `dist <= GRAVE_NEAR_LADDER (32)` dispatch `recover`, else
     once-note `"(sched) degraded but no executor until S5 - holding"` and return.
6. **Busy vs idle dispatch policy (single-goal discipline):**
   `const bodyBusy = commands.isBusy() || provision.isResting() || provision.isSecuringFood()`
   (the index.js:1649 trio).
   - **idle** → dispatch directly (this is I3's standing grave rule + the idle
     food/heal top-up; threshold food<14 matches today's idle FOOD_TOPUP trigger,
     index.js:757).
   - **busy** → dispatch ONLY when crisis-grade, else log-held: crisis-grade =
     the resolved executor is `recover` (a near grave IS the survival move, I3), OR
     `provision.survivalNeed(bot, { foodThreshold: Number(process.env.SCHED_CRISIS_FOOD || 6) })`
     is non-null — 6 being the documented mid-activity CRITICAL threshold
     (provision.js:3842-3846), between today's FOOD_CRISIS food≤2 and the gather loop's
     own food≤6 bail. A crisis-grade busy dispatch first calls
     `commands.preemptForSurvival()` (commands.js:46 — sets ONLY `buildAbort`;
     resumeJob/persistedResume survive, so the interrupted build resumes via its normal
     path — the exact mechanism the S1 gate PREEMPT proved live, index.js:1663-1666) and
     notes `(sched) PREEMPT …`.
7. **Latch checks + cooldowns (never double-drive):** before dispatching —
   `secureFood`: skip if `provision.isSecuringFood()` (provision.js:3965; the latch a
   busy job's own internal secureFood raises, so the tick can never stack a second one —
   and `secureFood` itself returns false on re-entry, provision.js:3967).
   `recoverHp`: skip if `provision.isRecoveringHp()` (provision.js:4337; re-entry safe at
   :4342) or `Date.now() < schedHpCooldownUntil`; set `schedHpCooldownUntil = Date.now()
   + 60000` after every attempt (mirror index.js:825).
   `recover`: skip if `Date.now() < schedGraveCooldownUntil`; on a dispatch whose result
   does not report success, set `schedGraveCooldownUntil = Date.now() +
   Number(process.env.SCHED_GRAVE_COOLDOWN_MS || 300000)` — a success marks the grave
   retrieved so it leaves the snapshot naturally.
8. **The single job-latch runner:** `schedJob = { name, startedAt: Date.now() }`;
   `try { const r = await executor(); note('(sched) ' + name + ' -> ' + …) } catch (e)
   { note('(sched) ' + name + ' failed: ' + e.message) } finally { schedJob = null }`.
   One dispatch at a time, always released, every executor already internally bounded
   (secureFood's chain deadlines, recoverHp's 180s hold provision.js:4352, recover's own
   handling) — the tick adds no unbounded wait.

## 7. The double-fire safety argument (REDESIGN §11, spelled out)

Who can call each survival executor once S4 lands with `SCHEDULER` on:

| executor | callers after S4 | mutual exclusion |
|---|---|---|
| `provision.secureFood` | the tick; busy jobs' own internal calls (gather loop etc.); FOOD_TOPUP (idle-only, index.js:758-761); brain `securefood`-class cmd via the gate | the `_securingFood` module latch (provision.js:3967-3969) makes every second entrant return false; the tick ADDITIONALLY checks `isSecuringFood()` before dispatching (never even starts); FOOD_CRISIS + SURVIVAL_HUNT — the two timers that raced it while busy — are delegated OFF (§6.2) |
| `provision.recoverHp` | the tick; the material-round heal (commands.js:2886 area); brain `recover`-adjacent cmds | `_recoveringHp` latch (provision.js:4336,4342-4343) + the tick's own check + 60s cooldown; HP_CRISIS delegated OFF |
| `commands.handle('recover')` | the tick; the respawn handler (one-shot, unchanged in S4); the brain via the gate PREEMPT | the `recovering` mutex (commands.js:47) rejects concurrent recovers; the tick's 5-min failure cooldown stops hammering |
| preemption latch | gate PREEMPT (index.js:1665) and tick PREEMPT both call `preemptForSurvival()` | it is idempotent (`buildAbort = true`, commands.js:46) — double-setting is harmless by construction |

And the tick itself is serialized by `schedJob` (one dispatch at a time, I4 —
pragmatically implemented as one NEW latch *plus* the existing per-flow latches as
belt-and-suspenders, per the operator's instruction; full latch consolidation is S7).
No watchdog exists yet (S7), so nothing can fail-and-redispatch a job the latches hold.
Worst case of a scheduler bug: a wrong *hold* (a survival job not dispatched) — which is
today's behavior — never two bodies-worth of commands, and the S2 external supervisor
(run.js) still breaks a total freeze from outside.

## 8. Change 5 — observability: `compactSample` fields (loghistory.js + statehistorytest.js)

`compactSample` (loghistory.js:21-41) already receives the FULL `commands.state(bot)`
snapshot (index.js:1830) which carries `oxygen` (commands.js:2314), `wearing`
(:2324, `{head,torso,legs,feet}` names-or-null per `wornArmor` commands.js:2279-2288),
`inventory` (:2333, `["name xN", …]` strings), and `hazards` (:2350,
`{underground,onFire,inLava,inWater,drowning}` per commands.js:2374). **No new plumbing —
map more of what's already there.** Append to the returned object (after `isDay`,
loghistory.js:39; existing fields byte-identical):

- `armor`: `snap.wearing ? (count of truthy among head/torso/legs/feet) : null` → 0-4.
- `packFood`: `Array.isArray(snap.inventory) ? Σ count over entries whose name matches
  EDIBLE_RE : null` — an APPROXIMATE pack-edible item count (points need minecraft-data,
  which this pure module must not require). `EDIBLE_RE` = a module const covering the
  staples (`bread|cooked_|apple|carrot|potato(?!_)|baked_potato|melon_slice|cookie|
  pumpkin_pie|_stew|beetroot|cod|salmon|tropical_fish|dried_kelp|honey_bottle|
  glow_berries|sweet_berries|chorus_fruit`, excluding `rotten|spider_eye|poisonous|raw`-
  prefixed nothing — keep raw meats OUT so the count means "ready to eat", mirroring
  foodTier<1 in spirit; comment it as approximate). Parse the count from the ` xN`
  suffix.
- `oxy`: `num(snap.oxygen)` (the existing `num` guard, loghistory.js:17; memory says
  oxygenLevel is unreliable live — record the raw value anyway, nulls included, and say
  so in the comment).
- `inWater`: `snap.hazards ? !!snap.hazards.inWater : null`.
- `underground`: `snap.hazards ? !!snap.hazards.underground : null`.

**statehistorytest.js:** extend the full-snapshot case (statehistorytest.js:20-44) with
`wearing: {head:'iron_helmet',torso:'iron_chestplate',legs:null,feet:'iron_boots'}` →
`armor 3`; `inventory: ['bread x5','cobblestone x32','cooked_beef x2','rotten_flesh x9']`
→ `packFood 7`; `oxygen: 12` → `oxy 12`; `hazards: {inWater:true, underground:false}` →
`inWater true / underground false`. Extend the null-snapshot case (:51-65): all five new
fields `null`. Add one backward-compat assertion: every PRE-EXISTING field of the full
case is unchanged (the S4 diff to this test is additions only). `readSince`/rotation
untouched.

---

## 9. Flags & rollback

- **`SCHEDULER`** (default ON): `=0` ⇒ the gate takes the `S1_HOTFIX` path verbatim
  (survivalAdmissible + the old regexes — S1_HOTFIX itself still honored there), the tick
  never registers, the three delegated reflexes run exactly as at HEAD, and the only
  residual delta is the new compactSample fields (pure telemetry) and two unused
  exports. When SCHEDULER is ON, the gate's scheduler branch supersedes `S1_HOTFIX`
  (the scheduler path IS its successor).
- **`SCHED_CRISIS_FOOD`** (default 6): the busy-preemption food threshold (§6.3.6).
- **`SCHED_GRAVE_COOLDOWN_MS`** (default 300000): failed-grave-recovery back-off.
- Existing flags keep their meaning: `S1_HOTFIX` (only under SCHEDULER=0), `GRAVE_NEAR`
  (16, read live by scheduler.js:146,184), `GRAVE_NEAR_LADDER` (32, scheduler.js:224),
  `SURVIVAL_HUNT/FOOD_CRISIS/HP_CRISIS=0` (still fully disable their reflexes — relevant
  under SCHEDULER=0), `MAINT_*` floors (maintain.js:34-39, feed `maintainNeeded`).
- Code rollback: one commit, five files + two test files; `git revert` clean; no data,
  no schema change (world-memory/death-ledger/chest-cache untouched).

## 10. Test plan (light gate — per the build-agent memory: no elaborate test-server runs)

**Syntax:** `node --check` on `bot/index.js bot/provision.js bot/commands.js
bot/loghistory.js`.

**Offline suites:**
- `node bot/gravegatetest.js` — existing cases green + the §5 gravesSnapshot cases.
- `node bot/schedstatetest.js` — NEW, the §4 cases (stub bot + WORLD_MEM_FILE/DEATH_FILE
  isolation).
- `node bot/statehistorytest.js` — extended per §8.
- Non-regression sweep: `schedulertest, maintaintest, arbitertest, foodtest, miningtest,
  routememtest, plannertest, sheltertest, supervisortest` (and the rest of `bot/*test.js`)
  all exit 0.
- Composition check inside schedstatetest (or gravegatetest): real
  `gravesSnapshot` output → `scheduler.pickJob` → survival job for the livelock fixture
  (§5 case 7+).

**ONE bounded live drill (§10 S4: "mid-gather hunger → preempt → fed → job resumed").**
Production bot, watched by cheap direct polls (operator rule: no monitoring subagent) —
`curl -s 127.0.0.1:3001/state`, `curl -s 127.0.0.1:3001/log`, and
`grep '(sched)' logs/bot-events.log`. Budget ≤ 20 min; any snag ⇒ set `SCHEDULER=0`,
restart, report — do not iterate live.

1. Deploy + restart via run.js at a calm moment; confirm reconnect, the persisted castle
   build resuming, and the first `(sched) pick=` line in bot-events.log (proves the tick
   is alive; expect `idle` or a real pick).
2. Wait for (or start) a busy phase — the castle build/gather is fine. From the server
   console: `effect give <bot> minecraft:hunger 255 200` (real generated terrain, live
   server — never flat/synthetic, per memory) and let food drain toward ≤ 6.
3. Watch for, in order: a `(sched) pick=secureFood PREEMPT reason="food …"` decision
   line → `(sched) PREEMPT` + dispatch → the bot eats/withdraws/cooks (food climbs to
   ≥ 18 in /state) → `(sched) secureFood -> …` outcome → the build resumes (persisted
   resume machinery; `/state` activity returns to the build within ~2 min of being fed).
4. Negative checks while it runs: (a) `curl -X POST /cmd -d '{"command":"eat"}'` at full
   food while busy → held with the scheduler's reason (`no survival need and no grave in
   reach…`) — the gate's new path adjudicates; (b) zero DOUBLE dispatch lines — no
   `(food-crisis)`/`(hp-crisis)`/`(survival)` reflex notes fire while SCHEDULER is on;
   (c) exactly one `(sched)` decision line per decision CHANGE, not one per 15s.
5. If a worthwhile grave happens to exist near home, optionally observe the standing I3
   behavior: `(sched) pick=graveSweep` → recover → grave cleared. Do NOT stage a death
   for it — the S1 drill already proved the recover path; S5's rock-bottom drill covers
   the rest.

## 11. Definition of done

1. `provision.schedulerState` and `commands.gravesSnapshot`/`activityInfo` exist, are
   exported, and their offline suites pass; `schedulerState` uses `cachedOnly` chest
   counts (grep-verifiable: the only `totalCounts` call it makes carries
   `cachedOnly: true`).
2. With SCHEDULER on, the busy-gate classifies via `commandClass` + decides via
   `admissible(…, schedulerState)`; supervisor exemption, stop-suppression,
   persisted-build hold, CHEAT gate, and one-job gate byte-identical; progress commands
   still held while busy.
3. The tick dispatches graveSweep/secureFood/recoverHp through ONE job-latch, preempts
   only on crisis-grade need or near grave, and never dispatches progress/maintain;
   recoveryLadder/nightShelter route per §6.4 (no new orchestrators built).
4. SURVIVAL_HUNT / FOOD_CRISIS / HP_CRISIS are inert while SCHEDULER is on (one-line
   delegates) and fully restored with SCHEDULER=0.
5. bot-events.log shows throttled `(sched)` decision lines carrying
   hp/food/packFoodPts/armorPieces/graves/homeDist; state-history.jsonl lines carry
   `armor/packFood/oxy/inWater/underground` with existing fields unchanged.
6. `node --check` clean; all offline suites (old + new) exit 0.
7. The live drill (§10) observed end-to-end on the production bot: mid-job hunger →
   scheduler preempt → fed ≥ 18 → job resumed; no reflex/tick double-fire lines.
8. `SCHEDULER=0` + restart demonstrably restores S1-hotfix behavior (one held-command
   probe shows the old reason string).

## 12. Deliberately out of scope / deferred

- **S5:** `recoverFromDegraded` + `boundedHold`, the `famineHold` delete
  (provision.js:4105,4200 untouched here), respawn-handler routing through
  `recoveryPlan`, `secureFood` returning `{fed, blockedOn}`.
- **S6:** `maintenancePass` + dispatching `maintain` picks, FOOD_TOPUP/FOOD_SUPPLY/
  GEAR_REFLEX/HOME_REPAIR migration, the courier/home-cache behavior, `tools` snapshot
  booleans, farm-trampling/hoe-gating, buffer tuning.
- **S7:** the watchdog interval, `touchProgress`/`lastProgressAt` telemetry
  (schedulerState carries `lastProgressAt: null` until then), consolidation of the
  ad-hoc latches into the one job-latch, nightShelter migration.
- **Builder's discretion:** exact note/reason wording (greppable + human), the EDIBLE_RE
  member list (approximate by design), tick jitter shape (±20-30%), small constant tuning
  — every bound stays finite and every default stays as specified.
