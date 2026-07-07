# Animus launcher - starts the BOT (connects per bot/config.json) and the BRAIN
# (qwen3:14b via Ollama) in two windows. Edit bot/config.json once for your
# server, make sure Ollama has qwen3:14b, then run this. See RUN.md.

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
$model = 'qwen3:14b'
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
$botCmd = "Set-Location '$botDir'; `$host.UI.RawUI.WindowTitle='Animus BOT'; node run.js"
Start-Process powershell -ArgumentList @('-NoExit', '-Command', $botCmd)

# --- 2. wait for the bot's control API to come up --------------------------
Write-Host "Waiting for the bot to spawn (finish the Microsoft login in the BOT window if prompted)..."
$up = $false
for ($i = 0; $i -lt 150; $i++) {
  try { Invoke-RestMethod -Uri 'http://127.0.0.1:3001/state' -TimeoutSec 2 | Out-Null; $up = $true; break }
  catch { Start-Sleep -Seconds 2 }
}
if (-not $up) {
  Write-Host "Bot did not come up on :3001 within ~5 min. Check the BOT window (login done? host/port/version right? account op on the server?)." -ForegroundColor Yellow
  Read-Host "Press Enter to still try starting the brain, or close this window to stop"
}

# --- open the dashboard in the browser -------------------------------------
if ($up) {
  Write-Host "Opening dashboard: http://127.0.0.1:3001" -ForegroundColor Cyan
  Start-Process 'http://127.0.0.1:3001'
}

# --- 3. start the BRAIN in its own window (proven Ollama-native config) -----
Write-Host "Starting BRAIN (qwen3:14b via Ollama)..." -ForegroundColor Green
$goal = 'Stay near players, help when asked, and behave like a normal survival player.'
$brain = @"
Set-Location '$botDir'
`$host.UI.RawUI.WindowTitle = 'Animus BRAIN'
`$env:LLM_URL = 'http://127.0.0.1:11434/api/chat'
`$env:OLLAMA_NATIVE = '1'
`$env:LLM_MODEL = '$model'
`$env:BOT_URL = 'http://127.0.0.1:3001'
`$env:GOAL = '$goal'
node brain-llm.js
"@
Start-Process powershell -ArgumentList @('-NoExit', '-Command', $brain)

Write-Host "`nDone - two windows open: 'Animus BOT' and 'Animus BRAIN'." -ForegroundColor Cyan
Write-Host "In-game, drive it as an operator with !commands (add your Minecraft name to 'operators' in bot/config.json)."
Write-Host "Close either window to stop that part."
