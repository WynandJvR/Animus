# Animus — Findings & Operating Notes

Hard-won notes from getting the AI bot running well on this machine + the live server.
Read this before debugging "it's slow / it griefs / it ignores me" again.

---

## 1. Hardware & inference (the core constraint)

- **GPU: RTX 5070 Ti, 16 GB VRAM** — the *only* CUDA-visible GPU.
- **RTX 3070 Ti (8 GB) is NOT used by Ollama** (not exposed to CUDA). Enabling it → 24 GB total, which *would* let 26–32B models run fully on GPU. Not set up.
- Ryzen 5 5600X (6c/12t), 32 GB RAM.
- **Ollama 0.30.10** (upgraded from 0.20.7 — older version couldn't pull newer model manifests).
- Ollama env opts already set (help, but don't change the VRAM ceiling): `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_CONTEXT_LENGTH=32768`.

**Key rule:** at Q4, ~14B is the max that fits **fully on GPU** (fast). 26B/35B (17–27 GB) spill to CPU → **15–45 s/decision = unusable** for a real-time bot. It's a **VRAM-capacity** limit, not GPU speed. Flash-attn / q8-KV shrink the *context*, not the *weights*.

---

## 2. The brain model — what works (THE key discovery)

| Model | Speed (real bot prompts) | Verdict |
|---|---|---|
| `qwen2.5:14b` | ~0.7–1.2 s | fast but dumb — fixates, spams, ignores requests |
| **`qwen3:14b`** | **~0.5–1 s** (thinking OFF) | **winner — fast AND good at natural language** |
| `qwen3:14b` via OpenAI `/v1` | **5–43 s** | thinking can't be disabled there → unusable |
| `gemma4:12b` | ~18–25 s | too slow even though it fits GPU |
| `gemma4:26b` / `qwen3.5:35b-a3b` | 15–45 s | spill to CPU — unusable; fine for *coding* (not real-time) |

**Qwen3 has a hybrid "thinking" mode. It MUST be disabled or it's as slow as the big models.**
The OpenAI-compatible `/v1/chat/completions` endpoint **cannot** turn it off. Ollama's **native `/api/chat` with `think:false`** can.

**Working brain config (env for `brain-llm.js`):**
```
LLM_URL=http://127.0.0.1:11434/api/chat
OLLAMA_NATIVE=1
LLM_MODEL=qwen3:14b
```
(`brain-llm.js` switches request shape + response parsing on `OLLAMA_NATIVE`.)

Reasoning/"thinking" models are the wrong tool for a ~1 s control loop. Avoid them.

---

## 3. Running against a live / online-mode server

(Fill in your own host/ports below — placeholders here so nothing personal is published.)

- Host: **`your-server.example.com`** (or a LAN/tailnet IP like `10.0.0.5`).
- **Java: port `25565`** (typical) — e.g. Paper **1.21.11**, online-mode, crossplay (Geyser+Floodgate), ViaVersion.
- **Bedrock (Geyser): UDP `19132`.**
- **Watch out for a web-map port** (e.g. BlueMap on `8100`) — it is NOT the MC port. Connecting mineflayer there hangs, because it speaks the MC protocol to an HTTP server.
- online-mode → bot needs **`MC_AUTH=microsoft`** (device-code login, first run prints a `microsoft.com/link` code). The bot's Microsoft account must be **op** on the server for `!`build/admin commands.

**Launch the Java body against a live server:**
```
MC_HOST=your-server.example.com MC_PORT=25565 MC_AUTH=microsoft MC_VERSION=1.21.11 node index.js
```
(`index.js` reads `MC_HOST/MC_PORT/MC_USERNAME/MC_AUTH/MC_VERSION`; `MC_VERSION=auto` = autodetect, but if the server disables status/SLP you must pin the version, e.g. `1.21.11`.)

---

## 4. ⚠️ FRAGILE: the mineflayer enchant-crash patch

mineflayer **4.37.1** `lib/plugins/digging.js` (`digTime`) assumes `item.enchants` is an array and calls `.concat` → **`enchantments.concat is not a function`** on 1.21 **enchanted** tools. This crashes any `dig` while holding enchanted gear (the account's diamond tools).

**Patched** by guarding `Array.isArray(...)` on held + helmet enchants.
**NOW DURABLE (2026-06-26):** `index.js` re-applies the guard at spawn via
`installDigTimeGuard(bot)`, which overrides `bot.digTime` (the function `bot.dig`
calls) with an `Array.isArray`-guarded version. This lives in the repo, so a future
`npm install` that wipes the `node_modules/` edit can no longer break tool-use.
(The node_modules edit is now redundant but harmless.) Verified: `break dirt` digs
cleanly with the override installed.

---

## 5. Anti-grief lessons (learned the hard way on the LIVE world)

These were real incidents on the live server — keep them fixed:

- **Pathfinder was digging through builds.** `setupMovements`: `canDig=false`, `allow1by1towers=false`, empty `scafoldingBlocks`, `canOpenDoors=true`. (Tradeoff: it now fails to path into sealed/gapped spots instead of tunneling — intended.)
- **`mine <name>` would hunt down crafted blocks (planks/glass) in builds.** Now: only **natural** blocks (`MINABLE` allowlist, anchored so `polished_*`/`*_bricks`/`raw_*_block` don't leak) are searched far (≤32); **crafted blocks only break if ≤4 blocks away** ("break these planks"). Never falls back to breaking a random looked-at block when a named target isn't found.
- **`say` strips a leading `/`** so a brain reply can't run a server/op command (the bot is op).
- **Brain is confined**: `CHEAT_CMDS` (`give/fill/setblock/clear/wall/tower/house/gamemode/tp`) are blocked on the `POST /cmd` path (operators keep them via in-game `!commands`). No eval/shell/fs anywhere; control API is `127.0.0.1`-only.
- **`AUTO_CREATIVE` off by default** — bot never changes gamemode on its own (it once flipped the account to creative).
- **Combat safety**: never melee/attack **players** (entity-type check, not name), never auto-melee **creepers** (it **flees** them), never melee ghast/warden/wither.

---

## 6. Behavior-tuning lessons

- **"Vary your actions / don't repeat" → fidgeting** (it inserted pointless turn/scan/stop between follows). Replaced with *"calm following or waiting is correct; don't fidget."*
- **Tasks that take time must BLOCK to completion**, or the brain reverts to `follow` mid-task and "runs back." `come`/`goto` now `await pathfinder.goto`; `break` chops the whole tree (cap 8); `hunt` chases (cap ~8 hits). Bounded so the brain isn't frozen too long.
- **Player requests must dominate the prompt** — surfaced loudly at the top of the user message (`unanswered`), delivered for `MAX_DELIVERIES` ticks, else the model under-weights them.
- **Chat: speak only when addressed** (gate on `lastAddressedAt > lastReplyAt`) + cooldown + dedupe — kills random chatter and spam-kicks.
- **Tools ≠ hardcoding.** Commands are the bot's *hands* (every agent has a fixed action set); the *behavior* (when/how) is the brain's, and it's autonomous. Adding commands expands capability, it does not script behavior.
- **Idle change-detector (2026-06-26) — the big efficiency/naturalness win.** The brain used to fire a full LLM inference every tick (~0.5s) even when nothing changed — measured ~100 identical `follow` decisions in 50s while just following someone. Now `brain-llm.js` computes a `signature()` of the SALIENT state (player *names* present, nearest threat bucket, hp/food buckets, day/night, pending-chat count) and, when it's unchanged AND no one's waiting, it **holds the current behaviour and polls cheaply** (`IDLE_POLL_MS=900`) instead of re-deciding — the body keeps executing the active goal (a `follow` keeps tracking a moving player on its own). It still thinks instantly on any real change, on a player chat, or every `IDLE_HEARTBEAT_MS=15000` as a slow heartbeat. Re-measured: ~14 decisions over the same kind of window. Player distance is deliberately left OUT of the signature so a moving follow-target doesn't wake the LLM each step.
- **Don't surface the bot's own name as a target.** `findPlayer()` named-branch now excludes `bot.username`; when *alone* the brain used to read `name:"Claudebot"` + `players:[]` and issue `follow Claudebot` (following itself → idle jitter). Now `follow/come <ownname>` returns "no player", `state` exposes `alone:true`, and the prompt says never follow/come yourself — so alone = it waits calmly.
- **One request → one action.** A pending chat is re-offered for `MAX_DELIVERIES` ticks; that used to make a single "follow me" re-fire ~6×. Now the body clears the pending request as soon as the brain takes a *fulfilling* action (anything except the preparatory perception cmds `scan/find/entities/block/look/state/inventory`), so a "look first, then answer" sequence still completes but "follow me" fires once.
- **Equip-first rule was misfiring.** Asked "what are you holding?", the model would `equip <random item>` first (the prompt's old literal `diamond_shovel` example leaked into the action). Prompt now scopes equip-first to explicit hold/show/equip *requests* and says a "what are you holding?" question is answered straight from `heldItem`.
- **Follow distance.** `GoalFollow` range was `2` → bot crowded the player ("too close"). Now `FOLLOW_RANGE` (default `3`, env-tunable) → measured ~4 blocks while walking, settling ~2.8 standing. Note `GoalFollow` only ever *closes* distance, never backs away, so a player walking into the parked bot is briefly close — inherent, not worth a custom goal. (`hunt` keeps range 2 — it needs to be in melee.)
- **New perception fields the brain can reason on:** `biome` (now actually populated — read from the solid block below, not the air at the feet), `threat` (`{type,dist,flee}` for the nearest hostile, so it can retreat/flee vs. fight instead of relying only on the reflex auto-defend), and `alone`.

---

## 7. Current capabilities (all natural-language driven via the brain)

perceive (state/scan/find/block/entities/inventory/look) · move (come/goto/follow/stop/turn) ·
break|mine (right tool, whole tree, natural-only far / crafted ≤4) · collect · plant (replants at last chop spot) ·
place · craft (walks to a table) · hunt (food animals) · sleep/wake · attack/defend (+auto-defend, creeper-flee) ·
eat (+auto-eat) · drop · equip · say · anti-AFK. Operator-only via in-game `!`: build/give/gamemode/tp.

---

## 8. Known limitations / future ideas

- **Can't go to a player it can't see** (vanilla client only knows nearby entity positions). Needs coords, or an op `tpto` (declined — cheat).
- **No strip-mining** — only mines *exposed* ore. "go mine iron" on the surface → "no iron nearby". A real `stripmine` (dig down, branch-mine, follow veins) is a possible future feature.
- **Bedrock body (`index-bedrock.js`) is written but NOT live-tested.** It now has the `CHEAT_CMDS` confinement block on its `/cmd` path (added 2026-06-26, mirrors the Java body), but still lacks auto-eat/auto-defend/anti-AFK.
- Growing the toolset further → use **grammar / tool-calling** (constrained output) so a small model reliably picks from a big menu.
- ~~Make the mineflayer patch durable~~ — DONE (see §4, `installDigTimeGuard`).
