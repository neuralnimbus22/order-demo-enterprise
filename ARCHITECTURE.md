# Architecture

## 1. System overview

A microservices-based e-commerce order pipeline (`order-demo-enterprise`) used as a **system-under-test platform** for TestKube demos. The system is the product: a believable enterprise application with a rich, observable surface (real authorization, message convergence over Kafka, a read-through cache, a backing database) on which test orchestration, multiple test types, and AI agents can be exercised. Failure modes with distinct signatures are deliberately built in so diagnosis and conditional orchestration are demonstrable.

All components run in the `order-demo` namespace.

## 2. Topology

```
Order pipeline (backend):

auth-service ──┐
               │ (authorize)
order-service ─┤── publishes ──► Kafka: order-placed ──────┐
       │       │                                            ├──► inventory-service
       │       │                                            │
       │ (optional sku validation)                          │
       ▼                                                    │
product-catalog                                             │
                                                            │
payment-service ── publishes ──► Kafka: payment-confirmed ──┘    (convergence + symptom point)
                                                                 │
                                                          Redis cache (stock lookups)
                                                                 │
                                                          Database (stock / products / users)


Human identity (for the UI — Phase 2):

      ┌────────────────┐
      │  user-session  │   register / login / JWT validate
      └────────────────┘
        (standalone — NOT on the order pipeline)
```

| Component | Role |
|---|---|
| **auth-service** | Authorizes ORDERS in the backend pipeline. Validates a static Bearer-token catalogue. `order-service` calls it first. Deepest upstream of the order pipeline. **Not** related to human login. |
| **order-service** | Calls `auth-service`, then — and only then — publishes `order-placed` to Kafka. When the request includes a `sku`, also calls `product-catalog` to validate it (optional path; absent `sku` skips the call entirely). Autoscales under load via a HorizontalPodAutoscaler on CPU (min 1, max 5). |
| **product-catalog** | Read-only product lookup. Serves the catalog of generic retail products from a `products` table in the shared Postgres. Provides sku → product resolution for order-service when a `sku` is supplied; otherwise not on any hot path. |
| **payment-service** | Confirms payment, then publishes `payment-confirmed` to Kafka. |
| **inventory-service** | Needs BOTH `order-placed` AND `payment-confirmed` for an order id before fulfillment. Reads stock from Redis cache, backed by the database. Where end-to-end outcomes surface as observable symptoms. |
| **user-session** | Human-identity service. Real `/register`, `/login` (issues signed JWTs), `/validate` (verifies them). The Phase 2 UI uses this for login/logout. **Standalone** — not on the order pipeline, no service calls it from the backend, and it does not share code or tokens with auth-service. |
| **Kafka** | Topics: `order-placed`, `payment-confirmed`. |
| **Redis** | Cache in front of inventory stock lookups. |
| **Database** | Single Postgres instance. Hosts three cleanly separate tables: `stock` (inventory's source of truth for fulfillment), `products` (product-catalog metadata), and `users` (user-session registered accounts). |

### Note on the two identity concepts

`auth-service` and `user-session` are **different things on purpose** and the codebase keeps them strictly separate:

| | auth-service | user-session |
|---|---|---|
| What it authorizes | an ORDER (backend pipeline) | a HUMAN (UI login) |
| Token model | static Bearer-token catalogue (`demo-token-good`, `demo-token-readonly`) | signed JWTs issued at login, verified on `/validate` |
| Who calls it | `order-service` (server-to-server) | the Phase 2 UI (browser → backend) |
| On the order pipeline? | yes — deepest upstream | no — standalone |

This is a believable e-commerce order pipeline: authorize → place order → confirm payment → reserve / fulfill inventory, with caching and a backing store. Dependencies flow left-to-right; a break anywhere shows up at, or downstream of, the break point.

## 3. In-cluster addresses

All components are in the `order-demo` namespace. Use these FQDNs verbatim — abbreviated names do not resolve.

| Component | Address |
|---|---|
| `auth-service` | `auth.order-demo.svc.cluster.local:3001` |
| `order-service` | `order.order-demo.svc.cluster.local:3002` |
| `inventory-service` | `inventory.order-demo.svc.cluster.local:3003` |
| `payment-service` | `payment.order-demo.svc.cluster.local:3004` |
| `product-catalog` | `product-catalog.order-demo.svc.cluster.local:3005` |
| `user-session` | `user-session.order-demo.svc.cluster.local:3006` |
| Kafka broker | `kafka.order-demo.svc.cluster.local:9092` |
| Kafka topics | `order-placed`, `payment-confirmed` |
| Redis | `redis.order-demo.svc.cluster.local:6379` |
| Database | `db.order-demo.svc.cluster.local:5432` |

## 4. Where the tests live

Each service ships at least one test under its own folder in `tests/`:

```
tests/
├── auth/
├── order/
├── payment/
├── inventory/
├── product-catalog/
└── user-session/
```

Test types are intentionally varied across services to exercise TestKube's tool-agnostic nature (pytest, Postman/Newman, API/integration tests, cache-consistency tests). The contents of each folder are the source of truth for what a service's test does and how to invoke it — discover by reading the folder. This file deliberately does not describe frameworks, commands, images, or environment variables.

## 5. Repository

- **Git URL:** `https://github.com/neuralnimbus22/order-demo-enterprise`
- **Default branch:** `main`

TestKube workflows targeting this system should pull test code from the paths above on this branch.
