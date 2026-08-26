# Animus launcher - starts the BOT (connects per bot/config.json) and the BRAIN
# (qwen3.5:4b via Ollama) in two windows. Edit bot/config.json once for your
# server, make sure Ollama has qwen3.5:4b, then run this. See RUN.md.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$botDir = Join-Path $root 'bot'

Write-Host "== Animus launcher ==" -ForegroundColor Cyan

# --- sanity checks ----------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "ERROR: 'node' is not on your PATH. Install Node.js and retry." -ForegroundColor Red
  Read-Host "Press Enter to close"; exit 1
}
if (-not (Test-Path (Join-Path $botDir 'node_modules'))) {
  Write-Host "Installing bot dependencies (first run)..." -ForegroundColor Yellow
  Push-Location $botDir; npm install; Pop-Location
}
# Ollama + model check (non-fatal - warn only)
$model = 'qwen3.5:4b'
try {
  $list = (& ollama list) 2>$null
  if ($list -notmatch [regex]::Escape($model)) {
    Write-Host "WARNING: Ollama does not have $model. Pull it first:  ollama pull $model" -ForegroundColor Yellow
  }
} catch {
  Write-Host "WARNING: could not reach Ollama ('ollama list' failed). Is Ollama running?" -ForegroundColor Yellow
}

# --- show what we're connecting to -----------------------------------------
$cfg = Get-Content (Join-Path $botDir 'config.json') -Raw | ConvertFrom-Json
Write-Host ("Bot will connect to {0}:{1}  (auth={2}, version={3}, name={4})" -f $cfg.host, $cfg.port, $cfg.auth, $cfg.version, $cfg.username)
if ($cfg.auth -eq 'microsoft') {
  Write-Host "First run: a microsoft.com/link CODE appears in the BOT window - open the link and enter it to log in your Java account." -ForegroundColor Cyan
}

# --- 1. start the BOT in its own window ------------------------------------
Write-Host "`nStarting BOT..." -ForegroundColor Green
# NAV_TERRAIN_PROFILE=1 (2026-08-26, operator's call): the bot may DIG NATURAL TERRAIN out in the
# wild. Off since it was written, which is why it could only ever walk on ground that already
# existed - it bridged over hills with carried dirt, wedged itself in tree canopies, and on
# 2026-08-26 sat in a river at 145,-116 for minutes unable to climb the bank while every survival
# job above it was killed by the watchdog for "no progress". Anti-grief is UNCHANGED and layered:
# nav-profile.breakExclusion refuses any block within 16b of own infra, inside the build zone +16b
# pad, or any crafted/scaffold type not registry-proven as the bot's own; canWildBreakType permits
# only natural terrain + leaves; wildAllowedAt only engages the dig profile 32b OUTSIDE home/build
# scope. Set to 0 (or unset) to revert to the no-dig profile instantly - the selector reads it per
# leg, so nothing else has to change.
# HEADLESS, WITH THE LOG AS THE RECORD (2026-08-26). These used to be `-NoExit` PowerShell windows
# titled 'Animus BOT' / 'Animus BRAIN'. A title is written ONCE into the command string and never
# updated, and -NoExit keeps the SHELL alive after node dies - so a window saying "Animus BRAIN"
# only ever meant "a shell here ran the brain at some point". Operator saw two BRAIN windows with
# one brain running and asked, fairly, why that is even possible. It is the same defect as every
# bug fixed today: a LABEL that does not track the WORLD.
# Nothing needs a console. Animus.exe is the control surface, it talks to the API on :3001, and
# stdout belongs in the log where it can be grepped after the fact (start-lab.sh already does this).
# No window can go stale if there is no window. To watch live: Get-Content -Wait on the log below.
$env:NAV_TERRAIN_PROFILE = '1'
Start-Process -FilePath (Get-Command node).Source -ArgumentList 'run.js' -WorkingDirectory $botDir `
  -RedirectStandardOutput (Join-Path $root 'logsot-stdout.log') `
  -RedirectStandardError  (Join-Path $root 'logsot-stderr.log') -WindowStyle Hidden

# --- 2. wait for the bot's control API to come up --------------------------
Write-Host "Waiting for the bot to spawn (a first-time Microsoft device code appears in logsot-stdout.log)..."
$up = $false
for ($i = 0; $i -lt 150; $i++) {
  try { Invoke-RestMethod -Uri 'http://127.0.0.1:3001/state' -TimeoutSec 2 | Out-Null; $up = $true; break }
  catch { Start-Sleep -Seconds 2 }
}
if (-not $up) {
  Write-Host "Bot did not come up on :3001 within ~5 min. Check the BOT window (login done? host/port/version right? account op on the server?)." -ForegroundColor Yellow
  Read-Host "Press Enter to still try starting the brain, or close this window to stop"
}

# --- the control surface is Animus.exe, NOT a browser ----------------------
# This used to Start-Process the URL. The browser dashboard was RETIRED when the
# native GUI landed (index.js: "the old browser dashboard is gone - the Animus GUI
# is the control surface now"), and :3001 has served a one-line string ever since.
# So the launcher was opening a tab that says "use the other thing".
if ($up) {
  Write-Host "Control surface: Animus.exe (the GUI). :3001 is the API it talks to." -ForegroundColor Cyan
}

# --- 3. start the BRAIN, also headless (proven Ollama-native config) --------
Write-Host "Starting BRAIN ($model via Ollama)..." -ForegroundColor Green
$goal = 'Stay near players, help when asked, and behave like a normal survival player.'
$env:LLM_URL = 'http://127.0.0.1:11434/api/chat'
$env:OLLAMA_NATIVE = '1'
$env:LLM_MODEL = $model
$env:BOT_URL = 'http://127.0.0.1:3001'
$env:GOAL = $goal
Start-Process -FilePath (Get-Command node).Source -ArgumentList 'brain-llm.js' -WorkingDirectory $botDir `
  -RedirectStandardOutput (Join-Path $root 'logsrain-stdout.log') `
  -RedirectStandardError  (Join-Path $root 'logsrain-stderr.log') -WindowStyle Hidden

# --- 4. the GUI is the control surface, so START IT ------------------------
# Operator rule: a restart that brings back the bot without the GUI leaves them blind, because the
# GUI - not a console - is how they actually watch the bot. The launcher used to print a line
# telling them Animus.exe was the control surface without ever opening it.
$exe = Join-Path $root 'Animus.exe'
if (Test-Path $exe) {
  if (-not (Get-Process Animus -ErrorAction SilentlyContinue)) {
    Write-Host "Starting the Animus GUI..." -ForegroundColor Green
    Start-Process -FilePath $exe -WorkingDirectory $root
  } else { Write-Host "Animus GUI already running." -ForegroundColor Cyan }
} else { Write-Host "WARNING: Animus.exe not found at $exe - build it with build-exe.ps1." -ForegroundColor Yellow }

Write-Host "`nDone - BOT, BRAIN and the GUI are running. No consoles: nothing to leave stale." -ForegroundColor Cyan
Write-Host "Logs:  logsot-stdout.log   logsrain-stdout.log   (Get-Content -Wait <path> to follow one)"
Write-Host "Stop:  .\stop-lab.sh, or Stop-Process on the node PIDs."
Write-Host "In-game, drive it as an operator with !commands (add your Minecraft name to 'operators' in bot/config.json)."
