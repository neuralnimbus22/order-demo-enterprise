# Contract tests (Pact, broker-less)

Consumer-driven contract tests for the order-demo backend, using
[Pact JS](https://github.com/pact-foundation/pact-js) v12 (the V3/V4 API).
**Broker-less:** the generated pacts are files committed under `pacts/` — they
*are* the artifact. Self-contained (own `package.json`).

```
tests/contract/
  package.json
  config.js                provider base-URL resolution (env var + FQDN default)
  consumer/                consumer tests — define interactions, generate pacts
  provider/                provider verification — replay pacts vs LIVE services
  pacts/                   generated contracts (committed)
  README.md
```

## What contract testing catches that integration tests miss

An integration test asserts *"when I call a running service, I get what I
expect."* It needs every dependency up, and it only fails once the two sides are
wired together. A contract test splits that into two halves that never run in the
same process:

- The **consumer** test records the exact request order-service makes and the
  response shape it relies on, verified against a Pact **mock** — no provider
  needed. This captures *what the consumer actually depends on* (e.g.
  order-service only reads `authorized` from auth, and `id`/`name` from the
  catalog — not the whole payload).
- The **provider** test replays that recorded contract against the **real**
  provider and fails if the provider no longer satisfies it.

So it catches the failure that ordinary integration tests miss: a provider
changing a field name, status code, or type that *some consumer* relied on —
caught against the provider in isolation, before the two are deployed together,
and without needing the consumer's whole environment. It pins the
**consumer's real expectations** rather than a hand-written example.

## Configuration

Provider base URLs resolve the same way as the BDD suite: an env var wins,
otherwise the in-cluster FQDN default (order-demo namespace).

| Provider | Env var | Default |
|---|---|---|
| auth-service | `AUTH_URL` | `http://auth.order-demo.svc.cluster.local:3001` |
| product-catalog | `PRODUCT_CATALOG_URL` (or `CATALOG_URL`) | `http://product-catalog.order-demo.svc.cluster.local:3005` |

## Running

Install once: `npm install`.

### Consumer side (no services needed — runs against the Pact mock)

```bash
npm run test:consumer
```

This regenerates the three pacts under `pacts/`:
`order-service-auth-service.json`, `order-service-product-catalog.json`, and the
message pact `inventory-service-order-service.json`. JUnit XML →
`target/contract-reports/consumer.xml`.

### Provider side (replays pacts against the LIVE services)

In-cluster the FQDN defaults resolve. Locally, port-forward and override:

```bash
kubectl -n order-demo port-forward svc/auth            3001:3001 &
kubectl -n order-demo port-forward svc/product-catalog 3005:3005 &

AUTH_URL=http://localhost:3001 \
PRODUCT_CATALOG_URL=http://localhost:3005 \
npm run test:provider
```

JUnit XML → `target/contract-reports/provider.xml`. `npm test` runs both sides.

## Re-verification when a provider changes

The pact files are the fixed contract. When a provider (auth or product-catalog)
changes, you **do not** regenerate anything — you re-run `npm run test:provider`
against the new provider. If the change dropped or retyped a field a consumer
relied on, provider verification goes red. That is the signal: the provider
broke a consumer expectation. The contract only changes when the *consumer's*
needs change — you edit the consumer test, re-run `npm run test:consumer` to
regenerate the pact, and commit the updated pact.

## The three contracts

| Kind | Consumer → Provider | What it pins |
|---|---|---|
| HTTP | order-service → auth-service | `POST /authorize` (Bearer + `{orderId,token}`) → `200 {authorized:true, scope[]}` |
| HTTP | order-service → product-catalog | `GET /products/BK-001` → `200 {id,name,...}` |
| Message | inventory-service ← order-service | `order-placed` event `{id,item,qty,at}` is processable |

### Message pact — honest note on the app-code gap

inventory-service's Kafka handler is an inline anonymous `eachMessage` closure
(`services/inventory/server.js:331`) and is **not exported**. To honour the
"no app-code changes" rule, the message consumer test does **not** import the
production handler; it uses a faithful local mirror of what inventory actually
does with a message (`JSON.parse` is done by Pact; inventory only reads `id`,
which it stringifies to track convergence). The event schema is derived from the
producer payload (`services/order/server.js:130`), with the topic and the
order→inventory relationship documented in `ARCHITECTURE.md`.

Consequence: this pins the **schema** contract for `order-placed`, but not the
production handler binary, and there is no provider-side message verification
(that would need a hook to make order-service emit the event on demand). If
inventory's handler is later exported, the mirror can be replaced with a direct
import and a message-provider verification added.

## Broker-less mode: what it gives up

Committing pacts as files is enough for one repo where consumer and provider live
together and are verified in the same pipeline. It gives up what a **Pact
Broker** (or PactFlow) provides:

- **`can-i-deploy`** — no cross-version compatibility matrix, so nothing answers
  *"is it safe to deploy consumer vX against provider vY that's in prod?"*
- versioned/branch-tagged pacts, provider **webhooks** that re-verify when a
  consumer publishes a new contract, and the pending/WIP-pacts workflow.

A Pact Broker becomes worth it once consumer and provider are **separate repos or
deploy pipelines** (or more than a couple of each), where you need
`can-i-deploy` to gate deploys instead of eyeballing it — until then, files in
the repo are simpler and honest.

## Reports

`target/contract-reports/{consumer,provider}.xml` — JUnit XML, same reporting
path pattern as the BDD and platform suites. `node_modules/` and `target/` are
git-ignored; `pacts/` is committed.
