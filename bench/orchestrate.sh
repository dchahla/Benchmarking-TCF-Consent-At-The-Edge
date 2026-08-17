#!/usr/bin/env bash
# Benchmark orchestrator: preflight -> functional gate -> (monitor) -> k6 -> results.
#
#   bench/orchestrate.sh <cell> [--mode synthetic|forward] [--vus N] [--duration D]
#
# Cells:
#   nginx-wasm       local podman container :3132 (monitored via cgroup)
#   viceroy          local `fastly compute serve` :7676 (monitored via /proc)
#   cloudflare-edge  real edge (URL from scripts/state/cloudflare.json)
#   fastly-cdn       real edge (URL from scripts/state/fastly-cdn.json)
#
# Results land in bench/results/<cell>-<mode>-<UTC>/:
#   k6-summary.json, resources.jsonl (local cells), origin-resources.jsonl
#   (forward runs), meta.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CELL="${1:?usage: $0 <nginx-wasm|viceroy|cloudflare-edge|cloudflare-edge-fwd-edge|fastly-cdn> [--mode ..] [--vus N] [--duration D]}"
shift

MODE=synthetic VUS=10 DURATION=20s
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)     MODE="$2"; shift 2 ;;
    --vus)      VUS="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

state_url() { python3 -c "import json; print(json.load(open('$1'))['url'])"; }

MONITOR_TARGET=""   # container name, or pid:N — empty = no monitoring (cloud)
case "$CELL" in
  nginx-wasm)
    TARGET_URL="http://localhost:3132"
    MONITOR_TARGET="wasm_local-nginx-wasm_1"
    ;;
  viceroy)
    TARGET_URL="http://127.0.0.1:7676"
    vpid="$(pgrep -x viceroy | head -1 || true)"
    [[ -n "$vpid" ]] || { echo "viceroy not running — start: cd implementations/rust/consent-filter-fastly && fastly compute serve --addr 127.0.0.1:7676" >&2; exit 1; }
    MONITOR_TARGET="pid:$vpid"
    ;;
  cloudflare-edge) TARGET_URL="$(state_url "$ROOT/scripts/state/cloudflare.json")" ;;
  cloudflare-edge-fwd-edge) TARGET_URL="https://consent-filter-cloudflare-edge-origin.consent-filter-cloudflare.workers.dev" ;;
  fastly-cdn)      TARGET_URL="$(state_url "$ROOT/scripts/state/fastly-cdn.json")" ;;
  *) echo "unknown cell: $CELL" >&2; exit 1 ;;
esac

# ---- preflight ---------------------------------------------------------------
if [[ "$CELL" == nginx-wasm ]]; then
  if ! curl -sf -m 3 "$TARGET_URL/healthz" >/dev/null; then
    echo "starting local-nginx-wasm..."
    (cd "$ROOT" && podman-compose up -d local-nginx-wasm)
    sleep 2
    curl -sf -m 3 "$TARGET_URL/healthz" >/dev/null || { echo "nginx-wasm failed to come up" >&2; exit 1; }
  fi
else
  code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$TARGET_URL/ads/request")"
  [[ "$code" == 204 || "$code" == 200 ]] || { echo "preflight failed: $TARGET_URL -> $code" >&2; exit 1; }
fi

# cloudflare-edge-fwd-edge forwards to an edge-hosted origin Worker (service
# binding) — the local origin server and tunnel are not involved.
needs_origin=0
if [[ "$CELL" != cloudflare-edge-fwd-edge ]]; then
  [[ "$MODE" == forward || "$CELL" == nginx-wasm || "$CELL" == fastly-cdn ]] && needs_origin=1
fi
if [[ $needs_origin == 1 ]]; then
  curl -s -m 3 "http://127.0.0.1:3131/preflight" | grep -q '"origin":true' \
    || { echo "origin server not running on 3131 — start: node origin/server.js" >&2; exit 1; }
fi
if [[ "$MODE" == forward && ( "$CELL" == cloudflare-edge || "$CELL" == fastly-cdn ) || "$CELL" == fastly-cdn ]]; then
  curl -s -m 8 "https://consent.gumball.pro/preflight" | grep -q '"origin":true' \
    || { echo "tunnel not reachable (consent.gumball.pro) — start the gumball client (COMMANDS.md §1)" >&2; exit 1; }
fi

# ---- functional gate (never benchmark broken logic) --------------------------
# fastly-cdn is a passthrough baseline (no filter) — functional gate n/a.
if [[ "$CELL" != fastly-cdn ]]; then
  extra=()
  [[ "$MODE" == forward ]] && extra=(-H "x-bench-origin: 1")
  "$ROOT/bench/functional-check.sh" "$TARGET_URL" "${extra[@]}" \
    || { echo "functional check failed — aborting benchmark" >&2; exit 1; }
fi

# ---- run ----------------------------------------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$ROOT/bench/results/$CELL-$MODE-$STAMP"
mkdir -p "$RUN_DIR"

MPID="" OPID=""
cleanup() {
  [[ -n "$MPID" ]] && kill "$MPID" 2>/dev/null || true
  [[ -n "$OPID" ]] && kill "$OPID" 2>/dev/null || true
}
trap cleanup EXIT

if [[ -n "$MONITOR_TARGET" ]]; then
  "$ROOT/bench/monitor/resource-monitor.sh" "$MONITOR_TARGET" "$RUN_DIR/resources.jsonl" &
  MPID=$!
fi
if [[ $needs_origin == 1 ]]; then
  opid="$(pgrep -f 'node.*origin/server.js' | head -1 || true)"
  if [[ -n "$opid" ]]; then
    "$ROOT/bench/monitor/resource-monitor.sh" "pid:$opid" "$RUN_DIR/origin-resources.jsonl" &
    OPID=$!
  fi
fi

# fastly-cdn has no filter: every scenario legitimately returns 200 (baseline)
FILTERED=1
[[ "$CELL" == fastly-cdn ]] && FILTERED=0

TARGET_URL="$TARGET_URL" MODE="$MODE" VUS="$VUS" DURATION="$DURATION" \
  FILTERED="$FILTERED" SUMMARY_PATH="$RUN_DIR/k6-summary.json" \
  k6 run "$ROOT/bench/k6/consent-scenarios.js"

cleanup; trap - EXIT; MPID="" OPID=""

# ---- meta ---------------------------------------------------------------------
WASM_SIZE="$(stat -c%s "$ROOT/implementations/rust/target/wasm32-unknown-unknown/release/consent_filter.wasm" 2>/dev/null || echo null)"
cat > "$RUN_DIR/meta.json" <<EOF
{
  "cell": "$CELL",
  "mode": "$MODE",
  "language": "rust",
  "target_url": "$TARGET_URL",
  "vus": $VUS,
  "duration_per_scenario": "$DURATION",
  "timestamp_utc": "$STAMP",
  "git_sha": "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "k6_version": "$(k6 version | head -1)",
  "consent_filter_wasm_bytes": $WASM_SIZE,
  "host": {
    "kernel": "$(uname -r)",
    "cpu": "$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ //')",
    "nproc": $(nproc)
  }
}
EOF

echo
echo "results: $RUN_DIR"
ls -la "$RUN_DIR"
