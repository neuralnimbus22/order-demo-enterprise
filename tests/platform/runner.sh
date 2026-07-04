#!/usr/bin/env bash
#
# Platform-checks engine. All logic lives here; the checks live in checks.yaml.
# For each check: run its command, evaluate its assert, print PASS/FAIL/WARN with
# one line of evidence, and emit JUnit XML to target/platform-reports/platform.xml.
#
# Exit 1 if any severity=fail check fails. WARNs never block.
#
# Usage:
#   ./runner.sh                       run every check
#   ./runner.sh --tags network        only checks tagged 'network' (comma list ok)
#   ./runner.sh --tool kubectl        only kubectl (or istioctl) checks
#   ./runner.sh --check pods-pending  a single check by name
#   NAMESPACE=staging ./runner.sh     target another namespace (default order-demo)
#
# Requires: kubectl, jq, python3 (PyYAML). istioctl is downloaded (pinned) on
# demand only when an istioctl check runs; nothing else is installed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${CHECKS_MANIFEST:-$SCRIPT_DIR/checks.yaml}"
REPORT_DIR="$SCRIPT_DIR/target/platform-reports"
REPORT="$REPORT_DIR/platform.xml"

# ---- defaults from the manifest (namespace, istio_version) ------------------
NAMESPACE="${NAMESPACE:-$(python3 -c 'import yaml,sys; print((yaml.safe_load(open(sys.argv[1])).get("defaults") or {}).get("namespace","order-demo"))' "$MANIFEST")}"
ISTIO_VERSION="$(python3 -c 'import yaml,sys; print((yaml.safe_load(open(sys.argv[1])).get("defaults") or {}).get("istio_version","1.24.2"))' "$MANIFEST")"
export NAMESPACE

# ---- args -------------------------------------------------------------------
FILTER_TAGS=""; FILTER_TOOL=""; FILTER_CHECK=""
usage() { sed -n '3,20p' "$SCRIPT_DIR/runner.sh" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --tags)  FILTER_TAGS="${2:-}"; shift 2 ;;
    --tool)  FILTER_TOOL="${2:-}"; shift 2 ;;
    --check) FILTER_CHECK="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ---- istioctl (downloaded on demand, pinned) --------------------------------
ISTIOCTL=""
ensure_istioctl() {
  [ -n "$ISTIOCTL" ] && return 0
  local dir="$SCRIPT_DIR/.tools/istio-$ISTIO_VERSION"
  local bin="$dir/bin/istioctl"
  if [ ! -x "$bin" ]; then
    local os arch asset
    os="$(uname -s)"; arch="$(uname -m)"
    case "$os" in
      Darwin) case "$arch" in arm64) asset="osx-arm64";; *) asset="osx";; esac ;;
      Linux)  case "$arch" in aarch64|arm64) asset="linux-arm64";; *) asset="linux-amd64";; esac ;;
      *) echo "unsupported OS for istioctl download: $os" >&2; return 1 ;;
    esac
    echo "  (downloading pinned istioctl $ISTIO_VERSION [$asset] ...)" >&2
    mkdir -p "$dir/bin"
    curl -sSL "https://github.com/istio/istio/releases/download/${ISTIO_VERSION}/istioctl-${ISTIO_VERSION}-${asset}.tar.gz" \
      | tar -xz -C "$dir/bin" || { echo "istioctl download failed" >&2; return 1; }
  fi
  ISTIOCTL="$bin"
}

# ---- helpers ----------------------------------------------------------------
# Does comma-list $1 share any element with comma-list $2?
tags_match() {
  local want="$1" have="$2" w h
  local IFS=,
  for w in $want; do
    w="$(echo "$w" | tr -d ' ')"
    for h in $have; do
      h="$(echo "$h" | tr -d ' ')"
      [ "$w" = "$h" ] && return 0
    done
  done
  return 1
}

