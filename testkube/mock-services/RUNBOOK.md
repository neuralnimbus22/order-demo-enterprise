# Mock services demo: runbook

This demo tests order-service on its own. Its real dependencies are replaced by
mocks built from the contracts in `contracts/`:

| Contract | What it describes |
|---|---|
| `contracts/auth-service.openapi.yaml` | `POST /authorize`: request `{orderId, token}`, response `{authorized, scope}` |
| `contracts/product-catalog.openapi.yaml` | `GET /products/{id}`: the product order-service looks up when the order has a sku |
| `contracts/order-placed.asyncapi.yaml` | The Kafka event `{id, item, qty, at, sku?}` that order-service publishes |

Everything runs in the **SA Demo** Testkube org (environment `default`), on the
home lab runner `testkube-runner` (node `lws-tklab`, kubectl context `default`).

## The three workflows

| Workflow | What it does |
|---|---|
| `mock-services-prism` | Starts Kafka and one Prism mock per REST contract as Testkube services. Runs order-service from the branch, places an order with sku BK-001, and checks that an order-placed event arrives. Prism rejects requests that break the REST contracts. It does not check the event. |
| `mock-services-microcks` | Starts Kafka as a Testkube service and uses the shared Microcks in namespace `mock-services`. Imports the three contracts, places the same order through the Microcks REST mocks, then runs a Microcks async contract test of the order-placed event against the AsyncAPI file. Microcks does not validate REST requests. |
| `mock-services-gate` | Runs both workflows in parallel for one branch. It is green only when both are green. Jenkins runs this one. |

All three take one setting, `branch` (default `mock-services-demo`). All three
pin the runner in their spec (`execution.target.match.name: [testkube-runner]`),
so no target has to be passed when you start them.

## The three branches

All three branches have identical tests, contracts and workflow files. Each break
branch differs from `mock-services-demo` by one line in `services/order/server.js`.

| Branch | The one change | What it simulates |
|---|---|---|
| `mock-services-demo` | none | The healthy baseline |
| `mock-services-demo-break` | The order-placed event sends `orderId` instead of `id` | A producer renames an event field that inventory-service reads |
| `mock-services-demo-rest-break` | The body of `POST /authorize` sends `order_id` instead of `orderId` | A consumer sends a request that the auth API does not accept |

## Expected results

| Branch | Prism | Microcks | Gate |
|---|---|---|---|
| `mock-services-demo` | green | green | green |
| `mock-services-demo-break` | green | **red** | **red** |
| `mock-services-demo-rest-break` | **red** | green | **red** |

The story: each tool catches one kind of break and misses the other. Prism checks
REST requests and ignores events. Microcks checks the event and does not
validate REST requests. The gate needs both to be green.

## How to run it

### From Jenkins (home lab)

Jenkins has no external address. Port-forward it first:

```bash
kubectl --context default -n jenkins port-forward svc/jenkins 8080:8080
```

1. Open http://localhost:8080/job/mock-services-gate/ and log in.
2. Click **Build with Parameters**.
3. Set **BRANCH** to one of the three branches and click **Build**.
4. Open the build and click **Console Output**. It streams the gate run and links to it in Testkube.

The build fails when the gate fails. The job reads `testkube/mock-services/Jenkinsfile`
from `mock-services-demo`. It runs in a pod with the `kubeshop/testkube-cli` image
and needs the Jenkins credential `TK_API_TOKEN`.

### From the Testkube dashboard

1. Open the SA Demo org, environment `default`, then **Test Workflows**.
2. Open `mock-services-gate`, or `mock-services-prism` / `mock-services-microcks` to show one tool.
3. Click **Run now**, set `branch`, and run. Leave the runner choice alone: the workflow pins it.

### From the CLI

```bash
testkube run testworkflow mock-services-gate --config branch=mock-services-demo-break -f
```

## Where the evidence for each failure is

### Microcks red on `mock-services-demo-break`

- **Log of the step "Run order-service against Microcks mocks, then test order-placed"**:
  `FAIL order-placed event matches the AsyncAPI contract order-placed:1.0.0 (Microcks async test) — order-placed contract (order-placed:1.0.0) violated, Microcks test <id>: SUBSCRIBE order-placed: required property 'id' not found`
- **JUnit report** (Reports tab): `mock-services-microcks.xml`, with the same message on the failing test case.
- **In Microcks**: the test id from the message. Port-forward with
  `kubectl --context default -n mock-services port-forward svc/microcks 8080:8080`
  and open http://localhost:8080. Go to **APIs | Services**, open `order-placed 1.0.0`, then **Tests**.

### Prism red on `mock-services-demo-rest-break`

order-service hides upstream failures behind a plain 502 on purpose, so the test
message points you to the mock logs:

- **Log of the step "Run order-service against Prism mocks and per-run Kafka"** and the **JUnit report** `mock-services-prism.xml`:
  `expected 201, got 502 {"error":"upstream dependency unavailable"}. order-service does not say which upstream call failed: open the authmock and catalogmock service logs of this run, where Prism logs the request that broke its contract.`
- **The authmock service log** of the same run. In the dashboard, open the execution and the **authmock** service log. The same file is the artifact `.testkube/<ref>/logs/authmock/0.log`. It shows:
  ```
  [VALIDATOR] ✖  error     Request body must have required property 'orderId'
  [HTTP SERVER] post /authorize ✖  error     Request terminated with error: https://stoplight.io/prism/errors#UNPROCESSABLE_ENTITY: Invalid request
  ```

### Gate red

The gate log lists both child runs and which one failed, for example
`1 of 2 executions failed: mock-services-microcks-9 (failed)`. Open the failed
child run for the evidence above.

## Health checks before a demo

Run these about ten minutes before you start.

1. **The home lab runner is up.**
   ```bash
   kubectl --context default -n testkube get pods -l app.kubernetes.io/name=testkube-runner
   kubectl --context default get node lws-tklab
   ```
   Expect the runner pod `Running` and the node `Ready`. In the dashboard, the
   agent list should show `testkube-runner` as connected.

2. **The shared Microcks and its async minion are up.**
   ```bash
   kubectl --context default -n mock-services get pods
   ```
   Expect `microcks` and `microcks-async-minion` both `1/1 Running`. The minion
   restarting a few times right after Microcks starts is normal: it exits until
   Microcks answers. Check that it is connected:
   ```bash
   kubectl --context default -n mock-services logs deploy/microcks-async-minion --tail=20
   ```
   Expect `microcks-uber-async-minion ... started` and recurring
   `Producing async mock messages` lines, not connection errors.

   If either is missing, reinstall it from the repo:
   ```bash
   kubectl --context default apply -f testkube/mock-services/microcks-shared.yaml
   ```
   Microcks keeps its data in memory. Each run imports the contracts again, so a
   restart loses nothing.

3. **A dry run.** Run `mock-services-gate` on `mock-services-demo` and expect
   green in about 35 seconds. If it is red there, fix that before the demo.

Microcks logs repeated errors about an unknown host `o11y_otel`. That is its
unset OpenTelemetry exporter. It does not affect the demo.

## Files

| Path | What it is |
|---|---|
| `contracts/` | The three contracts |
| `tests/mock-services/` | The checks the workflows run: `prism-check.js`, `microcks-check.js`, `common.js` |
| `testkube/mock-services/mock-services-*.yaml` | The three workflows, as created in SA Demo |
| `testkube/mock-services/microcks-shared.yaml` | The shared Microcks install |
| `testkube/mock-services/Jenkinsfile` | The Jenkins pipeline for the gate |
