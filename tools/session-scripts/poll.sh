#!/bin/bash
# poll.sh [sleep-seconds]: after the sleep, status + notable events since the last poll (marker = line count)
sleep ${1:-0}
S=$(cd "$(dirname "$0")" && pwd) # (its own folder: the marker and window files live beside it)
L=/c/mc-bot-lab/logs/bot2-events.log
last=$(cat $S/poll.mark 2>/dev/null || echo 0); now=$(wc -l < $L); [ "$now" -lt "$last" ] && last=0; echo $now > $S/poll.mark
s=$(curl -s -m 5 -X POST -H "Content-Type: application/json" -d '{"command":"status"}' http://127.0.0.1:3001/op/cmd)
node -e "try{const s=JSON.parse(process.argv[1]);console.log(new Date().toTimeString().slice(0,8),'pos',s.pos,'hp',s.hp,'food',s.food,'task',s.task&&s.task.name+': '+s.task.detail+' '+s.task.forSec+'s','| build',s.build&&s.build.done+'/'+s.build.total,s.paused?'PAUSED':'')}catch(e){console.log('status?',String(process.argv[1]).slice(0,200))}" "$s"
tail -n +$((last+1)) $L > $S/poll.win
echo "new lines $(wc -l < $S/poll.win) | deaths $(grep -ac '(death) died' $S/poll.win) | lag $(grep -ac '(lag)' $S/poll.win) | loops $(grep -ac 'something is looping' $S/poll.win) | edge $(grep -ac 'edge: stopped' $S/poll.win) | heal $(grep -ac 'healed\|-> heal' $S/poll.win) | fails $(grep -ac 'did not succeed' $S/poll.win)"
grep -a "(dir) ->" $S/poll.win | sed 's/^\[[^T]*T\([0-9:]*\)[^]]*\] (dir) -> /\1 /' | cut -c1-110 | uniq | tail -8
grep -a "(death)\|edge: stopped\|(lag)\|healed\|dig-in\|(grave)\|crash\|threw\|remembered\|forgotten\|gave up\|stuck\|dive broken\|boat:" $S/poll.win | tail -10 | cut -c12-220
