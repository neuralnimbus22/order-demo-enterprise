# testkube/flux/

Everything that brings [`../pr-checks/`](../pr-checks/) up on a cluster from Git, and keeps it applied.

| File | What it is |
|---|---|
| `bootstrap.sh` | One command that installs Flux from a pinned Helm chart, applies the two Flux objects below, and waits until Flux has applied the workflows |
| `flux-values.yaml` | Values for the Flux chart: the controllers this lab needs, the rest off |
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
| Chart `oci://ghcr.io/fluxcd-community/charts/flux2`, version `2.19.1` | `charts/flux2/Chart.yaml` in [fluxcd-community/helm-charts](https://github.com/fluxcd-community/helm-charts); it ships Flux 2.9.5 |
| Namespace `flux-system` | Where both Flux objects in this folder live |
| Namespace `testkube` | `targetNamespace` in `pr-checks-kustomization.yaml`, and where the runner is installed |
| Context `default` | The lab cluster's context name in the kubeconfig |

After the first run, nothing is applied by hand. A merge to `main` is the only way to change the workflows in the cluster.

## Check

```bash
kubectl -n flux-system get gitrepositories,kustomizations
kubectl -n testkube get testworkflows -l kustomize.toolkit.fluxcd.io/name=pr-checks
```
