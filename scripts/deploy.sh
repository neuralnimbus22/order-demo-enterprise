#!/usr/bin/env bash
# deploy.sh — bring the entire order-demo stack up from scratch with one command.
#
# Captures the exact sequence verified by hand for the full 4-service stack:
#   1. namespace
#   2. kafka + wait for it to become Available
#   3. pre-create BOTH topics: order-placed AND payment-confirmed
#      (Kafka's auto-create-topics only fires on first PRODUCE, not SUBSCRIBE —
#       without this, inventory's subscribe errors on whichever topic doesn't
#       exist yet and the rollout restart in step 6 can't fix it.)
#   4. apply all services + infra (auth, order, payment, inventory, redis, db,
#      and the HPA on order)
#   5. wait for every Deployment to become Available
#   6. rollout-restart the kafkajs clients (order + inventory + payment)
#      (kafkajs retries a connect ~5 times then gives up. If those pods came
#       up before Kafka was reachable, they're now alive-but-disconnected.
#       A restart with Kafka already up + both topics already created brings
#       every Kafka client into a clean steady state.)
#   7. scripts/sanity-check.sh
#
# Exit code: 0 on success. Aborts immediately on any failure (set -e).
# Idempotent — safe to re-run on an already-deployed stack.
#
# Style and helpers match the other scripts in this folder.

set -e -o pipefail

NS="${NAMESPACE:-order-demo}"
TOPICS=( "order-placed" "payment-confirmed" )
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Deployments that must be Available before we declare success. Order matters
# only insofar as Kafka is handled separately above; everything in this list
# runs in parallel under the hood but `kubectl wait` is sequential here for
# clear per-deployment progress lines.
SERVICES=( auth order payment inventory product-catalog user-session )
INFRA=( redis db )

# Subset of services that use kafkajs and therefore need the post-Kafka rollout
# restart (see step 6 above). auth + product-catalog + user-session have no
# Kafka client so they're not in this list.
KAFKA_CLIENTS=( order payment inventory )

ok()      { echo "[OK]   $*"; }
fail()    { echo "[FAIL] $*" >&2; }
hint()    { echo "       hint: $*"; }
section() { echo; echo "--- $* ---"; }

echo "=== deploy (namespace=$NS, topics=${TOPICS[*]}) ==="
echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"

# --- 1. namespace ----------------------------------------------------------
section "1. namespace"
kubectl apply -f "$REPO_ROOT/k8s/namespace.yaml"
ok "namespace '$NS' applied"

# --- 2. kafka --------------------------------------------------------------
section "2. kafka"
kubectl apply -f "$REPO_ROOT/kafka/"
echo "waiting for kafka to be Available..."
kubectl -n "$NS" wait --for=condition=available --timeout=180s deploy/kafka
ok "kafka is Ready"

# --- 3. pre-create topics --------------------------------------------------
section "3. pre-create topics: ${TOPICS[*]}"
for t in "${TOPICS[@]}"; do
  kubectl -n "$NS" exec deploy/kafka -- /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server localhost:9092 \
    --create --if-not-exists --topic "$t" \
    --partitions 1 --replication-factor 1
  ok "topic '$t' exists"
done

# --- 4. services + infra ---------------------------------------------------
section "4. services + infra (${SERVICES[*]}, ${INFRA[*]}) + HPA"
kubectl apply -f "$REPO_ROOT/k8s/"
ok "manifests applied"

# --- 5. wait for rollouts --------------------------------------------------
section "5. wait for every Deployment to be Available"
for d in "${SERVICES[@]}" "${INFRA[@]}"; do
  echo "waiting for $d..."
  kubectl -n "$NS" wait --for=condition=available --timeout=120s deploy/"$d"
  ok "$d is Ready"
done

# --- 6. rollout-restart Kafka clients (race fix) --------------------------
section "6. rollout-restart Kafka clients (${KAFKA_CLIENTS[*]}) — race fix"
kubectl -n "$NS" rollout restart "${KAFKA_CLIENTS[@]/#/deploy/}"
for d in "${KAFKA_CLIENTS[@]}"; do
  kubectl -n "$NS" rollout status "deploy/$d" --timeout=120s
done
ok "${KAFKA_CLIENTS[*]} restarted clean"

# --- 7. sanity check -------------------------------------------------------
section "7. sanity check"
"$REPO_ROOT/scripts/sanity-check.sh"

echo
ok "stack is deployed and green"