RESULTS="$(mktemp)"
CHECKS_B64="$(mktemp)"
trap 'rm -f "$RESULTS" "$CHECKS_B64"' EXIT
FAILED=0; RAN=0

# Parse the manifest once into base64-encoded JSON lines (one per check).
python3 - "$MANIFEST" > "$CHECKS_B64" <<'PY'
import sys, yaml, json, base64
doc = yaml.safe_load(open(sys.argv[1])) or {}
for c in (doc.get("checks") or []):
    print(base64.b64encode(json.dumps(c).encode()).decode())
PY

emit_result() { # name classname severity result evidence
  python3 - "$RESULTS" "$@" <<'PY'
import sys, json, base64
path, name, classname, severity, result, evidence = sys.argv[1:7]
rec = {"name": name, "classname": classname, "severity": severity,
       "result": result, "evidence": evidence}
with open(path, "a") as f:
    f.write(base64.b64encode(json.dumps(rec).encode()).decode() + "\n")
PY
}

# ---- iterate checks ---------------------------------------------------------
echo "platform-checks  (namespace=$NAMESPACE)"
echo "-------------------------------------------------------------"

while IFS= read -r line; do
  [ -z "$line" ] && continue
  c="$(printf '%s' "$line" | base64 -d)"

  name=$(printf '%s' "$c" | jq -r '.name')
  tool=$(printf '%s' "$c" | jq -r '.tool')
  command=$(printf '%s' "$c" | jq -r '.command')
  severity=$(printf '%s' "$c" | jq -r '.severity')
  tags=$(printf '%s' "$c" | jq -r '.tags')
  atype=$(printf '%s' "$c" | jq -r '.assert.type')
  first_tag=$(printf '%s' "$tags" | cut -d, -f1 | tr -d ' ')

  # filters
  [ -n "$FILTER_CHECK" ] && [ "$FILTER_CHECK" != "$name" ] && continue
  [ -n "$FILTER_TOOL" ]  && [ "$FILTER_TOOL" != "$tool" ] && continue
  if [ -n "$FILTER_TAGS" ]; then tags_match "$FILTER_TAGS" "$tags" || continue; fi

  # resolve tool binary
  if [ "$tool" = "istioctl" ]; then
    ensure_istioctl || { emit_result "$name" "platform.$first_tag" "$severity" FAIL "istioctl unavailable"; FAILED=$((FAILED+1)); RAN=$((RAN+1)); printf '[FAIL] %-22s istioctl unavailable\n' "$name"; continue; }
    BIN="$ISTIOCTL"
  else
    BIN="$tool"
  fi

  # execute (stdout and stderr captured separately)
  err_file="$(mktemp)"
  stdout="$(cd "$SCRIPT_DIR" && bash -c "\"$BIN\" $command" 2>"$err_file")"
  code=$?
  stderr="$(cat "$err_file")"; rm -f "$err_file"
  combined="$stdout
