# testkube/flux/

Everything that brings [`../pr-checks/`](../pr-checks/) up on a cluster from Git, keeps it applied, and starts it for every pull request.

| File | What it is |
|---|---|
| `bootstrap.sh` | One command: installs Flux, applies the Flux objects below, and waits until Flux has applied every folder |
| `flux-helmchart.yaml` | `HelmChart`: Flux, pinned to one chart version. The cluster's own Helm controller installs it |
| `gitrepository.yaml` | `GitRepository`: reads `main` of this repository every minute |
| `pr-checks-kustomization.yaml` | `Kustomization`: applies `./testkube/pr-checks` (the workflows and the trigger) into the `testkube` namespace every minute, and removes what was deleted from Git |
| `flux-operator-kustomization.yaml` | `Kustomization`: applies `./operator/` |
| `operator/` | The Flux Operator chart (`OCIRepository`) and its `HelmRelease`. The operator adds ResourceSets, which can watch the pull requests of a repository |
| `pr-watch-kustomization.yaml` | `Kustomization`: applies `./pr-watch/`, after the operator is running |
| `pr-watch/pull-requests.yaml` | `ResourceSetInputProvider`: reads the open pull requests of this repository every 2 minutes |
| `pr-watch/pr-requests.yaml` | `ResourceSet`: keeps one ConfigMap, `pr-<number>`, per open pull request in `testkube`, with its number and head commit |

The Testkube runner in the cluster watches the `testkube` namespace and copies every Test Workflow and trigger it finds there to the Testkube control plane. The copy goes one way. A change made in the dashboard is not written back, and the next sync replaces it with what is in Git.

## How a pull request starts its tests

1. Flux sees a new pull request, or a new commit on one, within 2 minutes.
2. Flux creates or changes the ConfigMap `pr-<number>` in `testkube`.
3. The Testkube trigger `pr-suite-on-pull-request` runs `pr-suite` with the number and commit from the ConfigMap.
4. Every run is tagged `pr`, `sha` and `repo`, so one filter shows every test for that pull request.

The same setup reads Azure Repos: set `type: AzureDevOpsPullRequest` and the repository URL in `pr-watch/pull-requests.yaml`, with a token Secret in `secretRef`.

## Bring it up

From the repository root, against the cluster's kube context (`default` if left out):

```bash
testkube/flux/bootstrap.sh default
```

It needs `kubectl`, a k3s or k3d cluster, and a Testkube runner with gitops enabled in the `testkube` namespace. It is safe to run again: anything that already matches is left as it is.

| Value | Where it comes from |
|---|---|
| Chart `flux2` from `https://fluxcd-community.github.io/helm-charts`, version `2.19.1` | `charts/flux2/Chart.yaml` in [fluxcd-community/helm-charts](https://github.com/fluxcd-community/helm-charts); it ships Flux 2.9.5 |
| `HelmChart` in `kube-system` | Where k3s keeps its own HelmChart objects (Traefik's is there too) |
| Controllers `source`, `kustomize`, `helm` | `source` reads Git and charts, `kustomize` applies folders, `helm` installs the Flux Operator chart |
| Chart `oci://ghcr.io/controlplaneio-fluxcd/charts/flux-operator`, tag `0.61.0` | `charts/flux-operator/Chart.yaml` in [controlplaneio-fluxcd/charts](https://github.com/controlplaneio-fluxcd/charts) |
| `type: GitHubPullRequest` | The [ResourceSetInputProvider](https://fluxoperator.dev/docs/crd/resourcesetinputprovider/) type for GitHub pull requests. It exports `id`, `sha`, `branch`, `author` and `title` |
| `reconcileEvery: "2m"` | Without a token, GitHub allows 60 API calls an hour from one address. Every 2 minutes stays under that |
| Label `pr-request: "true"` | Set on each ConfigMap in `pr-watch/pr-requests.yaml`, and selected on by the trigger in `../pr-checks/pr-suite-trigger.yaml` |
| `listener: testkube-runner` | The lab cluster's runner, the one that sees the ConfigMaps |
| Namespace `flux-system` | Where Flux, the operator and the Flux objects live |
| Namespace `testkube` | Where the runner is installed and watches. The workflows, the trigger and the ConfigMaps go there |
| Context `default` | The lab cluster's context name in the kubeconfig |

On a cluster that is not k3s or k3d, install the same Flux chart, version and values with `helm`, then apply the Flux objects.

After the first run, nothing is applied by hand. A merge to `main` is the only way to change what runs in the cluster.

## Look at Flux in a browser

The Flux Operator serves a status page on port 9080. From your Mac:

```bash
kubectl --context default -n flux-system port-forward svc/flux-operator 9080:9080
```

Then open http://localhost:9080. It shows every Flux object and its state: the `GitRepository`, the three `Kustomization`s, the operator's `HelmRelease`, and the pull request watch. It is read-only and has no sign-in, and it does not show Secrets or ConfigMaps. Press Ctrl+C in the terminal to stop the port-forward.

| Value | Where it comes from |
|---|---|
| `svc/flux-operator` | The Service the Flux Operator chart creates, named after the release `flux-operator` in `operator/helmrelease.yaml` |
| `9080:9080` | `web.enabled: true` in `operator/helmrelease.yaml` adds port 9080 to that Service |
| `--context default` | The lab cluster's context name in the kubeconfig |

## Check

```bash
kubectl -n flux-system get kustomizations,resourcesetinputproviders,resourcesets
kubectl -n testkube get testworkflows,testtriggers -l kustomize.toolkit.fluxcd.io/name=pr-checks
kubectl -n testkube get configmaps -l pr-request=true
```
