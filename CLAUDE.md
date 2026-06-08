# CLAUDE.md — order-demo-enterprise

## What this is
A four-service Kubernetes-native demo whose purpose is to make **upstream root-cause confirmation** visible end to end across a realistic enterprise topology (auth, an order branch and a payment branch converging in Kafka, a downstream consumer with a Redis read-through cache backed by Postgres). An orchestrator (built **outside this repo**, in TestKube) walks back along the real dependency chain and confirms which boundary actually broke. The application here is deliberately decoupled from how it gets tested so the orchestration layer can be reasoned about on its own. See `ARCHITECTURE.md` for the topology of record and `IMPLEMENTATION.md` for the as-built endpoint reference.

## Architecture
```
auth-service ──┐
               │ (Bearer-token authorize)
order-service ─┤── publishes ──► Kafka: order-placed ──────┐
               │                                            ├──► inventory-service ──► Redis cache ──► Postgres
payment-service ── publishes ──► Kafka: payment-confirmed ─┘    (convergence + symptom point)
```
**Failure flows down. The deepest upstream break is the true cause.**
- Four services, all Node.js + Express. order, payment, inventory use `kafkajs`. inventory also uses `ioredis` + `pg`. auth is pure HTTP.
- Two Kafka topics — `order-placed` (produced by order), `payment-confirmed` (produced by payment). Kafka runs single-node KRaft (no Zookeeper) inside the cluster.
- All in namespace **`order-demo`**.

### Non-negotiable correctness rules (encoded in code, not in tests)
- `order` genuinely calls `auth` over HTTP before publishing. If `auth` is unreachable / rejects / degraded-times-out, `order` returns an opaque `502 {"error":"upstream dependency unavailable"}` and **never** calls `producer.send`. No fallback path.
- `payment` is independent of `auth` and `order`. It publishes `payment-confirmed` directly.
- `inventory` only marks an id as **fulfilled** once it has received BOTH `order-placed` AND `payment-confirmed` for that id. `/processed/:id` reports the order-side arrival; `/fulfilled/:id` reports convergence and what it's still `waitingFor`.
- `inventory` checks cache vs source-of-truth on `/fulfill` — a stale cache surfaces as `409 DATA_INCONSISTENCY` (not as a connectivity error). This and DB DOWN vs DB DEGRADED are distinct, documented signatures.

## Key directories
| Path | Contents |
|---|---|
| `services/auth/server.js` | `POST /authorize` validates a Bearer token. `200 authorized` · `401 invalid_token` · `403 insufficient_scope`. Failure modes: scale to 0 (DOWN); send bad token (REJECT); `AUTH_DEGRADED_MS` env to artificially slow `/authorize` while `/health` stays fast (DEGRADED). SIGTERM handler for fast termination. |
| `services/order/server.js` | `POST /orders {id,item,qty}` → real `fetch` to `${AUTH_URL}/authorize` with `Authorization: Bearer ${AUTH_TOKEN}` and a 2s timeout → only on success calls `producer.send` on `order-placed`. Any auth-side failure returns opaque `502`. |
| `services/payment/server.js` | `POST /payments {id,amount?}` → publishes `payment-confirmed`. Independent of auth/order. |
| `services/inventory/server.js` | `kafkajs` consumer subscribed to BOTH topics (group `inventory-service`, `fromBeginning: true`). Tracks per-id arrivals in an in-process Map. `/health` (liveness only — does NOT touch DB), `/db/health`, `/processed/:id`, `/fulfilled/:id`. Stock layer: `POST /stock/seed`, `POST /cache/seed`, `POST /cache/flush`, `GET /stock/:sku`, `POST /fulfill` (cache-vs-DB check → 409 `DATA_INCONSISTENCY` on stale), `GET /consistency/check`, `POST /db/exhaust` (saturates the size-2 pg pool to demo DB DEGRADED). |
| `services/*/Dockerfile` | All `node:20-alpine`, `npm install --omit=dev`, run as USER `node`. |
| `kafka/kafka.yaml` | `apache/kafka:3.7.0` KRaft single-node combined mode (broker+controller), `emptyDir` storage, auto-create-topics enabled. |
| `k8s/namespace.yaml` | Creates `order-demo`. |
| `k8s/{auth,order,payment,inventory}.yaml` | Deployment + Service for each. Images `ghcr.io/neuralnimbus22/order-demo-{name}:latest` (public, multi-arch), `imagePullPolicy: IfNotPresent`. Auth has `terminationGracePeriodSeconds: 5`. order has CPU/memory `requests/limits` so an HPA can scale it. |
| `k8s/redis.yaml` | `redis:7-alpine` — read-through cache for inventory stock lookups. Service `redis:6379`. |
| `k8s/db.yaml` | `postgres:16-alpine` — source-of-truth for inventory's `stock` table. Service `db:5432`. Schema auto-applied by inventory on startup. |
| `tests/auth/test_auth.py` | pytest. Calls `/authorize` with/without tokens; asserts 200/401/403. |
| `tests/order/order.postman_collection.json` | Newman. Real `POST /orders` asserting `201` + `status:"placed"`. order-service injects `AUTH_TOKEN` server-side from env — the collection itself sends no token. |
| `tests/payment/test_payment.py` | pytest. Asserts `POST /payments` returns `201 confirmed`. |
| `tests/inventory/test_inventory.py` | pytest. Places an order then polls `/processed/:id`. Verdict is "did the message arrive?" — does NOT abort on order-side errors. Failure starts with `MESSAGE NEVER ARRIVED`. |
| `tests/inventory/test_cache_consistency.py` | pytest. Healthy cache-aside; stale cache → 409 `DATA_INCONSISTENCY`; cache-miss → fallback to DB then repopulate. |
| `tests/load/order-load.js` | k6 load script. Ramps to 500 VUs against `POST /orders` to drive HPA scaling. SLOs: p95<800ms, failed<5%. |
| `.github/workflows/build-images.yml` | Builds the four images multi-arch (linux/amd64 + linux/arm64) via QEMU+buildx, pushes to GHCR. Trigger filtered to `services/**` + this file. |
| `.github/workflows/ci-tests.yml` | Runs the four service tests sequentially on the self-hosted runner against the live cluster. |
| `scripts/deploy.sh` | **One-command bring-up.** namespace → Kafka + wait → pre-create `order-placed` → services + wait → rollout-restart order/inventory (Kafka client race) → sanity-check. Idempotent. |
| `scripts/break-auth.sh` | Scales auth → 0 and waits until cascade is observable (POST /orders returns 502). Typical 2–5s, capped by `WAIT_TIMEOUT_S=30`. |
| `scripts/restore.sh` | Scales auth → 1, deletes + recreates topic, restarts inventory (wipes in-memory state), verifies with a real order, then resets topic + inventory ONCE MORE so HWM=0. |
| `scripts/sanity-check.sh` | Per-deployment health + topic existence + topic high-water-mark. `[OK]/[WARN]/[FAIL]` markers. |
| `scripts/place-order.sh` | Healthy-path helper: place one order, confirm inventory processed it. |
| `testkube/README.md` | Intentionally empty marker — TestWorkflows are built by hand outside this repo. |