$stderr"

  # evaluate assert -> status (PASS|VIOL) + evidence
  status="VIOL"; evidence=""
  case "$atype" in
    jq)
      expr=$(printf '%s' "$c" | jq -r '.assert.expr')
      if printf '%s' "$stdout" | jq -e "$expr" >/dev/null 2>&1; then
        status="PASS"; evidence="ok"
      else
        ev_expr=$(printf '%s' "$c" | jq -r '.assert.evidence // ""')
        if [ -n "$ev_expr" ]; then
          evidence="$(printf '%s' "$stdout" | jq -c "$ev_expr" 2>/dev/null | head -c 400)"
        fi
        [ -z "$evidence" ] && evidence="assertion false: $expr"
      fi
      ;;
    grep)
      pattern=$(printf '%s' "$c" | jq -r '.assert.pattern')
      mode=$(printf '%s' "$c" | jq -r '.assert.mode')
      if printf '%s' "$combined" | grep -Eq "$pattern"; then found=1; else found=0; fi
      if [ "$mode" = "absent" ]; then
        if [ "$found" -eq 0 ]; then status="PASS"; evidence="no match for /$pattern/";
        else evidence="$(printf '%s' "$combined" | grep -E "$pattern" | head -3 | tr '\n' ';')"; fi
      else
        if [ "$found" -eq 1 ]; then status="PASS"; evidence="$(printf '%s' "$combined" | grep -E "$pattern" | head -1)";
        else evidence="expected /$pattern/ not found"; fi
      fi
      ;;
    grep-all)
      patterns=$(printf '%s' "$c" | jq -r '.assert.patterns[]')
      missing=""; present=""
      for p in $patterns; do
        [ -z "$p" ] && continue
        if printf '%s' "$combined" | grep -Eq "$p"; then present="$present $p"; else missing="$missing $p"; fi
      done
      if [ -z "$missing" ]; then status="PASS"; evidence="found:$present"; else evidence="missing:$missing"; fi
      ;;
    exit-code)
      if [ "$code" -eq 0 ]; then status="PASS"; evidence="exit 0";
      else evidence="$(printf '%s' "$combined" | grep -v '^$' | tail -2 | tr '\n' ' ')"; fi
      ;;
    *)
      evidence="unknown assert type: $atype"
      ;;
  esac

  # map status + severity -> result
  if [ "$status" = "PASS" ]; then result="PASS";
  elif [ "$severity" = "fail" ]; then result="FAIL"; FAILED=$((FAILED+1));
  else result="WARN"; fi
  RAN=$((RAN+1))

  printf '[%-4s] %-22s %s\n' "$result" "$name" "$evidence"
  emit_result "$name" "platform.$first_tag" "$severity" "$result" "$evidence"

done < "$CHECKS_B64"

# ---- JUnit XML --------------------------------------------------------------
mkdir -p "$REPORT_DIR"
python3 - "$RESULTS" "$REPORT" "$NAMESPACE" <<'PY'
import sys, json, base64, datetime
results_path, report_path, namespace = sys.argv[1:4]
recs = []
try:
    with open(results_path) as f:
        for line in f:
            line = line.strip()
            if line:
                recs.append(json.loads(base64.b64decode(line).decode()))
except FileNotFoundError:
    pass

def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))

tests = len(recs)
failures = sum(1 for r in recs if r["result"] == "FAIL")
ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

lines = ['<?xml version="1.0" encoding="UTF-8"?>']
lines.append(
    '<testsuite name="platform-checks" tests="%d" failures="%d" errors="0" '
    'skipped="0" timestamp="%s" hostname="%s">' % (tests, failures, ts, esc(namespace)))
for r in recs:
    tc = '  <testcase name="%s" classname="%s" time="0">' % (esc(r["name"]), esc(r["classname"]))
    if r["result"] == "FAIL":
        lines.append(tc)
        lines.append('    <failure message="%s">%s</failure>' % (esc(r["evidence"]), esc(r["evidence"])))
        lines.append('  </testcase>')
    elif r["result"] == "WARN":
        lines.append(tc)
        lines.append('    <system-out>WARN [severity=%s]: %s</system-out>' % (esc(r["severity"]), esc(r["evidence"])))
        lines.append('  </testcase>')
    else:
        lines.append('  <testcase name="%s" classname="%s" time="0"><system-out>PASS: %s</system-out></testcase>'
                     % (esc(r["name"]), esc(r["classname"]), esc(r["evidence"])))
lines.append('</testsuite>')
open(report_path, "w").write("\n".join(lines) + "\n")
PY

WARNS=$(python3 -c 'import sys,json,base64; print(sum(1 for l in open(sys.argv[1]) if l.strip() and json.loads(base64.b64decode(l)).get("result")=="WARN"))' "$RESULTS" 2>/dev/null || echo 0)
echo "-------------------------------------------------------------"
echo "ran=$RAN  failures=$FAILED  warnings=$WARNS  report=$REPORT"

[ "$FAILED" -gt 0 ] && exit 1
exit 0
