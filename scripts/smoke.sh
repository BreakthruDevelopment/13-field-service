#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL): roles, idempotent writes, version
# conflicts, technician isolation, the offline sync and the admin role grant, over HTTP. Needs curl and jq.
#
#   Local and CI:  DATABASE_URL=... BASE_URL=http://localhost:3000 ./scripts/smoke.sh
#     Signs up a dispatcher, two technicians, a new user and an admin, and gives them their roles with psql.
#   Live:          BASE_URL=https://app13.breakthruventures.ai \
#                  SMOKE_DISPATCHER_EMAIL=... SMOKE_DISPATCHER_PASSWORD=... SMOKE_TECH_EMAIL=... SMOKE_TECH_PASSWORD=... ./scripts/smoke.sh
#     Signs in with the accounts an admin granted a role in /admin (repo secrets). SMOKE_TECH2_EMAIL / SMOKE_TECH2_PASSWORD
#     are optional (a second technician for the "not your job" checks). With no accounts and no database it FAILS, it
#     never passes a partial check. The live run cancels the job it creates.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/out"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
command -v jq >/dev/null || fail "jq is required"

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
page=$(curl -fsS "$BASE_URL/") || fail "landing did not render"
echo "$page" | grep -qi 'technician' || fail "landing should describe field service (technicians)"
echo "$page" | grep -q 'Sign in' || fail "landing should offer sign in"
pass "pages render inside the shared shell"

for path in /dashboard /admin /parts /board /jobs /jobs/new; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard, admin, parts, board and jobs redirect"

# The installable offline app (13.2): the worker is never cached, the manifest opens /tech, location is ours alone.
sw_headers=$(curl -fsS -D - -o "$TMP/sw.js" "$BASE_URL/sw.js" | tr -d '\r') || fail "/sw.js is unreachable"
echo "$sw_headers" | grep -iq '^cache-control:.*no-store' || fail "/sw.js must be served with Cache-Control: no-store: $sw_headers"
grep -q '/api/' "$TMP/sw.js" && grep -q 'fsd-' "$TMP/sw.js" || fail "/sw.js does not look like the service worker"
manifest=$(curl -fsS "$BASE_URL/manifest.webmanifest") || fail "manifest unreachable"
[ "$(echo "$manifest" | jq -r '.start_url + " " + .scope + " " + .display')" = "/tech /tech standalone" ] || fail "manifest should open /tech standalone: $manifest"
# Captured first, like sw_headers above: `grep -q` exits at the first match, and whatever is still writing into the
# pipe then dies of SIGPIPE, which `set -o pipefail` turns into a failed check that actually passed. Never pipe a
# command straight into `grep -q` here. The `echo "$page" | grep -q` checks below are safe only because a page fits
# the 64 KB pipe buffer, so the write finishes whatever grep does (measured: 0 failures in 300 at 19.5 KB; 50 in 50
# with a 200 KB string matching on line 1).
page_headers=$(curl -fsS -D - -o /dev/null "$BASE_URL/" | tr -d '\r') || fail "landing headers unreachable"
echo "$page_headers" | grep -iq '^permissions-policy:.*geolocation=(self)' || fail "Permissions-Policy should allow geolocation for this origin only"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/tech")
[ "$code" = "307" ] || fail "signed-out /tech should redirect (307), got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/waiting")
[ "$code" = "307" ] || fail "signed-out /waiting should redirect (307), got $code"
clear_headers=$(curl -s -D - -o /dev/null -X POST -H "origin: $BASE_URL" "$BASE_URL/api/session/clear" | tr -d '\r')
echo "$clear_headers" | grep -iq '^clear-site-data: "cache", "storage"' || fail "/api/session/clear should answer Clear-Site-Data: $clear_headers"
pass "service worker is no-store, manifest opens /tech, geolocation is self-only, /api/session/clear sends Clear-Site-Data"

# --- helpers -----------------------------------------------------------------------------------------------------

# Better Auth allows 3 sign-in/sign-up requests per 10 s per IP. On a 429, wait out the window and retry once.
post_auth() {
  local jar=$1 path=$2 payload=$3 code
  for attempt in 1 2; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
      -d "$payload" "$BASE_URL$path")
    if [ "$code" = "429" ] && [ "$attempt" = "1" ]; then
      echo "auth rate limit (429) on $path; waiting 11s and retrying once"
      sleep 11
      continue
    fi
    break
  done
  case "$code" in 2??) return 0 ;; *) echo "auth request to $path returned $code" >&2; return 1 ;; esac
}

signup() { post_auth "$1" /api/auth/sign-up/email "{\"email\":\"$2\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke $3\"}" || fail "sign-up failed for $2"; }
signin() { post_auth "$1" /api/auth/sign-in/email "{\"email\":\"$2\",\"password\":\"$3\"}" || fail "sign-in failed for $2"; }
user_id() { curl -fsS -b "$1" "$BASE_URL/api/auth/get-session" | jq -r '.user.id // empty'; }

# api JAR METHOD PATH [BODY]: sets CODE and BODY. Sends our own Origin, as the browser does.
api() {
  local jar=$1 method=$2 path=$3 body=${4-}
  local args=(-s -o "$OUT" -w '%{http_code}' -X "$method" -H "origin: $BASE_URL")
  [ -n "$jar" ] && args+=(-b "$jar")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  CODE=$(curl "${args[@]}" "$BASE_URL$path")
  BODY=$(cat "$OUT")
}
want() { [ "$CODE" = "$1" ] || fail "$2: expected HTTP $1, got $CODE: $BODY"; }
jqr() { jq -r "$1" <<<"$BODY"; }
uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr 'A-Z' 'a-z'; }
hours_ahead() { date -u -d "+$1 hours" +%Y-%m-%dT%H:00:00Z 2>/dev/null || date -u -v+"$1"H +%Y-%m-%dT%H:00:00Z; }

