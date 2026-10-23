# testkube/pr-checks/

Test Workflows that run for every pull request. Flux applies this folder to the cluster (see [`../flux/`](../flux/)).

| Workflow | What it runs | Test code from |
|---|---|---|
| `pr-suite` | Every workflow labelled `pr-check=true`, in parallel | |
| `pr-playwright` | Playwright UI journeys in 3 shards | `order-demo-ui`, `main` |
| `pr-k6` | k6 load check on `POST /orders`, 35 seconds at 10 users | this repository, the pull request's commit |
| `pr-custom-checkout` | pytest checkout journey: order, payment, fulfilment | this repository, the pull request's commit |

## How a pull request reaches Testkube

1. `.github/workflows/pr-tests.yml` runs on every pull request. It starts `pr-suite` with three config values: `pr`, `sha` and `repo`.
2. `pr-suite` runs each workflow labelled `pr-check=true` and passes the same three values on.
3. Each workflow turns them into execution tags in `spec.execution.tags`, so every run carries `pr`, `sha` and `repo`.

The GitHub check passes only when every test in the suite passes.

## Tags

| Tag | Example | Set from |
|---|---|---|
| `pr` | `25` | `github.event.pull_request.number` |
| `sha` | 40-character commit | `github.event.pull_request.head.sha` |
| `repo` | `order-demo-enterprise` | `github.event.repository.name` |

Pull request numbers repeat across repositories. When several repositories report into one environment, filter on `repo` and `pr` together.

Runs started from the dashboard without config use the defaults: `pr=manual` and `sha=main`.

## Add a test to the pull request view

Add a Test Workflow to this folder with the label `pr-check: "true"` and the same three config values. After the merge, Flux applies it and the next pull request runs it with the others.
