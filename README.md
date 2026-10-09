# order-demo-enterprise

An e-commerce order pipeline built as six Node.js services on Kubernetes. An order is authorized, placed, paid for and fulfilled, with event-driven convergence over Kafka, a read-through cache, and a Postgres database.

```
auth-service ──┐
               │ (authorize)
order-service ─┤── publishes ──► Kafka: order-placed ──────┐
               │                                            ├──► inventory-service ──► Redis cache ──► Postgres
payment-service ── publishes ──► Kafka: payment-confirmed ─┘    (convergence point)
```

## How an order flows

1. `order-service` calls `auth-service` to authorize the order. Only when auth authorizes it does order publish `order-placed`.
2. `payment-service` confirms payment and publishes `payment-confirmed`. It is independent of auth and order.
3. `inventory-service` consumes both topics. It marks an order fulfilled only once it has seen both events for the same order id. `GET /fulfilled/:id` reports the convergence state, including what it is still `waitingFor`.
4. Inventory reads stock through a Redis cache backed by Postgres.

## Design rules

- **Dependencies are real.** `order` calls `auth` over HTTP before publishing. `payment` publishes to Kafka. `inventory` consumes from Kafka and reads from Redis and Postgres.
- **No publish without authorization.** If `auth` cannot authorize an order, `order` does not publish and returns `502 {"error":"upstream dependency unavailable"}`. The response is deliberately generic so internal service names and failure details are not exposed to callers.
- **Payment is a parallel producer.** It is independent of `auth` and `order`. Inventory needs both `order-placed` and `payment-confirmed` for the same id before an order is fulfilled.

## What's in this repo

| Path | Contents |
|---|---|
| `services/auth`, `services/order`, `services/payment`, `services/inventory`, `services/product-catalog`, `services/user-session` | The six Node.js services. `auth-service` and `user-session` are separate identity concepts: auth authorizes orders server to server, user-session is human login for the UI. |
| `kafka/` | KRaft-mode single-broker Kafka manifests; topics `order-placed` and `payment-confirmed` |
| `k8s/` | Per-service Deployment and Service manifests, the namespace, `redis.yaml` and `db.yaml` for the backing infra, and `hpa.yaml` (autoscaling for order-service) |
| `tests/auth`, `tests/order`, `tests/payment`, `tests/inventory`, `tests/product-catalog`, `tests/user-session` | Per-service tests (pytest, Newman, pytest, pytest, pytest, pytest), each runnable standalone. `tests/product-catalog` and `tests/user-session` are not wired into ci-tests.yml yet. |
| `tests/load` | k6 load test against `POST /orders`, sized to trigger autoscaling on order-service |
| `scripts/` | `deploy.sh` (one-command bring-up), `sanity-check.sh`, `place-order.sh`, `smoke-test.sh` (read-only health and functional check of all six services and the infra) |
| `.github/workflows/` | `build-images.yml` (multi-arch image builds to GHCR) and `ci-tests.yml` (sequential test runs) |
| `testkube/` | See `testkube/README.md` |

For the topology and in-cluster addresses, see **`ARCHITECTURE.md`**. For the endpoint reference, see **`IMPLEMENTATION.md`**.
