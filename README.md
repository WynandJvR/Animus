# Animus

*The mind that animates the body - an AI-controllable Minecraft bot with a swappable brain.*

An AI-controllable Minecraft bot that joins a server as its own player, walks
around, and builds things on command. The **body** (the bot) is separate from
the **brain** (what decides). The brain is swappable:

- **Claude** - drives the bot interactively over a small local HTTP API.
- **A local model** (llama.cpp or Ollama) - drives it autonomously, offline.

Same body, same command surface, two brains.

## Architecture

A **brain** decides, a **body** acts. They talk over a local HTTP API, so either
side can be swapped or driven by hand.

```
            ┌─────────────┐       HTTP control API        ┌──────────────┐
 brain ───► │   main.js   │ ◄──── POST /cmd, GET /state ──│  Claude (curl)│
            │  (the body) │                                │  or you       │
            │  Mineflayer │ ◄──── same API ───────────────│  brain-llm.js │
            └─────┬───────┘                                │  (local model)│
                  │ Minecraft protocol                     └──────────────┘
            ┌─────▼───────┐
            │  MC server  │
            └─────────────┘
```

The body runs three layers:

| Layer | What it owns |
|---|---|
| **Reflexes** (`lib/reflex.js`, every tick) | Survival: eat, fight or flee, air and drowning, edges and falls, digging in. They own the body whenever it is in danger. |
| **Director** (`lib/director.js`) | One task at a time, chosen from the live world: night, graves, gear, food, the farm, supply trips and expeditions, the build. |
| **Skills** (`lib/*.js`) | Walking, digging and placing, crafting, gathering, mining, smelting, farming, shelter, the base, and building from a blueprint. |

The bot builds **physically in survival**: it acquires its own materials and
places every block by hand. No `/give`, no creative spawn, no `/fill` for
structures.

## Layout

```
animus/
├── Animus.exe / animus.cs   the Windows panel: settings, start/stop, live view (build with build-exe.ps1)
├── bot2/                    the bot
│   ├── run.js               supervisor - keeps main.js running (Animus starts this)
│   ├── main.js              the body: Mineflayer, the reflexes and director, HTTP API (:3001)
│   ├── brain-llm.js         the local-model brain (llama.cpp / Ollama); command.gbnf is its grammar
│   ├── body.js  access.js  chat-gate.js  pov.js  collision-margin.js  supervise.js ...
│   ├── lib/                 reflexes, director and skills
│   ├── schematics/          blueprints to build (.schem / .litematic / .nbt)
│   ├── patch-mc262.js       Minecraft 26.2 data for the protocol libraries (re-run after npm install)
│   └── config.example.json  copy to config.json (gitignored - holds your server address)
├── testserver/              isolated Paper test server (localhost, offline-mode, :25599)
└── tools/                   deploy and monitoring scripts
```

## Requirements

- **Node.js 18+** (for the bot).
- **bash** environment for the helper scripts - Linux, macOS, WSL, or Git Bash on
  Windows. Driving the bot from a shell uses `curl`.
