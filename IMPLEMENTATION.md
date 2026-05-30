# IMPLEMENTATION.md — as-built reference

What the four-phase build actually produced. Endpoints, request/response shapes, env vars, ports, Kafka message formats, where each test lives, and **exactly how each failure mode is induced**. Source of truth for the spec is `order-demo-enterprise-build-spec.md`; this file is the source of truth for what's on disk and in the cluster.

All components run in the `order-demo` namespace. Image pattern: `ghcr.io/neuralnimbus22/order-demo-<name>:latest` with `imagePullPolicy: IfNotPresent` (local Docker Desktop build under the same tag is the cached version k8s uses).

---

## Topology (as built)

```
auth-service ──┐
               │ (Bearer token authorize)
order-service ─┤── publishes ──► Kafka: order-placed ──────┐
               │                                            ├──► inventory-service ──► Redis cache ──► Postgres
payment-service ── publishes ──► Kafka: payment-confirmed ─┘
```

| Component | In-cluster address | Manifest |
|---|---|---|
| auth | `auth.order-demo.svc.cluster.local:3001` | `k8s/auth.yaml` |
| order | `order.order-demo.svc.cluster.local:3002` | `k8s/order.yaml` |
| inventory | `inventory.order-demo.svc.cluster.local:3003` | `k8s/inventory.yaml` |
| payment | `payment.order-demo.svc.cluster.local:3004` | `k8s/payment.yaml` |
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
| `AUTH_DEGRADED_MS` | `0` | if `>0`, every /authorize sleeps this many ms before responding — used to induce DEGRADED |

### Built-in token catalogue (demo-only, hard-coded in `server.js`)

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

### Failure modes — how to induce

| Mode | Induction recipe | Observable signature |
|---|---|---|
| **DOWN** | `kubectl -n order-demo scale deploy/auth --replicas=0` (waits ~5s for SIGTERM cap) | direct `curl http://auth.../authorize` → `curl: (7) Connection refused`. Auth has no endpoints. |
| **REJECT** | Send any unknown token (built into the test) — **or** change order's env: `kubectl -n order-demo set env deploy/order AUTH_TOKEN=invalid-token-xyz` then rollout | `/health` 200; `/authorize` returns 401/403 promptly; auth logs `[auth] REJECT 401 invalid_token` or `[auth] REJECT 403 insufficient_scope` |
| **DEGRADED** | `kubectl -n order-demo set env deploy/auth AUTH_DEGRADED_MS=5000` then `kubectl -n order-demo rollout restart deploy/auth`. **Reset:** `kubectl -n order-demo set env deploy/auth AUTH_DEGRADED_MS-` (the trailing `-` removes the env) | `/health` instant 200; `/authorize` blocks for 5s; order's 2s fetch timeout fires → order returns 502 |

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
| `KAFKA_BROKERS` | `localhost:9092` | comma-separated brokers |
| `KAFKA_TOPIC` | `order-placed` | producer topic |

### Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | — | `200 {"status":"ok"}` |
| POST | `/orders` | `{"id":"<string>","item":"<string>","qty":<int>}` | `201 {"id":"...","item":"...","qty":N,"status":"placed"}` on success · `400 {"error":"id and item are required"}` on invalid body · **`502 {"error":"upstream dependency unavailable"}`** on **any** auth failure (DOWN/REJECT/DEGRADED-timeout) — opaque on purpose |

### Internal contract

`POST /orders` does (in this order, no fallback):
1. `fetch(${AUTH_URL}/authorize, { Authorization: Bearer ${AUTH_TOKEN}, body: {orderId, token} }, signal: AbortSignal.timeout(2000))`
2. If anything fails in step 1 (network error, non-2xx, `authorized!==true`) → 502 opaque, no Kafka publish.
3. Only on success: `producer.send({topic:'order-placed', messages:[{key:id, value: JSON}]})`.

### Failure modes induced via order

| Mode | Induction recipe |
|---|---|
| **bad token** | `kubectl -n order-demo set env deploy/order AUTH_TOKEN=invalid-token-xyz` then `kubectl -n order-demo rollout restart deploy/order`. Reset: set back to `demo-token-good` |

### Test

- **File:** `tests/order/order.postman_collection.json` (Postman v2.1 / Newman)
- **Behavior:** generates fresh `orderId` per run; asserts `201` + `status:"placed"`. Note: collection itself does NOT send a token — order-service injects `AUTH_TOKEN` from its env on the server side.
- **Run:** `npx --yes newman run tests/order/order.postman_collection.json --env-var baseUrl=http://localhost:3002`

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

### Failure modes

| Mode | Induction recipe | Signature |
|---|---|---|
| **PAYMENT DOWN** | `kubectl -n order-demo scale deploy/payment --replicas=0` | direct call: `curl: (7) Connection refused`. Indirect (via inventory) signature documented under inventory. |

### Test

