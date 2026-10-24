#!/bin/bash
# Devices and admin: the two tokens, device registration, per-device settings, blocking a lost gadget (and the tunnel key it holds),
# unblocking. Usage: test/smoke.sh   (needs node; wrangler is fetched with npx at a fixed version)
set -u
. "$(dirname "$0")/lib.sh"
gw_start
D=homelink-abcdef; P=$(head -c 32 /dev/urandom | base64)
BLOCK="{\"d\":\"$D\",\"block\":true}"; UNBLOCK="{\"d\":\"$D\",\"block\":false}"; ENROLL="{\"pub\":\"$P\"}"
APPROVE="{\"action\":\"approve\",\"pub\":\"$P\"}"; ASSIGN="{\"action\":\"assign\",\"pub\":\"$P\",\"d\":\"$D\"}"
check "health with admin token"            200 "$(code "$B/health?k=admtok")"
check "admin page without a token"         403 "$(code "$B/admin")"
check "admin page with the device token"   403 "$(code "$B/admin?k=devtok")"
check "admin page with the admin token"    200 "$(code "$B/admin?k=admtok")"
code -X POST "$B/chat?k=devtok" -H "X-Device: $D" -d '{"text":"hi"}' >/dev/null; sleep 1
check "device registered after a chat"     1 "$(curl -s "$B/admin/devices?k=admtok" | grep -c "\"d\":\"$D\"")"
check "per-device settings saved"          '{"ok":true}' "$(curl -s -X POST "$B/admin/api?k=admtok&d=$D" -d '{"over":["tts"],"config":{"tts":{"voice":"zh-CN-YunxiNeural"}}}')"
check "the override is listed for it"      1 "$(curl -s "$B/admin/devices?k=admtok" | grep -c '"over":\["tts"\]')"
check "and its value is read back"         1 "$(curl -s "$B/admin/api?k=admtok&d=$D" | grep -c 'zh-CN-YunxiNeural')"
curl -s -o /dev/null -X POST "$B/wg/enroll?k=devtok" -H "X-Device: $D" -d "$ENROLL"
curl -s -o /dev/null -X POST "$B/admin/wg?k=admtok" -d "$APPROVE"
curl -s -o /dev/null -X POST "$B/admin/wg?k=admtok" -d "$ASSIGN"
check "block a device"                     '{"ok":true}' "$(curl -s -X POST "$B/admin/device?k=admtok" -d "$BLOCK")"
check "blocked: /chat with X-Device"       403 "$(code -X POST "$B/chat?k=devtok" -H "X-Device: $D" -d '{"text":"hi"}')"
check "blocked: /tts with d="              403 "$(code -X POST "$B/tts?k=devtok&d=$D" -d '{"text":"hi"}')"
check "blocked: /wg/enroll"                403 "$(code -X POST "$B/wg/enroll?k=devtok" -H "X-Device: $D" -d "$ENROLL")"
check "blocked: badge list"                403 "$(code "$B/badge/list?k=devtok&d=$D")"
check "another device is not blocked"      503 "$(code -X POST "$B/chat?k=devtok" -H "X-Device: homelink-111111" -d '{"text":"hi"}')"
check "admin page works while blocked"     200 "$(code "$B/admin?k=admtok")"
check "tunnel key revoked on block"        0 "$(curl -s "$B/admin/wg?k=admtok" | grep -c '"ok":true')"
check "unblock a device"                   '{"ok":true}' "$(curl -s -X POST "$B/admin/device?k=admtok" -d "$UNBLOCK")"
check "unblocked: /chat works again"       503 "$(code -X POST "$B/chat?k=devtok" -H "X-Device: $D" -d '{"text":"hi"}')"
finish