# --- accounts ----------------------------------------------------------------------------------------------------

JAR_D="$TMP/d"; JAR_T1="$TMP/t1"; JAR_T2="$TMP/t2"; JAR_N="$TMP/n"; JAR_A="$TMP/a"
: > "$JAR_D"; : > "$JAR_T1"; : > "$JAR_T2"; : > "$JAR_N"; : > "$JAR_A"
HAVE_T2=0; HAVE_ADMIN=0
EMAIL_N="smoke-new-$RUN_ID@example.test"

is_local=0
case "$BASE_URL" in http://localhost*|http://127.0.0.1*) is_local=1 ;; esac

if [ -n "${SMOKE_DISPATCHER_EMAIL:-}" ] || [ -n "${SMOKE_TECH_EMAIL:-}" ]; then
  for v in SMOKE_DISPATCHER_EMAIL SMOKE_DISPATCHER_PASSWORD SMOKE_TECH_EMAIL SMOKE_TECH_PASSWORD; do
    [ -n "${!v:-}" ] || fail "$v is not set: the live smoke needs the dispatcher and technician accounts (see the header of this script)"
  done
  signin "$JAR_D" "$SMOKE_DISPATCHER_EMAIL" "$SMOKE_DISPATCHER_PASSWORD"
  signin "$JAR_T1" "$SMOKE_TECH_EMAIL" "$SMOKE_TECH_PASSWORD"
  if [ -n "${SMOKE_TECH2_EMAIL:-}" ] && [ -n "${SMOKE_TECH2_PASSWORD:-}" ]; then signin "$JAR_T2" "$SMOKE_TECH2_EMAIL" "$SMOKE_TECH2_PASSWORD"; HAVE_T2=1; fi
  signup "$JAR_N" "$EMAIL_N" new
  pass "signed in as the smoke dispatcher and technician, and signed up a new user"
