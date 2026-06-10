# CLAUDE.md — order-demo-enterprise

## What this is
A six-service Kubernetes-native demo whose purpose is to make **upstream root-cause confirmation** visible end to end across a realistic enterprise topology (auth, an order branch and a payment branch converging in Kafka, a downstream consumer with a Redis read-through cache backed by Postgres, plus a read-only product catalog for optional sku validation, plus a standalone user-session service for the Phase 2 UI's human login). An orchestrator (built **outside this repo**, in TestKube) walks back along the real dependency chain and confirms which boundary actually broke. The application here is deliberately decoupled from how it gets tested so the orchestration layer can be reasoned about on its own. See `ARCHITECTURE.md` for the topology of record and `IMPLEMENTATION.md` for the as-built endpoint reference.

## Architecture
```
Order pipeline (backend):

auth-service ──┐
               │ (Bearer-token authorize)
order-service ─┤── publishes ──► Kafka: order-placed ──────┐
       │       │                                            ├──► inventory-service ──► Redis cache ──► Postgres
       │  (optional sku validation)                         │
       ▼                                                    │
product-catalog                                             │
                                                            │
payment-service ── publishes ──► Kafka: payment-confirmed ──┘    (convergence + symptom point)

Human identity (for the UI — Phase 2):

  user-session   register / login / JWT validate — standalone, not on the order pipeline
```
**Failure flows down. The deepest upstream break is the true cause.**
- Six services, all Node.js + Express. order, payment, inventory use `kafkajs`. inventory also uses `ioredis` + `pg`. product-catalog uses `pg`. user-session uses `pg` + `bcryptjs` + `jsonwebtoken`. auth is pure HTTP.
- Two Kafka topics — `order-placed` (produced by order), `payment-confirmed` (produced by payment). Kafka runs single-node KRaft (no Zookeeper) inside the cluster.
- One Postgres (`db:5432`, database `inventory`) hosting three cleanly separate tables: `stock` (inventory's source of truth), `products` (product-catalog's seeded catalog), and `users` (user-session registered accounts).
- All in namespace **`order-demo`**.

### Two identity concepts — kept strictly separate
`auth-service` and `user-session` are different things on purpose:
- **auth-service** authorizes an ORDER in the backend. Static Bearer-token catalogue. `order-service` calls it server-to-server. Unrelated to humans.
- **user-session** is who the USER is. Real `/register`, `/login` (signed JWTs), `/validate`. The Phase 2 UI uses this for login/logout. Standalone — no other service calls it on the order path.

They do not share code, tokens, or a database table.

### Non-negotiable correctness rules (encoded in code, not in tests)
- `order` genuinely calls `auth` over HTTP before publishing. If `auth` is unreachable / rejects / degraded-times-out, `order` returns an opaque `502 {"error":"upstream dependency unavailable"}` and **never** calls `producer.send`. No fallback path.
- `order`'s catalog call is **optional and additive**. If `sku` is in the body, order calls `product-catalog`; unknown sku → 404, catalog unreachable → opaque 502 (same shape as auth-side failures). If `sku` is absent the catalog is not called at all — the no-sku path is byte-identical to the pre-catalog behavior.
- `payment` is independent of `auth` and `order`. It publishes `payment-confirmed` directly.
- `inventory` only marks an id as **fulfilled** once it has received BOTH `order-placed` AND `payment-confirmed` for that id. `/processed/:id` reports the order-side arrival; `/fulfilled/:id` reports convergence and what it's still `waitingFor`.
- `inventory` checks cache vs source-of-truth on `/fulfill` — a stale cache surfaces as `409 DATA_INCONSISTENCY` (not as a connectivity error). This and DB DOWN vs DB DEGRADED are distinct, documented signatures.

## Key directories
| Path | Contents |
|---|---|
| `services/auth/server.js` | `POST /authorize` validates a Bearer token. `200 authorized` · `401 invalid_token` · `403 insufficient_scope`. Failure modes: scale to 0 (DOWN); send bad token (REJECT); `AUTH_DEGRADED_MS` env to artificially slow `/authorize` while `/health` stays fast (DEGRADED). SIGTERM handler for fast termination. |
| `services/order/server.js` | `POST /orders {id,item,qty,sku?}` → if `sku` supplied, `GET ${CATALOG_URL}/products/:sku` first (404 → unknown product; catalog unreachable → opaque 502; on success fills `item` from product name if not supplied) → real `fetch` to `${AUTH_URL}/authorize` with `Authorization: Bearer ${AUTH_TOKEN}` and a 2s timeout → only on success calls `producer.send` on `order-placed`. Any auth-side failure returns opaque `502`. **No-sku path is byte-identical to pre-catalog behavior** (no catalog call). |
| `services/payment/server.js` | `POST /payments {id,amount?}` → publishes `payment-confirmed`. Independent of auth/order. |
| `services/product-catalog/server.js` | Read-only catalog, port 3005. Postgres-backed (same `db:5432` + `inventory` creds inventory uses; new `products` table). Auto-creates the table and seeds ~20 generic retail products on startup (idempotent `INSERT … ON CONFLICT DO NOTHING`; retries Postgres connect ~30× on boot). `GET /products` → list. `GET /products/:id` → one (404 on unknown sku). The product `id` IS the sku — same key inventory's `stock` table uses. Catalog `stock` is display data only; inventory's `stock` is source of truth for fulfillment. |
| `services/user-session/server.js` | Human-identity service, port 3006. Postgres-backed (same `db:5432` + `inventory` creds; new `users` table). `POST /register {email,password}` → 201 / 409 / 400; `POST /login` → opaque `401 invalid_credentials` or `200 {token,email}`; `GET /validate` (Authorization: Bearer …) → 200 with claims or `401 invalid_token`. Passwords hashed with `bcryptjs` (pure JS — works on `node:20-alpine` without native build tools). JWTs signed `HS256` via `jsonwebtoken`, default 1h expiry, secret from `JWT_SECRET` env. Seeds `demo@example.com` / `demo-password` on startup (idempotent) so the Phase 2 UI has a guaranteed login. NOT called by order-service or any other backend service — strictly the human login surface for the UI. |
| `services/inventory/server.js` | `kafkajs` consumer subscribed to BOTH topics (group `inventory-service`, `fromBeginning: true`). Tracks per-id arrivals in an in-process Map. `/health` (liveness only — does NOT touch DB), `/db/health`, `/processed/:id`, `/fulfilled/:id`. Stock layer: `POST /stock/seed`, `POST /cache/seed`, `POST /cache/flush`, `GET /stock/:sku`, `POST /fulfill` (cache-vs-DB check → 409 `DATA_INCONSISTENCY` on stale), `GET /consistency/check`, `POST /db/exhaust` (saturates the size-2 pg pool to demo DB DEGRADED). |
| `services/*/Dockerfile` | All `node:20-alpine`, `npm install --omit=dev`, run as USER `node`. |
| `kafka/kafka.yaml` | `apache/kafka:3.7.0` KRaft single-node combined mode (broker+controller), `emptyDir` storage, auto-create-topics enabled. |
| `k8s/namespace.yaml` | Creates `order-demo`. |
| `k8s/{auth,order,payment,inventory,product-catalog,user-session}.yaml` | Deployment + Service for each. Images `ghcr.io/neuralnimbus22/order-demo-{name}:latest` (public, multi-arch), `imagePullPolicy: IfNotPresent`. Auth has `terminationGracePeriodSeconds: 5`. order has CPU/memory `requests/limits` so an HPA can scale it. order also has `CATALOG_URL` pointing at product-catalog. product-catalog and user-session share the same DB env-var set as inventory. user-session also carries `JWT_SECRET` (env-value for the local demo — production would use a Kubernetes Secret). |
| `k8s/redis.yaml` | `redis:7-alpine` — read-through cache for inventory stock lookups. Service `redis:6379`. |
| `k8s/db.yaml` | `postgres:16-alpine` — source-of-truth for inventory's `stock` table. Service `db:5432`. Schema auto-applied by inventory on startup. |
| `k8s/hpa.yaml` | HorizontalPodAutoscaler on `deploy/order`: min 1, max 5, target avg CPU 70%. Pairs with order's `resources` block and the k6 load test. **Requires metrics-server** — present on GKE, typically NOT on local Docker Desktop (the HPA object exists but metric reads `<unknown>` and no scaling happens). |
| `tests/auth/test_auth.py` | pytest. Calls `/authorize` with/without tokens; asserts 200/401/403. |
| `tests/order/order.postman_collection.json` | Newman. Real `POST /orders` asserting `201` + `status:"placed"`. order-service injects `AUTH_TOKEN` server-side from env — the collection itself sends no token. |
| `tests/payment/test_payment.py` | pytest. Asserts `POST /payments` returns `201 confirmed`. |
| `tests/inventory/test_inventory.py` | pytest. Places an order then polls `/processed/:id`. Verdict is "did the message arrive?" — does NOT abort on order-side errors. Failure starts with `MESSAGE NEVER ARRIVED`. |
| `tests/inventory/test_cache_consistency.py` | pytest. Healthy cache-aside; stale cache → 409 `DATA_INCONSISTENCY`; cache-miss → fallback to DB then repopulate. |
| `tests/product-catalog/test_product_catalog.py` | pytest. `/health`, full `/products` list (>=20 seeded), known sku, 404 on unknown. **Not wired into ci-tests.yml** — pipeline wiring deferred on purpose. |
| `tests/user-session/test_user_session.py` | pytest. `/health`, register (success + duplicate 409 + missing fields 400), login (success + wrong password 401 + unknown email 401 — both opaque), `/validate` (good JWT + missing + garbage). Uses a unique email per run via `uuid` so re-runs don't collide. **Not wired into ci-tests.yml** — pipeline wiring deferred on purpose. |
| `tests/load/order-load.js` | k6 load script. Ramps to 500 VUs against `POST /orders` to drive HPA scaling. SLOs: p95<800ms, failed<5%. |
| `.github/workflows/build-images.yml` | Builds the six service images multi-arch (linux/amd64 + linux/arm64) via QEMU+buildx, pushes to GHCR. Matrix: `[auth, order, payment, inventory, product-catalog, user-session]`. Trigger filtered to `services/**` + this file. |
| `.github/workflows/ci-tests.yml` | Runs the four original service tests sequentially on the self-hosted runner against the live cluster. (product-catalog and user-session tests deliberately NOT wired in — see deferral above.) |
| `scripts/deploy.sh` | **One-command bring-up.** namespace → Kafka + wait → pre-create BOTH topics (`order-placed`, `payment-confirmed`) → services + infra (auth, order, payment, inventory, product-catalog, user-session, redis, db) + HPA → wait for every Deployment Available → rollout-restart the kafkajs clients (order, payment, inventory — product-catalog and user-session have no Kafka client) → sanity-check. Idempotent. |
| `scripts/break-auth.sh` | Scales auth → 0 and waits until cascade is observable (POST /orders returns 502). Typical 2–5s, capped by `WAIT_TIMEOUT_S=30`. |
| `scripts/restore.sh` | Scales auth → 1, deletes + recreates topic, restarts inventory (wipes in-memory state), verifies with a real order, then resets topic + inventory ONCE MORE so HWM=0. |
| `scripts/sanity-check.sh` | Per-deployment health + topic existence + topic high-water-mark. `[OK]/[WARN]/[FAIL]` markers. |
| `scripts/place-order.sh` | Healthy-path helper: place one order, confirm inventory processed it. |
| `testkube/samples/` | Commented reference TestWorkflows for demos (pytest-auth, k6-load-sharded, playwright-ui). Production orchestration still lives outside the repo. |

## How to run / deploy
**Build images locally** (tag with the GHCR path so `IfNotPresent` uses your local build without pulling — fresh machines pull from GHCR automatically):
```bash
cd services/auth            && docker build -t ghcr.io/neuralnimbus22/order-demo-auth:latest .
cd ../order                 && docker build -t ghcr.io/neuralnimbus22/order-demo-order:latest .
cd ../payment               && docker build -t ghcr.io/neuralnimbus22/order-demo-payment:latest .
cd ../inventory             && docker build -t ghcr.io/neuralnimbus22/order-demo-inventory:latest .
cd ../product-catalog       && docker build -t ghcr.io/neuralnimbus22/order-demo-product-catalog:latest .
cd ../user-session          && docker build -t ghcr.io/neuralnimbus22/order-demo-user-session:latest .
# Pushing to GHCR is normally done by .github/workflows/build-images.yml on merge to main.
```

**Deploy everything to k8s (one command):**
```bash
./scripts/deploy.sh
```
What it does, in order: applies `k8s/namespace.yaml` → applies `kafka/` and waits for Kafka Available → pre-creates **both** topics (`order-placed` and `payment-confirmed`) → applies `k8s/` (auth + order + payment + inventory + product-catalog + user-session + redis + db + the HPA) → waits for every Deployment Available (`auth`, `order`, `payment`, `inventory`, `product-catalog`, `user-session`, `redis`, `db`) → rollout-restarts the kafkajs clients (`order`, `payment`, `inventory`) to clear the Kafka client race → runs `scripts/sanity-check.sh`. Idempotent.

If you'd rather apply manually:
```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f kafka/
kubectl -n order-demo wait --for=condition=available --timeout=180s deploy/kafka
for t in order-placed payment-confirmed; do
  kubectl -n order-demo exec deploy/kafka -- /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server localhost:9092 --create --if-not-exists \
    --topic "$t" --partitions 1 --replication-factor 1
done
kubectl apply -f k8s/
kubectl -n order-demo rollout restart deploy/order deploy/payment deploy/inventory
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
kubectl -n order-demo port-forward svc/auth            13001:3001 &
kubectl -n order-demo port-forward svc/order           13002:3002 &
kubectl -n order-demo port-forward svc/payment         13004:3004 &
kubectl -n order-demo port-forward svc/inventory       13003:3003 &
kubectl -n order-demo port-forward svc/product-catalog 13005:3005 &
kubectl -n order-demo port-forward svc/user-session    13006:3006 &

AUTH_URL=http://localhost:13001 pytest tests/auth/test_auth.py -v
PAYMENT_URL=http://localhost:13004 pytest tests/payment/test_payment.py -v
ORDER_URL=http://localhost:13002 INVENTORY_URL=http://localhost:13003 \
  pytest tests/inventory/ -v
PRODUCT_CATALOG_URL=http://localhost:13005 \
  pytest tests/product-catalog/test_product_catalog.py -v
USER_SESSION_URL=http://localhost:13006 \
  pytest tests/user-session/test_user_session.py -v
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
- **Kafka consumer + auto-create-topics interaction**: auto-create fires on PRODUCE, not SUBSCRIBE. If inventory starts before any message is published, its subscribe errors. Fix: pre-create the topic. `scripts/deploy.sh` now pre-creates **both** topics (`order-placed` and `payment-confirmed`) so a fresh-cluster bring-up no longer races on either.
- **Kafka client retry window**: `kafkajs` retries a broker connect ~5 times (~15s total) and then **gives up permanently**, leaving the pod alive but disconnected. Any service that hosts a kafkajs client — **order, payment, and inventory** — hits this if it starts before Kafka is reachable. Fix: rollout-restart all three after Kafka is proven up. `scripts/deploy.sh` does this automatically — if you bring the stack up manually, do the restart yourself.
- **Inventory's `/health` is deliberately liveness-only** — it does NOT touch the DB. That's so DB DEGRADED (pool saturation) doesn't kill the readiness probe and turn a slow-DB symptom into a CrashLoop. Use `/db/health` to actually check DB reachability.
- **DB pool is intentionally tiny** (`DB_POOL_MAX=2`) so `/db/exhaust` can reliably saturate it for the DB DEGRADED demo.
- **DATA_INCONSISTENCY is a distinct signature** — all services `/health` 200, but `/fulfill` returns `409` with `cacheQty` and `dbQty` reported. Cache TTL is 60s, so the poison window is finite; re-seed via `/cache/seed` to extend.
- **Scripts use port-forwards internally** — they assume a working `kubectl` and proper cluster context. No external load balancer needed.
- **`testkube/samples/` holds commented reference TestWorkflows for demos**; production orchestration still lives outside the repo.

## Common tasks
- **Modify a service** → edit `services/<name>/server.js`, rebuild (`docker build -t ghcr.io/neuralnimbus22/order-demo-<name>:latest .`), `kubectl -n order-demo rollout restart deploy/<name>`. To publish for other clusters: merge to main and let `build-images.yml` push.
- **Tune the cascade demo timing** → `WAIT_TIMEOUT_S`, `HEALTHY_POLL_TIMEOUT_S`, `INVENTORY_POLL_TIMEOUT_S` env vars in the relevant scripts/tests.
- **Add a new test in a different framework** → drop it in `tests/<framework>/`. Use env vars for URLs (`AUTH_URL`, `ORDER_URL`, `PAYMENT_URL`, `INVENTORY_URL`). Don't bake in invocation assumptions — the orchestrator wraps it later.
- **Reset state after a failed run** → `./scripts/restore.sh` (idempotent — works whether auth was down or up).
- **Demo a failure mode end-to-end** → see `IMPLEMENTATION.md` for the exact one-line induction recipe for each (DOWN/REJECT/DEGRADED auth, PAYMENT DOWN, STALE CACHE, DB DOWN, DB DEGRADED).
- **Debug "test fails but I don't know why"** → start at the downstream test's failure message, then walk back: `kubectl -n order-demo get pods,endpoints`, `kubectl -n order-demo logs deploy/inventory`, `kubectl -n order-demo exec deploy/kafka -- /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 --topic order-placed --time -1` (and the same for `payment-confirmed`).
