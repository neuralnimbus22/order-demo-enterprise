#!/usr/bin/env bash
# bootstrap.sh — bring up the pull request checks on a cluster from Git, with
# no hand edits.
#
#   1. Apply flux-helmchart.yaml. The cluster's own Helm controller (k3s and
#      k3d have one) installs Flux from the pinned chart in a Job.
#   2. Apply the two Flux objects in this folder: the GitRepository that reads
#      main of this repository, and the Kustomization that applies
#      ../pr-checks/ into the testkube namespace.
#   3. Wait until Flux has read Git and applied the workflows.
#   4. List the Test Workflows Flux applied.
#
# The Testkube runner in the testkube namespace (with gitops enabled) then
# copies those workflows to the Testkube control plane. This script does not
# call Testkube.
#
# Usage:  testkube/flux/bootstrap.sh [kube-context]
#         kube-context defaults to "default", the lab cluster's context.
# Needs:  kubectl, a k3s or k3d cluster, and a Testkube runner with gitops
#         enabled in the testkube namespace.
# Idempotent: safe to re-run. kubectl apply leaves anything that already
# matches unchanged.

set -e -o pipefail

CONTEXT="${1:-default}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K=(kubectl --context "$CONTEXT")
FLUX_NAMESPACE="flux-system"
TESTKUBE_NAMESPACE="testkube"

ok()      { echo "[OK]   $*"; }
fail()    { echo "[FAIL] $*" >&2; }
section() { echo; echo "--- $* ---"; }

START=$(date +%s)
echo "=== bootstrap the pull request checks (context=$CONTEXT) ==="

# --- 0. checks -------------------------------------------------------------
section "0. checks"
command -v kubectl >/dev/null || { fail "kubectl not found"; exit 1; }
"${K[@]}" get crd helmcharts.helm.cattle.io >/dev/null \
  || { fail "no HelmChart objects here: this cluster is not k3s or k3d"; exit 1; }
"${K[@]}" get namespace "$TESTKUBE_NAMESPACE" >/dev/null \
  || { fail "no $TESTKUBE_NAMESPACE namespace: install the Testkube runner first"; exit 1; }
ok "kubectl, the k3s Helm controller and the $TESTKUBE_NAMESPACE namespace are there"

# --- 1. Flux ---------------------------------------------------------------
section "1. Flux, installed by the cluster's Helm controller"
"${K[@]}" apply -f "$HERE/flux-helmchart.yaml"
for _ in $(seq 1 30); do
  "${K[@]}" -n kube-system get job helm-install-flux >/dev/null 2>&1 && break
  sleep 2
done
"${K[@]}" -n kube-system wait job/helm-install-flux --for=condition=complete --timeout=5m
"${K[@]}" wait --for=condition=Established --timeout=60s \
  crd/gitrepositories.source.toolkit.fluxcd.io \
  crd/kustomizations.kustomize.toolkit.fluxcd.io
"${K[@]}" -n "$FLUX_NAMESPACE" wait deployment --all --for=condition=Available --timeout=5m
ok "Flux is running in $FLUX_NAMESPACE"

# --- 2. the two Flux objects -----------------------------------------------
section "2. GitRepository and Kustomization"
"${K[@]}" apply -f "$HERE/gitrepository.yaml" -f "$HERE/pr-checks-kustomization.yaml"
ok "applied"

# --- 3. wait for Flux ------------------------------------------------------
section "3. wait for Flux to read Git and apply the workflows"
"${K[@]}" -n "$FLUX_NAMESPACE" wait gitrepository/order-demo-enterprise \
  --for=condition=Ready --timeout=3m
"${K[@]}" -n "$FLUX_NAMESPACE" wait kustomization/pr-checks \
  --for=condition=Ready --timeout=3m
ok "Flux applied ./testkube/pr-checks"

# --- 4. what Flux applied --------------------------------------------------
section "4. Test Workflows applied by Flux"
"${K[@]}" -n "$TESTKUBE_NAMESPACE" get testworkflows \
  -l kustomize.toolkit.fluxcd.io/name=pr-checks

echo
ok "done in $(( $(date +%s) - START ))s"