elif [ "$is_local" = 1 ] && [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null; then
  grant() {
    local got
    got=$(psql "$DATABASE_URL" -qtA -c "update \"user\" set role = '$2' where email = '$1' returning id") || fail "could not grant $2 to $1"
    [ -n "$got" ] || fail "no account $1 to grant $2 to"
  }
  EMAIL_D="smoke-disp-$RUN_ID@example.test"; EMAIL_T1="smoke-tech1-$RUN_ID@example.test"; EMAIL_T2="smoke-tech2-$RUN_ID@example.test"; EMAIL_A="smoke-admin-$RUN_ID@example.test"
  signup "$JAR_D" "$EMAIL_D" dispatcher; signup "$JAR_T1" "$EMAIL_T1" tech1; signup "$JAR_T2" "$EMAIL_T2" tech2
  signup "$JAR_A" "$EMAIL_A" admin; signup "$JAR_N" "$EMAIL_N" new
  grant "$EMAIL_D" dispatcher; grant "$EMAIL_T1" technician; grant "$EMAIL_T2" technician; grant "$EMAIL_A" admin
  HAVE_T2=1; HAVE_ADMIN=1
  pass "signed up a dispatcher, two technicians, an admin and a new user, and granted the roles"
else
  fail "no smoke accounts: set SMOKE_DISPATCHER_* and SMOKE_TECH_* (live), or DATABASE_URL with psql and a localhost BASE_URL"
fi
ID_T1=$(user_id "$JAR_T1"); [ -n "$ID_T1" ] || fail "could not read the technician's id"
ID_N=$(user_id "$JAR_N"); [ -n "$ID_N" ] || fail "could not read the new user's id"
ID_T2=""; if [ "$HAVE_T2" = 1 ]; then ID_T2=$(user_id "$JAR_T2"); fi

page=$(curl -fsS -b "$JAR_D" "$BASE_URL/parts") || fail "dispatcher /parts did not render"
echo "$page" | grep -q 'Add a part' || fail "dispatcher /parts missing the add form"
echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "dispatcher /parts missing the shared footer"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_T1" "$BASE_URL/parts")
[ "$code" = "307" ] || fail "technician /parts should redirect (307), got $code"
pass "dispatcher parts catalog renders; technicians are redirected"

page=$(curl -fsS -b "$JAR_D" "$BASE_URL/board") || fail "dispatcher /board did not render"
echo "$page" | grep -q 'Schedule board' || fail "dispatcher /board missing the heading"
echo "$page" | grep -q 'Unassigned' || fail "dispatcher /board missing the unassigned tray"
echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "dispatcher /board missing the shared footer"
if echo "$page" | grep -q 'The schedule board is being built'; then fail "dispatcher /board is still the placeholder"; fi
page=$(curl -fsS -b "$JAR_D" "$BASE_URL/jobs") || fail "dispatcher /jobs did not render"
echo "$page" | grep -q 'New job' || fail "dispatcher /jobs missing the new job link"
if echo "$page" | grep -q 'This page is being built'; then fail "dispatcher /jobs is still the placeholder"; fi
page=$(curl -fsS -b "$JAR_D" "$BASE_URL/jobs/new") || fail "dispatcher /jobs/new did not render"
echo "$page" | grep -q 'New job' || fail "dispatcher /jobs/new missing the heading"
echo "$page" | grep -q 'Customer' || fail "dispatcher /jobs/new missing the customer picker"
for path in /board /jobs /jobs/new; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_T1" "$BASE_URL$path")
  [ "$code" = "307" ] || fail "technician $path should redirect (307), got $code"
done
pass "dispatcher board, jobs list and new job render; technicians are redirected"

# Technician PWA shell (13.6). The HTML is the cached shell: job rows load on the phone, so the response names the
# screen and the empty states, not a customer. A new sign-up waits on /waiting.
page=$(curl -fsS -b "$JAR_T1" "$BASE_URL/tech") || fail "technician /tech did not render"
echo "$page" | grep -q 'My jobs' || fail "technician /tech missing My jobs"
echo "$page" | grep -q 'Loading your jobs' || fail "technician /tech should render the shell before job data"
echo "$page" | grep -q 'Needs attention' || fail "technician /tech missing Needs attention"
echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "technician /tech missing the shared footer"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_N" "$BASE_URL/tech")
[ "$code" = "307" ] || fail "a new sign-up /tech should redirect (307), got $code"
page=$(curl -fsS -b "$JAR_N" "$BASE_URL/waiting") || fail "new sign-up /waiting did not render"
echo "$page" | grep -q 'An admin needs to give you access' || fail "waiting page should say an admin needs to give access"
echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "waiting page missing the shared footer"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_T1" "$BASE_URL/waiting")
[ "$code" = "307" ] || fail "technician /waiting should redirect (307), got $code"
pass "technician shell and waiting page render for the right roles"

# --- a new sign-up has no role -----------------------------------------------------------------------------------

api "" GET /api/jobs; want 401 "anonymous job list"
api "$JAR_N" GET /api/jobs; want 403 "new user listing jobs"
api "$JAR_N" POST /api/jobs '{"customerId":"'"$(uuid)"'","siteId":"'"$(uuid)"'","title":"x"}'; want 403 "new user creating a job"
api "$JAR_N" GET /api/parts; want 403 "new user reading parts"
api "$JAR_N" GET /api/admin/stats; want 403 "new user reading admin counts"
api "$JAR_N" POST /api/admin/roles '{"userId":"'"$ID_N"'","role":"dispatcher","from":"user"}'; want 403 "new user granting themselves a role"
pass "a new sign-up has no role: 401 signed out, 403 on jobs, parts and admin"

# --- dispatcher: customer, site, job (idempotent) ----------------------------------------------------------------

OP_C=$(uuid)
api "$JAR_D" POST /api/customers '{"name":"Smoke Co '"$RUN_ID"'","phone":"555-0100","email":"smoke@example.test","clientOpId":"'"$OP_C"'"}'; want 201 "create customer"
CUSTOMER=$(jqr .customer.id)
api "$JAR_D" POST /api/customers '{"name":"Smoke Co '"$RUN_ID"'","phone":"555-0100","email":"smoke@example.test","clientOpId":"'"$OP_C"'"}'; want 200 "replay customer"
[ "$(jqr .customer.id)" = "$CUSTOMER" ] || fail "a replayed customer op id must return the first customer"
OP_S=$(uuid)
api "$JAR_D" POST "/api/customers/$CUSTOMER/sites" '{"label":"Main","address":"1 Smoke St","accessNotes":"Side door","lat":30.2672,"lng":-97.7431,"clientOpId":"'"$OP_S"'"}'; want 201 "create site"
SITE=$(jqr .site.id)
api "$JAR_D" POST "/api/customers/$CUSTOMER/sites" '{"label":"Main","address":"1 Smoke St","accessNotes":"Side door","lat":30.2672,"lng":-97.7431,"clientOpId":"'"$OP_S"'"}'; want 200 "replay site"
[ "$(jqr .site.id)" = "$SITE" ] || fail "a replayed site op id must return the first site"
pass "dispatcher created a customer and a site; replaying the op ids returned the same rows"

START=$(hours_ahead 2); END=$(hours_ahead 3); DAY=${START%%T*}
OP_J=$(uuid)
JOB_BODY='{"customerId":"'"$CUSTOMER"'","siteId":"'"$SITE"'","title":"Smoke job '"$RUN_ID"'","description":"Kitchen sink leaking","priority":"high","assigneeId":"'"$ID_T1"'","scheduledStart":"'"$START"'","scheduledEnd":"'"$END"'","clientOpId":"'"$OP_J"'"}'
api "$JAR_D" POST /api/jobs "$JOB_BODY"; want 201 "create job"
JOB=$(jqr .job.id); [ "$(jqr .job.status)" = "scheduled" ] || fail "an assigned job should be scheduled: $BODY"
api "$JAR_D" POST /api/jobs "$JOB_BODY"; want 200 "replay job"
[ "$(jqr .job.id)" = "$JOB" ] || fail "a replayed client op id must return the first job"
api "$JAR_D" GET "/api/jobs?q=Smoke%20job%20$RUN_ID"; want 200 "search jobs"
[ "$(jqr '.jobs | length')" = "1" ] || fail "replaying a client op id must leave one job, got: $BODY"
pass "dispatcher created a job for technician 1; retrying the same client op id made one job"

page=$(curl -fsS -b "$JAR_D" "$BASE_URL/jobs?q=Smoke%20job%20$RUN_ID") || fail "dispatcher /jobs search did not render"
echo "$page" | grep -qF "Smoke job $RUN_ID" || fail "jobs list missing the smoke job"
page=$(curl -fsS -b "$JAR_D" "$BASE_URL/board?date=$DAY") || fail "dispatcher /board for the job's day did not render"
echo "$page" | grep -qF "Smoke job $RUN_ID" || fail "board missing the assigned smoke job"
page=$(curl -fsS -b "$JAR_D" "$BASE_URL/jobs/new") || fail "dispatcher /jobs/new after creating a customer did not render"
echo "$page" | grep -qF "Smoke Co $RUN_ID" || fail "new job form should list the smoke customer"
pass "dispatcher sees the new job on /jobs and /board, and the customer on /jobs/new"

api "$JAR_D" POST /api/jobs '{"customerId":"'"$CUSTOMER"'","siteId":"'"$SITE"'","title":"nul\u0000byte"}'; want 400 "NUL byte in a title"
api "$JAR_D" POST /api/customers '{"name":"x","phone":"nul\u0000"}'; want 400 "NUL byte in a phone"
api "$JAR_D" GET "/api/jobs?q=a%00b"; want 400 "NUL byte in a query"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_D" -H 'content-type: application/json' -H 'origin: https://evil.example' -d "$JOB_BODY" "$BASE_URL/api/jobs")
[ "$code" = "403" ] || fail "cross-origin create should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_D" -H 'content-type: application/json' -d "$JOB_BODY" "$BASE_URL/api/jobs")
[ "$code" = "403" ] || fail "create without an Origin should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_D" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{nope' "$BASE_URL/api/jobs")
[ "$code" = "400" ] || fail "malformed JSON should be 400, got $code"
code=$(head -c 40000 /dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '%{http_code}' -b "$JAR_D" -H 'content-type: application/json' -H "origin: $BASE_URL" --data-binary @- "$BASE_URL/api/jobs")
[ "$code" = "413" ] || fail "oversized body should be 413, got $code"
pass "NUL bytes, cross-origin, malformed and oversized writes refused"

# --- technician isolation ----------------------------------------------------------------------------------------

api "$JAR_T1" GET /api/jobs; want 200 "technician 1 listing jobs"
jq -e --arg id "$JOB" '.jobs | map(.id) | index($id) != null' <<<"$BODY" >/dev/null || fail "technician 1 should see their job: $BODY"
api "$JAR_T1" GET "/api/jobs/$JOB"; want 200 "technician 1 reading their job"
echo "$BODY" | grep -q 'smoke@example.test' && fail "a technician must not see the customer's email"
[ "$(jqr .job.customer.phone)" = "555-0100" ] || fail "a technician should see the customer's phone: $BODY"
api "$JAR_T1" POST /api/jobs "$JOB_BODY"; want 403 "technician creating a job"
api "$JAR_T1" GET /api/customers; want 403 "technician listing customers"
api "$JAR_T1" GET "/api/customers/$CUSTOMER"; want 403 "technician reading a customer"
api "$JAR_T1" GET "/api/board?date=$DAY"; want 403 "technician reading the board"
api "$JAR_N" GET "/api/jobs/$JOB"; want 403 "new user reading a job"
if [ "$HAVE_T2" = 1 ]; then
  api "$JAR_T2" GET "/api/jobs/$JOB"; want 404 "technician 2 reading technician 1's job"
  api "$JAR_T2" POST "/api/jobs/$JOB/notes" '{"body":"sneaky"}'; want 404 "technician 2 adding a note to technician 1's job"
  api "$JAR_T2" GET /api/jobs; want 200 "technician 2 listing jobs"
  jq -e --arg id "$JOB" '.jobs | map(.id) | index($id) == null' <<<"$BODY" >/dev/null || fail "technician 2 must not see technician 1's job"
  api "$JAR_T2" GET "/api/jobs/$(uuid)"; want 404 "a made-up job id"
  pass "technician 1 sees their own job; technician 2 gets 404 (the same answer as a made-up id); a new user gets 403"
else
  pass "technician 1 sees their own job; a new user gets 403 (no second technician in this run)"
fi

api "$JAR_T1" POST "/api/jobs/$JOB/notes" '{"body":"Replaced the cartridge.","opId":"'"$OP_J"'"}'; want 201 "technician note"
api "$JAR_T1" POST "/api/jobs/$JOB/notes" '{"body":"Replaced the cartridge.","opId":"'"$OP_J"'"}'; want 200 "replayed technician note"
[ "$(jqr '.job.notes | length')" = "1" ] || fail "a replayed note op id must leave one note: $BODY"
pass "a replayed note op id left one note"

# --- offline sync (13.2): snapshot, batched ops, replay, ownership, conflicts ---------------------------------------

OP_SJ=$(uuid)
api "$JAR_D" POST /api/jobs '{"customerId":"'"$CUSTOMER"'","siteId":"'"$SITE"'","title":"Smoke sync job '"$RUN_ID"'","assigneeId":"'"$ID_T1"'","scheduledStart":"'"$(hours_ahead 6)"'","scheduledEnd":"'"$(hours_ahead 7)"'","clientOpId":"'"$OP_SJ"'"}'; want 201 "create the sync job"
SJOB=$(jqr .job.id); SSV=$(jqr .job.statusVersion)

api "" POST /api/sync '{"ownerId":"x","ops":[]}'; want 401 "anonymous sync"
api "$JAR_N" POST /api/sync '{"ownerId":"'"$ID_N"'","ops":[]}'; want 403 "new user syncing"
api "$JAR_D" POST /api/sync '{"ownerId":"x","ops":[]}'; want 403 "dispatcher syncing"
api "$JAR_D" GET /api/my/jobs; want 403 "dispatcher reading a technician snapshot"
api "" GET /api/my/jobs; want 401 "anonymous snapshot"

api "$JAR_T1" GET /api/my/jobs; want 200 "technician 1 snapshot"
jq -e --arg id "$SJOB" --arg me "$ID_T1" '.userId == $me and (.jobs | map(.id) | index($id) != null)' <<<"$BODY" >/dev/null || fail "the snapshot should be technician 1's and hold the sync job: $BODY"
echo "$BODY" | grep -q 'smoke@example.test' && fail "the snapshot must not carry the customer's email"
jq -e --arg id "$SJOB" '.jobs[] | select(.id == $id) | .customer.phone == "555-0100" and .site.accessNotes == "Side door"' <<<"$BODY" >/dev/null || fail "the snapshot should carry phone and access notes: $BODY"
ETAG=$(curl -s -D - -o /dev/null -b "$JAR_T1" "$BASE_URL/api/my/jobs" | tr -d '\r' | awk 'tolower($1)=="etag:" {print $2}')
[ -n "$ETAG" ] || fail "the snapshot should send an ETag"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_T1" -H "if-none-match: $ETAG" "$BASE_URL/api/my/jobs")
[ "$code" = "304" ] || fail "an unchanged snapshot should answer 304, got $code"
if [ "$HAVE_T2" = 1 ]; then
  api "$JAR_T2" GET /api/my/jobs; want 200 "technician 2 snapshot"
  jq -e --arg id "$SJOB" '.jobs | map(.id) | index($id) == null' <<<"$BODY" >/dev/null || fail "technician 2's snapshot must not hold technician 1's job"
fi
pass "snapshot: technician 1 gets their job (phone, access notes, no email), unchanged is a 304, others get 401/403"

OP_N=$(uuid); OP_S1=$(uuid); OP_S2=$(uuid); NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SYNC_BODY='{"ownerId":"'"$ID_T1"'","deviceId":"smoke","ops":['\
'{"kind":"note.add","opId":"'"$OP_N"'","jobId":"'"$SJOB"'","clientAt":"'"$NOW"'","body":"Offline note: replaced the cartridge."},'\
'{"kind":"status.set","opId":"'"$OP_S1"'","jobId":"'"$SJOB"'","clientAt":"'"$NOW"'","to":"en_route","baseStatusVersion":'"$SSV"',"dependsOn":null}]}'
api "$JAR_T1" POST /api/sync "$SYNC_BODY"; want 200 "first sync"
[ "$(jqr '[.results[].outcome] | join(",")')" = "applied,applied" ] || fail "both ops should apply: $BODY"
api "$JAR_T1" POST /api/sync "$SYNC_BODY"; want 200 "replayed sync"
[ "$(jqr '[.results[].outcome] | join(",")')" = "replayed,replayed" ] || fail "a replayed batch should answer replayed: $BODY"
api "$JAR_T1" GET "/api/jobs/$SJOB"; want 200 "reading the synced job"
[ "$(jqr '.job.notes | length')" = "1" ] && [ "$(jqr .job.status)" = "en_route" ] || fail "a replayed batch must leave one note and en_route: $BODY"
pass "sync: a batch applies once and its replay returns 'replayed' without a second note"

SYNC_REUSE='{"ownerId":"'"$ID_T1"'","ops":[{"kind":"note.add","opId":"'"$OP_N"'","jobId":"'"$SJOB"'","clientAt":"'"$NOW"'","body":"A different note with a used op id"}]}'
api "$JAR_T1" POST /api/sync "$SYNC_REUSE"; want 200 "reused op id"
[ "$(jqr '.results[0].code')" = "op_id_reused" ] || fail "an op id reused with another payload should be refused: $BODY"
api "$JAR_T1" POST /api/sync '{"ownerId":"'"$ID_N"'","ops":[{"kind":"note.add","opId":"'"$(uuid)"'","jobId":"'"$SJOB"'","clientAt":"'"$NOW"'","body":"wrong owner"}]}'; want 409 "a device holding another account's data"
[ "$(jqr .code)" = "owner_mismatch" ] || fail "should be owner_mismatch: $BODY"
api "$JAR_T1" POST /api/sync '{"ownerId":"'"$ID_T1"'","ops":[{"kind":"note.add","opId":"'"$(uuid)"'","jobId":"'"$SJOB"'","clientAt":"'"$NOW"'","body":"nul\u0000byte"}]}'; want 400 "NUL byte in a synced note"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_T1" -H 'content-type: application/json' -H 'origin: https://evil.example' -d "$SYNC_BODY" "$BASE_URL/api/sync")
[ "$code" = "403" ] || fail "cross-origin sync should be 403, got $code"
code=$(head -c 70000 /dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '%{http_code}' -b "$JAR_T1" -H 'content-type: application/json' -H "origin: $BASE_URL" --data-binary @- "$BASE_URL/api/sync")
[ "$code" = "413" ] || fail "an oversized sync body should be 413, got $code"
if [ "$HAVE_T2" = 1 ]; then
  api "$JAR_T2" POST /api/sync '{"ownerId":"'"$ID_T2"'","ops":[{"kind":"note.add","opId":"'"$(uuid)"'","jobId":"'"$SJOB"'","clientAt":"'"$NOW"'","body":"not mine"}]}'; want 200 "technician 2 syncing a note on technician 1's job"
  [ "$(jqr '.results[0].code')" = "not_assigned" ] || fail "another technician's job should be not_assigned: $BODY"
fi
pass "sync refusals: reused op id, wrong owner (409), NUL (400), cross-origin (403), oversized (413), someone else's job"

# The office reschedules: the technician's next status still applies. Then the office takes the job back: their queued ops don't.
api "$JAR_D" GET "/api/jobs/$SJOB"; want 200 "dispatcher reading the sync job"; V=$(jqr .job.version)
api "$JAR_D" PATCH "/api/jobs/$SJOB" '{"op":"reschedule","version":'"$V"',"scheduledStart":"'"$(hours_ahead 8)"'","scheduledEnd":"'"$(hours_ahead 9)"'"}'; want 200 "reschedule the sync job"
OP_S3=$(uuid); OP_S4=$(uuid); OP_N2=$(uuid)
api "$JAR_T1" POST /api/sync '{"ownerId":"'"$ID_T1"'","ops":[{"kind":"status.set","opId":"'"$OP_S2"'","jobId":"'"$SJOB"'","clientAt":"'"$NOW"'","to":"on_site","baseStatusVersion":'"$((SSV + 1))"',"dependsOn":"'"$OP_S1"'","location":{"lat":30.26721999,"lng":-97.74309999,"accuracyM":24.6,"capturedAt":"'"$NOW"'"}}]}'; want 200 "on site after a reschedule"
[ "$(jqr '.results[0].outcome')" = "applied" ] || fail "a reschedule must not stop the technician's next status: $BODY"
api "$JAR_D" GET "/api/jobs/$SJOB"; want 200 "dispatcher reading the check-in"; V=$(jqr .job.version)
[ "$(jqr '.job.events[] | select(.toStatus == "on_site") | .checkIn.lat')" = "30.2672" ] || fail "the check-in should be stored to 4 decimals: $BODY"
api "$JAR_D" PATCH "/api/jobs/$SJOB" '{"op":"unassign","version":'"$V"'}'; want 200 "the office takes the job back"
api "$JAR_T1" POST /api/sync '{"ownerId":"'"$ID_T1"'","ops":[{"kind":"note.add","opId":"'"$OP_N2"'","jobId":"'"$SJOB"'","clientAt":"'"$NOW"'","body":"typed after the job was taken back"},{"kind":"status.set","opId":"'"$OP_S3"'","jobId":"'"$SJOB"'","clientAt":"'"$NOW"'","to":"on_hold","baseStatusVersion":'"$((SSV + 2))"',"dependsOn":"'"$OP_S2"'"}]}'; want 200 "ops after reassignment"
[ "$(jqr '[.results[] | .outcome + ":" + .code] | join(",")')" = "rejected:not_assigned,conflict:not_assigned" ] || fail "after the job was taken back a note is rejected and a status is a conflict: $BODY"
api "$JAR_T1" GET "/api/jobs/$SJOB"; want 404 "technician 1 reading the job they lost"
api "$JAR_D" GET "/api/jobs/$SJOB"; want 200 "dispatcher reading the sync job"; V=$(jqr .job.version)
[ "$(jqr '.job.notes | length')" = "1" ] || fail "the refused note must not be stored: $BODY"
api "$JAR_D" PATCH "/api/jobs/$SJOB" '{"op":"cancel","version":'"$V"'}'; want 200 "cancel the sync job"
pass "sync conflicts: a reschedule keeps the next status valid; after the office takes the job back a note is rejected and a status is a conflict"

# --- AI work order (13.3): draft, replay, isolation, submit, approve ---------------------------------------------

OP_W=$(uuid); DRAFT_BODY='{"clientOpId":"'"$OP_W"'","baseVersion":null}'
api "$JAR_T1" GET "/api/jobs/$JOB/work-order"; want 200 "reading the work order before there is one"
[ "$(jqr .workOrder)" = "null" ] || fail "a job without a work order should answer null: $BODY"
api "$JAR_T1" POST "/api/jobs/$JOB/work-order/draft" "$DRAFT_BODY"; want 200 "technician 1 drafting a work order"
WO=$(jqr .workOrder.id); WOV=$(jqr .workOrder.version)
[ "$(jqr .replayed)" = "false" ] && [ "$(jqr .workOrder.status)" = "draft" ] || fail "the first draft should be a new draft: $BODY"
jq -e '.workOrder.lines | all(.partId != null or (.flags | index("unknown_part") != null))' <<<"$BODY" >/dev/null || fail "every line must be a catalog part or flagged unknown_part: $BODY"
api "$JAR_T1" POST "/api/jobs/$JOB/work-order/draft" "$DRAFT_BODY"; want 200 "replayed draft"
[ "$(jqr .replayed)" = "true" ] && [ "$(jqr .workOrder.id)" = "$WO" ] && [ "$(jqr .workOrder.version)" = "$WOV" ] || fail "a replayed draft must return the first result: $BODY"
api "$JAR_T1" POST "/api/jobs/$JOB/work-order/draft" '{"clientOpId":"'"$OP_W"'","baseVersion":1}'; want 409 "the same op id with another payload"
api "$JAR_T1" POST "/api/jobs/$JOB/work-order/draft" '{"clientOpId":"'"$(uuid)"'","baseVersion":null}'; want 409 "a stale baseVersion"
api "$JAR_T1" POST "/api/jobs/$JOB/work-order/draft" '{"baseVersion":null}'; want 400 "a draft without an op id"
api "$JAR_N" POST "/api/jobs/$JOB/work-order/draft" "$DRAFT_BODY"; want 403 "new user drafting"
if [ "$HAVE_T2" = 1 ]; then
  api "$JAR_T2" POST "/api/jobs/$JOB/work-order/draft" '{"clientOpId":"'"$(uuid)"'","baseVersion":null}'; want 404 "technician 2 drafting on technician 1's job"
  api "$JAR_T2" GET "/api/jobs/$JOB/work-order"; want 404 "technician 2 reading technician 1's work order"
fi
api "$JAR_T1" PATCH "/api/jobs/$JOB/work-order" '{"op":"approve","clientOpId":"'"$(uuid)"'","version":'"$WOV"'}'; want 403 "technician approving"
OP_SUB=$(uuid)
api "$JAR_T1" PATCH "/api/jobs/$JOB/work-order" '{"op":"submit","clientOpId":"'"$OP_SUB"'","version":'"$WOV"'}'; want 200 "technician submitting"
[ "$(jqr .workOrder.status)" = "submitted" ] || fail "the work order should be submitted: $BODY"
api "$JAR_T1" PATCH "/api/jobs/$JOB/work-order" '{"op":"submit","clientOpId":"'"$OP_SUB"'","version":'"$WOV"'}'; want 200 "replayed submit"
[ "$(jqr .replayed)" = "true" ] || fail "a replayed submit must say so: $BODY"
WOV=$(jqr .workOrder.version)
api "$JAR_T1" PATCH "/api/jobs/$JOB/work-order" '{"op":"edit","clientOpId":"'"$(uuid)"'","version":'"$WOV"',"summary":"sneaky"}'; want 409 "editing a submitted order"
api "$JAR_D" PATCH "/api/jobs/$JOB/work-order" '{"op":"approve","clientOpId":"'"$(uuid)"'","version":'"$((WOV - 1))"'}'; want 409 "approving with a stale version"
api "$JAR_D" PATCH "/api/jobs/$JOB/work-order" '{"op":"approve","clientOpId":"'"$(uuid)"'","version":'"$WOV"'}'; want 200 "dispatcher approving"
[ "$(jqr .workOrder.status)" = "approved" ] || fail "the work order should be approved: $BODY"
pass "AI work order: drafted and replayed once, checked lines, isolated per technician, submitted by the technician and approved by the dispatcher"

# --- dispatcher: versions, schedule, status, reassign ------------------------------------------------------------

api "$JAR_D" GET "/api/jobs/$JOB"; want 200 "dispatcher reading the job"
V=$(jqr .job.version); SV=$(jqr .job.statusVersion)
api "$JAR_D" PATCH "/api/jobs/$JOB" '{"op":"edit","version":'"$V"',"title":"Smoke job '"$RUN_ID"' (edited)"}'; want 200 "edit"
api "$JAR_D" PATCH "/api/jobs/$JOB" '{"op":"edit","version":'"$V"',"title":"stale write"}'; want 409 "stale version"
[ "$(jqr .current.version)" = "$((V + 1))" ] || fail "a 409 should carry the current job: $BODY"
pass "a stale version is a 409 with the current job"

V=$((V + 1))
api "$JAR_D" PATCH "/api/jobs/$JOB" '{"op":"reschedule","version":'"$V"',"scheduledStart":"'"$(hours_ahead 4)"'","scheduledEnd":"'"$(hours_ahead 5)"'"}'; want 200 "reschedule"
[ "$(jqr .job.statusVersion)" = "$SV" ] || fail "rescheduling must not change statusVersion: $BODY"
V=$(jqr .job.version)
api "$JAR_D" GET "/api/board?date=$(hours_ahead 4 | cut -dT -f1)"; want 200 "board"
jq -e --arg id "$JOB" '(.jobs + .unassigned) | map(.id) | index($id) != null' <<<"$BODY" >/dev/null || fail "the board should show the job: $BODY"
pass "reschedule kept statusVersion; the board shows the job"

api "$JAR_D" PATCH "/api/jobs/$JOB" '{"op":"status","version":'"$V"',"to":"completed"}'; want 409 "completing a scheduled job"
api "$JAR_D" PATCH "/api/jobs/$JOB" '{"op":"status","version":'"$V"',"to":"en_route"}'; want 200 "en route"; V=$(jqr .job.version)
api "$JAR_D" PATCH "/api/jobs/$JOB" '{"op":"status","version":'"$V"',"to":"on_site"}'; want 200 "on site"; V=$(jqr .job.version)
api "$JAR_D" PATCH "/api/jobs/$JOB" '{"op":"status","version":'"$V"',"to":"completed"}'; want 200 "completed (a note exists)"; V=$(jqr .job.version)
api "$JAR_D" PATCH "/api/jobs/$JOB" '{"op":"reopen","version":'"$V"'}'; want 200 "reopen"; V=$(jqr .job.version)
pass "status rules: an illegal move is 409; en route, on site, completed and reopen work"

if [ "$HAVE_T2" = 1 ]; then
  api "$JAR_D" PATCH "/api/jobs/$JOB" '{"op":"assign","version":'"$V"',"assigneeId":"'"$ID_T2"'"}'; want 200 "reassign"; V=$(jqr .job.version)
  api "$JAR_T1" GET "/api/jobs/$JOB"; want 404 "the previous technician reading a reassigned job"
  api "$JAR_T2" GET "/api/jobs/$JOB"; want 200 "the new technician reading the job"
  pass "reassigning moved the job: technician 1 gets 404, technician 2 can read it"
fi
api "$JAR_D" PATCH "/api/jobs/$JOB" '{"op":"assign","version":'"$V"',"assigneeId":"'"$ID_N"'"}'; want 400 "assigning to a non-technician"

# --- parts -------------------------------------------------------------------------------------------------------

SKU="SMOKE-$RUN_ID"; OP_P=$(uuid)
api "$JAR_D" POST /api/parts '{"sku":"'"$SKU"'","name":"Smoke part","unit":"each","aliases":["smokey"],"clientOpId":"'"$OP_P"'"}'; want 201 "create part"
PART=$(jqr .part.id); PV=$(jqr .part.version)
api "$JAR_D" POST /api/parts '{"sku":"'"$SKU"'","name":"Smoke part","unit":"each","aliases":["smokey"],"clientOpId":"'"$OP_P"'"}'; want 200 "replay part"
[ "$(jqr .part.id)" = "$PART" ] || fail "a replayed part op id must return the first part"
api "$JAR_D" POST /api/parts '{"sku":"'"$SKU"'","name":"Another"}'; want 409 "duplicate SKU"
api "$JAR_T1" GET "/api/parts?q=smok"; want 200 "technician searching parts"
jq -e --arg sku "$SKU" '.parts | map(.sku) | index($sku) != null' <<<"$BODY" >/dev/null || fail "technician should find the part: $BODY"
api "$JAR_T1" POST /api/parts '{"sku":"SMOKE-TECH","name":"x"}'; want 403 "technician creating a part"
api "$JAR_D" PATCH "/api/parts/$PART" '{"version":'"$PV"',"active":false}'; want 200 "deactivate part"
api "$JAR_T1" GET "/api/parts?q=$SKU"; want 200 "technician searching parts again"
[ "$(jqr '.parts | length')" = "0" ] || fail "a technician must not see an inactive part: $BODY"
pass "parts: idempotent create, duplicate SKU 409, technicians read active parts only and can't write"

# --- admin: counts and the only way a role changes ---------------------------------------------------------------

if [ "$HAVE_ADMIN" = 1 ]; then
  page=$(curl -fsS -b "$JAR_A" "$BASE_URL/admin") || fail "admin page did not render"
  echo "$page" | grep -q 'Load demo workspace' || fail "admin page missing the demo button"
  echo "$page" | grep -q 'Jobs by status' || fail "admin page missing job counts"
  echo "$page" | grep -q 'Grant a role' || fail "admin page missing role grants"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "admin page missing the shared footer"
  api "$JAR_A" GET /api/admin/stats; want 200 "admin counts"
  jq -e '.jobsByStatus and .usersByRole and .ai' <<<"$BODY" >/dev/null || fail "admin stats missing fields: $BODY"
  api "$JAR_A" GET /api/jobs; want 403 "admin reading jobs"
  api "$JAR_A" GET "/api/jobs/$JOB"; want 403 "admin reading a job"
  api "$JAR_A" GET /api/customers; want 403 "admin reading customers"
  api "$JAR_A" GET "/api/board?date=$DAY"; want 403 "admin reading the board"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d '{"userId":"'"$ID_N"'","role":"dispatcher"}' "$BASE_URL/api/auth/admin/set-role")
  case "$code" in 403|404) ;; *) fail "Better Auth's /admin/set-role must be disabled, got $code" ;; esac
  api "$JAR_N" GET /api/jobs; want 403 "new user after the blocked set-role"
  api "$JAR_A" POST /api/admin/roles '{"userId":"'"$ID_N"'","role":"technician","from":"user","clientOpId":"'"$(uuid)"'"}'; want 200 "grant technician"
  api "$JAR_N" GET /api/jobs; want 200 "newly granted technician listing jobs"
  api "$JAR_A" POST /api/admin/roles '{"userId":"'"$ID_N"'","role":"admin","from":"technician"}'; want 400 "granting admin"
  api "$JAR_A" POST /api/admin/roles '{"userId":"'"$ID_N"'","role":"user","from":"user"}'; want 409 "revoking with a stale role"
  api "$JAR_A" POST /api/admin/roles '{"userId":"'"$ID_N"'","role":"user","from":"technician"}'; want 200 "revoke"
  api "$JAR_N" GET /api/jobs; want 403 "revoked technician listing jobs"
  pass "admin: counts only, no job content; roles change only through POST /api/admin/roles (set-role is disabled)"
else
  pass "admin checks skipped (needs the database to make an admin; the live run has no admin account)"
fi

# --- clean up ----------------------------------------------------------------------------------------------------

api "$JAR_D" GET "/api/jobs/$JOB"; want 200 "reading the job before cancelling"; V=$(jqr .job.version)
api "$JAR_D" PATCH "/api/jobs/$JOB" '{"op":"cancel","version":'"$V"'}'; want 200 "cancel the smoke job"
[ "$(jqr .job.status)" = "cancelled" ] || fail "the smoke job should be cancelled: $BODY"
pass "cancelled the smoke job"

echo "SMOKE PASS"
