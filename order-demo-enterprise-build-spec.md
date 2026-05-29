# Order-Demo Enterprise — Build Spec & Harness Guide

This is the source of truth for building **order-demo-enterprise**: a realistic, enterprise-grade
microservices system that serves as a **system-under-test platform** for TestKube demos.

The system is the product. On top of it we build many things over time:
- deterministic test orchestration (conditional workflows),
- multiple test types (API, Postman, Playwright, cache/consistency, and more),
- a growing family of AI agents (root-cause analysis is the first; test generation, optimization,
  coverage analysis, and others will follow),
- reporting and visibility.

The app's job is to be **rich and realistic enough** to support all of that. Failure modes with
distinct signatures are one valuable property of the system (they make diagnosis and conditional
orchestration demonstrable), but they are not the system's only purpose. Build the system to be a
believable enterprise application first.

The coding agent (Claude Code) builds **to this spec**, in phases, stopping at each verification
gate. Code serves this spec, not the other way around.

This file has two parts:
- **Part A — Harness rules**: how the coding agent must behave while building.
- **Part B — Architecture & phases**: what to build, per service, with verification checks.

The topology in Part B is also the source for the system's `architecture.md` (which any agent —
RCA or otherwise — can read to understand the system).

---

## PART A — HARNESS RULES (how the agent builds)

1. **Build in phases, in order. Stop after each phase.** Do not start the next phase until the
   current one passes its verification check and I confirm. One phase = one reviewable unit.

2. **After each phase, run that phase's verification check and show me the output.** Do not claim
   a phase works without showing the check passing. A check that fails to *reach* a service (DNS
   error, connection-setup error) means the check or wiring is wrong, not that the feature works.

3. **Reuse what exists.** The services carried over from order-demo (auth, order, inventory, kafka)
   and their tests in `tests/` are working. Extend them; do not rewrite from scratch unless a phase
   explicitly says so.

4. **Addressing rule (carried over from a real failure).** Always use the exact in-cluster FQDN +
   port from the topology below, verbatim. Never abbreviate to `auth-service` etc.; those do not
   resolve.

5. **Namespacing.** Everything stays in the `order-demo` namespace. New services follow the existing
   naming pattern.

6. **Do not touch TestKube objects.** This spec is about app + test code in the repo only. Do not
   create, modify, or delete TestKube workflows, agents, or triggers. Those are managed separately
   in the TestKube UI.

7. **Build for realism and observability.** Each service should behave like a real component:
   sensible endpoints, health/readiness, logs that describe what happened, clear status codes. Rich,
   observable behavior is what lets every downstream consumer (orchestration, agents, reports) do its
   job. Where a phase calls for a failure mode, make its behavior and output *distinguishable* from
   other failure modes.

8. **Keep each service independently runnable and testable.** A service's test lives in its own
   `tests/<service>/` folder.

9. **Show diffs before committing. Commit per phase** with a clear message. Push to main only after
   I confirm the phase.

---

## PART B — ARCHITECTURE & PHASES

### Topology (also the system's `architecture.md` source of truth)

```
auth-service ──┐
               │ (authorize)
order-service ─┤── publishes ──► Kafka: order-placed ──────┐
               │                                            ├──► inventory-service
payment-service ── publishes ──► Kafka: payment-confirmed ─┘    (convergence + symptom point)
                                                                 │
                                                          Redis cache (stock lookups)
                                                                 │
                                                          Database (stock records)
```

| Component | Role |
|---|---|
| **auth-service** | Authorizes orders. order-service calls it first. Deepest upstream. |
| **order-service** | Calls auth, then publishes `order-placed`. |
| **payment-service** | Confirms payment, then publishes `payment-confirmed`. |
| **inventory-service** | Needs BOTH `order-placed` AND `payment-confirmed` to fulfill an order. Reads stock from Redis cache, backed by the database. Where end-to-end outcomes surface. |
| **Kafka** | Topics: `order-placed`, `payment-confirmed`. |
| **Redis** | Cache in front of inventory stock lookups. |
| **Database** | Source of truth for stock records. |

This is a believable e-commerce order pipeline: authorize -> place order -> confirm payment ->
reserve/fulfill inventory, with caching and a backing store. Dependencies flow left to right; a
break anywhere shows up at or downstream of the break point.

### In-cluster addresses (use verbatim)

| Component | Address |
|---|---|
| auth | `auth.order-demo.svc.cluster.local:3001` |
| order | `order.order-demo.svc.cluster.local:3002` |
| inventory | `inventory.order-demo.svc.cluster.local:3003` |
| payment | `payment.order-demo.svc.cluster.local:3004` |
| kafka | `kafka.order-demo.svc.cluster.local:9092` |
| redis | `redis.order-demo.svc.cluster.local:6379` |
| database | `db.order-demo.svc.cluster.local:5432` |

### Test surface (so non-RCA consumers have something to work with)

Each service exposes a clear API and ships at least one test in `tests/<service>/`. Test types are
intentionally varied to demonstrate TestKube's tool-agnostic nature: e.g. pytest (auth, inventory),
Postman/Newman (order), API tests (payment), and a cache-consistency test (inventory<->redis<->db).
This variety is also what a future test-generation or coverage agent would reason over.

