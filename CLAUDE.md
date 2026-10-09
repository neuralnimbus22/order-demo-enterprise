# CLAUDE.md — order-demo-enterprise

## What this is
An e-commerce order pipeline built as six Node.js services on Kubernetes: auth, an order branch and a payment branch converging in Kafka, a downstream inventory consumer with a Redis read-through cache backed by Postgres, a read-only product catalog for optional sku validation, and a standalone user-session service for human login in the UI. See `ARCHITECTURE.md` for the topology and `IMPLEMENTATION.md` for the endpoint reference.

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
payment-service ── publishes ──► Kafka: payment-confirmed ──┘    (convergence point)

Human identity (for the UI):

  user-session   register / login / JWT validate — standalone, not on the order pipeline
```
- Six services, all Node.js + Express. order, payment, inventory use `kafkajs`. inventory also uses `ioredis` + `pg`. product-catalog uses `pg`. user-session uses `pg` + `bcryptjs` + `jsonwebtoken`. auth is pure HTTP.
- Two Kafka topics — `order-placed` (produced by order), `payment-confirmed` (produced by payment). Kafka runs single-node KRaft (no Zookeeper) inside the cluster.
- One Postgres (`db:5432`, database `inventory`) hosting three cleanly separate tables: `stock` (inventory's source of truth), `products` (product-catalog's seeded catalog), and `users` (user-session registered accounts).
- All in namespace **`order-demo`**.

### Two identity concepts — kept strictly separate
`auth-service` and `user-session` are different things on purpose:
- **auth-service** authorizes an ORDER in the backend. Static Bearer-token catalogue. `order-service` calls it server-to-server. Unrelated to humans.
- **user-session** is who the USER is. Real `/register`, `/login` (signed JWTs), `/validate`. The UI uses this for login/logout. Standalone — no other service calls it on the order path.

They do not share code, tokens, or a database table.

### Behavior encoded in code
- `order` calls `auth` over HTTP before publishing. If `auth` cannot authorize the order, `order` returns `502 {"error":"upstream dependency unavailable"}` and does not call `producer.send`. No fallback path. The response is deliberately generic so callers do not see internal service names.
- `order`'s catalog call is **optional and additive**. If `sku` is in the body, order calls `product-catalog`; unknown sku → 404, catalog unreachable → 502 with the same generic shape. If `sku` is absent the catalog is not called at all.
- `payment` is independent of `auth` and `order`. It publishes `payment-confirmed` directly.
- `inventory` only marks an id as **fulfilled** once it has received BOTH `order-placed` AND `payment-confirmed` for that id. `/processed/:id` reports the order-side arrival; `/fulfilled/:id` reports convergence and what it's still `waitingFor`.
- `inventory` checks cache against the database on `/fulfill`. A cache that disagrees with the database returns `409 DATA_INCONSISTENCY`.

## Key directories
| Path | Contents |
|---|---|
| `services/auth/server.js` | `POST /authorize` validates a Bearer token and its scopes. `200 authorized` · `401 invalid_token` · `403 insufficient_scope`. `AUTH_DEGRADED_MS` adds latency to `/authorize` for latency testing. SIGTERM handler for fast termination. |
| `services/order/server.js` | `POST /orders {id,item,qty,sku?}` → if `sku` supplied, `GET ${CATALOG_URL}/products/:sku` first → `fetch` to `${AUTH_URL}/authorize` with `Authorization: Bearer ${AUTH_TOKEN}` and a 2s timeout → only on success calls `producer.send` on `order-placed`. Any auth-side failure returns a generic `502`. |
| `services/payment/server.js` | `POST /payments {id,amount?}` → publishes `payment-confirmed`. Independent of auth/order. |
| `services/product-catalog/server.js` | Read-only catalog, port 3005. Postgres-backed (`products` table in the shared database). Auto-creates the table and seeds ~20 generic retail products on startup. `GET /products` → list. `GET /products/:id` → one (404 on unknown sku). The product `id` IS the sku — same key inventory's `stock` table uses. |
| `services/user-session/server.js` | Human-identity service, port 3006. Postgres-backed (`users` table). `POST /register`, `POST /login` (signed JWTs), `GET /validate`. Passwords hashed with `bcryptjs`. JWT secret from `JWT_SECRET` env. Seeds a default user on startup so the UI has a guaranteed login. Not called by any other backend service. |
| `services/inventory/server.js` | `kafkajs` consumer subscribed to BOTH topics (group `inventory-service`, `fromBeginning: true`). Tracks per-id arrivals in an in-process Map. `/health` (liveness only — does NOT touch DB), `/db/health`, `/processed/:id`, `/fulfilled/:id`. Stock layer: `POST /stock/seed`, `POST /cache/seed`, `POST /cache/flush`, `GET /stock/:sku`, `POST /fulfill` (cache-vs-DB check), `GET /consistency/check`, `POST /db/exhaust` (holds pool connections busy, for load testing). |
| `services/*/Dockerfile` | All `node:20-alpine`, `npm install --omit=dev`, run as USER `node`. |
| `kafka/kafka.yaml` | `apache/kafka:3.7.0` KRaft single-node combined mode (broker+controller), `emptyDir` storage, auto-create-topics enabled. |
| `k8s/namespace.yaml` | Creates `order-demo`. |
| `k8s/{auth,order,payment,inventory,product-catalog,user-session}.yaml` | Deployment + Service for each. Images `ghcr.io/neuralnimbus22/order-demo-{name}:latest` (public, multi-arch), `imagePullPolicy: IfNotPresent`. order has CPU/memory `requests/limits` so an HPA can scale it. user-session carries `JWT_SECRET` as an env value here; production would use a Kubernetes Secret. |
| `k8s/redis.yaml` | `redis:7-alpine` — read-through cache for inventory stock lookups. Service `redis:6379`. |
| `k8s/db.yaml` | `postgres:16-alpine` — source of truth for inventory's `stock` table. Service `db:5432`. Schema auto-applied by inventory on startup. |
| `k8s/hpa.yaml` | HorizontalPodAutoscaler on `deploy/order`: min 1, max 5, target avg CPU 70%. **Requires metrics-server** — present on GKE, typically NOT on local clusters (the HPA object exists but the metric reads `<unknown>` and no scaling happens). |
| `tests/auth/test_auth.py` | pytest. Calls `/authorize` with/without tokens; asserts 200/401/403. |
| `tests/order/order.postman_collection.json` | Newman. Real `POST /orders` asserting `201` + `status:"placed"`. order-service injects `AUTH_TOKEN` server-side from env — the collection itself sends no token. |
| `tests/payment/test_payment.py` | pytest. Asserts `POST /payments` returns `201 confirmed`. |
| `tests/inventory/test_inventory.py` | pytest. Places an order then polls `/processed/:id`. Logs order-side errors and continues; fails only if the message never arrives (`MESSAGE NEVER ARRIVED`). |
| `tests/inventory/test_cache_consistency.py` | pytest. Healthy cache-aside; cache disagreeing with DB → 409 `DATA_INCONSISTENCY`; cache-miss → fallback to DB then repopulate. |
| `tests/product-catalog/test_product_catalog.py` | pytest. `/health`, full `/products` list, known sku, 404 on unknown. Not wired into ci-tests.yml yet. |
| `tests/user-session/test_user_session.py` | pytest. Register, login, and validate, with a unique email per run. Not wired into ci-tests.yml yet. |
| `tests/load/order-load.js` | k6 load script. Ramps to 500 VUs against `POST /orders` to drive HPA scaling. SLOs: p95<800ms, failed<5%. |
| `.github/workflows/build-images.yml` | Builds the six service images multi-arch (linux/amd64 + linux/arm64) and pushes to GHCR. Trigger filtered to `services/**` + this file. |
| `.github/workflows/ci-tests.yml` | Runs the four original service tests sequentially on the self-hosted runner against the live cluster. |
| `scripts/deploy.sh` | **One-command bring-up.** namespace → Kafka + wait → pre-create BOTH topics → services + infra + HPA → wait for every Deployment Available → rollout-restart the kafkajs clients (order, payment, inventory) → sanity-check. Idempotent. |
| `scripts/sanity-check.sh` | Per-deployment health + topic existence + topic high-water-mark. `[OK]/[WARN]/[FAIL]` markers. |
| `scripts/place-order.sh` | Healthy-path helper: place one order, confirm inventory processed it. |
| `scripts/smoke-test.sh` | **Read-only smoke test of the live backend.** Deployments healthy, both Kafka topics exist, Redis PING, `/health` on all six services, inventory `/db/health`, product-catalog `/products` non-empty, and a user-session register → login → validate round-trip. Exits non-zero on any failure so it can gate a pipeline. |
| `testkube/samples/` | Commented reference TestWorkflows (pytest-auth, k6-load-sharded, playwright-ui). |

## How to run / deploy
**Build images locally** (tag with the GHCR path so `IfNotPresent` uses your local build without pulling):
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
- **Namespace is `order-demo`** for the workload; the Testkube runner lives elsewhere — this repo doesn't deploy it.
- **Images come from public GHCR multi-arch** (`ghcr.io/neuralnimbus22/order-demo-{name}:latest`) with `imagePullPolicy: IfNotPresent`. Built and pushed by `.github/workflows/build-images.yml` on merges that touch `services/**`.
- **Auth has a SIGTERM handler + `terminationGracePeriodSeconds: 5`** in `k8s/auth.yaml`, so it shuts down in seconds instead of the default 30.
- **Kafka consumer + auto-create-topics interaction**: auto-create fires on PRODUCE, not SUBSCRIBE. If inventory starts before any message is published, its subscribe errors. Fix: pre-create the topics. `scripts/deploy.sh` pre-creates both.
- **Kafka storage is `emptyDir`**: a Kafka pod restart loses the topics. Re-create them, then restart the kafkajs clients.
- **Kafka client retry window**: `kafkajs` retries a broker connect ~5 times (~15s total) and then **gives up permanently**, leaving the pod alive but disconnected. Any service that hosts a kafkajs client — **order, payment, and inventory** — hits this if it starts before Kafka is reachable. Fix: rollout-restart all three after Kafka is up. `scripts/deploy.sh` does this automatically.
- **Inventory's `/health` is liveness-only** — it does NOT touch the DB, so a slow database does not fail the readiness probe. Use `/db/health` to check DB reachability.
- **DB pool is small** (`DB_POOL_MAX=2`).
- **Scripts use port-forwards internally** — they assume a working `kubectl` and proper cluster context.

## Common tasks
- **Modify a service** → edit `services/<name>/server.js`, rebuild (`docker build -t ghcr.io/neuralnimbus22/order-demo-<name>:latest .`), `kubectl -n order-demo rollout restart deploy/<name>`. To publish for other clusters: merge to main and let `build-images.yml` push.
- **Add a new test** → drop it in `tests/<service>/`. Use env vars for URLs (`AUTH_URL`, `ORDER_URL`, `PAYMENT_URL`, `INVENTORY_URL`).
- **Debug a failing test** → start at the test's failure message, then walk back through the services it depends on: `kubectl -n order-demo get pods,endpoints`, `kubectl -n order-demo logs deploy/<service>`, and for Kafka, `kubectl -n order-demo exec deploy/kafka -- /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 --topic order-placed --time -1` (and the same for `payment-confirmed`).
