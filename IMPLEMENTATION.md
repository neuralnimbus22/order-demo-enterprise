# IMPLEMENTATION.md — as-built reference

As-built reference: endpoints, request/response shapes, env vars, ports, Kafka message formats, and where each test lives. This file is the source of truth for what's on disk and in the cluster.

All components run in the `order-demo` namespace. Image pattern: `ghcr.io/neuralnimbus22/order-demo-<name>:latest` with `imagePullPolicy: IfNotPresent` (local Docker Desktop build under the same tag is the cached version k8s uses).

---

## Topology (as built)

```
Order pipeline (backend):

auth-service ──┐
               │ (Bearer token authorize)
order-service ─┤── publishes ──► Kafka: order-placed ──────┐
       │       │                                            ├──► inventory-service ──► Redis cache ──► Postgres
       │ (optional sku validation)                          │
       ▼                                                    │
product-catalog                                             │
                                                            │
payment-service ── publishes ──► Kafka: payment-confirmed ──┘

Human identity (standalone — for the Phase 2 UI):

user-session   /register · /login (issues signed JWT) · /validate
```

| Component | In-cluster address | Manifest |
|---|---|---|
| auth | `auth.order-demo.svc.cluster.local:3001` | `k8s/auth.yaml` |
| order | `order.order-demo.svc.cluster.local:3002` | `k8s/order.yaml` |
| inventory | `inventory.order-demo.svc.cluster.local:3003` | `k8s/inventory.yaml` |
| payment | `payment.order-demo.svc.cluster.local:3004` | `k8s/payment.yaml` |
| product-catalog | `product-catalog.order-demo.svc.cluster.local:3005` | `k8s/product-catalog.yaml` |
| user-session | `user-session.order-demo.svc.cluster.local:3006` | `k8s/user-session.yaml` |
| kafka | `kafka.order-demo.svc.cluster.local:9092` | `kafka/kafka.yaml` |
| redis | `redis.order-demo.svc.cluster.local:6379` | `k8s/redis.yaml` |
| db (postgres) | `db.order-demo.svc.cluster.local:5432` | `k8s/db.yaml` |

---

## auth-service (Phase 1)

**Source:** `services/auth/server.js` · **Port:** `3001`

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | listen port |
| `AUTH_REQUIRED_SCOPE` | `orders:create` | scope required for /authorize success |
| `AUTH_DEGRADED_MS` | `0` | if `>0`, every /authorize sleeps this many ms before responding — used for latency testing |

### Token catalogue (hard-coded in `server.js`)

| Token | Scopes |
|---|---|
| `demo-token-good` | `["orders:create"]` |
| `demo-token-readonly` | `["orders:read"]` |
| anything else | none → 401 |

### Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | — | `200 {"status":"ok"}` |
| POST | `/authorize` | accepts token in `Authorization: Bearer <t>` **or** `{"token":"<t>", ...}` | `200 {"authorized":true,"scope":["orders:create"]}` · `401 {"error":"invalid_token"}` · `403 {"error":"insufficient_scope","required":"orders:create","have":[...]}` |

### Test

- **File:** `tests/auth/test_auth.py` (pytest)
- **Deps:** `tests/auth/requirements.txt` (`pytest`, `requests`)
- **Env:** `AUTH_URL` (default `http://localhost:3001`)
- **Run:** `AUTH_URL=http://localhost:3001 pytest tests/auth/test_auth.py -v`

---

## order-service (Phase 1 update)

**Source:** `services/order/server.js` · **Port:** `3002`

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3002` | listen port |
| `AUTH_URL` | `http://localhost:3001` | base URL for /authorize call |
| `AUTH_TOKEN` | `demo-token-good` | token sent to auth (Bearer + body) |
| `CATALOG_URL` | `http://localhost:3005` | base URL for the product-catalog sku-validation call (only used when `sku` is supplied) |
| `KAFKA_BROKERS` | `localhost:9092` | comma-separated brokers |
| `KAFKA_TOPIC` | `order-placed` | producer topic |

### Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | — | `200 {"status":"ok"}` |
| POST | `/orders` | `{"id":"<string>","item":"<string>","qty":<int>,"sku":"<string>"?}` | `201 {"id":"...","item":"...","qty":N,"status":"placed","sku":"..."?}` on success — `sku` appears in the response only if it was in the request · `400 {"error":"id is required"}` if `id` missing · `400 {"error":"id and item are required"}` if both `item` and `sku` missing · `404 {"error":"unknown product","sku":"..."}` if catalog reports an unknown sku · **`502 {"error":"upstream dependency unavailable"}`** on **any** auth or catalog failure (unreachable, rejected, timed out, or a non-2xx from catalog) — deliberately generic so callers do not see internal details |

### Internal contract

`POST /orders` does (in this order, no fallback):
1. **Body validation.** `id` always required. `item` required UNLESS `sku` is supplied (then `item` is filled from the catalog's product name).
2. **OPTIONAL catalog step (Phase 1b).** If `sku` is in the body: `fetch(${CATALOG_URL}/products/:sku, signal: AbortSignal.timeout(2000))`. 404 → 404 unknown product; non-2xx / network / bad body → 502 opaque (no Kafka publish). On 200 success, fill `item = product.name` if `item` wasn't supplied. **If `sku` is absent the catalog is not called at all.** This is the backward-compatibility property: the no-sku path is byte-identical to the pre-1b behavior.
3. `fetch(${AUTH_URL}/authorize, { Authorization: Bearer ${AUTH_TOKEN}, body: {orderId, token} }, signal: AbortSignal.timeout(2000))`.
4. If anything fails in step 3 (network error, non-2xx, `authorized!==true`) → 502 opaque, no Kafka publish.
5. Only on success: `producer.send({topic:'order-placed', messages:[{key:id, value: JSON}]})`. The Kafka payload includes `sku` only when it was supplied — inventory ignores unknown fields, so this is forward-compatible.

### Resource limits + HPA

`k8s/order.yaml` declares per-pod resource bounds so a Horizontal Pod Autoscaler can target the deployment:
- **requests:** cpu `100m`, memory `64Mi`
- **limits:**   cpu `250m`, memory `128Mi`

These intentionally low ceilings are what make the k6 load test (below) reliably push order-service over its CPU target and trigger scaling.

`k8s/hpa.yaml` is the `HorizontalPodAutoscaler` (autoscaling/v2) that pairs with the above:
- **scaleTargetRef:** `deploy/order`
- **min/max replicas:** 1 / 5
- **metric:** Resource cpu, Utilization, averageUtilization 70

Applied automatically by `scripts/deploy.sh` as part of `kubectl apply -f k8s/`. Requires metrics-server in the cluster — present on GKE by default; typically NOT installed on local Docker Desktop, in which case the HPA object exists but the CPU metric reports `<unknown>` and no scaling happens. The Deployment runs normally either way.

### Test

- **File:** `tests/order/order.postman_collection.json` (Postman v2.1 / Newman)
- **Behavior:** generates fresh `orderId` per run; asserts `201` + `status:"placed"`. Note: collection itself does NOT send a token — order-service injects `AUTH_TOKEN` from its env on the server side.
- **Run:** `npx --yes newman run tests/order/order.postman_collection.json --env-var baseUrl=http://localhost:3002`

### Load test (k6)

- **File:** `tests/load/order-load.js`
- **Behavior:** ramps to **500 VUs** over 30s, holds for 2m, ramps down 30s. Each iteration POSTs `/orders` with a unique id then sleeps 100ms. Designed to push order-service CPU usage above the HPA target.
- **SLO thresholds (built-in):** `http_req_duration p(95) < 800ms`, `http_req_failed rate < 0.05`.
- **Run:** `ORDER_URL=http://localhost:3002 k6 run tests/load/order-load.js`

---

## payment-service (Phase 2 — new)

**Source:** `services/payment/server.js` · **Port:** `3004`

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3004` | listen port |
| `KAFKA_BROKERS` | `localhost:9092` | comma-separated brokers |
| `KAFKA_TOPIC` | `payment-confirmed` | producer topic |

### Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | — | `200 {"status":"ok"}` |
| POST | `/payments` | `{"id":"<string>","amount":<number?>}` | `201 {"id":"...","status":"confirmed"}` · `400` on missing id · `502` on Kafka publish failure · `503` if producer not yet connected |

### Test

- **File:** `tests/payment/test_payment.py` (pytest)
- **Deps:** `tests/payment/requirements.txt`
- **Env:** `PAYMENT_URL` (default `http://localhost:3004`)
- **Run:** `PAYMENT_URL=http://localhost:3004 pytest tests/payment/test_payment.py -v`

---

## product-catalog service (Phase 1b — new)

**Source:** `services/product-catalog/server.js` · **Port:** `3005`

A read-only product catalog. Backs order-service's optional `sku` validation. Not on any Kafka hot path; not part of fulfillment. Catalog `stock` is display data only — inventory's `stock` table remains the source of truth for fulfillment.

### Data-store decision (recorded here)

**Same Postgres instance (`db:5432`), same `inventory` database, NEW `products` table.** Same DB connection settings inventory uses (`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` — all defaults match k8s/db.yaml's `POSTGRES_USER=inventory` / `POSTGRES_PASSWORD=inventory` / `POSTGRES_DB=inventory`).

**Why same DB, separate table** (vs a separate `catalog` database in the same Postgres instance):
- **Simplest.** Zero changes to `db.yaml`; the `inventory` database already exists from the Postgres pod's env vars. A separate `catalog` database would require an init container running `psql -c 'CREATE DATABASE catalog'`, or a postgres init-script mounted at `/docker-entrypoint-initdb.d`, or in-app `CREATE DATABASE` logic (Postgres doesn't allow CREATE DATABASE IF NOT EXISTS in a single statement and requires connecting to the maintenance DB first). All add moving parts for no demo benefit.
- **Clean table separation.** `products` and `stock` are unambiguous; the two tables never share a name. Postgres-level isolation isn't needed for a demo.
- **Matches the existing connect pattern verbatim** — product-catalog's server.js uses the same env-var set and pool wiring as inventory; only the table definition differs.

Recorded trade-off: both services have read/write access to each other's tables through a single shared credential. For this demo, acceptable. For production you'd want separate database users or a `catalog` schema with restricted GRANTs.

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3005` | listen port |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `localhost` / `5432` / `inventory` / `inventory` / `inventory` | Postgres connection — same set inventory uses |
| `DB_POOL_MAX` | `4` | pg pool size (slightly larger than inventory's 2 — catalog serves a higher read mix) |
| `DB_TIMEOUT_MS` | `2000` | pg `connectionTimeoutMillis` |

### Schema + seed (auto-created on startup)

```sql
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  price       NUMERIC(10,2) NOT NULL,
  description TEXT,
  stock       INTEGER NOT NULL DEFAULT 0
);
```

`initSchemaAndSeed()` mirrors inventory's retry-on-boot pattern (30 attempts × 1 s sleep). Seeds 20 generic retail products via `INSERT … ON CONFLICT (id) DO NOTHING`, so re-runs / pod restarts don't overwrite existing rows.

### Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | — | `200 {"status":"ok"}` |
| GET | `/products` | — | `200 [{id,name,category,price,description,stock}, …]` |
| GET | `/products/:id` | — | `200 {id,name,category,price,description,stock}` · `404 {"error":"unknown product","sku":"..."}` |

`:id` IS the sku — the same key inventory's `stock` table uses.

### Test

- **File:** `tests/product-catalog/test_product_catalog.py` (pytest)
- **Deps:** `tests/product-catalog/requirements.txt`
- **Env:** `PRODUCT_CATALOG_URL` (default `http://localhost:3005`)
- **Run:** `PRODUCT_CATALOG_URL=http://localhost:3005 pytest tests/product-catalog/test_product_catalog.py -v`
- **Wiring:** **Not** in `ci-tests.yml`, **not** in any TestKube workflow. Lives in its folder for any pipeline to pick up; pipeline wiring deferred on purpose.

