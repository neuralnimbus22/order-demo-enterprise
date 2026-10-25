# testkube/flux/

Everything that brings [`../pr-checks/`](../pr-checks/) up on a cluster from Git, and keeps it applied.

| File | What it is |
|---|---|
| `bootstrap.sh` | One command: installs the Flux Operator from a pinned Helm chart, has it install Flux, applies the two Flux objects below, and waits until Flux has applied the workflows |
| `flux-instance.yaml` | `FluxInstance`: the Flux version and controllers the operator installs |
| `gitrepository.yaml` | `GitRepository`: reads `main` of this repository every minute |
| `pr-checks-kustomization.yaml` | `Kustomization`: applies `./testkube/pr-checks` into the `testkube` namespace every minute, and removes workflows that were deleted from Git |

The Testkube runner in the cluster watches the `testkube` namespace and copies every Test Workflow it finds there to the Testkube control plane. The copy goes one way. A change made in the dashboard is not written back, and the next sync replaces it with what is in Git.

## Bring it up

From the repository root, against the cluster's kube context (`default` if left out):

```bash
testkube/flux/bootstrap.sh default
```

It needs `kubectl`, `helm`, and a Testkube runner with gitops enabled in the `testkube` namespace. It is safe to run again: anything that already matches is left as it is.

| Value | Where it comes from |
|---|---|
| Chart `oci://ghcr.io/controlplaneio-fluxcd/charts/flux-operator`, version `0.61.0` | `charts/flux-operator/Chart.yaml` in [controlplaneio-fluxcd/charts](https://github.com/controlplaneio-fluxcd/charts). Every object in this chart names its namespace, so the operator lands in `flux-system` whichever Helm client installs it |
| Flux `2.9.6` | `config/data/flux/v2.9.6` in [controlplaneio-fluxcd/flux-operator](https://github.com/controlplaneio-fluxcd/flux-operator) at tag `v0.61.0`, the Flux versions that operator release carries |
| Controllers `source`, `kustomize`, `helm` | `source` reads Git and `kustomize` applies it. `helm` is there for a later step that installs charts as HelmReleases |
| Namespace `flux-system` | Where the operator, Flux and both Flux objects live |
| Namespace `testkube` | `targetNamespace` in `pr-checks-kustomization.yaml`, and where the runner is installed |
| Context `default` | The lab cluster's context name in the kubeconfig |

After the first run, nothing is applied by hand. A merge to `main` is the only way to change the workflows in the cluster.

## Check

```bash
kubectl -n flux-system get fluxinstance,gitrepositories,kustomizations
kubectl -n testkube get testworkflows -l kustomize.toolkit.fluxcd.io/name=pr-checks
```
