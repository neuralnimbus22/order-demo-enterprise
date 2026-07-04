# API-layer BDD suite

Self-contained Cucumber (JUnit 5 Platform) + REST Assured suite covering the
**API layer** of `order-demo-enterprise`. It exercises the real services over
HTTP — auth, order, payment, inventory convergence, catalog, user-session, and a
cross-service health smoke.

- **Stack:** Java 17, Maven, `cucumber-java` + `cucumber-junit-platform-engine`
  (JUnit 5), REST Assured. `maven-surefire-plugin` writes JUnit XML to
  `target/surefire-reports/`.
- **Layout:** features under `src/test/resources/features/`, step definitions per
  domain under `src/test/java/.../steps/`, one runner (`RunCucumberTest`).

## Prerequisites

- JDK 17 and Maven 3.9+.
- The `order-demo` services reachable at the URLs the suite is configured with
  (see **Configuration**). Nothing else — REST Assured is the only client.

## Configuration

Every base URL resolves in this order (first non-blank wins):

1. a `-D` system property (e.g. `-Dauth.url=...`)
2. an environment variable (e.g. `AUTH_URL=...`)
3. the in-cluster FQDN default (the `order-demo` namespace)

| Service          | System property   | Env var               | Default (in-cluster) |
|------------------|-------------------|-----------------------|----------------------|
| auth             | `auth.url`        | `AUTH_URL`            | `http://auth.order-demo.svc.cluster.local:3001` |
| order            | `order.url`       | `ORDER_URL`           | `http://order.order-demo.svc.cluster.local:3002` |
| inventory        | `inventory.url`   | `INVENTORY_URL`       | `http://inventory.order-demo.svc.cluster.local:3003` |
| payment          | `payment.url`     | `PAYMENT_URL`         | `http://payment.order-demo.svc.cluster.local:3004` |
| product-catalog  | `catalog.url`     | `PRODUCT_CATALOG_URL` | `http://product-catalog.order-demo.svc.cluster.local:3005` |
| user-session     | `session.url`     | `USER_SESSION_URL`    | `http://user-session.order-demo.svc.cluster.local:3006` |

The inventory convergence poll is tunable via `inventory.poll.timeout` /
`INVENTORY_POLL_TIMEOUT_S` (default 20s) and `inventory.poll.interval` /
`INVENTORY_POLL_INTERVAL_S` (default 1s).

Defaults target the cluster, so inside `order-demo` the suite runs unconfigured.

## Running

Inside the cluster (defaults resolve):

```bash
cd tests/bdd
mvn test
```

Locally against port-forwarded services:

```bash
kubectl -n order-demo port-forward svc/auth            3001:3001 &
kubectl -n order-demo port-forward svc/order           3002:3002 &
kubectl -n order-demo port-forward svc/inventory       3003:3003 &
kubectl -n order-demo port-forward svc/payment         3004:3004 &
kubectl -n order-demo port-forward svc/product-catalog 3005:3005 &
kubectl -n order-demo port-forward svc/user-session    3006:3006 &

cd tests/bdd
mvn test \
  -Dauth.url=http://localhost:3001 \
  -Dorder.url=http://localhost:3002 \
  -Dinventory.url=http://localhost:3003 \
  -Dpayment.url=http://localhost:3004 \
  -Dcatalog.url=http://localhost:3005 \
  -Dsession.url=http://localhost:3006
```

## Tag filtering

Tags: `@api` on everything, plus one service tag per feature (`@auth`, `@order`,
`@payment`, `@inventory`, `@catalog`, `@session`) and `@smoke` on the fast
checks (health across every service, plus the auth / payment / catalog happy
paths).

```bash
mvn test -Dcucumber.filter.tags="@api"                 # the whole suite
mvn test -Dcucumber.filter.tags="@api and @auth"       # just auth
mvn test -Dcucumber.filter.tags="@smoke"               # fast smoke set
mvn test -Dcucumber.filter.tags="@api and not @inventory"
```

## Running a single feature file

```bash
mvn test -Dcucumber.features=src/test/resources/features/auth.feature
```

## Reports

- JUnit XML: `target/surefire-reports/`
- Cucumber HTML: `target/cucumber-report.html`
