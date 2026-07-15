# REDESIGN: Proactive survival + non-compounding recovery (defense in depth)

Status: DESIGN — not yet implemented. Target: bot/arbiter.js, bot/provision.js,
bot/index.js, bot/commands.js, bot/planner.js, bot/run.js + new pure modules.
Written against the code as of commit f0696d4 (2026-07-15). Every claim below is
cited to the actual code; where the triggering diagnosis was imprecise, §1.2 says so.

## The organizing principle (judge every choice against this)

The from-nothing autonomous survival+build goal only works if **no single failure is
fatal**. We cannot prove zero deadlocks in a system this size, so this design does
not pretend to. The success criterion is NOT "no bug ever" (unreachable); it is:

> **Every failure is bounded and recoverable, and the death spiral is structurally
> impossible.**

Two properties are deliberately decoupled and BOTH addressed:

1. **Deadlock-freedom** (make freezes rare): scheduling invariants + blocked-on-X →
   schedule-the-producer (§3), proactive buffers so crisis states are rare (§4).
2. **Spiral-resistance** (what actually saves autonomy): even when a deadlock or bug
   slips through, it must not compound. A freeze is *bounded* — broken in seconds
   when vitals are critical, minutes otherwise (§6, §8). A death is a *blip, not a
   ratchet* — respawn+recovery reclaims the graves and treats "naked + starving +
   far from supply" as an always-solvable state, never a downward step (§5, §7).

Explicitly NOT a goal: relocating the farm/orchard nearer the bed, or gating treks
on distance. The 76-block farm distance in the live incident is a red herring — 76
blocks is trivial for a healthy bot. The failure was arriving at food 0 / 1 hp /
naked with no recovery sequencing, while its own `busy` flag muzzled the commands
that would have saved it.

---

## 1. Problem summary

### 1.1 The live failure (2026-07-15, confirmed against code + live state)

The bot froze 12+ minutes at 1 hp / food 0 / naked, 3 blocks from 5 graves holding
its iron. Three structural flaws:

- **F1 — Reactive-only food/gear.** Nothing tops up food/gear *while healthy*. The
  proactive hooks that DO exist (`FOOD_TOPUP` index.js:726, `FOOD_SUPPLY`
  index.js:806, gearup reflex index.js:866) are all gated behind
  `commands.isBusy()` / `arbiter.maneuverActive()` / `provision.isSecuringFood()` /
  `mayDoProgress()`, so they only fire in a narrow "idle and already fine" window —
  and the wheat/orchard harvest only happens inside `secureFood` (after hunger has
  already struck) or the 45s idle `ensureFoodSupply` pass. By the time a crisis
  hits, the good moves are far away or gated off.
- **F2 — Deadlock / priority inversion.** `index.js:1572` computes
  `bodyBusy = commands.isBusy() || provision.isResting() || provision.isSecuringFood()`
  and suppresses EVERY brain command not in the read-only whitelist
  (`state|scan|find|block|entities|inventory|look|say`). `recover`, `wear`, `eat`,
  `armorup` — the exact survival moves — are suppressed while the body is "busy"
  with the very hold that is failing. Meanwhile the body's own hold
  (`provision.famineHold`, provision.js:4054) sits up to **480s per pass** waiting
  for wake conditions that cannot occur (food appearing in the pack, an animal
  wandering within 24b) — it never checks the graves, never re-checks the bank,
  never sleeps toward dawn as a strategy. Nested waits with no actor scheduling the
  producer of the missing resource.
- **F3 — No forward-progress guarantee.** `famineHold` is a sanctioned 8-minute
  no-op; the stuck-detector (`commands.trackTick`, commands.js:226) explicitly
  excludes `isBusy()` bodies, so a wedged job standing still is invisible; and
  nothing at all catches a *totally* wedged process (a hung promise, a frozen
  decision loop) — run.js only restarts on **exit**, not on hang.

And the ratchet that turns one failure into five deaths: each death moved gear from
the pack into a grave, `shouldChaseGrave` (commands.js:126) then deferred the grave
*because* the bot was hungry — checked **before** distance, so even a grave 3b away
is deferred at food 0 — and the chase is attempted exactly once per respawn
(index.js:620), so a deferral is never revisited until the next death. Each loop
respawned strictly weaker. That is the compounding this design must make
structurally impossible.

### 1.2 Corrections / sharpenings to the triggering diagnosis (from the code)

- **"The stalled gearup job owns busy" — half right.** At hp 1 / food 0 the gearup
  *reflex* cannot even start (index.js:886 holds it on `mayDoProgress`, logging
  "survival need first: heal"). The `busy` that suppressed the brain was held either
  by (a) an earlier `armorup` command (commands.js:1287 sets `provisioning = true`
  for its whole duration) whose inner `gatherLoop` hit food 0 and ran
  `secureFood → famineHold` (provision.js:4782-4785 → 3959), or (b) the latched
  `_securingFood` itself — `isSecuringFood()` is part of `bodyBusy` at
  index.js:1572, and famineHold's 8-minute indoor sit runs *inside* that latch.
  Same bug class either way: **a survival hold is itself suppressible-of-survival-
  commands**. The redesign removes the class, not the instance.
