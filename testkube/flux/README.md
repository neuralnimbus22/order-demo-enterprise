# testkube/flux/

The two Flux objects that keep [`../pr-checks/`](../pr-checks/) applied to the cluster.

| File | Kind | What it does |
|---|---|---|
| `gitrepository.yaml` | `GitRepository` | Reads `main` of this repository every minute |
| `pr-checks-kustomization.yaml` | `Kustomization` | Applies `./testkube/pr-checks` into the `testkube` namespace every minute, and removes workflows that were deleted from Git |

The Testkube runner in the cluster watches the `testkube` namespace and copies every Test Workflow it finds there to the Testkube control plane. The copy goes one way. A change made in the dashboard is not written back, and the next sync replaces it with what is in Git.

## Apply

Flux must be installed in the cluster first (`flux install`). Then, against the cluster's kube context:

```bash
kubectl apply -f testkube/flux/gitrepository.yaml
kubectl apply -f testkube/flux/pr-checks-kustomization.yaml
```

## Check

```bash
flux get sources git
flux get kustomizations
kubectl get testworkflows -n testkube
```
