# testkube/

| Folder | Contents |
|---|---|
| [`pr-checks/`](pr-checks/) | The Test Workflows that run for every pull request: Playwright, k6 and a custom pytest journey, started together by `pr-suite` |
| [`flux/`](flux/) | The Flux `GitRepository` and `Kustomization` that apply `pr-checks/` to the cluster |
| [`samples/`](samples/) | Commented reference TestWorkflows for this system |

Other workflows live outside the repo.