- **The gearup back-off compounds the ratchet.** `worldMem.gearup = {fails: 15,
  until: …}` (provision.js:2913, live world-memory.json) silences re-arming for up
  to 45 min — precisely when a naked bot most needs gear. `planner.gearUp` already
  bypasses the back-off for banked iron (planner.js:479); it has no bypass for
  "free armor is sitting in a grave 3b away."
- **"No maintenance pass" is partially wrong** (see F1): the routines exist; the
  *scheduling and admissibility* around them is broken. Good news — most of this
  redesign is re-wiring, not new capability.

---

## 2. Defense in depth — the layer model (the spine of this design)

Four independent layers, ordered cheap/frequent → last-resort. Each assumes the
layers above it CAN fail. An implementer should be able to point at any line of new
code and say which layer it belongs to.

| layer | property | mechanism | bounds a failure to | section |
|---|---|---|---|---|
| **(a) Invariants** | bad states are *rare* | pure scheduler: admissibility, producer-scheduling, named wakes; proactive buffers | n/a (prevention) | §3, §4 |
| **(b) In-process watchdog** | any freeze is *bounded* | progress heartbeats + danger-scaled escalation (20s windows when vitals critical, 120s otherwise) | seconds–minutes of lost time | §6 |
| **(c) Non-compounding recovery** | a death/freeze is a *blip, not a ratchet* | recovery ladder (graves first), persisted ledgers, back-offs that never silence recovery, banked progress | one death's worth of loss, then monotone re-climb | §5, §7 |
| **(d) External supervisor** | a *total* wedge (hung event loop / promise — invisible to all in-process logic) is caught | out-of-process liveness probe in run.js: /state probe + heartbeat file; nudge → restart | ≤ ~90s of silence, then a clean restart into (c) | §8 |

Layer (d) is deliberately independent of the bot's own logic being correct — it
watches externally observable signals only. Layer (c) is what makes (d) safe: a
restart (or a death) lands in persisted state (world-memory.json, chest-cache.json,
persisted death ledger, persistedResume build) from which the recovery ladder
re-climbs, so "kill it and restart" is always a legal move, never a loss spiral.

---

## 3. Layer (a) — target architecture: the scheduler/arbiter model

### 3.1 What stays (unchanged contracts)

- **arbiter.js stays THE survival authority.** `jobSurvivalNeed` /
  `jobMayProgress` (arbiter.js:119) and the maneuver ledger
  (`beginManeuver`/`maneuverActive`) keep their tiers (SURVIVE 3 > PRESERVE 2 >
  PROGRESS 1 > IDLE 0). Nothing below re-implements threat/hp/food detection.
- **resources.js stays the single source of truth** (withdraw > craft > gather;
  `reconcile`/`acquire`/`ensureFood`). All new jobs provision through it.
- **navigate.js stays the ONE nav entry point** + its recovery ladder. No inline
  stall hacks anywhere in the new code.
- **pathfix.js / scaffold.js verification contracts untouched.**
- **Body-level reflexes stay reflexes**: flee/defend, drowning, auto-eat
  (index.js:664), gaze/leash — millisecond-scale, correctly bypass any job model.
- **Single-goal discipline holds**: one job owns the body; only survival preempts.

### 3.2 The new piece: `bot/scheduler.js` (PURE, offline-tested)

