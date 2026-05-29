# Architecture

## 1. System overview

A microservices-based e-commerce order pipeline (`order-demo-enterprise`) used as a **system-under-test platform** for TestKube demos. The system is the product: a believable enterprise application with a rich, observable surface (real authorization, message convergence over Kafka, a read-through cache, a backing database) on which test orchestration, multiple test types, and AI agents can be exercised. Failure modes with distinct signatures are deliberately built in so diagnosis and conditional orchestration are demonstrable.

All components run in the `order-demo` namespace.

## 2. Topology

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
| **auth-service** | Authorizes orders. `order-service` calls it first. Deepest upstream. |
| **order-service** | Calls `auth-service`, then — and only then — publishes `order-placed` to Kafka. |
| **payment-service** | Confirms payment, then publishes `payment-confirmed` to Kafka. |
| **inventory-service** | Needs BOTH `order-placed` AND `payment-confirmed` for an order id before fulfillment. Reads stock from Redis cache, backed by the database. Where end-to-end outcomes surface as observable symptoms. |
| **Kafka** | Topics: `order-placed`, `payment-confirmed`. |
| **Redis** | Cache in front of inventory stock lookups. |
| **Database** | Source of truth for stock records. |

This is a believable e-commerce order pipeline: authorize → place order → confirm payment → reserve / fulfill inventory, with caching and a backing store. Dependencies flow left-to-right; a break anywhere shows up at, or downstream of, the break point.

## 3. In-cluster addresses

All components are in the `order-demo` namespace. Use these FQDNs verbatim — abbreviated names do not resolve.

| Component | Address |
|---|---|
| `auth-service` | `auth.order-demo.svc.cluster.local:3001` |
| `order-service` | `order.order-demo.svc.cluster.local:3002` |
| `inventory-service` | `inventory.order-demo.svc.cluster.local:3003` |
| `payment-service` | `payment.order-demo.svc.cluster.local:3004` |
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
└── inventory/
```

Test types are intentionally varied across services to exercise TestKube's tool-agnostic nature (pytest, Postman/Newman, API/integration tests, cache-consistency tests). The contents of each folder are the source of truth for what a service's test does and how to invoke it — discover by reading the folder. This file deliberately does not describe frameworks, commands, images, or environment variables.

## 5. Repository

- **Git URL:** `https://github.com/neuralnimbus22/order-demo-enterprise`
- **Default branch:** `main`

TestKube workflows targeting this system should pull test code from the paths above on this branch.
