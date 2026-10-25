# testkube/

| Folder | Contents |
|---|---|
| [`pr-checks/`](pr-checks/) | The Test Workflows that run for every pull request: Playwright, k6 and a custom pytest journey, started together by `pr-suite`, and the trigger that starts `pr-suite` for each pull request |
| [`flux/`](flux/) | The Flux objects that apply `pr-checks/` to the cluster and keep one ConfigMap per open pull request, plus `bootstrap.sh` to bring it all up |
| [`samples/`](samples/) | Commented reference TestWorkflows for this system |

Other workflows live outside the repo.
