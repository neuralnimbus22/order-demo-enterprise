#!/usr/bin/env bash
# smoke-test.sh — read-only health + functional check of the live order-demo
# backend. Probes every service's /health, asserts product-catalog actually
# serves its seeded products, exercises the real user-session identity
# round-trip (register → login → validate), and confirms the infra (kafka
# topics, redis, postgres) is reachable.
#
# READ-ONLY BY DESIGN: no scaling, no deploys, no failure injection — that's
# break-auth.sh / restore.sh territory. The only write anywhere is the single
# throwaway user row the register step creates (unique email per run, so
# re-runs never collide on 409).
#
# Exit code: 0 if every check passes, non-zero otherwise — safe to gate a
# pipeline on.
#
# Style and helpers match the other scripts in this folder.

set -o pipefail

NS="${NAMESPACE:-order-demo}"
TOPICS=( "order-placed" "payment-confirmed" )

# Local probe ports — distinct ranges per script so concurrent runs can't
# collide (break-auth uses 18402, restore 185xx, place-order 186xx).
PROBE_PORT_AUTH="${PROBE_PORT_AUTH:-18701}"
PROBE_PORT_ORDER="${PROBE_PORT_ORDER:-18702}"
PROBE_PORT_INV="${PROBE_PORT_INV:-18703}"
PROBE_PORT_PAYMENT="${PROBE_PORT_PAYMENT:-18704}"
PROBE_PORT_CATALOG="${PROBE_PORT_CATALOG:-18705}"
PROBE_PORT_SESSION="${PROBE_PORT_SESSION:-18706}"

PASS=0; FAIL=0; WARN=0
ok()      { echo "[OK]   $*"; PASS=$((PASS+1)); }
fail()    { echo "[FAIL] $*"; FAIL=$((FAIL+1)); }
warn()    { echo "[WARN] $*"; WARN=$((WARN+1)); }
hint()    { echo "       hint: $*"; }
section() { echo; echo "--- $* ---"; }

# curl wrapper: hit a URL, assert the HTTP code, count PASS/FAIL.
# Leaves the response body in $BODY for callers that assert on content.
BODY=""
check_http() {
  local label="$1" expect="$2" url="$3"; shift 3
  local code
  code=$(curl -s -o /tmp/smoke-body -w "%{http_code}" --max-time 5 "$@" "$url" 2>/dev/null)
  BODY=$(cat /tmp/smoke-body 2>/dev/null)
  if [ "$code" = "$expect" ]; then
    ok "$label -> HTTP $code"
    return 0
  else
    fail "$label -> HTTP ${code:-000} (expected $expect)  body=${BODY}"
    return 1
  fi
}

echo "=== smoke-test (namespace=$NS) ==="
echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"

# --- 1. namespace ----------------------------------------------------------
section "1. namespace"
if ! kubectl get ns "$NS" >/dev/null 2>&1; then
  fail "namespace '$NS' does not exist"
  hint "scripts/deploy.sh brings the stack up from scratch"
  echo; echo "Passed=$PASS Failed=$FAIL Warned=$WARN"
  exit 1
fi
ok "namespace '$NS' exists"

# --- 2. deployments healthy -------------------------------------------------
# Compare status.replicas vs status.availableReplicas — equal and non-zero =
# healthy. (Same probe sanity-check.sh uses; here scaled-to-0 is a FAIL, not
# a WARN — a smoke test asserts the system is up, broken-state demos aren't
# its business.)
section "2. deployments"
for dep in kafka auth order payment inventory product-catalog user-session redis db; do
  read -r desired available < <(
    kubectl -n "$NS" get deploy "$dep" \
      -o jsonpath='{.status.replicas} {.status.availableReplicas}' 2>/dev/null
  )
  desired=${desired:-0}; available=${available:-0}
  if [ "$desired" = "$available" ] && [ "$desired" != "0" ]; then
    ok "deploy/$dep $available/$desired"
  else
    fail "deploy/$dep $available/$desired"
    hint "kubectl -n $NS get pods -l app=$dep ; kubectl -n $NS describe deploy/$dep"
  fi
done

# --- 3. kafka topics ---------------------------------------------------------
section "3. kafka topics"
topic_list=$(kubectl -n "$NS" exec deploy/kafka -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --list 2>/dev/null)
if [ -z "$topic_list" ]; then
  fail "could not list topics (kafka unreachable?)"
  hint "kubectl -n $NS logs deploy/kafka --tail=20"
else
  for t in "${TOPICS[@]}"; do
    if echo "$topic_list" | grep -q "^${t}$"; then
      ok "topic '$t' exists"
    else
      fail "topic '$t' does not exist"
      hint "scripts/deploy.sh pre-creates both topics"
    fi
  done
fi

# --- 4. redis ----------------------------------------------------------------
section "4. redis"
if [ "$(kubectl -n "$NS" exec deploy/redis -- redis-cli ping 2>/dev/null)" = "PONG" ]; then
  ok "redis PING -> PONG"
else
  fail "redis did not answer PING"
  hint "kubectl -n $NS logs deploy/redis --tail=20"
fi

