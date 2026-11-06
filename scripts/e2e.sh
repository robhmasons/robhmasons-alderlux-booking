#!/usr/bin/env bash
# End-to-end check against a local Worker + local D1. Usage: bash scripts/e2e.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8799}
rm -rf .wrangler/state
npx wrangler d1 migrations apply alderlux-booking --local >/dev/null
npx wrangler dev --local --port "$PORT" --test-scheduled >/tmp/alx-wrangler.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/config" >/dev/null && break; sleep 1; done
B="http://127.0.0.1:$PORT"
pass=0; fail=0
check() { if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }

cfg=$(curl -s "$B/api/config")
check "config lists 3 meeting types" '[ "$(echo "$cfg" | jq ".eventTypes|length")" = 3 ]'
check "home page is served" 'curl -s "$B/" | grep -q "Choose a conversation"'
check "security headers on page" 'curl -sI "$B/" | grep -qi "content-security-policy"'

slots=$(curl -s "$B/api/slots?type=succession&days=14")
first=$(echo "$slots" | jq -r '[.slots[]] | flatten | .[0]')
check "slots returned for next 14 days" '[ "$first" != "null" ] && [ -n "$first" ]'
check "unknown type is 404" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$B/api/slots?type=nope")" = 404 ]'

body=$(jq -n --arg s "$first" '{type:"succession",start:$s,name:"Test Person",email:"test@example.com",answers:{heard_about:"Personal introduction"}}')
res=$(curl -s -w "\n%{http_code}" -H 'content-type: application/json' -d "$body" "$B/api/bookings")
code=$(echo "$res" | tail -1); json=$(echo "$res" | head -1)
tok=$(echo "$json" | jq -r .manageToken)
check "booking created (201)" '[ "$code" = 201 ]'

code2=$(curl -s -o /dev/null -w "%{http_code}" -H 'content-type: application/json' -d "$body" "$B/api/bookings")
check "same slot cannot be booked twice (409)" '[ "$code2" = 409 ]'

# Simultaneous attempts on the next free slot: exactly one should win.
second=$(curl -s "$B/api/slots?type=succession&days=14" | jq -r '[.slots[]] | flatten | .[0]')
b2=$(jq -n --arg s "$second" '{type:"succession",start:$s,name:"Race One",email:"r1@example.com",answers:{heard_about:"LinkedIn"}}')
pids=(); : > /tmp/alx-race.txt
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "%{http_code}\n" -H 'content-type: application/json' -d "$b2" "$B/api/bookings" >> /tmp/alx-race.txt & pids+=($!); done
wait "${pids[@]}"
wins=$(grep -c '^201$' /tmp/alx-race.txt || true)
check "5 simultaneous requests for one slot: exactly 1 succeeds" '[ "$wins" = 1 ]'

after=$(curl -s "$B/api/slots?type=succession&days=14" | jq -r '[.slots[]] | flatten')
check "booked slot no longer offered" '! echo "$after" | grep -q "$first"'

check "validation: missing required answer is 400" '[ "$(curl -s -o /dev/null -w "%{http_code}" -H "content-type: application/json" -d "$(jq -n --arg s "$first" "{type:\"succession\",start:\$s,name:\"A B\",email:\"a@b.com\",answers:{}}")" "$B/api/bookings")" = 400 ]'
check "validation: off-grid time is 409" '[ "$(curl -s -o /dev/null -w "%{http_code}" -H "content-type: application/json" -d "{\"type\":\"succession\",\"start\":\"2030-01-01T03:17:00Z\",\"name\":\"A B\",\"email\":\"a@b.com\",\"answers\":{\"heard_about\":\"Other\"}}" "$B/api/bookings")" = 409 ]'

check "manage view shows confirmed booking" '[ "$(curl -s "$B/api/bookings/$tok" | jq -r .status)" = confirmed ]'
check "calendar file downloads" 'curl -s "$B/api/bookings/$tok.ics" | grep -q "BEGIN:VEVENT"'
check "cancel works" '[ "$(curl -s -X POST "$B/api/bookings/$tok/cancel" | jq -r .status)" = cancelled ]'
check "cancelled slot is offered again" 'curl -s "$B/api/slots?type=succession&days=14" | grep -q "$first"'
check "unknown token is 404" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$B/api/bookings/AAAAAAAAAAAAAAAAAAAAAAAA")" = 404 ]'
check "cron handler runs" 'curl -s "$B/__scheduled?cron=*/30+*+*+*+*" >/dev/null'
check "dev emails were generated (confirmation + host)" 'grep -q "\[email:dev\] to=test@example.com" /tmp/alx-wrangler.log && grep -q "\[email:dev\] to=anna@alderlux.com" /tmp/alx-wrangler.log'

echo "----"; echo "passed=$pass failed=$fail"
[ "$fail" = 0 ]
