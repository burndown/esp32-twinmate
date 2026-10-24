# Shared by the test scripts: starts the Worker locally with workerd (no Cloudflare account, no Workers AI binding) and gives
# `check`, `code` and the base URL $B. Source it, then call `gw_start --var NAME:VALUE ...`.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PORT=${PORT:-8797}; B=http://127.0.0.1:$PORT; fail=0; PID=""; MPID=""
gw_start() {
  TMP=$(mktemp -d); LOG=$TMP/wrangler.log
  mkdir -p "$TMP/w"; cp -r "$ROOT/src" "$TMP/w/src"
  awk '/^\[ai\]/{skip=1; next} /^\[/{skip=0} !skip' "$ROOT/wrangler.toml" > "$TMP/w/wrangler.toml"
  trap gw_stop EXIT
  (cd "$TMP/w" && exec npx --yes wrangler@4.149.0 dev --local --ip 127.0.0.1 --port "$PORT" --persist-to "$TMP/state" --log-level warn \
    --var GATEWAY_TOKEN:devtok --var ADMIN_TOKEN:admtok --var WG_SERVER_PUB:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= --var WG_ENDPOINT:test.example.com "$@") >"$LOG" 2>&1 &
  PID=$!
  for i in $(seq 1 90); do curl -s -o /dev/null "$B/health?k=admtok" && return 0; sleep 1; done
  echo "gateway did not start"; tail -20 "$LOG"; exit 1
}
mock_start() { node "$ROOT/test/mock.mjs" "$MOCK_PORT" & MPID=$!; sleep 1; }
gw_stop() { [ -n "$PID" ] && { kill "$PID" 2>/dev/null; pkill -P "$PID" 2>/dev/null; }; [ -n "$MPID" ] && kill "$MPID" 2>/dev/null; rm -rf "$TMP"; }
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: expected $2, got $3"; fail=1; fi
}
contains() { case "$3" in *"$2"*) echo "ok    $1" ;; *) echo "FAIL  $1: expected to contain '$2', got '${3:0:120}'"; fail=1 ;; esac; }
lacks() { case "$3" in *"$2"*) echo "FAIL  $1: must not contain '$2', got '${3:0:120}'"; fail=1 ;; *) echo "ok    $1" ;; esac; }
finish() { [ $fail = 0 ] || { echo "--- gateway log (tail)"; tail -20 "$LOG"; }; exit $fail; }
# A gadget is listed only after the gateway wrote it (it does that after answering): wait until it shows, before changing its settings.
wait_device() { for i in $(seq 1 30); do curl -s "$B/admin/devices?k=admtok" | grep -q "\"d\":\"$1\"" && return 0; sleep 0.5; done; echo "FAIL  device $1 never appeared"; fail=1; }