# --- 5. port-forwards --------------------------------------------------------
section "5. port-forwards"
kubectl -n "$NS" port-forward svc/auth            ${PROBE_PORT_AUTH}:3001    >/tmp/smoke-pf-auth.log 2>&1 &
PF_AUTH=$!
kubectl -n "$NS" port-forward svc/order           ${PROBE_PORT_ORDER}:3002   >/tmp/smoke-pf-order.log 2>&1 &
PF_ORDER=$!
kubectl -n "$NS" port-forward svc/inventory       ${PROBE_PORT_INV}:3003     >/tmp/smoke-pf-inv.log 2>&1 &
PF_INV=$!
kubectl -n "$NS" port-forward svc/payment         ${PROBE_PORT_PAYMENT}:3004 >/tmp/smoke-pf-payment.log 2>&1 &
PF_PAYMENT=$!
kubectl -n "$NS" port-forward svc/product-catalog ${PROBE_PORT_CATALOG}:3005 >/tmp/smoke-pf-catalog.log 2>&1 &
PF_CATALOG=$!
kubectl -n "$NS" port-forward svc/user-session    ${PROBE_PORT_SESSION}:3006 >/tmp/smoke-pf-session.log 2>&1 &
PF_SESSION=$!
cleanup() {
  for p in "$PF_AUTH" "$PF_ORDER" "$PF_INV" "$PF_PAYMENT" "$PF_CATALOG" "$PF_SESSION"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null && wait "$p" 2>/dev/null
  done
}
trap cleanup EXIT
# Let the port-forwards bind locally (same wait break-auth.sh uses).
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -sf -o /dev/null --max-time 1 http://localhost:${PROBE_PORT_SESSION}/health 2>/dev/null && break
  sleep 0.5
done
echo "port-forwards up (auth=${PROBE_PORT_AUTH} order=${PROBE_PORT_ORDER} inventory=${PROBE_PORT_INV} payment=${PROBE_PORT_PAYMENT} catalog=${PROBE_PORT_CATALOG} session=${PROBE_PORT_SESSION})"

# --- 6. service health -------------------------------------------------------
section "6. service /health"
check_http "auth            GET /health"    200 "http://localhost:${PROBE_PORT_AUTH}/health"
check_http "order           GET /health"    200 "http://localhost:${PROBE_PORT_ORDER}/health"
check_http "payment         GET /health"    200 "http://localhost:${PROBE_PORT_PAYMENT}/health"
check_http "inventory       GET /health"    200 "http://localhost:${PROBE_PORT_INV}/health"
# /db/health doubles as the postgres-reachability probe — it wraps SELECT 1
# and distinguishes DOWN (ECONNREFUSED) from DEGRADED (db_health_timeout).
check_http "inventory       GET /db/health (postgres reachable)" 200 \
  "http://localhost:${PROBE_PORT_INV}/db/health" \
  || hint "kubectl -n $NS logs deploy/db --tail=20 ; body above distinguishes DB DOWN vs DEGRADED"
check_http "product-catalog GET /health"    200 "http://localhost:${PROBE_PORT_CATALOG}/health"
check_http "user-session    GET /health"    200 "http://localhost:${PROBE_PORT_SESSION}/health"

# --- 7. product-catalog serves its seed --------------------------------------
section "7. product-catalog functional"
if check_http "product-catalog GET /products" 200 "http://localhost:${PROBE_PORT_CATALOG}/products"; then
  # The catalog seeds ~20 products on startup; a 200 with an empty array means
  # the seed never ran — assert at least one product row came back.
  if echo "$BODY" | grep -q '"id"'; then
    ok "product-catalog /products returned a non-empty product list"
  else
    fail "product-catalog /products returned 200 but no products  body=${BODY}"
    hint "kubectl -n $NS logs deploy/product-catalog --tail=20 (seed should run on startup)"
  fi
fi

# --- 8. user-session identity round-trip --------------------------------------
section "8. user-session register -> login -> validate"
SMOKE_EMAIL="smoke-$(date +%s)-${RANDOM}@example.com"
SMOKE_PASSWORD="smoke-password-${RANDOM}"

check_http "user-session POST /register (${SMOKE_EMAIL})" 201 \
  "http://localhost:${PROBE_PORT_SESSION}/register" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"email\":\"${SMOKE_EMAIL}\",\"password\":\"${SMOKE_PASSWORD}\"}"

TOKEN=""
if check_http "user-session POST /login" 200 \
     "http://localhost:${PROBE_PORT_SESSION}/login" \
     -X POST -H 'Content-Type: application/json' \
     -d "{\"email\":\"${SMOKE_EMAIL}\",\"password\":\"${SMOKE_PASSWORD}\"}"; then
  TOKEN=$(echo "$BODY" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  if [ -n "$TOKEN" ]; then
    ok "login returned a JWT"
  else
    fail "login returned 200 but no token in body  body=${BODY}"
  fi
fi

if [ -n "$TOKEN" ]; then
  check_http "user-session GET /validate" 200 \
    "http://localhost:${PROBE_PORT_SESSION}/validate" \
    -H "Authorization: Bearer ${TOKEN}"
else
  fail "user-session GET /validate skipped — no token from login"
fi

cleanup
trap - EXIT

# --- summary ------------------------------------------------------------------
echo
echo "=== summary ==="
echo "Passed: $PASS  Failed: $FAIL  Warned: $WARN"
if [ $FAIL -eq 0 ]; then
  echo "[PASS] backend smoke test green"
  exit 0
else
  echo "[FAIL] backend smoke test NOT green — fix the items above"
  exit 1
fi