## How to run / deploy
**Build images locally** (tag with the GHCR path so `IfNotPresent` uses your local build without pulling — fresh machines pull from GHCR automatically):
```bash
cd services/auth      && docker build -t ghcr.io/neuralnimbus22/order-demo-auth:latest .
cd ../order           && docker build -t ghcr.io/neuralnimbus22/order-demo-order:latest .
cd ../payment         && docker build -t ghcr.io/neuralnimbus22/order-demo-payment:latest .
cd ../inventory       && docker build -t ghcr.io/neuralnimbus22/order-demo-inventory:latest .
# Pushing to GHCR is normally done by .github/workflows/build-images.yml on merge to main.
```

**Deploy everything to k8s (one command):**
```bash
./scripts/deploy.sh
```
What it does, in order: applies `k8s/namespace.yaml` → applies `kafka/` and waits for Kafka Available → pre-creates the `order-placed` topic → applies `k8s/` (auth + order + payment + inventory + redis + db) → waits for all Deployments Available → rollout-restarts order + inventory to clear the Kafka client race → runs `scripts/sanity-check.sh`. Idempotent.

> **Note:** `scripts/deploy.sh` currently only pre-creates the `order-placed` topic. `payment-confirmed` auto-creates on first PRODUCE, but inventory subscribes to it at startup. If inventory ever logs `This server does not host this topic-partition` on the payment topic, pre-create it the same way: `kubectl -n order-demo exec deploy/kafka -- /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --if-not-exists --topic payment-confirmed --partitions 1 --replication-factor 1`.

If you'd rather apply manually:
```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f kafka/
kubectl -n order-demo wait --for=condition=available --timeout=180s deploy/kafka
kubectl -n order-demo exec deploy/kafka -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --create --if-not-exists \
  --topic order-placed --partitions 1 --replication-factor 1
kubectl -n order-demo exec deploy/kafka -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --create --if-not-exists \
  --topic payment-confirmed --partitions 1 --replication-factor 1
kubectl apply -f k8s/
kubectl -n order-demo rollout restart deploy/order deploy/inventory
```

**Sanity check:** `./scripts/sanity-check.sh` → expects all `[OK]`.

**Demo cycle (run from outside the cluster — scripts handle port-forwards themselves):**
```bash
./scripts/place-order.sh    # green-path proof (note: only places the order half)
./scripts/break-auth.sh     # take auth down + wait for cascade
# … run downstream test or your orchestrator here …
./scripts/restore.sh        # bring auth back, reset state, verify
```

