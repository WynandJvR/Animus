#!/usr/bin/env bash
# Stop the lab and release its RAM (recommended when not actively testing,
# so the live server keeps full headroom).
LAB="$(cd "$(dirname "$0")" && pwd)"
echo "stopping bot..."
# ORDER MATTERS: run.js is a SUPERVISOR that restarts index.js within seconds, so
# killing the body alone just gets it resurrected - that is why this script appeared
# to do nothing. Supervisor first, then the body, then the brain.
pkill -f "$LAB/bot/run.js" 2>/dev/null || pkill -f "node run.js" 2>/dev/null || true
sleep 1
pkill -f "$LAB/bot/index.js" 2>/dev/null || pkill -f "node index.js" 2>/dev/null || true
pkill -f "brain-llm.js" 2>/dev/null || true
sleep 1
# VERIFY rather than assume: the control port is the honest test.
if curl -s --max-time 3 http://127.0.0.1:3001/health >/dev/null 2>&1; then
  echo "STOP FAILED: :3001 still answers - the bot is still up"
else
  echo "bot stopped (:3001 closed)."
fi
echo "stopping test server..."
[ -f "$LAB/logs/testserver.pid" ] && kill "$(cat "$LAB/logs/testserver.pid")" 2>/dev/null || true
# fall back to matching our jar if pid file is stale
pkill -f "paper-1.21.11-69.jar" 2>/dev/null || true
sleep 2
ss -tln 2>/dev/null | grep -qE ':25599|:3001' && echo "WARN: something still listening" || echo "lab stopped."
free -h | awk 'NR==1||/Mem/'
