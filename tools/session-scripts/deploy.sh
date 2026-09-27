#!/bin/bash
# gated deploy: waits (up to $1 s, default 600) until the bot is near home, hp>=14, no threat, reflex idle; then reloads
lim=${1:-600}; end=$((SECONDS+lim))
for f in /c/mc-bot-lab/bot2/main.js /c/mc-bot-lab/bot2/lib/*.js; do node --no-lazy --check "$f" || { echo "SYNTAX FAIL $f"; exit 1; }; done
while [ $SECONDS -lt $end ]; do
  s=$(curl -s -m 5 -X POST -H "Content-Type: application/json" -d '{"command":"status"}' http://127.0.0.1:3001/op/cmd)
  st=$(curl -s -m 5 http://127.0.0.1:3001/state)
  ok=$(node -e "try{const s=JSON.parse(process.argv[1]);const t=JSON.parse(process.argv[2]);const [x,y,z]=s.pos.split(',').map(Number);const h=s.home;const d=h?Math.hypot(x-h.x,y-h.y,z-h.z):0;const r=(t.reflex&&t.reflex.active)||t.reflexActive;console.log(s.hp>=14&&(!t.threat||t.threat.dist>=(+process.env.MIN_THREAT||99))&&d<=12&&!r?'yes':'no d='+Math.round(d)+' hp='+s.hp+' threat='+JSON.stringify(t.threat))}catch(e){console.log('no '+e.message)}" "$s" "$st")
  if [ "$ok" = yes ]; then curl -s -m 5 -X POST -H "Content-Type: application/json" -d '{"reconnect":true}' http://127.0.0.1:3001/config; echo; for i in $(seq 1 20); do sleep 3; grep -a "(boot) spawned" /c/mc-bot-lab/logs/bot2-events.log | tail -1 | grep -q "$(date +%Y-%m-%dT%H:%M)" && break; done; grep -a "(boot) spawned" /c/mc-bot-lab/logs/bot2-events.log | tail -1 | cut -c1-110; exit 0; fi
  sleep 10
done
echo "gate never opened: $ok"; exit 2