**Run a test standalone (port-forward first):**
```bash
kubectl -n order-demo port-forward svc/auth      13001:3001 &
kubectl -n order-demo port-forward svc/order     13002:3002 &
kubectl -n order-demo port-forward svc/payment   13004:3004 &
kubectl -n order-demo port-forward svc/inventory 13003:3003 &

AUTH_URL=http://localhost:13001 pytest tests/auth/test_auth.py -v
PAYMENT_URL=http://localhost:13004 pytest tests/payment/test_payment.py -v
ORDER_URL=http://localhost:13002 INVENTORY_URL=http://localhost:13003 \
  pytest tests/inventory/ -v
npx --yes newman run tests/order/order.postman_collection.json \
  --env-var baseUrl=http://localhost:13002
ORDER_URL=http://localhost:13002 k6 run tests/load/order-load.js
```

## Conventions / gotchas
- **Namespace is `order-demo`** for the workload; the TestKube agent (where orchestrator runs) lives elsewhere — this repo doesn't deploy it.
- **Images come from public GHCR multi-arch** (`ghcr.io/neuralnimbus22/order-demo-{auth,order,payment,inventory}:latest`) with `imagePullPolicy: IfNotPresent`. Built and pushed by `.github/workflows/build-images.yml` on merges that touch `services/**`. For local iteration, build with the same ghcr-prefixed tag and the kubelet uses your local build instead of pulling.
- **Tests must run in different frameworks on purpose** (pytest for auth/payment/inventory, Newman for order, k6 for load). Tool heterogeneity is what proves the orchestrator is tool-agnostic.
- **Inventory test does NOT fail on order-side errors** — it logs them and proceeds. The only verdict is "message arrived?". This keeps the symptom the orchestrator sees clean and consistent (`MESSAGE NEVER ARRIVED`), regardless of where upstream broke.
- **`break-auth.sh` returns ONLY after cascade is observable** — `POST /orders → 502` is confirmed via probe. No race window for the next step.
- **`restore.sh` resets all three state layers** — Kafka log (topic delete + recreate), consumer offset (inventory restart), in-memory state (inventory restart). Skipping any layer can cause false passes.
- **Auth has a SIGTERM handler + `terminationGracePeriodSeconds: 5`** in `k8s/auth.yaml`. Without these, the default 30s grace period made the cascade take ~31s instead of ~2–5s.
- **Kafka consumer + auto-create-topics interaction**: auto-create fires on PRODUCE, not SUBSCRIBE. If inventory starts before any message is published, its subscribe errors. Fix: pre-create the topic (the bring-up commands above do this for `order-placed`; do the same for `payment-confirmed` if you hit it).
- **Kafka client retry window**: `kafkajs` retries a broker connect ~5 times (~15s total) and then **gives up permanently**, leaving the pod alive but disconnected. If order/inventory pods start before Kafka is reachable (e.g. all manifests applied in one shot), they end up "Ready but broken". Fix: rollout-restart order + inventory after Kafka is proven up. `scripts/deploy.sh` does this automatically — if you bring the stack up manually, do the restart yourself.
- **Inventory's `/health` is deliberately liveness-only** — it does NOT touch the DB. That's so DB DEGRADED (pool saturation) doesn't kill the readiness probe and turn a slow-DB symptom into a CrashLoop. Use `/db/health` to actually check DB reachability.
- **DB pool is intentionally tiny** (`DB_POOL_MAX=2`) so `/db/exhaust` can reliably saturate it for the DB DEGRADED demo.
- **DATA_INCONSISTENCY is a distinct signature** — all services `/health` 200, but `/fulfill` returns `409` with `cacheQty` and `dbQty` reported. Cache TTL is 60s, so the poison window is finite; re-seed via `/cache/seed` to extend.
- **Scripts use port-forwards internally** — they assume a working `kubectl` and proper cluster context. No external load balancer needed.
- **No TestKube content in this repo.** `testkube/` is intentionally empty; orchestration lives outside.

## Common tasks
- **Modify a service** → edit `services/<name>/server.js`, rebuild (`docker build -t ghcr.io/neuralnimbus22/order-demo-<name>:latest .`), `kubectl -n order-demo rollout restart deploy/<name>`. To publish for other clusters: merge to main and let `build-images.yml` push.
- **Tune the cascade demo timing** → `WAIT_TIMEOUT_S`, `HEALTHY_POLL_TIMEOUT_S`, `INVENTORY_POLL_TIMEOUT_S` env vars in the relevant scripts/tests.
- **Add a new test in a different framework** → drop it in `tests/<framework>/`. Use env vars for URLs (`AUTH_URL`, `ORDER_URL`, `PAYMENT_URL`, `INVENTORY_URL`). Don't bake in invocation assumptions — the orchestrator wraps it later.
- **Reset state after a failed run** → `./scripts/restore.sh` (idempotent — works whether auth was down or up).
- **Demo a failure mode end-to-end** → see `IMPLEMENTATION.md` for the exact one-line induction recipe for each (DOWN/REJECT/DEGRADED auth, PAYMENT DOWN, STALE CACHE, DB DOWN, DB DEGRADED).
- **Debug "test fails but I don't know why"** → start at the downstream test's failure message, then walk back: `kubectl -n order-demo get pods,endpoints`, `kubectl -n order-demo logs deploy/inventory`, `kubectl -n order-demo exec deploy/kafka -- /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 --topic order-placed --time -1` (and the same for `payment-confirmed`).
