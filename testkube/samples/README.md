# TestKube Demo Sample Workflows — order-demo-enterprise

Three TestWorkflows against the live system in the `order-demo` namespace on GKE.
Git holds **one commented reference copy** of each — the comments are the point.
The same file is what you apply to TestKube; the cluster stores workflows as
structured objects and strips comments on the way in, so no separate "clean
twin" is needed.

| Workflow | Tool | Target | Runnable today? |
|---|---|---|---|
| `pytest-auth-checks` | pytest | `auth.order-demo.svc.cluster.local:3001` | ✅ yes |
| `k6-load-sharded` | k6 ×3 workers | `order.order-demo.svc.cluster.local:3002` | ✅ yes |
| `playwright-ui-e2e` | Playwright | `ui.order-demo... :3000` (placeholder) | ⏳ staged — activates with the Phase 2 UI |

## Apply (pick one)

```bash
# CLI — into the namespace your TestKube agent watches (typically `testkube`)
kubectl apply -f pytest-auth.yaml -n testkube
kubectl apply -f k6-load-sharded.yaml -n testkube

# or TestKube CLI
testkube create testworkflow -f pytest-auth.yaml

# or Dashboard → Workflows → Create → Import YAML (paste the file in)
```

## Run

```bash
testkube run testworkflow pytest-auth-checks -f     # -f follows logs live
testkube run testworkflow k6-load-sharded -f        # watch 3 pods appear:
kubectl get pods -n testkube -w                     # the fan-out, live
```

Or the Run button on the workflow page.

## Two gotchas worth knowing before showing this

1. **Comments don't survive apply.** Kubernetes stores the workflow as a
   structured object, so the dashboard editor shows the spec without comments.
   The file in this folder is the git/teaching artifact; what lives in the
   cluster is the same spec minus comments. In a demo that's a feature:
   "this annotated file is in our repo — here's the same object live."
2. **The k6 script ramps to 500 VUs on its own.** The workflow's `--stage`
   flags override it down to ~60 VUs total (demo-safe). Delete those flags
   to run the full profile and drive the order-service HPA from 1→5 replicas.
