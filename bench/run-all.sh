#!/usr/bin/env bash
# Run the full benchmark matrix back-to-back — one same-day, comparable sweep —
# then rebuild report/comparison.html. Fire-and-forget: preflights every
# external dependency up front (fails fast before any 2-minute run), keeps
# going if an individual cell fails, prints a pass/fail table at the end.
#
#   bench/run-all.sh [--label NAME] [--vus N] [--duration D]
#
# --label NAME   records this sweep under a friendly name in
#                bench/results/sweeps.jsonl (which exact run dirs belong to
#                it) so report/build-report.js can generate a standalone,
#                never-overwritten report for it later — see
#                report/sweeps/index.html. Omit to default the name to the
#                UTC start time (YYYYMMDDTHHMMSSZ, no spaces) — every sweep
#                is always recorded, just unnamed ones get a timestamp name.
# --vus/--duration are passed through to orchestrate.sh.
#
# Deps checked up front (start them first — COMMANDS.md §1/§4):
#   origin server :3131, viceroy :7676, tunnel (consent.gumball.pro)
# nginx-wasm is auto-started by orchestrate.sh itself.
#
# Cloudflare free tier: a default sweep is ~90k Worker requests against the
# 100k/day cap (fwd-edge forwards bill the origin Worker too). Run at most
# once per day at defaults, or halve it with --duration 10s.
#
# ~16 min total at defaults (7 runs × ~2m12s).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

LABEL=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[[ -n "$LABEL" ]] || LABEL="$(date -u +%Y%m%dT%H%M%SZ)"

RUNS=(
  "nginx-wasm"
  "viceroy"
  "viceroy --mode forward"
  "cloudflare-edge"
  "cloudflare-edge --mode forward"
  "cloudflare-edge-fwd-edge --mode forward"
  "fastly-cdn"
)

# ---- preflight all deps before burning any bench time ------------------------
missing=0
check() {
  local label="$1"; shift
  if eval "$*" >/dev/null 2>&1; then
    printf 'ok       %s\n' "$label"
  else
    printf 'MISSING  %s\n' "$label"; missing=1
  fi
}
check "origin :3131 (node origin/server.js — §1)" \
  "curl -sf -m 3 http://127.0.0.1:3131/preflight | grep -q '\"origin\":true'"
check "viceroy :7676 (fastly compute serve — §4)" \
  "curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:7676/ads/request | grep -qE '^(200|204)$'"
check "tunnel consent.gumball.pro (§1)" \
  "curl -s -m 8 https://consent.gumball.pro/preflight | grep -q '\"origin\":true'"
[[ $missing == 0 ]] || { echo "start the missing dep(s) above, then re-run" >&2; exit 1; }

# ---- run the matrix -----------------------------------------------------------
declare -A status
run_dirs=()
for run in "${RUNS[@]}"; do
  echo; echo "=== $run ==="
  # Cell + mode parsed from $run so we can predict orchestrate.sh's RUN_DIR
  # (cell-mode-STAMP) without scraping its stdout.
  cell="${run%% *}"
  mode=synthetic
  [[ "$run" == *"--mode forward"* ]] && mode=forward
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"

  # shellcheck disable=SC2086  # $run word-splits into cell + flags on purpose
  if "$ROOT/bench/orchestrate.sh" $run ${ARGS[@]+"${ARGS[@]}"}; then
    status[$run]=ok
    # orchestrate.sh picks its own STAMP internally (may differ by a second) —
    # find the actual dir it just created rather than trusting ours.
    found="$(ls -td "$ROOT/bench/results/$cell-$mode-"*/ 2>/dev/null | head -1)"
    [[ -n "$found" ]] && run_dirs+=("$(basename "$found")")
  else
    status[$run]=FAILED
  fi
done

echo; echo "=== recording sweep '$LABEL' ==="
node "$ROOT/bench/record-sweep.js" "$LABEL" "${run_dirs[@]}"

echo; echo "=== rebuilding report ==="
node "$ROOT/report/build-report.js" || echo "report build FAILED" >&2

echo; echo "=== sweep summary ==="
fail=0
for run in "${RUNS[@]}"; do
  printf '%-42s %s\n' "$run" "${status[$run]}"
  [[ "${status[$run]}" == ok ]] || fail=1
done
exit $fail