- **File:** `tests/payment/test_payment.py` (pytest)
- **Deps:** `tests/payment/requirements.txt`
- **Env:** `PAYMENT_URL` (default `http://localhost:3004`)
- **Run:** `PAYMENT_URL=http://localhost:3004 pytest tests/payment/test_payment.py -v`

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
| `DB_POOL_MAX` | `2` | 4 | **intentionally tiny** so pool exhaustion is easy to demonstrate |
| `DB_TIMEOUT_MS` | `2000` | 4 | `pg` pool connectionTimeoutMillis — this is what fires under DB DEGRADED |

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
| 6 | POST | `/cache/seed` | `{"sku":"...","qty":<int>}` | `200 {"sku":"...","qty":N,"source":"cache"}` — sets Redis ONLY (poisons cache) |
| 7 | POST | `/cache/flush` | — | `200 {"flushed":N}` — drops all `stock:*` Redis keys |
| 8 | GET | `/stock/:sku` | — | `200 {"sku":"...","qty":N,"source":"cache"\|"db"}` · `404` if unknown sku · `502` on backing-store error |
| 9 | POST | `/fulfill` | `{"id":"...","sku":"...","qty":<int>}` | `200 {"id":"...","sku":"...","qty":N,"fulfilled":true,"remaining":N}` · **`409 {"error":"DATA_INCONSISTENCY","cacheQty":N,"dbQty":N}`** · `409 {"error":"insufficient_stock"}` · `503 {"error":"db_unavailable","detail":"..."}` |
| 10 | GET | `/consistency/check` | — | `200 {"consistent":true,...}` or `409 {"consistent":false,"mismatches":[{"sku":"...","cacheQty":N,"dbQty":N,"agree":false}],...}` |
| 11 | POST | `/db/exhaust` | `{"hold":<ms>?,"n":<int>?}` | `200 {"started":N,"hold":<ms>}` — fires N background `SELECT pg_sleep(hold/1000)` queries that each hold a pooled connection, **saturating the pool for `hold` ms** |

### Failure modes induced via inventory

| Mode | Induction recipe |
|---|---|
| **STALE CACHE** (Phase 3) | `curl -X POST .../stock/seed -d '{"sku":"X","qty":0}'` then `curl -X POST .../cache/seed -d '{"sku":"X","qty":10}'`. Now DB says 0, cache says 10. `POST /fulfill {id,sku:X,qty:1}` returns `409 DATA_INCONSISTENCY`. `GET /consistency/check` reports the mismatch. **All `/health` and `/db/health` stay 200.** Reset: `POST /cache/flush`. |
| **DB DOWN** (Phase 4) | `kubectl -n order-demo scale deploy/db --replicas=0; kubectl -n order-demo wait --for=delete pod -l app=db`. `/db/health` returns `503 {"db":"unreachable","detail":"connect ECONNREFUSED <ip>:5432"}`. Restore: `kubectl -n order-demo scale deploy/db --replicas=1`. **Inventory pool may need recovery** — `kubectl -n order-demo rollout restart deploy/inventory` after DB is back to be safe. |
| **DB DEGRADED** (Phase 4) | `curl -X POST .../db/exhaust -d '{"hold":8000,"n":2}'`. For the next ~8s the 2-connection pool is saturated. `/db/health` returns `503 {"db":"unreachable","detail":"db_health_timeout"}`, `/fulfill` returns `503 {"error":"db_unavailable","detail":"timeout exceeded when trying to connect"}`. **Self-recovers** when `pg_sleep` finishes. |

### Tests

- **File:** `tests/inventory/test_inventory.py` (pytest) — original convergence/symptom test; uses `/processed/:id`. Verifies "message arrived in inventory". Used by the orchestrator demo as the downstream symptom test.
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

## Failure-signature reference (the seven from the spec, all live)

One end-to-end symptom (order not fulfilled), seven distinct causes:

| Cause | Where to look | Signature |
|---|---|---|
| auth DOWN | `curl auth.../authorize` direct | `curl: (7) Connection refused`; `kubectl -n order-demo get endpoints auth` empty; `order-placed` topic gets NO new message for the id |
| auth REJECT | auth pod logs | `[auth] REJECT 401 invalid_token` / `[auth] REJECT 403 insufficient_scope`; `/health` 200; order returns opaque 502 |
| auth DEGRADED | timing | auth `/health` 200; `/authorize` blocks `AUTH_DEGRADED_MS`; order's 2s fetch timeout fires → opaque 502 |
| payment DOWN | `/fulfilled/:id` on inventory | `orderPlaced` is set, `paymentConfirmed:null`, `waitingFor:["payment-confirmed"]` |
| STALE CACHE | `GET /consistency/check`, `POST /fulfill` | All `/health` 200; `/consistency/check` → 409 mismatch; `/fulfill` → 409 `DATA_INCONSISTENCY` with `cacheQty` vs `dbQty` |
| DB DOWN | `/db/health` | 503 `{"db":"unreachable","detail":"connect ECONNREFUSED <ip>:5432"}`; raw TCP probe → connection refused |
| DB DEGRADED | `/db/health` under load | 503 `{"db":"unreachable","detail":"db_health_timeout"}` and 503 `{"error":"db_unavailable","detail":"timeout exceeded when trying to connect"}` — note **timeout**, not refused; auto-recovers |

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

