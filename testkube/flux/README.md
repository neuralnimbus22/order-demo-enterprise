# testkube/flux/

Everything that brings [`../pr-checks/`](../pr-checks/) up on a cluster from Git, and keeps it applied.

| File | What it is |
|---|---|
| `bootstrap.sh` | One command: applies the three files below in order and waits until Flux has applied the workflows |
| `flux-helmchart.yaml` | `HelmChart`: Flux, pinned to one chart version. The cluster's own Helm controller installs it |
| `gitrepository.yaml` | `GitRepository`: reads `main` of this repository every minute |
| `pr-checks-kustomization.yaml` | `Kustomization`: applies `./testkube/pr-checks` into the `testkube` namespace every minute, and removes workflows that were deleted from Git |

The Testkube runner in the cluster watches the `testkube` namespace and copies every Test Workflow it finds there to the Testkube control plane. The copy goes one way. A change made in the dashboard is not written back, and the next sync replaces it with what is in Git.

## Bring it up

From the repository root, against the cluster's kube context (`default` if left out):

```bash
testkube/flux/bootstrap.sh default
```

It needs `kubectl`, a k3s or k3d cluster, and a Testkube runner with gitops enabled in the `testkube` namespace. It is safe to run again: anything that already matches is left as it is.

Each step is a controller doing its own job, with nothing run by hand in between:

1. The k3s Helm controller sees the `HelmChart` and installs Flux in the Job `kube-system/helm-install-flux`.
2. Flux reads `main` and applies `./testkube/pr-checks` into `testkube`.
3. The Testkube runner copies those workflows to the control plane.

| Value | Where it comes from |
|---|---|
| Chart `flux2` from `https://fluxcd-community.github.io/helm-charts`, version `2.19.1` | `charts/flux2/Chart.yaml` in [fluxcd-community/helm-charts](https://github.com/fluxcd-community/helm-charts); it ships Flux 2.9.5 |
| `HelmChart` in `kube-system` | Where k3s keeps its own HelmChart objects (Traefik's is there too) |
| Controllers `source`, `kustomize`, `helm` | `source` reads Git and `kustomize` applies it. `helm` is there for a later step that installs charts as HelmReleases |
| Namespace `flux-system` | `targetNamespace` of the `HelmChart`, and where both Flux objects in this folder live |
| Namespace `testkube` | `targetNamespace` in `pr-checks-kustomization.yaml`, and where the runner is installed |
| Context `default` | The lab cluster's context name in the kubeconfig |

On a cluster that is not k3s or k3d, install the same chart, version and values with `helm`, then apply the two Flux objects.

After the first run, nothing is applied by hand. A merge to `main` is the only way to change the workflows in the cluster.

## Check

```bash
kubectl -n kube-system get helmchart flux
kubectl -n flux-system get gitrepositories,kustomizations
kubectl -n testkube get testworkflows -l kustomize.toolkit.fluxcd.io/name=pr-checks
```