- **A Paper 1.21.11 server jar** for the local test server (not bundled - see below).
- *Optional, for the local-model brain:* [Ollama](https://ollama.com) or
  [llama.cpp](https://github.com/ggerganov/llama.cpp), plus a GPU with enough VRAM
  (~16 GB runs a 14B model well - see [NOTES.md](NOTES.md)).

## Quickstart

On Windows, run **Animus.exe**: set the server and account on the left, press Start.
It installs the dependencies on first run and starts the bot and the brain.

By hand:

```bash
# 1) install the bot's dependencies (then the 26.2 data patch)
cd bot2 && npm install && node patch-mc262.js && cd ..

# 2) copy the example config and point it at your server
cp bot2/config.example.json bot2/config.json

# 3) start the bot (the supervisor keeps it running)
cd bot2 && node run.js
```

For the local test server, download a Paper jar from https://papermc.io/downloads/paper
into `testserver/` and start it with `testserver/start.sh` first.

### Driving the bot

The bot serves a control API on `127.0.0.1:3001`:

```bash
curl -s http://127.0.0.1:3001/state                       # full world/self state as JSON
curl -s http://127.0.0.1:3001/health                      # liveness check
curl -s -X POST http://127.0.0.1:3001/op/cmd -H 'Content-Type: application/json'      -d '{"command":"help"}'                               # operator commands (status, build, pause, ...)
```

## Local-model brain (autonomous, offline)

The bot can run itself with a local LLM via `brain-llm.js`. With Ollama:

```bash
cd bot && \
  LLM_URL=http://127.0.0.1:11434/api/chat OLLAMA_NATIVE=1 LLM_MODEL=gemma4:12b \
  GOAL="follow the player and build a small house" \
  node brain-llm.js
```

> **Use Ollama's native `/api/chat` with a non-thinking model.** Qwen3's "thinking"
> mode makes each decision take 5-40 s; the OpenAI-compatible `/v1` endpoint can't
> turn it off, but native `/api/chat` (`OLLAMA_NATIVE=1`) sends `think:false` and
> drops it to ~1 s. See [NOTES.md §2](NOTES.md) for the full model comparison and
> hardware notes - this is the single biggest factor in whether the bot feels good.

Or with llama.cpp, using the bundled grammar to force valid JSON commands:

```bash
./llama-server -m your-model-Q4_K_M.gguf --port 8080 --grammar-file bot2/command.gbnf
cd bot2 && LLM_URL=http://127.0.0.1:8080/v1/chat/completions \
  GOAL="follow the player and build a small house" node brain-llm.js
```

## Security

- **Localhost only.** The test server (`:25599`) and the bot control API (`:3001`)
  are bound to `127.0.0.1` and must stay that way. The lab runs **`online-mode=false`**
  with an **op + creative** bot - fine on loopback, trivially abusable if you expose
  those ports to the internet. Don't port-forward them; don't bind to `0.0.0.0`.
- The control API has **no authentication** by design (local dev tool). Anything that
  can reach `:3001` can drive the bot. Keep it local.
- The autonomous brain is confined: world-editing/admin commands
  (`give`/`fill`/`setblock`/`gamemode`/`tp`/build) are blocked on the `POST /cmd`
  path, and `say` strips a leading `/` so a reply can't run a server command.
  Operators keep full access via in-game `!commands`.

## In-game players & access

Players interact with the bot two ways:

- **Commands** - type `!<command>` in chat (`!house oak_planks`, `!come`,
  `!follow Steve`, `!tower stone 12`, `!stop`). These run only for **allowlisted
  operators**:

  ```json
  // bot2/config.json
  "operators": ["Steve", "Alex"],   // usernames allowed to run !commands
  "floodgatePrefix": "."            // stripped before matching Bedrock names
  ```
  Also overridable with env: `OPERATORS="Steve,Alex"` and `FLOODGATE_PREFIX="."`.
  An **empty list = nobody** can command the bot (locked down by default).

- **Natural conversation** - anyone can talk to the bot by **mentioning its name**
  (or a configured alias): "hey Claudebot, what are you building?". The body
  surfaces these in `/state.unanswered`; the brain (`brain-llm.js`) replies
  in-character with `say`. Requires the brain + a local model running. Replies use
  real chat (no op needed).

## Running against a live (online-mode) server

Set `auth` to `microsoft` in `bot2/config.json` (or in Animus) with an account the
server accepts. The first run prints a `microsoft.com/link` device code to sign in.

## Notes

- Building is **physical survival placement**: the bot gathers its own materials and
  places each block by hand from its inventory. `/fill` and `/setblock` remain only
  behind the legacy `wall`/`tower`/`house`/`clear` operator commands, not on the
  build path.
- [NOTES.md](NOTES.md) is the development history of the first runtime (retired) -
  the model and hardware findings in it still hold.

## License

MIT - see [LICENSE](LICENSE).
