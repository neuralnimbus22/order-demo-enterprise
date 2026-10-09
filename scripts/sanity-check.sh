#!/usr/bin/env bash
# sanity-check.sh — confirm the order-demo system is in a known-clean state.
#
# Run before testing to catch "pod CrashLoopBackOff", "topic missing", "stale
# messages in topic", etc. before they bite you on stage.
#
# Exit code: 0 if all checks pass, non-zero on the first failure.
#
# Output is plain [OK]/[WARN]/[FAIL] markers, no colors, no unicode.

set -o pipefail

NS="${NAMESPACE:-order-demo}"
TOPIC="${KAFKA_TOPIC:-order-placed}"

PASS=0; FAIL=0; WARN=0
ok()   { echo "[OK]   $*"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL+1)); }
warn() { echo "[WARN] $*"; WARN=$((WARN+1)); }
hint() { echo "       hint: $*"; }

echo "=== sanity-check (namespace=$NS, topic=$TOPIC) ==="
echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"

# --- 1. namespace exists ---------------------------------------------------
if ! kubectl get ns "$NS" >/dev/null 2>&1; then
  fail "namespace '$NS' does not exist"
  hint "kubectl apply -f k8s/namespace.yaml"
  echo; echo "Passed=$PASS Failed=$FAIL Warned=$WARN"
  exit 1
fi
ok "namespace '$NS' exists"

# --- 2. all four deployments healthy --------------------------------------
# Compare status.replicas vs status.availableReplicas — equal = healthy
# (including 0/0 if a deployment is intentionally scaled to 0).
echo
echo "--- deployments ---"
for dep in kafka auth order inventory; do
  read -r desired available < <(
    kubectl -n "$NS" get deploy "$dep" \
      -o jsonpath='{.status.replicas} {.status.availableReplicas}' 2>/dev/null
  )
  desired=${desired:-0}; available=${available:-0}
  if [ "$desired" = "0" ] && [ "$dep" = "auth" ]; then
    warn "$dep $available/$desired — auth is scaled to 0. Restore with: kubectl -n $NS scale deploy/auth --replicas=1"
  elif [ "$desired" = "$available" ] && [ "$desired" != "0" ]; then
    ok "$dep $available/$desired"
  else
    fail "$dep $available/$desired"
    hint "kubectl -n $NS get pods -l app=$dep ; kubectl -n $NS describe deploy/$dep"
  fi
done

# --- 3. kafka topic exists --------------------------------------------------
echo
echo "--- kafka topic ---"
if kubectl -n "$NS" exec deploy/kafka -- /opt/kafka/bin/kafka-topics.sh \
     --bootstrap-server localhost:9092 --list 2>/dev/null | grep -q "^${TOPIC}$"; then
  ok "topic '$TOPIC' exists"
else
  fail "topic '$TOPIC' does not exist"
  hint "create it with: kubectl -n $NS exec deploy/kafka -- /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --topic $TOPIC --partitions 1 --replication-factor 1"
fi

# --- 4. topic is empty (zero high-water-mark on partition 0) --------------
# kafka-get-offsets prints "TOPIC:PART:OFFSET". --time -1 = latest offset = HWM.
# A clean topic just after creation should be at offset 0.
hwm=$(kubectl -n "$NS" exec deploy/kafka -- /opt/kafka/bin/kafka-get-offsets.sh \
        --bootstrap-server localhost:9092 --topic "$TOPIC" --time -1 2>/dev/null \
        | awk -F: '{print $3}' | head -1)
hwm=${hwm:-?}
if [ "$hwm" = "0" ]; then
  ok "topic '$TOPIC' is empty (HWM=0)"
elif [ "$hwm" = "?" ]; then
  warn "could not read topic high-water-mark"
else
  warn "topic '$TOPIC' has $hwm messages (not fresh)"
fi

# --- summary --------------------------------------------------------------
echo
echo "=== summary ==="
echo "Passed: $PASS  Failed: $FAIL  Warned: $WARN"
if [ $FAIL -eq 0 ]; then
  echo "[PASS] system looks healthy"
  exit 0
else
  echo "[FAIL] system NOT ready — fix the items above"
  exit 1
fi
