# order-demo-enterprise

A four-service Kubernetes-native demo whose purpose is to make **upstream root-cause confirmation** visible end to end. The failure case is deliberate: a downstream test reports the symptom, then an orchestrator (built separately in TestKube — **not** in this repo) walks back along the real dependency chain and confirms which boundary actually broke.

## The story

A realistic enterprise order pipeline. Two producers converge on a downstream consumer; failure flows **down**; the deepest **upstream** break is the true cause.

```
auth-service ──┐
               │ (authorize)
order-service ─┤── publishes ──► Kafka: order-placed ──────┐
               │                                            ├──► inventory-service ──► Redis cache ──► Postgres
payment-service ── publishes ──► Kafka: payment-confirmed ─┘    (convergence + symptom point)
```

When `auth` is down, the cascade on the order branch is:

1. `order-service` calls `auth.POST /authorize` → it fails.
2. `order-service` refuses to publish. (The honesty rule below.)
3. `inventory-service` may still receive `payment-confirmed` from the independent payment branch, but **fulfillment never completes** because `order-placed` never arrived for that id. `/fulfilled/:id` reports `waitingFor: ["order-placed"]`.

When `payment` is down, the symmetric thing happens: `order-placed` arrives, `payment-confirmed` doesn't, `waitingFor: ["payment-confirmed"]`. From the downstream test's perspective the only thing visible is "fulfillment never completed" — which side broke is invisible across the Kafka boundary. That invisibility is the whole point of the demo, and the **`waitingFor`** field is the structural cue the orchestrator uses to disambiguate.

The system also models failures that have nothing to do with messages going missing:
- **Stale cache** — every service `/health` is 200, yet `/fulfill` returns `409 DATA_INCONSISTENCY` because Redis disagrees with Postgres. A distinct signature; no connection error anywhere.
- **DB DOWN vs DB DEGRADED** — connection refused versus pool-exhaustion timeout. Same downstream symptom; clearly different signatures on `/db/health`.

## Dependency-direction rules (non-negotiable)

These rules make the demo honest. The orchestration layer can only prove what the system actually does.

- **Dependencies are real, never faked.** `order` genuinely calls `auth`; `payment` genuinely publishes; `inventory` genuinely consumes from Kafka and genuinely reads from Redis + Postgres. There is no staged cascade — if you stop `auth`, the cascade fires because the code paths really require those calls.
- **If `auth` is unreachable / rejecting / degraded-timing-out, `order` MUST fail to publish.** Hard refusal: opaque `502 {"error":"upstream dependency unavailable"}`. No fallback "publish anyway". The opacity is intentional — the symptom must never name auth, or diagnosis isn't actually required.
- **If `order` never published, `inventory` MUST genuinely time out** waiting on the consumer. Not a synthetic assertion error — a real "I waited and nothing arrived" condition.
- **`payment` is a parallel producer.** It's independent of `auth` and `order`. Inventory needs BOTH `order-placed` AND `payment-confirmed` for the same id before it considers an order fulfilled — verified via `/fulfilled/:id`.
- **Each test runs in a different framework on purpose.** pytest for auth / payment / inventory, Postman/Newman for order, k6 for the load test. The orchestrator that walks upstream has to be tool-agnostic, and proving that requires actual heterogeneity.

## What's in this repo

The application + the raw plumbing that any test orchestrator can drive:

| Path | Contents |
|---|---|
| `services/auth`, `services/order`, `services/payment`, `services/inventory` | The four Node.js services |
| `kafka/` | KRaft-mode single-broker Kafka manifests; topics `order-placed` and `payment-confirmed` |
| `k8s/` | Per-service Deployment + Service manifests + namespace, plus `redis.yaml` and `db.yaml` for the backing infra |
| `tests/auth`, `tests/order`, `tests/payment`, `tests/inventory` | Per-service test files in three frameworks (pytest, Newman, pytest, pytest) — runnable standalone |
| `tests/load` | k6 load test that drives `POST /orders` hard enough to trigger HPA scaling on order-service |
| `scripts/` | `deploy.sh` (one-command bring-up), `break-auth.sh`, `restore.sh`, `sanity-check.sh`, `place-order.sh` |
| `.github/workflows/` | `build-images.yml` (multi-arch image builds → GHCR) and `ci-tests.yml` (sequential test runs) |
| `testkube/` | Intentionally empty — see `testkube/README.md` |

For the topology of record (FQDNs + ports), see **`ARCHITECTURE.md`**. For the as-built endpoint reference and exact failure-induction recipes, see **`IMPLEMENTATION.md`**.

## What's NOT in this repo

The TestKube TestWorkflows, the orchestrator that walks upstream, the condition/execute branching logic, the composite workflow, and any control-plane wiring all live **outside** this repo and are built separately, by hand. The application here is deliberately decoupled from how it gets tested so that the orchestration layer can be reasoned about on its own.
