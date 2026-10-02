#!/bin/bash
# watchdog.sh: runs until an ALARM condition appears (or 60 min pass: HEARTBEAT), then prints why and exits.
# Always restart it after handling the alarm. Conditions are read from the live log + op console every 60s.
L=/c/mc-bot-lab/logs/bot2-events.log
op () { curl -s -m 10 -X POST http://127.0.0.1:3001/op/cmd -H 'Content-Type: application/json' -d "{\"command\":\"$1\"}"; }
done_now () { op buildstatus | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).done)}catch{console.log(-1)}})"; }
since () { date -d "-$1 min" +%Y-%m-%dT%H:%M; }
recent () { awk -v t="[$(since $1)" 'substr($0,1,17) >= t' $L; }
start=$(date +%s); last_done=$(done_now); last_change=$(date +%s)
while true; do
  sleep 60
  now=$(date +%s)
  # the bot process itself
  st=$(op status); for i in 1 2 3; do [ -n "$st" ] && break; sleep 10; st=$(op status); done; if [ -z "$st" ]; then echo "ALARM: op console not answering for 30s (bot down?)"; exit 0; fi
  d=$(recent 10 | grep -ac "(death) died")
  [ "$d" -ge 3 ] && { echo "ALARM: $d deaths in 10 min"; recent 10 | grep -a "(death) died" | cut -c2-200 | tail -5; exit 0; }
  f=$(recent 15 | grep -aoE "\(dir\) [a-zA-Z]+ did not succeed \(([4-9]|[1-9][0-9]+) in a row\)" | tail -1)
  # (only while it is STILL failing: the task run again since its last failure and not failed again has recovered - a yard
  #  fill that took after a restart alarmed for 15 more minutes, 2026-10-02)
  tn=$(echo "$f" | awk '{print $2}'); lf=$(grep -a "(dir) $tn did not succeed" $L | tail -1 | cut -c2-24); ld=$(grep -a "(dir) -> $tn:" $L | tail -1 | cut -c2-24)
  recovered=0; if [ -n "$f" ] && [ -n "$ld" ] && [[ "$ld" > "$lf" ]]; then nxt=$(awk -v t="[$ld" 'substr($0,1,24) > t' $L | grep -a "(dir) " | head -3 | grep -ac "$tn did not succeed"); [ "$nxt" = 0 ] && [ "$(awk -v t="[$ld" 'substr($0,1,24) > t' $L | grep -ac "(dir) ")" -ge 1 ] && recovered=1; fi
  [ -n "$f" ] && [ "$recovered" = 0 ] && { echo "ALARM: repeated failure: $f"; recent 15 | grep -a "did not succeed" | cut -c2-160 | tail -5; exit 0; }
  c=$(recent 10 | grep -aoE "\(dir\) -> [a-zA-Z]+" | sort | uniq -c | sort -rn | awk '$1>=6 && $3 ~ /level|fix|farm|tidy|hideout|grave/ {print; exit}')
  [ -n "$c" ] && { echo "ALARM: churn: $c in 10 min"; exit 0; }
  h=$(recent 10 | grep -ac "(dir) -> hideout")
  tod=$(curl -s -m 5 http://127.0.0.1:3001/state | grep -o '"timeOfDay":[0-9]*' | cut -d: -f2); day=$([ -n "$tod" ] && [ "$tod" -ge 1000 ] && [ "$tod" -le 11500 ] && echo 1)
  h5=$(recent 5 | grep -ac "(dir) -> hideout")
  [ "$h" -ge 3 ] && [ "$h5" -ge 1 ] && [ -n "$day" ] && { echo "ALARM: hiding $h times in 10 min"; recent 20 | grep -a "(dir) -> hideout" | cut -c2-160 | tail -3; exit 0; }
  t=$(echo "$st" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.task&&j.task.name)+' '+(j.task&&j.task.forSec))}catch{}})")
  set -- $t; [ -n "$2" ] && [ "$2" != "null" ] && [ "$2" -gt 1200 ] && [ "$1" != "sleep" ] && [ "$1" != "expedition" ] && { echo "ALARM: task $1 running ${2}s"; exit 0; }
  # (a silent loop: one line - timestamps off, coordinates kept - 40+ times in 10 min. The strip loop (637 dead clicks) and
  #  the mine's corridor ping-pong (240 "turning") ran for hours under every other alarm, 2026-09-28)
  sp=$(recent 10 | cut -c32- | grep -av "(op) \|(body)\|(vital)" | sort | uniq -c | sort -rn | awk '$1>=40 {print; exit}')
  [ -n "$sp" ] && { echo "ALARM: log loop: $sp"; exit 0; }
  # (the same kind of line at different cells - "blocked at X", "won't place at Y": numbers normalised, 60+ in 10 min)
  sk=$(recent 10 | cut -c32- | grep -av "(op) \|(body)\|(vital)" | sed -E 's/-?[0-9]+(\.[0-9]+)?/#/g' | sort | uniq -c | sort -rn | awk '$1>=60 {print; exit}')
  [ -n "$sk" ] && { echo "ALARM: log loop (any cell): $sk"; exit 0; }
  # a throw in the pathfinder's tick (caught: one path reset - patch-mc262.js) or an uncaught crash: the body's faults
  # a gate the path opens refusing its click at one spot, 5+ times in 2 min: the stuck retry (move.js path_use_error)
  pu=$(recent 2 | grep -aoE "path_use_error at [-0-9]+,[-0-9]+,[-0-9]+" | sort | uniq -c | sort -rn | awk '$1>=5 {print; exit}')
  [ -n "$pu" ] && { echo "ALARM: stuck gate retry: $pu"; exit 0; }
  # walks giving up at ONE spot, 5+ in 10 min: trapped (a room, a crawlspace, a pit) - the escape should have fired
  gs=$(recent 10 | grep -aoE "gave up \(stuck x3\) at -?[0-9]+,-?[0-9]+,-?[0-9]+" | sort | uniq -c | sort -rn | awk '$1>=5 {print; exit}')
  [ -n "$gs" ] && { echo "ALARM: trapped - $gs"; exit 0; }
  # (the event loop stalled 2s+ three times in 10 min: the body froze - a deploy's search on the loop, 5-9s each, 3 in 3 min
  #  went unalarmed on 2026-10-02; body-first: a rollback trigger after a deploy)
  # (only stalls after the last deploy say anything of it - the ones before a rollback alarmed again after it)
  ld2=$(tail -1 /c/mc-bot-lab/tools/session-scripts/last-deploy.txt 2>/dev/null | cut -d' ' -f1)
  lg=$(recent 10 | awk -v ld="$ld2" '{ t = substr($0, 2, 16); if (ld == "" || t >= ld) print }' | grep -aoE "event loop stalled [0-9.]+s" | awk '{ if ($4+0 >= 2) n++ } END { print n+0 }')
  [ "$lg" -ge 3 ] && { echo "ALARM: event loop stalled 2s+ $lg times in 10 min (body-first) - last deploy $(tail -1 /c/mc-bot-lab/tools/session-scripts/last-deploy.txt 2>/dev/null | cut -d' ' -f1)"; recent 10 | grep -a "stalled in:" | tail -2 | cut -c2-220; exit 0; }
  pe=$(recent 10 | grep -ac "path_error #\|(crash) uncaught")
  [ "$pe" -ge 1 ] && { echo "ALARM: $pe path_error/crash lines in 10 min"; recent 10 | grep -a "path_error #\|(crash) uncaught" | cut -c2-200 | tail -3; exit 0; }
  # (a code error thrown by a task - a deploy's regression, not the world: "castle threw: TypeError: coverMiss is not
  #  iterable" ran 7 minutes after the 06:55 deploy with the rounds placing nothing, 2026-09-30. Named with the last deploy:
  #  by the no-regression rule a rollback trigger - restore the snapshot, then fix; audit)
  # (only an error AFTER the last deploy says anything of it: the 07:02 error, fixed by the 07:04 deploy, alarmed at 07:16
  #  and named the fix as the cause - ISO stamps compare as strings)
  ld=$(cut -d' ' -f1 /c/mc-bot-lab/tools/session-scripts/last-deploy.txt 2>/dev/null)
  ce=$(recent 15 | grep -a -E "threw: (TypeError|ReferenceError|SyntaxError|RangeError)" | awk -v ld="$ld" '{ t = substr($0, 2, 16); if (ld == "" || t >= ld) print }' | tail -1 | cut -c2-200)
  [ -n "$ce" ] && { echo "ALARM: CODE ERROR (rollback trigger) after deploy $(cut -d' ' -f1 /c/mc-bot-lab/tools/session-scripts/last-deploy.txt 2>/dev/null): $ce"; echo "  rollback: $(cat /c/mc-bot-lab/tools/session-scripts/last-deploy.txt 2>/dev/null)"; exit 0; }
  # (handwork stopped because its click did nothing - /state buildProgress.stoppedWork - for over 10 min)
  sw=$(curl -s -m 5 http://127.0.0.1:3001/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const w=(JSON.parse(s).buildProgress||{}).stoppedWork||[];console.log(w.map(x=>x.work).join(','))}catch{}})")
  if [ -n "$sw" ]; then [ -z "$sw_since" ] && sw_since=$now; [ $((now - sw_since)) -gt 600 ] && { echo "ALARM: handwork stopped >10 min: $sw"; exit 0; }; else sw_since=; fi
  cur=$(done_now); if [ "$cur" != "$last_done" ]; then last_done=$cur; last_change=$now; fi
  # (progress is any block placed, not only the blueprint's count: the foundation under the rim is not in the total, and
  #  168 of its blocks in 2.5h read as "stuck", 2026-09-29)
  recent 30 | grep -aq "build step: placed [1-9]" && last_change=$now
  # (away on an expedition the castle waits by design - its wood is what the trip fetches: not "stuck")
  exp=$(node -e 'try{console.log(require("C:/mc-bot-lab/bot2/memory.json").expedition?1:0)}catch{console.log(0)}'); [ "$exp" = 1 ] && last_change=$now
  # (and far from home - a respawn across the map walking back: the build's count cannot move from there, 2026-10-02)
  far=$(echo "$st" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const [x,,z]=j.pos.split(',').map(Number);console.log(j.home&&Math.hypot(x-j.home.x,z-j.home.z)>200?1:0)}catch{console.log(0)}})"); [ "$far" = 1 ] && last_change=$now
  tod=$(echo "$st" | grep -o '"tod":[0-9]*' | cut -d: -f2)
  if [ $((now - last_change)) -gt 1800 ]; then echo "ALARM: build stuck at $cur for $(( (now-last_change)/60 )) min"; exit 0; fi
  if [ $((now - start)) -gt 3600 ]; then echo "HEARTBEAT: 60 min, build $cur, deaths/60m $(recent 60 | grep -ac '(death) died')"; exit 0; fi
done