---

## user-session service (Phase 1c — new)

**Source:** `services/user-session/server.js` · **Port:** `3006`

Human-identity service for the Phase 2 UI. Real `/register`, `/login` (issues signed JWTs), `/validate` (verifies them). **Standalone — not on the order pipeline. No other backend service calls it.**

### Distinct from `auth-service` (do not confuse the two)

| | `auth-service` | `user-session` |
|---|---|---|
| What it authorizes | an ORDER in the backend | a HUMAN logging into the UI |
| Token model | static Bearer-token catalogue | signed JWTs (HS256 via `jsonwebtoken`) |
| Storage | none — token catalogue is hard-coded in `server.js` | Postgres `users` table |
| Who calls it | `order-service` (server-to-server, every /orders request) | the Phase 2 UI (browser → backend) |
| On the order pipeline? | yes — deepest upstream | no — standalone |

They do not share code, tokens, or a database table.

### Storage decision (recorded)

**Same Postgres instance (`db:5432`), same `inventory` database, NEW `users` table.** Same DB env-var set inventory and product-catalog use.

**Why DB-backed (vs in-memory):**
- **User registrations must survive pod restarts.** A person who registers via the UI on Monday expects their login to work Tuesday. In-memory storage would lose every non-seeded user every time the pod recycles.
- **Pattern continuity.** product-catalog (Phase 1b) established the exact same pattern — same DB, new table — one phase ago. Reusing it is zero cognitive overhead and zero new infra.
- **Test users persist too.** The pytest suite registers a fresh uuid-email per run; with DB-backed storage those rows remain, which is realistic for a demo environment.