---

### PHASE 1 — IAM: real authorization

Upgrade auth-service from "scaled to zero" to a real authorizer with genuine behavior and three
distinct failure modes.

**auth-service endpoints**
- `POST /authorize` — body includes an order + a token. Validates the token, returns
  `200 {authorized:true}` or `401`/`403` if the token is invalid/insufficient.
- `GET /health` — liveness, returns `200` when the process is up.

**order-service change**
- Before publishing `order-placed`, call `POST auth.../authorize`. Only publish if `200`.
- On auth failure, return the existing opaque `502 {"error":"upstream dependency unavailable"}`
  (keep the symptom opaque — do not leak "auth" downstream).

**Failure modes & signatures (each distinct)**
| Mode | How to induce | Signature |
|---|---|---|
| DOWN | scale auth to 0 | health check: clean connection refused (`curl (7)`) |
| REJECT | auth returns 401/403 for the request | health check PASSES; auth returns 401/403 in its own logs/test |
| DEGRADED | auth sleeps N seconds before responding | health check PASSES but slow; functional test times out |

**Verification check (Phase 1)**
- Health endpoints reachable on the FQDNs.
- Happy path: valid token -> order authorized -> `order-placed` published.
- DOWN -> order returns opaque 502, `order-placed` not published.
- REJECT -> order returns opaque 502, auth log shows 401/403.
- DEGRADED -> auth health passes, functional test exceeds timeout.
- The three failure modes produce three different signatures.

---

### PHASE 2 — Payment branch (converging topics)

Add payment-service and a second topic so inventory needs BOTH messages.

**payment-service endpoints**
- `POST /payments` — confirms a payment, publishes `payment-confirmed` to Kafka, returns `201`.
- `GET /health` — liveness.

**inventory-service change**
- Fulfillment now requires BOTH `order-placed` AND `payment-confirmed` for an order id.
- If one topic's message never arrives, the existing "message never arrived" symptom fires.

**Failure mode & signature**
| Mode | How to induce | Signature |
|---|---|---|
| PAYMENT DOWN | scale payment to 0 | `order-placed` IS present; `payment-confirmed` missing; inventory waits then fails. Distinct from auth-down (where order-placed itself is missing). |

**Verification check (Phase 2)**
- Happy path: order + payment -> both topics populated -> inventory fulfills.
- Payment down -> order-placed present, payment-confirmed absent, inventory symptom fires.
- Signature distinguishable from Phase 1's auth-down.

---

### PHASE 3 — Redis cache (stale-data failure)

Put a Redis cache in front of inventory's stock lookups.

**inventory-service change**
- Stock lookups read from Redis first, fall back to the database on miss, and populate the cache.

**Failure mode & signature (the deceptive one)**
| Mode | How to induce | Signature |
|---|---|---|
| STALE CACHE | seed Redis with stock that disagrees with the DB (e.g. cache says in-stock, DB says zero) | EVERY health check passes, every service is "up", but fulfillment fails on a data inconsistency. No connection error anywhere. |

**Verification check (Phase 3)**
- Normal: cache and DB agree, fulfillment succeeds.
- Stale: cache disagrees with DB, all health checks pass, fulfillment fails with a data-mismatch
  error clearly NOT a connectivity or missing-message error.
- A cache-consistency test exists in `tests/inventory/` (or its own folder) that asserts cache vs DB.

---

### PHASE 4 — Database degraded mode

Add a database behind inventory (and optionally order) with a connection-pool-exhaustion failure.

**Failure mode & signature**
| Mode | How to induce | Signature |
|---|---|---|
| DB DOWN | stop the DB | inventory health degraded/failing; clean connection error to db FQDN |
| DB DEGRADED | exhaust the connection pool (hold connections) | service is UP, health passes, but queries are slow/timing out — "slow not down", distinct from DB down |

**Verification check (Phase 4)**
- DB down -> distinct connection-error signature on the db FQDN.
- DB degraded -> health passes, queries time out, signature distinct from DB down and auth degraded.

---

## What this system enables (consumers, not just RCA)

The system above is deliberately rich so that many TestKube capabilities can be demonstrated on it:

- **Deterministic orchestration** — conditional workflows that read a failure's signature and decide
  whether (and where) to run upstream suites, including when NOT to cascade.
- **Root-cause analysis agent** — walks the dependency chain and identifies the deepest real cause.
- **Future agents** — e.g. test generation (reasoning over the API surface), optimization (execution
  time / resources), coverage analysis (which paths are exercised). These are not built yet; the
  system is designed so they can be.
- **Multiple test types & reporting** — varied frameworks across services, JUnit artifacts, etc.

### Signature reference (one useful property of the system)

One end-to-end symptom ("order not fulfilled"), many root causes, each distinguishable:

| Root cause | Distinguishing signature |
|---|---|
| auth down | order-placed missing; clean connection refused to auth |
| auth reject | auth health passes; 401/403 in auth logs |
| auth degraded | auth health passes but slow; functional timeout |
| payment down | order-placed present, payment-confirmed missing |
| stale cache | all healthy; data mismatch, no connection error |
| db down | connection error to db FQDN |
| db degraded | db up, queries slow/timeout |
