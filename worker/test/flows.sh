#!/bin/bash
# The core flows of the cloud gateway that can run without the outside world: who a turn goes to (Muse or the Grok Bot) by the
# gadget's bot mode, what the device is told when the bot is not set up, the bad-input answers of /chat /tts /stt, and a forged callback.
# The bot's Webhook itself is not exercised here: the Worker only sends it to https addresses on public host names (so a stand-in on
# localhost is refused on purpose); that path was verified against a real bot, see docs/GATEWAY.md.
# Usage: worker/test/flows.sh   (needs node)
set -u
PORT=${PORT:-8795}   # not the smoke test's port, so a slow shutdown of the one cannot disturb the other
. "$(dirname "$0")/lib.sh"
gw_start
chat() { curl -s -m 30 -X POST "$B/chat?k=devtok" -H "X-Device: ${DEV:-homelink-aaaaaa}" -d "$1"; }
admin() { for i in 1 2 3 4 5; do r=$(curl -s -X POST "$B/admin/api?k=admtok${2:-}" -d "$1"); case "$r" in *'"ok":true'*) echo "$r"; return 0 ;; esac; sleep 1; done; echo "FAIL  admin save: $r"; fail=1; }

check    "a turn with no flag is for Muse (503)"       503 "$(code -X POST "$B/chat?k=devtok" -d '{"text":"hi"}')"
check    "a turn with no text is refused (400)"        400 "$(code -X POST "$B/chat?k=devtok" -d '{"away":true}')"
r=$(chat '{"text":"hello","away":true}')
contains "away: the acknowledgement comes first"       "收到" "$r"
contains "away without a bot set up: told it failed"   "bot_unreachable" "$r"
chat '{"text":"x"}' >/dev/null; wait_device homelink-aaaaaa
admin '{"config":{"bot":{"mode":"off"}},"over":["bot"]}' "&d=homelink-aaaaaa" >/dev/null
check    "bot mode off: away goes to Muse (503)"       503 "$(code -X POST "$B/chat?k=devtok" -H "X-Device: homelink-aaaaaa" -d '{"text":"hi","away":true}')"
DEV=homelink-bbbbbb chat '{"text":"x"}' >/dev/null; wait_device homelink-aaaaaa
admin '{"config":{"bot":{"mode":"always"}},"over":["bot"]}' "&d=homelink-bbbbbb" >/dev/null
r=$(DEV=homelink-bbbbbb chat '{"text":"hi"}')
contains "bot mode always: even a home turn goes to the bot" "收到" "$r"
check    "a gadget without an override still follows the rule" 503 "$(code -X POST "$B/chat?k=devtok" -H "X-Device: homelink-cccccc" -d '{"text":"hi"}')"
check    "/stt: under 0.1 s is an empty text"          '{"text":""}' "$(curl -s -X POST "$B/stt?k=devtok" -H 'x-sample-rate: 16000' --data-binary 'tiny')"
check    "/tts: no text means 400"                     400 "$(code -X POST "$B/tts?k=devtok" -d '{}')"
check    "a forged bot callback is refused"            403 "$(code -X POST "$B/bot-reply/0000/0000" -d '{"reply":"x"}')"
check    "an http Webhook address is refused when saved" 400 "$(code -X POST "$B/admin/api?k=admtok" -d '{"secrets":{"grokbot_url":"http://127.0.0.1:9/hook","grokbot_auth":"x"}}')"
finish
