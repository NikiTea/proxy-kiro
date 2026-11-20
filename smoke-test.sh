#!/usr/bin/env bash
# proxy-kiro smoke test — run on the VPS with the relay running.
#
# Usage:
#   ./smoke-test.sh [BASE] [RELAY_KEY]
#   BASE      defaults to http://127.0.0.1:3000
#   RELAY_KEY defaults to the $RELAY_KEY env var (e.g. `set -a; . ./.env; set +a` first)
#
# Checks:
#   1. GET /health, no auth          -> 200 {"ok":true}
#   2. GET /kiro/ WITHOUT x-relay-key -> 401 unauthorized
#   3. GET /kiro/ WITH wrong key     -> 401 unauthorized
#   4. GET /kiro/ WITH correct key   -> 4xx from the AWS upstream (unauthenticated
#      AWS rejects it — that PROVES the request was forwarded past this relay)

set -u

BASE="${1:-http://127.0.0.1:3000}"
KEY="${2:-${RELAY_KEY:-}}"

PASS=0
FAIL=0

say_pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
say_fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

echo "== proxy-kiro smoke test =="
echo "BASE: $BASE"
echo "RELAY_KEY: $([ -n "$KEY" ] && echo 'present' || echo 'NOT SET (test 4 will be skipped)')"
echo

# 1. /health, unauthenticated
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/health" 2>/dev/null)
body=$(curl -s --max-time 20 "$BASE/health" 2>/dev/null)
if [ "$code" = "200" ] && echo "$body" | grep -q '"ok":true'; then
  say_pass "/health -> 200 {\"ok\":true}"
else
  say_fail "/health expected 200 {\"ok\":true}, got $code / $body"
fi

# 2. /kiro/ without key -> 401
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/kiro/" 2>/dev/null)
if [ "$code" = "401" ]; then
  say_pass "/kiro/ without key -> 401"
else
  say_fail "/kiro/ without key expected 401, got $code"
fi

# 3. /kiro/ with a wrong key -> 401
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H "x-relay-key: definitely-wrong-key" "$BASE/kiro/" 2>/dev/null)
if [ "$code" = "401" ]; then
  say_pass "/kiro/ with wrong key -> 401"
else
  say_fail "/kiro/ with wrong key expected 401, got $code"
fi

# 4. /kiro/ with the correct key -> expect a 4xx from AWS, not from this relay.
if [ -n "$KEY" ]; then
  out=$(curl -s --max-time 20 -H "x-relay-key: $KEY" -w '\n%{http_code}' "$BASE/kiro/" 2>/dev/null)
  code=$(printf '%s' "$out" | tail -n1)
  body=$(printf '%s' "$out" | head -n -1)
  case "$code" in
    4[0-9][0-9])
      if echo "$body" | grep -q 'relay_disabled'; then
        say_fail "/kiro/ with key -> 403 relay_disabled (server RELAY_KEY differs from the key used here)"
      elif echo "$body" | grep -q '"unauthorized"'; then
        say_fail "/kiro/ with key -> 401 from the relay itself (server RELAY_KEY differs from the key used here)"
      else
        say_pass "/kiro/ with key -> upstream $code (forwarding works)"
      fi
      ;;
    502)
      say_fail "/kiro/ with key -> 502 upstream_failed (AWS unreachable from this host — check network/DNS, forwarding NOT proven)"
      ;;
    *)
      say_fail "/kiro/ with key expected upstream 4xx, got $code"
      ;;
  esac
else
  echo "SKIP: /kiro/ with key (no RELAY_KEY available; rerun: set -a; . ./.env; set +a; ./smoke-test.sh)"
fi

echo
echo "== summary: PASS=$PASS FAIL=$FAIL =="
if [ "$FAIL" -eq 0 ]; then
  echo "RESULT: PASS"
else
  echo "RESULT: FAIL"
fi
exit 0