**Why same DB, new table (vs a separate `users` database in the same Postgres instance):** identical reasoning to the Phase 1b product-catalog decision. A separate database would require an init container or postgres init-script to `CREATE DATABASE`. Table-level separation (`users` vs `stock` vs `products`) is sufficient for a demo.

**Trade-off acknowledged:** all three services use the single `inventory`/`inventory` credential, so each has read/write capability into the others' tables in principle. For a demo, fine. For production each service would use a distinct PostgreSQL role with `GRANT`s scoped to its own table(s).

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3006` | listen port |
| `JWT_SECRET` | `dev-secret-change-me` | HMAC key for JWT signing. **In production this MUST come from a Kubernetes Secret**, not a plain env value. (Same trade-off already recorded for the shared DB credentials in `db.yaml`.) |
| `JWT_EXPIRES` | `1h` | JWT expiry — passed straight to `jsonwebtoken.sign({…, expiresIn: …})`. Any zeit/ms expression accepted. |
| `BCRYPT_COST` | `10` | bcryptjs work factor. 10 is the bcryptjs default. |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `localhost` / `5432` / `inventory` / `inventory` / `inventory` | Postgres connection — same set inventory uses |
| `DB_POOL_MAX` | `4` | pg pool size |
| `DB_TIMEOUT_MS` | `2000` | pg `connectionTimeoutMillis` |
| `SEED_USER_EMAIL` | `demo@example.com` | demo user seeded on startup |
| `SEED_USER_PASSWORD` | `demo-password` | password for that demo user (idempotent — won't overwrite an existing row) |

### Library choices (and why)

- **`bcryptjs` (not `bcrypt`).** `bcrypt` is a native module that needs Python + node-gyp + alpine build deps (`apk add make g++ python3`) to compile. `bcryptjs` is pure JavaScript and runs on `node:20-alpine` with no extra layers. Identical hash format on the wire (`$2a$10$…`), so the choice is invisible to any future migration.
- **`jsonwebtoken` (HS256).** Symmetric-key signing is enough for a single demo service — no public-key distribution to do. Default `expiresIn: 1h` keeps issued tokens short-lived.

### Schema + seed (auto-created on startup)

```sql
CREATE TABLE IF NOT EXISTS users (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
```

`initSchemaAndSeed()` mirrors the inventory / product-catalog retry-on-boot pattern (30 attempts × 1 s sleep). On boot it bcrypt-hashes `SEED_USER_PASSWORD` and `INSERT … ON CONFLICT DO NOTHING` for `SEED_USER_EMAIL`. So:
- A fresh DB → demo user is created.
- A restarted pod against a DB that already has the demo user → no-op; whatever password is currently in the row (which may have been changed via `/register` flow or other ops work) is preserved.

### Endpoints

| Method | Path | Body / Header | Response |
|---|---|---|---|
| GET | `/health` | — | `200 {"status":"ok"}` |
| POST | `/register` | `{"email":"…","password":"…"}` | `201 {"email":"…"}` · `400 {"error":"email and password are required"}` · `409 {"error":"email_exists"}` |
| POST | `/login` | `{"email":"…","password":"…"}` | `200 {"token":"<jwt>","email":"…"}` · **`401 {"error":"invalid_credentials"}`** for wrong password, unknown email, or missing fields — opaque on purpose |
| GET | `/validate` | `Authorization: Bearer <jwt>` | `200 {"email":"…","sub":"…","iat":<int>,"exp":<int>}` · `401 {"error":"invalid_token"}` if missing / malformed / signature-bad / expired |

JWT claims include `sub` (subject = email), `email`, `iat`, `exp`. Signed with `JWT_SECRET` using HS256. Default expiry 1 h (`JWT_EXPIRES`).

### Test

- **File:** `tests/user-session/test_user_session.py` (pytest)
- **Deps:** `tests/user-session/requirements.txt`
- **Env:** `USER_SESSION_URL` (default `http://localhost:3006`)
- **Run:** `USER_SESSION_URL=http://localhost:3006 pytest tests/user-session/test_user_session.py -v`
- **Wiring:** **Not** in `ci-tests.yml`, **not** in any TestKube workflow. Lives in its folder for any pipeline to pick up; pipeline wiring deferred on purpose.
- **Coverage:** `/health` · register (success + duplicate 409 + missing fields 400) · login (success + wrong password 401 + unknown email 401, both opaque) · `/validate` (good JWT → identity claims + missing → 401 + garbage → 401). Generates a fresh uuid-email per run so re-runs against the same DB don't 409 on the first register.

---

## inventory-service (Phase 2, 3, 4 — extended each phase)

**Source:** `services/inventory/server.js` · **Port:** `3003`

This service is the convergence point and accumulates all three later phases. It runs an HTTP server, a `kafkajs` consumer subscribed to both topics, a Redis client, and a Postgres pool — all in one process.

### Env vars

| Var | Default | Phase | Purpose |
|---|---|---|---|
| `PORT` | `3003` | 1 | listen port |
| `KAFKA_BROKERS` | `localhost:9092` | 1 | brokers |
| `KAFKA_TOPIC` | `order-placed` | 1 | first topic to subscribe |
| `KAFKA_PAYMENT_TOPIC` | `payment-confirmed` | 2 | second topic |
| `KAFKA_GROUP_ID` | `inventory-service` | 1 | consumer group |
| `REDIS_HOST` | `localhost` | 3 | cache host |
| `REDIS_PORT` | `6379` | 3 | cache port |
| `CACHE_TTL_S` | `60` | 3 | TTL on `stock:*` keys |
| `DB_HOST` | `localhost` | 4 | postgres host |
| `DB_PORT` | `5432` | 4 | postgres port |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `inventory` / `inventory` / `inventory` | 4 | postgres creds |
| `DB_POOL_MAX` | `2` | 4 | small pool |
| `DB_TIMEOUT_MS` | `2000` | 4 | `pg` pool connectionTimeoutMillis |

### Schema (auto-created on startup)

```sql
CREATE TABLE IF NOT EXISTS stock (
  sku TEXT PRIMARY KEY,
  qty INTEGER NOT NULL DEFAULT 0
);
```

`initSchema()` retries up to 30 attempts with 1s backoff while postgres comes up.

### Endpoints

| # | Method | Path | Body | Response |
|---|---|---|---|---|
| 1 | GET | `/health` | — | `200 {"status":"ok"}` — pure liveness, **does NOT touch DB** |
| 2 | GET | `/db/health` | — | `200 {"db":"ok"}` or `503 {"db":"unreachable","detail":"..."}` — wraps `SELECT 1` with a 1.5s race-timeout so a stalled pool surfaces as `db_health_timeout` (distinct from `ECONNREFUSED`) |
| 3 | GET | `/processed/:id` | — | `200 {"id":"...","processed":true,"processedAt":"<iso>"}` once `order-placed` seen; else `404` |
| 4 | GET | `/fulfilled/:id` | — | `200 {"id":"...","orderPlaced":"<iso>|null","paymentConfirmed":"<iso>|null","fulfilled":<bool>,"waitingFor":[...]}` or `404` |
| 5 | POST | `/stock/seed` | `{"sku":"...","qty":<int>}` | `200 {"sku":"...","qty":N,"source":"db"}` — upserts in postgres |
| 6 | POST | `/cache/seed` | `{"sku":"...","qty":<int>}` | `200 {"sku":"...","qty":N,"source":"cache"}` — sets Redis ONLY |
| 7 | POST | `/cache/flush` | — | `200 {"flushed":N}` — drops all `stock:*` Redis keys |
| 8 | GET | `/stock/:sku` | — | `200 {"sku":"...","qty":N,"source":"cache"\|"db"}` · `404` if unknown sku · `502` on backing-store error |
| 9 | POST | `/fulfill` | `{"id":"...","sku":"...","qty":<int>}` | `200 {"id":"...","sku":"...","qty":N,"fulfilled":true,"remaining":N}` · **`409 {"error":"DATA_INCONSISTENCY","cacheQty":N,"dbQty":N}`** · `409 {"error":"insufficient_stock"}` · `503 {"error":"db_unavailable","detail":"..."}` |
| 10 | GET | `/consistency/check` | — | `200 {"consistent":true,...}` or `409 {"consistent":false,"mismatches":[{"sku":"...","cacheQty":N,"dbQty":N,"agree":false}],...}` |
| 11 | POST | `/db/exhaust` | `{"hold":<ms>?,"n":<int>?}` | `200 {"started":N,"hold":<ms>}` — fires N background `SELECT pg_sleep(hold/1000)` queries that each hold a pooled connection, **saturating the pool for `hold` ms** |

### Tests

- **File:** `tests/inventory/test_inventory.py` (pytest) — places an order and polls `/processed/:id` to verify the message arrived in inventory.
  - **Env:** `ORDER_URL`, `INVENTORY_URL`, `INVENTORY_POLL_TIMEOUT_S` (default 20)
  - **Run:** `ORDER_URL=http://localhost:3002 INVENTORY_URL=http://localhost:3003 pytest tests/inventory/test_inventory.py -v`
- **File:** `tests/inventory/test_cache_consistency.py` (pytest, Phase 3 addition) — three tests:
  1. `test_healthy_cache_aside_fulfills`
  2. `test_stale_cache_surfaces_as_data_inconsistency` (the key test for stale cache)
  3. `test_cache_miss_falls_back_to_db_then_repopulates`
  - **Env:** `INVENTORY_URL`
  - **Run:** `INVENTORY_URL=http://localhost:3003 pytest tests/inventory/test_cache_consistency.py -v`

---

## Kafka

**Source:** `kafka/kafka.yaml` (single-broker KRaft, `apache/kafka:3.7.0`, emptyDir storage, auto-create-topics ON).

### Topics (must exist before consumers subscribe — auto-create only fires on PRODUCE)

| Topic | Producer | Consumers |
|---|---|---|
| `order-placed` | `order-service` | `inventory-service` |
| `payment-confirmed` | `payment-service` | `inventory-service` |

Pre-create both:
```bash
kubectl -n order-demo exec deploy/kafka -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --create --if-not-exists \
  --topic order-placed --partitions 1 --replication-factor 1
kubectl -n order-demo exec deploy/kafka -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --create --if-not-exists \
  --topic payment-confirmed --partitions 1 --replication-factor 1
```

### Message formats

**`order-placed`** (key = order id string)
```json
{ "id": "<string>", "item": "<string>", "qty": <int>, "at": "<iso8601>" }
```

**`payment-confirmed`** (key = order id string)
```json
{ "id": "<string>", "amount": <number>, "confirmedAt": "<iso8601>" }
```

### Consumer-group note

`inventory-service` subscribes with `fromBeginning: true` so it doesn't miss messages published while it was rebalancing. The convergence Map (`events`) is in-process — restarting the inventory pod clears it.

---

## End-to-end happy-path recipe

```bash
# Port-forwards
kubectl -n order-demo port-forward svc/order     13002:3002 &
kubectl -n order-demo port-forward svc/payment   13004:3004 &
kubectl -n order-demo port-forward svc/inventory 13003:3003 &
sleep 3

OID="happy-$(date +%s)"

# 1. Place order (order-service authorizes against auth, publishes order-placed)
curl -X POST -H 'Content-Type: application/json' \
  -d "{\"id\":\"${OID}\",\"item\":\"widget\",\"qty\":1}" http://localhost:13002/orders
# expect: 201 {"id":"...","status":"placed"}

# 2. Confirm payment (payment-service publishes payment-confirmed)
curl -X POST -H 'Content-Type: application/json' \
  -d "{\"id\":\"${OID}\",\"amount\":19.99}" http://localhost:13004/payments
# expect: 201 {"id":"...","status":"confirmed"}

# 3. Convergence on inventory
curl http://localhost:13003/fulfilled/${OID}
# expect: {"id":"...","orderPlaced":"<iso>","paymentConfirmed":"<iso>","fulfilled":true,"waitingFor":[]}
```

---

## CI workflows

Two GitHub Actions workflows live in `.github/workflows/`. Both target the live cluster via the self-hosted runner where applicable.

### `build-images.yml` — multi-arch image builds → GHCR
- **Triggers:** push to `main` (filtered to `services/**` or this workflow file) and tags matching `v*`.
- **Permissions:** `contents: read`, `packages: write`.
- **Strategy:** matrix over `[auth, order, payment, inventory, product-catalog, user-session]`, `fail-fast: false`, per-service GHA cache scope.
- **Steps:** checkout → GHCR login (`github.actor` / `secrets.GITHUB_TOKEN`) → setup QEMU → setup Buildx → `docker/build-push-action` with `platforms: linux/amd64,linux/arm64`, `push: true`, tag `ghcr.io/neuralnimbus22/order-demo-<service>:latest`.
- **Why multi-arch:** the same `:latest` tag must work on Apple Silicon developer machines (arm64) and on GKE / cloud nodes (amd64).
- **Note:** adding a new service is a one-line matrix change. Forgetting it → pod schedules but `ImagePullBackOff` on the cluster because the image never builds/pushes.

### `ci-tests.yml` — sequential service tests
- **Triggers:** push to `main`.
- **Runner:** `self-hosted` (cluster-resident, so it can `kubectl port-forward` into `order-demo`).
- **Job order:** `auth-tests` → `order-tests` → `payment-tests` → `inventory-tests`. Each job installs its deps if needed, port-forwards the service it targets (and any others it calls into), and runs the standalone test command.
- **Note:** this is the in-repo CI. TestKube workflows live outside this repo.
