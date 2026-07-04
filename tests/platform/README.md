# Platform checks

Infrastructure-level health for the order-demo stack — a new asset class next to
the per-service functional tests. **Manifest-driven:** every check is a data
entry in [`checks.yaml`](checks.yaml); [`runner.sh`](runner.sh) is the only
logic. It runs each check, judges the output, prints `PASS`/`FAIL`/`WARN` with
one line of evidence, and emits JUnit XML.

```
tests/platform/
  checks.yaml          the manifest — every check is an entry
  runner.sh            reads the manifest, runs each check, emits JUnit XML
  rbac/                least-privilege read-only Role/ClusterRole for the checks
  istio/manifests/
    good/              coherent Istio config — must analyze clean
    broken/            same shape with planted errors — must surface known codes
  README.md
```

## Requirements

- `kubectl` (context pointed at the target cluster), `jq`, `python3` (with
  PyYAML). No cluster port-forward is needed — the checks call `kubectl`
  directly.
- `istioctl` is **not** required up front: the runner downloads a pinned version
  on demand, and only when an istioctl check actually runs.

## Running

```bash
cd tests/platform
./runner.sh                        # every check
./runner.sh --tags network         # only network checks (comma list ok)
./runner.sh --tool kubectl         # only kubectl checks (or --tool istioctl)
./runner.sh --check pods-pending   # a single check by name
NAMESPACE=staging ./runner.sh      # target another namespace (default order-demo)
```

Exit code is `1` if any `severity: fail` check fails; `warn` checks never block.
The JUnit report is written to `target/platform-reports/platform.xml` (one
`<testcase>` per check; failures carry the evidence text, warnings pass with a
`<system-out>` note).

## What each check proves

| Check | Severity | Tags | What it proves |
|---|---|---|---|
| `nodes-ready` | fail | node | Every node reports `Ready=True`. |
| `deploys-available` | fail | workload | Every Deployment's ready replicas == desired. |
| `pods-healthy` | fail | workload | No pod is in `CrashLoopBackOff` / `ImagePullBackOff` / `ErrImagePull` / `CreateContainerError`. |
| `pods-pending` | fail | workload,capacity | No pod has been `Pending` longer than 5m (a scheduling/capacity signal). |
| `restarts-threshold` | warn | workload | No container has `>3` restarts with the most recent inside the last hour (proxy for ">3/hr"). |
| `endpoints-ready` | fail | network | Every Service has at least one ready endpoint address. |
| `selector-match` | fail | network | Every Service selector matches at least one pod. |
| `events-warnings` | warn | events | No `Warning` events in the last 15m (lists any it finds). |
| `hpa-sane` | warn | autoscaling | An HPA exists and is not currently pinned at max (proxy for "pinned at max > 30m"). |
| `pvc-bound` | fail | storage | Every PVC is `Bound`. |
| `limits-present` | warn | hygiene | Every container declares resource `requests` **and** `limits`. |
| `pdb-coverage` | warn | hygiene | Every Deployment with `>1` replica is covered by a matching PodDisruptionBudget. |
| `istio-good-clean` | fail | istio | The coherent Istio config analyzes with zero validation messages. |
| `istio-broken-detected` | fail | istio | The intentionally-broken Istio config surfaces the expected `IST` codes. |
| `istio-version-pinned` | warn | istio | The pinned `istioctl` client version is the expected one. |

Some checks are `warn` on purpose: they report drift (missing limits, transient
warnings, PDB gaps) without failing the run. A few use documented heuristics
(`restarts-threshold`, `hpa-sane`) because the runner has no historical window —
those approximations are noted inline in `checks.yaml`.

### The assert vocabulary

Each check's `assert` says how to judge the command output:

- `jq` — a boolean jq expression; PASS when it is true. An optional `evidence`
  jq expression lists the offending objects on failure.
- `grep` — a regex with `mode: absent` (PASS when it does **not** appear) or
  `mode: present` (PASS when it does).
- `grep-all` — a list of patterns that must **all** appear (used to assert the
  expected Istio codes).
- `exit-code` — PASS when the command exits `0`.

## RBAC

[`rbac/platform-checks-readonly.yaml`](rbac/platform-checks-readonly.yaml)
defines a `platform-checks` ServiceAccount and grants it **only** the read verbs
(`get`, `list`) on **only** the resources the checks declare in their `rbac:`
fields — pods, services, endpoints, events, PVCs, deployments, HPAs, PDBs
(namespaced `Role`) and nodes (cluster-scoped `ClusterRole`). This is ordinary
Kubernetes RBAC, not a TestKube resource, so it lives in the repo and lets a
runner authenticate as a scoped, read-only identity:

```bash
kubectl apply -f rbac/platform-checks-readonly.yaml
```

The `rbac:` block on each check is documentation the runner does not consume —
it is the source the Role is derived from, kept next to the check it justifies.
The three istioctl checks need no cluster access at all.

## Istio: static tier now, live mesh later

The istioctl checks are **static**: they run `istioctl analyze --use-kube=false`
against local manifest files. **No cluster interaction, no service mesh
required** — they validate configuration shape, not a running mesh.

- `istio/manifests/good/` is a coherent config for the storefront (a Gateway, a
  VirtualService routing to `order-demo-ui` and the backend services, and
  DestinationRules). It must analyze clean.
- `istio/manifests/broken/` is the same shape with deliberate, realistic errors
  kept broken on purpose (a VirtualService referencing a missing gateway, and a
  route to a subset no DestinationRule defines). Each planted error and its
  expected `IST` code is documented in the file headers; `istio-broken-detected`
  asserts those codes appear.

Live-mesh checks (proxy sync status, mTLS posture, sidecar injection) belong to a
**live tier** that arrives when a labeled-namespace mesh install happens — not
part of this static tier.

## Reports

`target/platform-reports/platform.xml` — JUnit XML, consumable by any CI or
TestKube JUnit collector. `target/` and the on-demand `.tools/` istioctl
download are git-ignored.
