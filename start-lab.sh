#!/usr/bin/env bash
# Start the isolated lab (test server + bot) on demand.
# Safe to run alongside the live server: tiny heap, localhost-only.
set -euo pipefail
LAB="$(cd "$(dirname "$0")" && pwd)"
export PATH="$LAB/node/bin:$PATH"
mkdir -p "$LAB/logs"

# The Paper jar is not stored in git. If the test-server runtime was cleaned up
# to free space, re-copy it from a local source. Override PAPER_JAR_SRC to point
# at wherever you keep a Paper 1.21.11 jar, or just download one from
# https://papermc.io/downloads/paper and drop it in testserver/.
JAR="$LAB/testserver/paper-1.21.11-69.jar"
if [ ! -f "$JAR" ]; then
  SRC="${PAPER_JAR_SRC:-/opt/minecraft/server/paper-1.21.11-69.jar}"
  if [ -r "$SRC" ]; then echo "restoring Paper jar from $SRC ..."; cp "$SRC" "$JAR"
  else echo "ERROR: $JAR missing and PAPER_JAR_SRC ($SRC) not readable — download a Paper 1.21.11 jar into testserver/"; exit 1; fi
fi

if ss -tln 2>/dev/null | grep -q 25599; then
  echo "test server already running on :25599"
else
  echo "starting test server..."
  ( cd "$LAB/testserver" && nohup ./start.sh > "$LAB/logs/testserver.log" 2>&1 & echo $! > "$LAB/logs/testserver.pid" )
  for i in $(seq 1 40); do grep -q 'Done (' "$LAB/logs/testserver.log" 2>/dev/null && break; sleep 1.5; done
  echo "server ready."
fi

if curl -s --max-time 3 http://127.0.0.1:3001/health >/dev/null 2>&1; then
  echo "bot already running on :3001"
else
  echo "starting bot..."
  ( cd "$LAB/bot" && nohup node index.js > "$LAB/logs/bot.log" 2>&1 & echo $! > "$LAB/logs/bot.pid" )
  for i in $(seq 1 15); do grep -q 'spawned as' "$LAB/logs/bot.log" 2>/dev/null && break; sleep 1.5; done
  echo "bot ready."
fi

echo "lab up. drive it with:  ./ctl.sh state   |   ./ctl.sh cmd \"house oak_planks 9 7 5\""
free -h | awk 'NR==1||/Mem/'