A pure decision module (no bot handle, mirrors arbiter.js's style) answering, from
a snapshot: *which ONE job should own the body right now, and is this incoming
command admissible?* provision.js grows a `schedulerState(bot)` snapshot builder
(superset of `survivalState`, provision.js:3714).

**Snapshot fields** (plain data):

```js
{
  hp, food, packFoodPts,          // vitals + edible points carried (foodTier<2, food.js)
  armorPieces,                    // provision.armorPieceCount (provision.js:1848)
  threatDist, creeperDist, isNight, nightStuck, drowning, inLava,
  graves: [{ dist, value, dangerous, hasGear }],   // commands death ledger snapshot
  homeDist,                       // XZ to hut anchor (hutAnchor, provision.js:2548)
  bankFoodPts,                    // CACHED chest counts only (totalCounts cachedOnly)
  farm: { exists, dist, ripeLikely }, orchard: { dist, readyAt },
  gearupBackoffUntil, deathsRecent,                // deaths in the last 20 min
  activeJob: { name, cls, startedAt, lastProgressAt, blockedOn } | null,
  brainJobPending, persistedBuild                  // operator build on disk
}
```

**Job classes** (ordered; class beats age):

| cls | members | may preempt |
|---|---|---|
| `survival` | recoveryLadder, graveSweep, secureFood, recoverHp, nightShelter | progress, maintain, idle |
| `progress` | build (operator), gearup, mine, gather, brain travel/goto | maintain, idle |
| `maintain` | maintenancePass (food/gear/tool/torch buffers, harvest, bank courier) | idle only |
| `idle` | cosmetic reflexes (unchanged) | — |

`maintain` deliberately CANNOT interrupt `progress` — the operator's single-goal
rule. `survival` preempting `progress` is the one legal interrupt; today that
happens through ad-hoc "fires even while busy" reflexes (FOOD_CRISIS/HP_CRISIS,
index.js:742/768) — the scheduler makes it the *only* mechanism.

**API** (all pure):

```js
pickJob(snapshot)              // -> { job, cls, reason, preempt } | null (null = idle)
recoveryPlan(snapshot)         // -> ordered rungs (§5)
commandClass(line)             // -> 'survival' | 'progress' | 'perception' | 'chat'
admissible(cmdClass, snapshot) // -> { allow, reason }  (replaces the busy-gate regex)
needProducer(need)             // -> job name (the blocked-on-X map)
watchdog(activeJob, vitals, now) // -> 'ok' | 'nudge' | 'fail-job'  (§6)
```

### 3.3 Deadlock-freedom invariants (each unit-tested)

- **I1 — Survival is always admissible.** `admissible('survival', s)` is true
  whenever `arbiter.jobSurvivalNeed(s) != null` OR a non-dangerous worthwhile grave
  is within `GRAVE_NEAR` (default 16b) — *regardless* of `busy`/latches. A
  survival command from the brain (`recover`, `eat`, `wear`, `sleep`) does not
  bypass the body: it triggers **preemption** — the running progress job's stop
  latch is set (`buildAbort` / job `isStopped`), the command runs, the job resumes
  via its existing resume path (builds already survive this: `persistedResume` /
  `markBuildInterrupted`, commands.js:143). A survival command when NO survival
  need exists stays held exactly as today (the brain must not cancel an operator
  build on a whim — index.js:1552's rationale stands).
- **I2 — Blocked-on-X schedules the producer of X. No busy-waiting.** Every long
  job returns `{ ok, blockedOn }` instead of spinning or silently holding. The
  producer map: `food → secureFood`, `heal → recoverHp`, `shelter → nightShelter`,
  `gear → gearup`, `iron → mine`, `wood/planks/tool → resources.acquire` chain
  (which already implements withdraw > craft > gather). The map is a DAG by
  construction; if walking it revisits a need (food needs a trek, trek needs heal,
  heal needs food), the cycle-break is **rung R0 of the recovery ladder** (§5):
  consume what exists, grab the nearest win, or take the ONE bounded hold whose
  wake provably occurs (dawn). There is no other wait state.
- **I3 — Nearby graves are a first-class survival action.** `pickJob` returns
  `graveSweep` (cls `survival`) whenever a non-dangerous worthwhile grave is within
  `GRAVE_NEAR` and no active threat/flee — **even at food 0 / hp 1**: at 3 blocks
  the grave IS the survival move (armor + often food, zero trek risk).
  `shouldChaseGrave` gets the matching fix (§9 commands.js). Beyond `GRAVE_NEAR`
  the fed+safe gating stands, but deferral is re-evaluated on every scheduler tick,
  not once per respawn.
- **I4 — One body owner, honest preemption.** Exactly one scheduler-dispatched job
  runs at a time (ONE module latch replacing today's five ad-hoc ones —
  `_securingFood`, `gearing`, `toppingUpFood`, `buildingFoodSupply`,
  `survivalHunting`). Preemption = set the victim's stop latch, await its bounded
  unwind, start the survival job. The maneuver ledger keeps arbitrating the
  *pathfinder* underneath, unchanged.
- **I5 — Holds must name their wake.** Any wait state carries
  `{ wake: 'dawn'|'hp>=N'|'foodInPack'|…, deadlineMs <= 90000 }` and re-enters the
  scheduler on expiry. A wake must be something that provably occurs (dawn) or a
  condition another *scheduled* job is actively producing. `famineHold` as it
  exists (provision.js:4054 — waits for food to materialize) is deleted; §5 R5 is
  its replacement.

### 3.4 The busy gate rework (index.js:1572)

Replace the single `bodyBusy && !readOnlyRegex` check with:

```js
const cls = scheduler.commandClass(line)         // pure, tested
if (cls === 'perception' || cls === 'chat') -> allow (as today)
if (cls === 'survival') {
  const s = provision.schedulerState(bot)
  const a = scheduler.admissible('survival', s)
  if (a.allow) -> preempt current job (stop latch) + run command
  else -> hold with a.reason ("no survival need - not interrupting the build")
}
if (cls === 'progress') -> exactly today's behavior (held while busy; held while a
                            persisted build waits; stop-suppression unchanged)
```

The `stop`-suppression and persisted-build protections (index.js:1568,1591) are
untouched — they guard *operator intent* and are orthogonal.

Net effect on the live incident: the brain's `recover` at minute 1 classifies
`survival`, `admissible` is true (hp 1 ⇒ `heal` need; grave 3b), famineHold's latch
is preempted, and the graves — iron armor + possibly food — are back on the bot in
two minutes. But the brain is a backstop, not the fix: §5 makes the *body* do this
unaided.

---

## 4. Layer (a) — proactive maintenance model

Goal: the bot never *arrives* at a crisis with empty buffers. The routines exist;
the new parts are buffers, cadence, and one courier behavior.

### 4.1 Buffers (constants in new pure `bot/maintain.js`, env-overridable)

| buffer | target | floor (triggers maintain) | measured via |
|---|---|---|---|
| pack food | ≥ 24 food-pts (≈ 5 bread) | < 12 pts | inventory + `foodTier` < 2 |
| home bank food | ≥ 40 food-pts in hut chests | < 16 pts | resources cached counts (`cachedOnly`) |
| armor | 4/4 pieces | < 4 | `armorPieceCount` |
| tools | working pick + axe + sword + spare pick | any missing | pick helpers (provision.js:1180) |
| torches | ≥ 8 | < 4 | `countItem` |
| food bar | ≥ 18 (eat from pack when < 18 and safe) | — | auto-eat (unchanged) |

Pure `maintain.needs(snapshot)` returns the ordered unmet-buffer list — what
`pickJob` consults for the `maintain` class. Unit-test ordering (food before gear
before torches) and hysteresis.

### 4.2 The maintenance pass (`provision.maintenancePass`, new orchestrator)

Runs as ONE `maintain`-class job when: no progress job active, no survival need,
daylight or safely indoors, `maintain.needs()` non-empty. Steps, each an existing
verified routine, each individually skippable:

1. **Harvest the orchard when ripe** — `worldMem.orchard.harvestReadyAt` already
   persists; today nothing *acts* on it until a wood gather happens by. Trek +
   harvest + replant while fed and armored.
2. **Tend/harvest the farm on ripeness cadence** — `tendWheatFarm`
   (provision.js:3520) + `ensureWheatFarm` expansion, no longer only inside
   `secureFood`/`ensureFoodSupply`. At most once per ~20 min (wheat is slow).
3. **Cook + bake at home** — `cookRawMeat`, bread from wheat via
   `resources.reconcile` (never raw inventory math).
4. **Courier: stock the HOME cache.** New: after harvest/cook, deposit food surplus
   into the *hut* bank (`resources.autoBank` near `hutAnchor`), keeping the pack
   buffer. This is how the far-flung geography is handled **without moving
   anything**: the farm stays at its water (z=12); a fed bot carries produce home
   so the bed-adjacent chest always holds ≥ 40 pts. A future famine's R2 rung (§5)
   then resolves 3 blocks from the respawn point, not 76.
5. **Gear/tools/torches** — `planner.gearUp` when under-armored (back-off applies
   here — maintenance must not churn a barren site; the back-off *bypasses* for
   near-graves/banked-iron per §7), tool top-up, `ensureTorches`.

Cadence + believability: dispatched from the scheduler tick with ±30% jitter and a
5-min per-sub-step hysteresis, so it reads as a player doing chores between jobs,
not a metronome. Existing chat lines already cover the natural-player surface.

### 4.3 What this replaces

FOOD_TOPUP (index.js:726), FOOD_SUPPLY (index.js:806) and the gear reflex
(index.js:866) stop being independent competing timers and become `maintain.needs()`
entries dispatched by the one scheduler tick. Executors (`secureFood` threshold-14
top-up, `ensureFoodSupply`, `armorup`) are kept as-is. Env kill-switches kept
through migration (§10).

---

## 5. Layer (c) — the recovery ladder from a degraded state (first-class)

The recoverability pillar. Pure `scheduler.recoveryPlan(snapshot)` returns an
ordered rung list; `provision.recoverFromDegraded(bot)` (new orchestrator, cls
`survival`) executes the first feasible rung, then **re-snapshots and re-plans** —
each rung changes the world (grave gear enables the trek; eating enables regen).
Entered whenever `pickJob` sees a degraded signature:
`hp <= 6 || food <= 6 || (armorPieces == 0 && graves.length) || deathsRecent >= 2`.

Ordering principle: **most-urgent-survivable first, nearest-win first, never a wait
that depends on the world spontaneously changing.** Distance NEVER disqualifies a
rung — it only sequences it after the free wins, and shapes *how* the trek is done.
"Naked + starving + far from supply" must always map to a non-empty plan.

- **R0 — Consume what exists (seconds, zero risk).** Eat pack food
  (`eatUp`/`eatBestFood`, raw-gate rules unchanged); `wearFromPack` any carried
  armor. Drowning/lava/active threat are reflex-owned and outrank, as today.
- **R1 — Nearest safe win: the graves.** Any non-dangerous worthwhile grave within
  `GRAVE_NEAR_LADDER` (32b for the ladder; 16b for the standing pickJob rule):
  `commands.handle('recover')` (the hardened AxGraves logic, commands.js:1364, is
  reused verbatim), then wear + eat what came back. Night with a hostile camped on
  the grave: pit first (R2), grab at dawn — the night gate inside `recover`
  (commands.js:1393) already does this; keep it as *shelter then proceed*, never
  abandon.
- **R2 — Shelter + raid the home cache.** Hut/bed within ~48b: get indoors (the
  `famine-home` nav profile as today), `resources.ensureFood({forceFresh: true})`
  on the hut bank, cook, eat; if night — sleep (`sleepInBedHere`): a hold whose
  wake (dawn) provably occurs. No hut in range but night + exposed:
  `digInForNight` pit (existing). This rung is where §4.2's courier cache pays off.
- **R3 — Harvest owned supply, at ANY distance.** Farm and orchard treks, sequenced
  *after* R0-R2 so the bot travels with whatever gear/food the cheap rungs
  restored. Trek shape, all existing primitives: `walkStaged`/`travelFar` by
  daylight, eat en route (auto-eat), `restUntilSafe` when night falls mid-trek
  (provision.js:4139 — its maxFails hand-back is right), arrive → `tendWheatFarm` /
  orchard harvest → eat → carry surplus home (courier step). 76b or 300b changes
  the duration, not the feasibility.
- **R4 — Acquire new supply.** The existing `secureFood` steps 3-6 (hunt visible →
  fish → `scoutForFood` octant sweep), each bounded as today.
- **R5 — The ONLY hold.** Reached iff R0-R4 are all infeasible *right now* (night,
  nothing in reach, scout night-gated). Replaces `famineHold` with `boundedHold`:
  prefer bed-sleep (wake=dawn, skips the night — starvation stops at half a heart,
  provision.js:3832, so a slept night at 1hp indoors is survivable); else sealed
  pit until dawn; hard re-eval every 90s (not 480s); extra wakes: foodInPack /
  grave-appeared / animal ≤ 24b. On `nightStuck` (frozen night) R5 is skipped —
  re-run the ladder, which takes R3/R4 by night with pit-shelter discipline,
  because on an eternal night waiting is provably non-terminating (same reasoning
  as arbiter.js:145).
- **Death-ratchet guard** (`deathsRecent >= 2`): does NOT shrink the radius or
  forbid treks — it biases *sequencing*: R2 shelter and bed/spawn re-assert
  (`recoverSpawnAnchor`, provision.js:3015) are forced before R3/R4, and treks
  defer to daylight. Recovery slows down; it never gives up.

The respawn handler (index.js:535) keeps its order (home → spawn-anchor → grave)
but its grave step delegates to `recoveryPlan` instead of the one-shot
`shouldChaseGrave` call — deferral becomes "the ladder picks it up on the next
tick", not "wait for the next death".

Believability: this ladder IS what a human does after a death spiral — run to your
grave, gear up, eat, sleep the night, walk to the farm. It reads more natural than
the current freeze, not less.

---

## 6. Layer (b) — forward-progress watchdog (bounded freezes)

**Invariant: if actionable work exists, within 30s the body is executing a job; if
a job runs, it demonstrates progress within a danger-scaled window or is escalated.**

- **What counts as progress** (a `touchProgress()` heartbeat on the activity record
  — commands.js `beginActivity`/`endActivity` grow `lastProgressAt`): moved ≥ 8b
  toward a nav target (reusing the stuck-detector samples, commands.js:221); a
  dig/place/craft/smelt verified by pathfix; an item-count delta; a job sub-goal
  completed; a *declared* hold heartbeat (`boundedHold` counts only while its
  wake+deadline are valid — I5). Long smelts already poll furnace slots
  (`runSmelt`) — hook `touchProgress` there against false positives.
- **Danger-scaled windows** (the "seconds, not minutes" requirement): the watchdog
  window is a function of vitals, not a constant —
  `hp <= 6 || food <= 2` → **20s** nudge / 40s fail-over;
  survival-class job active → 45s / 90s;
  otherwise → 120s / 240s.
  Rationale: a frozen famine-response at 1hp must be broken before chip damage
  kills; a slow gather stall can afford patience.
- **Escalation ladder** (one index.js interval ~5s; decision fn `scheduler.watchdog`
  is pure):
  1. window exceeded → **nudge**: log loudly, set the job's `blockedOn='stalled'`,
     let the job's own recovery (navigate ladder, forceUnstick) act — many stalls
     self-heal.
  2. second consecutive window → **fail-job**: set the stop latch, record an honest
     outcome (`recordOutcome`), persist back-off where one exists (`gearupResult`
     pattern), hand to `pickJob` — which sees `blockedOn` and schedules the
     producer (I2) or the next job.
  3. **Idle-with-work**: no active job AND `pickJob` non-null for > 30s → dispatch.
     This alone kills the "sat frozen while graves gleamed 3b away" class,
     independent of every other fix.
- Existing inner watchdogs stay (navigate stall/force-unstick, `restUntilSafe`
  maxFails, chest dead-tracking) — this is the *outer* guarantee that was missing.
- What this layer canNOT catch — and hands to layer (d): a hung event loop, a
  never-resolving promise inside the watchdog's own process, a crashed interval.

---

## 7. Layer (c) — spiral-resistance: deaths and freezes must not compound

Design rules that make the ratchet structurally impossible. Several are properties
the code already has (kept and named as invariants); the rest are gaps this design
closes. Each is a testable statement:

- **S1 — A death moves value into graves; recovery of graves is never gated on the
  state the death caused.** The old gate deferred a 3b grave because the corpse-run
  had made the bot hungry (commands.js:131 before :134). Fixed by I3 + the
  `shouldChaseGrave` distance-first rework (§9). Graves re-checked every scheduler
  tick, not once per death (fixes the retry-only-on-next-death ratchet).
- **S2 — Back-offs may throttle *acquisition*, never *recovery*.** The gearup
  back-off (provision.js:2913) exists to stop fruitless mining churn — correct. It
  must be bypassed when gear is FREE: banked iron (already, planner.js:479) or a
  worthwhile grave ≤ 48b (new). Similarly the dead-chest cooldown (resources.js:57)
  already keeps cached counts and allows last-resort reads when starving — keep.
- **S3 — Progress is banked, so a death's loss is bounded to the pack.**
  `gearUp` already banks loose iron at run end (planner.js:534); maintenancePass
  extends the principle to food (courier, §4.2). Worn armor and banked goods
  survive a death; only pack contents go to the grave — and S1 gets those back.
- **S4 — All recovery-relevant state survives a process restart.** Already true:
  death ledger (`persistDeath`), world-memory (bed/hut/farm/graves' coordinates via
  ledger), chest-cache, persistedResume build, spawn-suspect flag
  (provision.js:2944 — persisted *because* the RAM flag once died mid-crisis).
  New scheduler state is deliberately *stateless* (recomputed from a snapshot each
  tick) so a restart loses nothing but the in-flight job — which resumes or
  re-plans idempotently. This is what makes layer (d)'s restart a safe move.
- **S5 — Respawn always improves the anchor before spending resources.** The
  existing respawn order (home → re-assert bed/spawn → graves, index.js:577-645)
  is the anti-carousel and is kept: every respawn makes the NEXT death land at
  home, monotonically shrinking the problem.
- **S6 — "Naked + starving + far" is a solvable input by construction.**
  `recoveryPlan` is total: for every snapshot it returns at least one rung (R5's
  bounded, dawn-waking hold in the worst case). Unit test: sweep the full
  (hp, food, gear, graveDist, homeDist, night, deathsRecent) grid and assert a
  non-empty plan with no unnamed waits.

---

## 8. Layer (d) — the external supervisor (the ultimate backstop)

No in-process rule can catch a hung event loop or a never-settling promise wedging
the whole decision loop. run.js (bot/run.js) is already the out-of-process parent —
today it only restarts on **exit** (run.js:20). Extend it into a liveness
supervisor. Concretely:

### 8.1 Signals (all externally observable; no dependence on bot logic being right)

1. **Heartbeat file.** index.js writes `bot/heartbeat.json` every 5s from a plain
   `setInterval`: `{ t, hp, food, pos, activity, lastProgressAt, connected }`.
   A wedged event loop stops writing it — that is the point.
2. **HTTP probe.** `GET 127.0.0.1:3001/state` with a 5s AbortController timeout
   (the control API already exists; brain-llm.js already fetches it with timeouts).
3. **Frozen-vitals check** on the probe result: same `pos` AND same `activity`
   AND `lastProgressAt` older than 5 min while `activity != null` — the
   "alive-but-wedged" case where HTTP still answers but nothing moves (this
   backstops layer (b) itself being broken).

### 8.2 Escalation ladder (in run.js, ~80 lines, poll every 15s)

1. **Healthy** — heartbeat fresh (< 30s) and probe answers: do nothing.
2. **Wedged-but-responsive** — probe answers but frozen-vitals trips: POST
   `/cmd` `stop`, wait 20s, then POST `/cmd` `recover` (post-§3.4 these classify
   correctly: `stop` from this path is the *supervisor*, not the brain — send it
   with an `X-Supervisor: 1` header that index.js exempts from the brain's
   stop-suppression, since that suppression guards against the *brain*, not ops).
   Log the intervention. If still frozen on the next two polls → step 3.
3. **Silent** — heartbeat stale > 90s OR probe times out 3 consecutive polls
   (~45s): `child.kill()`. run.js's existing restart loop brings it back with the
   existing quick-crash back-off (run.js:23-25). S4 guarantees the restart lands in
   recoverable persisted state; the respawn/startup path runs the recovery ladder.
4. **Bounded interventions** — supervisor actions are rate-limited (≥ 10 min
   between kills unless the child exited on its own) and every intervention is
   appended to `logs/supervisor.log`, so a crash-looping bug surfaces to the
   operator instead of masking itself.

### 8.3 Boundaries

- The supervisor never makes gameplay decisions — its only verbs are `stop`,
  `recover`, and restart. It cannot grief, build, or move the bot.
- It is ~100 lines of dependency-free node in the existing run.js process; testable
  offline by pointing it at a mock HTTP server + stale heartbeat file
  (`bot/supervisortest.js`).

Worst case with all four layers: a novel bug wedges the process → ≤ ~90s of
silence → restart → persisted state intact → recovery ladder reclaims graves and
buffers → the incident cost is minutes, not a death spiral. That is the success
criterion met even for bugs this design has never seen.

---

## 9. Concrete change list (per file)

**NEW `bot/scheduler.js`** — PURE, no bot handle. Exports: `pickJob`,
`recoveryPlan`, `commandClass`, `admissible`, `needProducer`, `watchdog`,
`JOB_CLASSES`, `_setNow`. ~250 lines.
**NEW `bot/schedulertest.js`** — offline suites: (a) the live livelock snapshot
(hp 1, food 0, naked, grave 3b, busy=securingFood) MUST yield graveSweep /
admissible-recover; (b) blocked-on chains resolve to producers, cycles break to R0;
(c) maintain never preempts progress; (d) recoveryPlan totality sweep (S6) incl.
"far supply never disqualified"; (e) watchdog danger-scaled windows + nudge→fail
sequencing; (f) every hold carries a valid wake.

**NEW `bot/maintain.js`** — PURE buffer model: `needs(snapshot)`, buffer constants,
hysteresis. **NEW `bot/maintaintest.js`**.

**`bot/index.js`**
- Replace the `bodyBusy` suppression block (index.js:1572-1586) with the
  class-based gate (§3.4). Keep stop-suppression + persisted-build holds verbatim;
  add the `X-Supervisor` exemption (§8.2).
- ONE scheduler tick interval (~15s + jitter): build
  `provision.schedulerState(bot)`, `pickJob`, dispatch via a single job-latch
  runner (executors are existing functions: `commands.handle('recover')`,
  `provision.secureFood`, `provision.recoverFromDegraded`,
  `provision.maintenancePass`, `commands.handle('armorup')`). FOOD_TOPUP /
  FOOD_SUPPLY / SURVIVAL_HUNT / GEAR_REFLEX / FOOD_CRISIS / HP_CRISIS become thin
  delegates (kept behind their env flags through migration; flee/defend/drown/
  auto-eat/gaze/shelter reflexes untouched).
- Watchdog interval (§6) with danger-scaled windows.
- Heartbeat writer (§8.1).
- Respawn handler grave step (index.js:620-645): route through
  `scheduler.recoveryPlan` instead of one-shot `shouldChaseGrave`.

**`bot/commands.js`**
- `shouldChaseGrave` (commands.js:126): near-grave override — `dist <= GRAVE_NEAR
  (16)` and `!dangerous` and `!threat` ⇒ chase regardless of food/hp; the food gate
  moves AFTER distance classification. PURE — extend `gravegatetest.js`
  (food-0 + 3b grave ⇒ chase; food-0 + 90b grave ⇒ defer).
- `beginActivity`/`endActivity`: add `touchProgress()` + `lastProgressAt`.
- Expose `gravesSnapshot()` (dist/value/dangerous/hasGear per unretrieved grave).

**`bot/provision.js`**
- `schedulerState(bot)` — superset of `survivalState` (provision.js:3714), §3.2.
- DELETE `famineHold` (provision.js:4054); add `boundedHold` (§5 R5) and
  `recoverFromDegraded` (the ladder executor). `secureFoodInner` step 7
  (provision.js:3957) calls `boundedHold`; `secureFood` returns
  `{ fed, blockedOn }` so I2 has data.
- `maintenancePass(bot, opts)` (§4.2) composing existing tend/ensure/cook/bank.
- Consolidate the ad-hoc latches into the one job-latch (I4); keep
  `isSecuringFood()` as a compat view.

**`bot/planner.js`**
- `gearUp`: thread `blockedOn` out of `runGoal`'s failure reason into the return;
  back-off bypass when a grave holding armor is ≤ 48b (mirror of the banked-iron
  bypass, planner.js:469-483).

**`bot/run.js`** — the liveness supervisor (§8.2): heartbeat/probe poll, nudge,
kill; `logs/supervisor.log`. **NEW `bot/supervisortest.js`** (mock HTTP + stale
heartbeat file).

**`bot/arbiter.js`** — unchanged (optionally export PRIORITY for scheduler reuse).
**`bot/navigate.js`, `bot/resources.js`, `bot/mining.js`, `bot/pathfix.js`,
`bot/scaffold.js`** — unchanged. `world-memory.json` — no schema change required
(orchard.harvestReadyAt, gearup, bed, infra already exist).

Pure + unit-tested: scheduler.js, maintain.js, the `shouldChaseGrave` fix,
`commandClass`/`admissible`, `watchdog`, `recoveryPlan`, the supervisor decision
logic. Orchestrators (`maintenancePass`, `recoverFromDegraded`, `boundedHold`) are
thin compositions of already-live-verified routines — light-gate smoke only.

---

## 10. Migration & test plan (independently shippable slices)

Per the build-agent light gate: each slice = `node --check` + unit tests + ONE
bounded live smoke on the test server (Paper, real generated terrain — NEVER
flat/synthetic), driven/observed by a Sonnet subagent polling `/state` + `/log`;
full money-tests only where dig/build behavior changes (none of these slices adds a
dig path).

- **S1 — Break the livelock (hotfix, ship first).** `shouldChaseGrave` near-grave
  override + busy-gate survival-class admissibility (hard-coded class list is fine
  pre-scheduler) + famineHold deadline 480s→90s with bank-recheck + dawn-sleep
  wake. Live proof: recreate the degraded state (op `/kill` the bot once near its
  hut carrying iron, `/effect give hunger`, verify food≈0/naked/grave≈3b), then
  watch: grave grabbed + gear worn + eating within ~2 min, zero
  "brain command suppressed" lines for `recover`/`eat`/`wear`.
- **S2 — External supervisor (independent of everything else — ship early, it
  protects all later slices' live tests).** run.js liveness ladder + heartbeat
  writer + supervisortest. Live proof: `kill -STOP` the child (simulated hang) →
  restart within ~90s; freeze `activity` via a debug endpoint → nudge path fires.
- **S3 — scheduler.js + maintain.js pure modules** + full suites. No wiring; zero
  live risk.
- **S4 — Wire the survival tier.** Scheduler tick dispatches
  graveSweep/secureFood/recoverHp; FOOD_CRISIS/HP_CRISIS/SURVIVAL_HUNT become
  delegates. Live: S1 drill again + a mid-`gather` hunger (op hunger effect during
  a wood gather) — job preempted, fed, job resumed.
- **S5 — Recovery ladder.** `recoverFromDegraded` + respawn-handler routing. Live
  rock-bottom drill: naked, food 0, hp ≤ 4, graves 3b, farm 76b — the log must
  show R0→R1(graves)→R2(indoors/eat or sleep)→R3(farm trek) in order and an
  unaided return to fed+armored. Repeat with graves 200b away (post-far-death) to
  prove distance-never-defeats. Then the spiral drill: 3 rapid op-kills — assert
  each respawn strictly *improves* (anchor re-asserted, graves reclaimed, no
  gear-bleed across loops).
- **S6 — Maintenance + home cache.** Live: 1h fed-idle observation — orchard
  harvested when `harvestReadyAt` passes, bread banked in the HUT chest, pack
  topped to buffer, no interruption of an operator build started mid-hour.
- **S7 — In-process watchdog.** Progress telemetry + danger-scaled escalation.
  Live: induce a stall (gather an unreachable target / op-fence the bot) at full
  vitals — nudge ~2 min, fail-over ~4 min; repeat at hp 4 — nudge ≤ 20s,
  fail-over ≤ 60s; never silent.

Rollback: every slice behind an env flag (`SCHEDULER=0`, `RECOVERY_LADDER=0`,
`MAINTAIN=0`, `WATCHDOG=0`, `SUPERVISE=0`) reverting to today's wiring, matching
the codebase convention (BRANCH_MINE=0 etc.).

---

## 11. Non-goals / risks / open questions

**Non-goals:** relocating farm/orchard or distance-gating treks (red herring — see
preamble); rewriting nav/build/mining; multi-job concurrency; new perception or
world-map features (semantic-map is a separate approved track); brain-prompt
changes beyond optionally surfacing `job`/`blockedOn` in `/state`; any change to
anti-grief movement profiles; proving global deadlock-freedom (explicitly replaced
by the layered bounded-failure model, §2).

**Risks:**
- *Double-fire during migration* — old reflexes + scheduler dispatching the same
  executor. Mitigation: the single job-latch (I4) + delegate-not-duplicate wiring
  in S4; existing per-flow latches stay as belt-and-suspenders until S7.
- *Supervisor-induced churn* — a too-eager kill loop is its own spiral. Mitigation:
  rate-limited kills (§8.2.4), supervisor.log, and S4's guarantee that restarts are
  loss-free; the quick-crash back-off in run.js already exists.
- *Believability regression* — a metronomic chore loop or instant job-switching
  reads robotic. Mitigation: jittered cadence, hysteresis, 2-window watchdog
  damping; observe in S6.
- *Watchdog false positives* on legitimately slow steps (long smelts, big treks).
  Mitigation: `touchProgress` hooks in smelt/nav loops; danger-scaled windows mean
  patience exactly when patience is cheap.
- *Preemption unwind bugs* — a stopped progress job that doesn't resume. Builds
  already survive this (persistedResume); gather/gearup resume by re-planning from
  holdings (the resource model makes them idempotent). Verify explicitly in S4.
- *Snapshot cost* — `schedulerState` on a 15s tick must use `cachedOnly` chest
  counts (resources.totalCounts opts) — never walk the bot from a tick.

**Open questions (decide during implementation; none block S1-S3):**
- Exact buffer numbers (§4.1) — tune from live observation in S6.
- Should `maintain` run indoor sub-steps (cook/bake/craft) at night? (Leaning yes;
  treks stay day-gated.)
- Surface `blockedOn`/`job` in /state so the brain's chatter stays grounded?
  (Leaning yes — cheap, improves believability.)
- `GRAVE_NEAR` 16 vs 24 — pick after measuring typical death-to-respawn distances
  at the live base.
- Does `nightShelter` migrate into the scheduler now or stay a reflex? (It
  coordinates with nightStuck/forceUnstick subtly — leaning: stays a reflex until
  S7 proves the scheduler stable.)
- Supervisor `stop` authority: header-based exemption (§8.2) vs a dedicated
  localhost-only `/supervisor` endpoint — pick whichever keeps the brain-
  confinement story simplest to audit.
