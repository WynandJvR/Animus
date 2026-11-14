# Running Animus on your own server (Java / Microsoft account)

One-time setup, then it's a double-click every time.

## One-time setup

1. **Make sure Ollama has the brain model** (only needed once):
   ```
   ollama pull gemma4:12b
   ```
   And make sure Ollama is running (it usually runs in the background on Windows).

2. **Point the bot at your server** - edit `bot2/config.json` (the `//` notes below are explanation only - leave them
   out of the real file, JSON has no comments):
   ```json
   {
     "host": "your-server-address.com",   // your server's IP or hostname
     "port": 25565,                        // your server's Java port (usually 25565)
     "username": "your-account@email.com", // the Microsoft account the bot logs in as
     "auth": "microsoft",                  // <-- change from "offline" to "microsoft"
     "version": "26.2",                    // your server's Minecraft version
     "operators": ["YourInGameName"],      // who may drive it with !commands (your MC name)
     "aliases": ["claude"],
     "controlHost": "127.0.0.1",
     "controlPort": 3001
   }
   ```
   - `operators` = the players allowed to command it in chat with `!` (put YOUR in-game name here).

3. **Have `git` and Node.js 22+ installed.** On its first start the panel installs the bot's dependencies and adds the
   Minecraft 26.2 data (`patch-mc262.js`, which fetches it with git). It checks for that data on every Start and adds it
   again if it is missing; if the activity log says the patch FAILED, run `node patch-mc262.js` in `bot2/` yourself.

## Every time - just launch it

- **Double-click `Animus.exe`** (in the project root), or run `Animus.exe --start` to open the panel and start
  straight away.

The Animus panel starts and owns both processes:
- **the bot** - connects to your server. **On the very first run** it prints a `microsoft.com/link` code - open that
  link in a browser and enter the code to log the bot's account in (it caches after that).
- **the brain** - the local model that talks and advises.

To stop: press Stop in the panel (closing the panel stops both).

## Driving it in-game

- Just talk to it - say its name and it responds (e.g. "Claudebot, what are you building?").
- As an operator (your name in `operators`), use `!commands` for the powerful stuff:
  - `!build <schematic> <x> <y> <z>` - build a blueprint from `bot2/schematics/` in survival (the coords are its centre)
  - `!buildcost <schematic>` - what a blueprint needs
  - `!status`, `!home`, `!stop`, and `!help` for the rest
- Non-operators can chat with it but can't run `!commands`.

## If something's off

- **Bot never spawns:** wrong host/port/version, or the Microsoft login wasn't finished. Read the `[bot]` lines in the panel's activity log.
- **Brain does nothing / errors:** Ollama isn't running, or `gemma4:12b` isn't pulled (`ollama pull gemma4:12b`).
- **"not an operator":** add your exact in-game name to `operators` in `bot2/config.json`.
- Prefer the terminal? Run the two pieces by hand - see the Quickstart and brain sections of `README.md`.
