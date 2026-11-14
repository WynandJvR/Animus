# Animus

*The mind that animates the body - a Minecraft bot that survives and builds on its own.*

Animus joins a server as an ordinary player. Dropped with nothing, it shelters,
feeds and gears itself, then builds a blueprint you give it - gathering every
material itself and placing every block by hand. No `/give`, no creative mode,
no `/fill`.

## How it works

A **body** acts and a **brain** talks. They are separate processes joined by a
local HTTP API.

| Part | What it owns |
|---|---|
| **Reflexes** (`lib/reflex.js`, every tick) | Survival: eat, fight or flee, air, edges and falls, digging in. They own the body whenever it is in danger. |
| **Director** (`lib/director.js`) | One task at a time, chosen from the live world: night, graves, gear, food, the farm, supply trips, the build. |
| **Skills** (`lib/*.js`) | Walking, digging and placing, crafting, gathering, mining, smelting, farming, shelter, and building from a blueprint. |
| **Brain** (`brain-llm.js`, optional) | A local model that chats in character and looks around. It does not drive the body's work. |

## Layout

```
Animus.exe / animus.cs   the Windows panel: settings, start/stop, live view (build with build-exe.ps1)
bot2/
  run.js                 supervisor - keeps main.js running (Animus starts this)
  main.js                the body: Mineflayer, reflexes, director, control API (:3001)
  brain-llm.js           the local-model brain; command.gbnf is its grammar
  lib/                   reflexes, director and skills
  schematics/            blueprints to build (.schem / .litematic / .nbt)
  patch-mc262.js         Minecraft 26.2 data for the protocol libraries
  config.example.json    copy to config.json (gitignored - holds your server address)
tools/                   deploy, monitoring and offline test scripts
```

## Requirements

- **Node.js 22+** and **git** (the 26.2 data patch clones from GitHub)
- **bash** for the helper scripts (Git Bash on Windows works)
- *Optional, for the brain:* [Ollama](https://ollama.com) or
  [llama.cpp](https://github.com/ggerganov/llama.cpp) and a GPU with ~16 GB VRAM

## Quickstart

On Windows, run **Animus.exe**: set the server and account, press Start. On first run
it installs the dependencies and the 26.2 data patch, then starts the bot and the
brain. [RUN.md](RUN.md) walks through it.

By hand:

```bash
cd bot2
npm install && node patch-mc262.js      # the patch again after every npm install
cp config.example.json config.json      # then point it at your server
node run.js
```

For an online-mode server set `"auth": "microsoft"`; the first run prints a
`microsoft.com/link` device code to sign in.

## Driving it

**In game.** Operators - the names in `operators` in `config.json`, empty by
default so nobody can command it - type `!<command>` in chat, for example
`!build <schematic> <x> <y> <z>`, `!status`, `!home`, `!stop`. `!help` lists the
main ones. Anyone can talk to the bot by saying its name; the brain answers.

**Over HTTP**, on `127.0.0.1:3001`:

```bash
curl -s http://127.0.0.1:3001/state      # world and self state as JSON
curl -s http://127.0.0.1:3001/health     # liveness
curl -s -X POST http://127.0.0.1:3001/op/cmd -H 'Content-Type: application/json' \
     -d '{"command":"help"}'             # the operator console
```

## The brain

With Ollama:

```bash
cd bot2 && LLM_URL=http://127.0.0.1:11434/api/chat OLLAMA_NATIVE=1 \
  LLM_MODEL=gemma4:12b node brain-llm.js
```

Use Ollama's native `/api/chat` with thinking off (`OLLAMA_NATIVE=1`). A thinking
model takes 5-40 s per reply instead of about 1 s, and the OpenAI-compatible `/v1`
endpoint cannot turn thinking off.

With llama.cpp, the bundled grammar forces valid JSON commands:

```bash
./llama-server -m your-model.gguf --port 8080 --grammar-file bot2/command.gbnf
cd bot2 && LLM_URL=http://127.0.0.1:8080/v1/chat/completions node brain-llm.js
```

## Security

The control API has **no authentication** and binds to `127.0.0.1`. Anything that
can reach port 3001 can drive the bot, so never expose it or bind it to `0.0.0.0`.

## License

MIT - see [LICENSE](LICENSE).
