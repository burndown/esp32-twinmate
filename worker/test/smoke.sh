#!/bin/bash
# Starts the Worker locally (workerd, no Cloudflare account) and checks the device and admin calls that must not break:
# the two tokens, device registration, per-device settings, blocking a lost gadget (and the tunnel key it holds), unblocking.
# Usage: worker/test/smoke.sh   (needs node; wrangler is fetched with npx at a fixed version)
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8797}; B=http://127.0.0.1:$PORT; TMP=$(mktemp -d); LOG=$TMP/wrangler.log
# a copy without the Workers AI binding: it always talks to Cloudflare, and the test needs neither an account nor the network
mkdir -p "$TMP/w"; cp -r src "$TMP/w/src"; awk '/^\[ai\]/{skip=1; next} /^\[/{skip=0} !skip' wrangler.toml > "$TMP/w/wrangler.toml"
cd "$TMP/w"
npx --yes wrangler@4.149.0 dev --local --ip 127.0.0.1 --port "$PORT" --persist-to "$TMP/state" --log-level warn \
  --var GATEWAY_TOKEN:devtok --var ADMIN_TOKEN:admtok --var WG_SERVER_PUB:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= --var WG_ENDPOINT:test.example.com >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; pkill -P $PID 2>/dev/null; rm -rf "$TMP"' EXIT
for i in $(seq 1 60); do curl -s -o /dev/null "$B/health?k=admtok" && break; sleep 1; done
fail=0
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: expected $2, got $3"; fail=1; fi
}
D=homelink-abcdef; P=$(head -c 32 /dev/urandom | base64)
BLOCK="{\"d\":\"$D\",\"block\":true}"; UNBLOCK="{\"d\":\"$D\",\"block\":false}"; ENROLL="{\"pub\":\"$P\"}"
APPROVE="{\"action\":\"approve\",\"pub\":\"$P\"}"; ASSIGN="{\"action\":\"assign\",\"pub\":\"$P\",\"d\":\"$D\"}"
check "health with admin token"            200 "$(code "$B/health?k=admtok")"
check "admin page without a token"         403 "$(code "$B/admin")"
check "admin page with the device token"   403 "$(code "$B/admin?k=devtok")"
check "admin page with the admin token"    200 "$(code "$B/admin?k=admtok")"
code -X POST "$B/chat?k=devtok" -H "X-Device: $D" -d '{"text":"hi"}' >/dev/null; sleep 1
check "device registered after a chat"     1 "$(curl -s "$B/admin/devices?k=admtok" | grep -c "\"d\":\"$D\"")"
check "per-device settings saved"          200 "$(code -X POST "$B/admin/api?k=admtok&d=$D" -d '{"over":["tts"],"cfg":{"tts":{"voice":"zh-CN-YunxiNeural"}}}')"
curl -s -o /dev/null -X POST "$B/wg/enroll?k=devtok" -H "X-Device: $D" -d "$ENROLL"
curl -s -o /dev/null -X POST "$B/admin/wg?k=admtok" -d "$APPROVE"
curl -s -o /dev/null -X POST "$B/admin/wg?k=admtok" -d "$ASSIGN"
check "block a device"                     '{"ok":true}' "$(curl -s -X POST "$B/admin/device?k=admtok" -d "$BLOCK")"
check "blocked: /chat with X-Device"       403 "$(code -X POST "$B/chat?k=devtok" -H "X-Device: $D" -d '{"text":"hi"}')"
check "blocked: /tts with d="              403 "$(code -X POST "$B/tts?k=devtok&d=$D" -d '{"text":"hi"}')"
check "blocked: /wg/enroll"                403 "$(code -X POST "$B/wg/enroll?k=devtok" -H "X-Device: $D" -d "$ENROLL")"
check "blocked: badge list"                403 "$(code "$B/badge/list?k=devtok&d=$D")"
check "another device is not blocked"      1 "$(code -X POST "$B/chat?k=devtok" -H "X-Device: homelink-111111" -d '{"text":"hi"}' | grep -vc 403)"
check "admin page works while blocked"     200 "$(code "$B/admin?k=admtok")"
check "tunnel key revoked on block"        0 "$(curl -s "$B/admin/wg?k=admtok" | grep -c '"ok":true')"
check "unblock a device"                   '{"ok":true}' "$(curl -s -X POST "$B/admin/device?k=admtok" -d "$UNBLOCK")"
check "unblocked: /chat works again"       1 "$(code -X POST "$B/chat?k=devtok" -H "X-Device: $D" -d '{"text":"hi"}' | grep -vc 403)"
[ $fail = 0 ] || { echo "--- wrangler log (tail)"; tail -20 "$LOG"; }
exit $fail
