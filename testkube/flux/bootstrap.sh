#!/usr/bin/env bash
# bootstrap.sh — bring up the pull request checks on a cluster from Git, with
# no hand edits.
#
#   1. Install the Flux Operator from a pinned Helm chart into flux-system.
#   2. Apply flux-instance.yaml. The operator installs Flux from it.
#   3. Apply the two Flux objects in this folder: the GitRepository that reads
#      main of this repository, and the Kustomization that applies
#      ../pr-checks/ into the testkube namespace.
#   4. Wait until Flux has read Git and applied the workflows.
#   5. List the Test Workflows Flux applied.
#
# The Testkube runner in the testkube namespace (with gitops enabled) then
# copies those workflows to the Testkube control plane. This script does not
# call Testkube.
#
# Usage:  testkube/flux/bootstrap.sh [kube-context]
#         kube-context defaults to "default", the lab cluster's context.
# Needs:  kubectl and helm, and a Testkube runner with gitops enabled in the
#         testkube namespace.
# Idempotent: safe to re-run. helm upgrade --install and kubectl apply leave
# anything that already matches unchanged.

set -e -o pipefail

CONTEXT="${1:-default}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The Flux Operator chart, pinned: charts/flux-operator/Chart.yaml in
# github.com/controlplaneio-fluxcd/charts. The Flux version it installs is
# pinned separately, in flux-instance.yaml.
FLUX_OPERATOR_CHART="oci://ghcr.io/controlplaneio-fluxcd/charts/flux-operator"
FLUX_OPERATOR_VERSION="0.61.0"
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
command -v helm    >/dev/null || { fail "helm not found"; exit 1; }
kubectl --context "$CONTEXT" get namespace "$TESTKUBE_NAMESPACE" >/dev/null \
  || { fail "no $TESTKUBE_NAMESPACE namespace: install the Testkube runner first"; exit 1; }
ok "kubectl, helm and the $TESTKUBE_NAMESPACE namespace are there"

# --- 1. Flux Operator ------------------------------------------------------
section "1. Flux Operator from the pinned Helm chart ($FLUX_OPERATOR_VERSION)"
helm upgrade --install flux-operator "$FLUX_OPERATOR_CHART" \
  --version "$FLUX_OPERATOR_VERSION" \
  --namespace "$FLUX_NAMESPACE" --create-namespace \
  --kube-context "$CONTEXT" \
  --wait --timeout 5m
ok "the Flux Operator is running in $FLUX_NAMESPACE"

# --- 2. Flux ---------------------------------------------------------------
section "2. Flux, as declared in flux-instance.yaml"
kubectl --context "$CONTEXT" apply -f "$HERE/flux-instance.yaml"
kubectl --context "$CONTEXT" -n "$FLUX_NAMESPACE" wait fluxinstance/flux \
  --for=condition=Ready --timeout=5m
kubectl --context "$CONTEXT" wait --for=condition=Established --timeout=60s \
  crd/gitrepositories.source.toolkit.fluxcd.io \
  crd/kustomizations.kustomize.toolkit.fluxcd.io
ok "Flux is running in $FLUX_NAMESPACE"

# --- 3. the two Flux objects -----------------------------------------------
section "3. GitRepository and Kustomization"
kubectl --context "$CONTEXT" apply \
  -f "$HERE/gitrepository.yaml" \
  -f "$HERE/pr-checks-kustomization.yaml"
ok "applied"

# --- 4. wait for Flux ------------------------------------------------------
section "4. wait for Flux to read Git and apply the workflows"
kubectl --context "$CONTEXT" -n "$FLUX_NAMESPACE" wait gitrepository/order-demo-enterprise \
  --for=condition=Ready --timeout=3m
kubectl --context "$CONTEXT" -n "$FLUX_NAMESPACE" wait kustomization/pr-checks \
  --for=condition=Ready --timeout=3m
ok "Flux applied ./testkube/pr-checks"

# --- 5. what Flux applied --------------------------------------------------
section "5. Test Workflows applied by Flux"
kubectl --context "$CONTEXT" -n "$TESTKUBE_NAMESPACE" get testworkflows \
  -l kustomize.toolkit.fluxcd.io/name=pr-checks

echo
ok "done in $(( $(date +%s) - START ))s"
