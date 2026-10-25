# testkube/pr-checks/

Test Workflows that run for every pull request. Flux applies this folder to the cluster (see [`../flux/`](../flux/)).

| Workflow | What it runs | Test code from |
|---|---|---|
| `pr-suite` | Every workflow labelled `pr-check=true`, in parallel | |
| `pr-playwright` | Playwright UI journeys in 3 shards | `order-demo-ui`, `main` |
| `pr-k6` | k6 load check on `POST /orders`, 35 seconds at 10 users | this repository, the pull request's commit |
| `pr-custom-checkout` | pytest checkout journey: order, payment, fulfilment | this repository, the pull request's commit |

`pr-suite-trigger.yaml` is the Testkube trigger that starts `pr-suite` for each pull request.

## How a pull request reaches Testkube

Flux starts the tests. No pipeline step is involved.

1. Flux reads the open pull requests of this repository every 2 minutes ([`../flux/pr-watch/pull-requests.yaml`](../flux/pr-watch/pull-requests.yaml)).
2. For each open pull request, Flux keeps one ConfigMap, `pr-<number>`, in the `testkube` namespace, holding the pull request number and its head commit ([`../flux/pr-watch/pr-requests.yaml`](../flux/pr-watch/pr-requests.yaml)). A new pull request creates it. A new commit changes it. A closed pull request removes it.
3. The Testkube trigger `pr-suite-on-pull-request` ([`pr-suite-trigger.yaml`](pr-suite-trigger.yaml)) sees the ConfigMap created or changed, and runs `pr-suite` with three config values from it: `pr`, `sha` and `repo`.
4. `pr-suite` runs each workflow labelled `pr-check=true` and passes the same three values on.
5. Each workflow turns them into execution tags in `spec.execution.tags`, so every run carries `pr`, `sha` and `repo`.

The Testkube Executions view filtered on `pr=<number>` lists every run for that pull request, across every push to it.

`.github/workflows/pr-tests.yml` can start the same suite by hand from GitHub Actions, with a pull request number and commit as inputs. It shows the same call made from a pipeline step.

## Tags

| Tag | Example | Set from |
|---|---|---|
| `pr` | `26` | `id` of the pull request, as Flux reports it (`<< inputs.id >>`) |
| `sha` | 40-character commit | `sha` of the pull request's head commit (`<< inputs.sha >>`) |
| `repo` | `order-demo-enterprise` | Set in `../flux/pr-watch/pr-requests.yaml` |

Pull request numbers repeat across repositories. When several repositories report into one environment, filter on `repo` and `pr` together.

Runs started from the dashboard without config use the defaults: `pr=manual` and `sha=main`.

## Add a test to the pull request view

Add a Test Workflow to this folder with the label `pr-check: "true"` and the same three config values. After the merge, Flux applies it and the next pull request runs it with the others.
