#!/bin/bash
# gated-deploy.sh [maxSec]: waits until the bot is on the surface (or inside the safehouse), not in water, within 20 of
# home, hp >= 14, not at night, no threat within 16, no reflex running, not paused; then snapshots the code and restarts it. Exits 2 if the gate never opens.
S=$(cd "$(dirname "$0")" && pwd); lim=${1:-1800}; end=$((SECONDS+lim))
# (the code is fingerprinted NOW: a reconnect loads bot2 from disk, so an edit saved while the gate is shut would ship
#  unaudited - it nearly did twice on 2026-09-28. Changed when the gate opens = refused; start the deploy again)
fp () { cat /c/mc-bot-lab/bot2/main.js /c/mc-bot-lab/bot2/lib/*.js | md5sum | cut -d' ' -f1; }
FP0=$(fp); echo "code fingerprint $FP0 ($(git -C /c/mc-bot-lab rev-parse --short HEAD))"
while [ $SECONDS -lt $end ]; do
  st=$(curl -s -m 5 http://127.0.0.1:3001/state)
  ok=$(node -e "try{const j=JSON.parse(process.argv[1]);const h=j.home;const d=h?Math.hypot(j.pos.x-h.x,j.pos.z-h.z):99;const t=j.timeOfDay;const night=!(t>=1500&&t<11400);const threat=j.threat&&(j.threat.dist==null||j.threat.dist<16);const reflex=!!j.maneuver;console.log((!j.hazards.underground||d<8)&&!j.hazards.inWater&&d<20&&j.health>=14&&!night&&!threat&&!reflex&&!j.paused?'yes':'no')}catch(e){console.log('no')}" "$st")
  if [ "$ok" = yes ]; then
    [ "$(fp)" = "$FP0" ] || { echo "REFUSED: bot2 changed while the gate was shut - what is on disk now is not what this deploy was started for"; exit 3; }
    cd /c/mc-bot-lab/bot2; for f in main.js lib/*.js; do node --no-lazy --check "$f" || { echo "SYNTAX FAIL $f"; exit 1; }; done
    NODE_PATH=/c/mc-bot-lab/bot/node_modules node /c/mc-bot-lab/tools/session-scripts/xmodcheck.js /c/mc-bot-lab/bot2 > /dev/null || { echo "CROSS-MODULE NAME MISSING - run tools/session-scripts/xmodcheck.js"; exit 1; }
    PREV=$(ls -d $S/rollback/candidate-* 2>/dev/null | tail -1)
    N=$S/rollback/candidate-$(date +%H%M); mkdir -p $N; cp -r lib main.js $N/; cp ../bot/config.json $N/
    echo "$(date +%Y-%m-%dT%H:%M) prev=$PREV new=$N" > $S/last-deploy.txt # (rollback target = prev: the snapshot is of the NEW code)
    curl -s -m 5 -X POST -H "Content-Type: application/json" -d '{"reconnect":true}' http://127.0.0.1:3001/config; echo " deployed: $(cat $S/last-deploy.txt)"; exit 0
  fi
  sleep 15
done
echo "gate never opened"; exit 2