## Deviations from `order-demo-enterprise-build-spec.md`

Things implemented differently from the spec, with the reason.

### 1. Built all four phases without per-phase approval gates
**Spec (Part A rule 1):** "Build in phases, in order. Stop after each phase." **Done:** built all four in sequence in a single session.
**Why:** explicit user instruction to do so this session ("do NOT pause and wait for my approval between phases"). Per-phase verification gates from rule 2 were still enforced — each phase's verification check was run and its output shown before moving to the next.

### 2. Three admin endpoints added on inventory that the spec didn't enumerate
Endpoints: `POST /stock/seed`, `POST /cache/seed`, `POST /cache/flush`, `POST /db/exhaust`.
**Why:** the spec **describes** how to induce STALE CACHE ("seed Redis with stock that disagrees with the DB") and DB DEGRADED ("exhaust the connection pool"), but doesn't dictate the mechanism. These endpoints make the recipes one-line curl calls so a TestKube workflow or human can induce the failure declaratively without `kubectl exec` into redis-cli / psql. They are clearly demo/admin-grade and would not exist in a production service.

### 3. Inventory has both `/health` and `/db/health`
**Spec:** describes DB DOWN as "inventory health degraded/failing; clean connection error to db FQDN".
**Why deviation:** rather than make the main `/health` couple to the DB (which would make the DEGRADED case kill readiness probes and replace the failure with a CrashLoop), I kept `/health` as pure-liveness and added `/db/health` as the DB-dependent probe. That gives the spec's required clean-connection-error signature on `/db/health` while letting Kubernetes correctly leave the pod Ready during DB DEGRADED — which is the whole point of the "slow not down" signature.

### 4. `/db/health` wraps the SELECT in a 1.5s race-timeout
**Why:** without this, a stalled-pool query would just hang `/db/health` forever (until the pool wait timeout fires inside `pg`, at which point the response is the same as DB DOWN — `ECONNREFUSED` was the only distinguishable error). The race-timeout produces a distinct `db_health_timeout` error string under DB DEGRADED while still letting DB DOWN show its `ECONNREFUSED` signature. This is what makes the two modes textually distinguishable.

### 5. DB pool intentionally tiny (`DB_POOL_MAX=2`)
**Spec:** "exhaust the connection pool (hold connections)" — implies a small pool.
**Why explicit:** with a default 10-connection pool, demonstrating exhaustion needs 10 concurrent slow queries which is awkward. Pinning to 2 makes `/db/exhaust` with `n:2` reliably saturate the pool. Documented as an env var so it can be widened later if a more "realistic" pool size is needed for a different demo.

### 6. Three failure modes for DEGRADED are env-driven, not code-driven
**Why:** `AUTH_DEGRADED_MS` is an env on the auth deployment; the recipe to induce it is `kubectl set env` + `rollout restart`. Same shape for any future "this service degrades" knob. Keeps the app code clean of conditional fault-injection logic and keeps the recipe `kubectl`-only.

### 7. Existing tests in `tests/inventory/test_inventory.py` and `tests/order/order.postman_collection.json` were preserved unchanged
**Why:** they still pass against the post-Phase-4 system because the endpoints they target (`POST /orders` and `GET /processed/:id`) kept the same contract. Phase 2's "needs both messages" requirement is exposed via the **new** `/fulfilled/:id` endpoint, leaving the old `/processed/:id` (single-topic semantics) intact for the orchestrator-demo flow it was designed for. The Postman collection also did not need a token change because order-service injects `AUTH_TOKEN` server-side from its env — the client never sees it.

### 8. `tests/payment/test_payment.py` uses pytest (not "API tests" as a separate framework)
**Spec (Part B):** "API tests (payment)".
**Why deviation:** pytest already gives clean API-test ergonomics and the rest of the system uses pytest for two of the three other services. Treating "API tests" as just "pytest hitting HTTP" keeps the testing surface coherent without adding a fourth tool. Postman/Newman remains the order-service test, satisfying the tool-variety intent.

### 9. The carried-over scripts (`scripts/deploy.sh`, `scripts/break-auth.sh`, etc.) were not updated for new services
**Why:** out of scope for this build. They still work for the auth-only break/restore demo flow. A future "enterprise deploy.sh" that brings up payment + redis + db is straightforward but deferred.

### 10. CLAUDE.md is stale
**Why:** the in-tree `CLAUDE.md` still describes the pre-enterprise topology (three services, one topic). Updating it was not in the scope for today; this `IMPLEMENTATION.md` is the as-built source for now. A future task should rewrite CLAUDE.md to match.
