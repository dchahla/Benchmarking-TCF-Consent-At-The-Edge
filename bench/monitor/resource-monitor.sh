#!/usr/bin/env bash
# Resource monitor for local benchmark cells. Language-agnostic: reads
# kernel accounting, no in-process instrumentation.
#
#   bench/monitor/resource-monitor.sh <container-name> <out.jsonl>   # podman container (cgroup v2)
#   bench/monitor/resource-monitor.sh pid:<PID>        <out.jsonl>   # host process (/proc)
#
# Emits one JSON line per sample (~4/s):
#   {"ts_ms":..., "cpu_usec":<cumulative>, "cpu_pct":<since last sample>, "mem_bytes":...}
#
# Verified 2026-07-11: rootless podman on this host delegates cgroup v2, so
# direct cpu.stat/memory.current reads work (no podman-stats subprocess noise).
# Stops on SIGTERM/SIGINT or when the target disappears.
set -uo pipefail

TARGET="${1:?usage: $0 <container-name|pid:N> <out.jsonl>}"
OUT="${2:?usage: $0 <container-name|pid:N> <out.jsonl>}"
INTERVAL="${INTERVAL:-0.25}"

CLK_TCK=$(getconf CLK_TCK)

if [[ "$TARGET" == pid:* ]]; then
  PID="${TARGET#pid:}"
  MODE=proc
  [[ -d "/proc/$PID" ]] || { echo "no such pid: $PID" >&2; exit 1; }
else
  MODE=cgroup
  PID="$(podman inspect --format '{{.State.Pid}}' "$TARGET")" \
    || { echo "cannot inspect container: $TARGET" >&2; exit 1; }
  CG="/sys/fs/cgroup$(cut -d: -f3 "/proc/$PID/cgroup")"
  [[ -r "$CG/cpu.stat" ]] || { echo "cgroup not readable: $CG" >&2; exit 1; }
fi

read_cpu_usec() {
  if [[ "$MODE" == cgroup ]]; then
    awk '/^usage_usec/ {print $2}' "$CG/cpu.stat"
  else
    # utime+stime in clock ticks -> usec
    awk -v tck="$CLK_TCK" '{printf "%.0f", ($14 + $15) * 1000000 / tck}' "/proc/$PID/stat"
  fi
}

read_mem_bytes() {
  if [[ "$MODE" == cgroup ]]; then
    cat "$CG/memory.current"
  else
    awk '/^VmRSS/ {print $2 * 1024}' "/proc/$PID/status"
  fi
}

running=1
trap 'running=0' TERM INT

prev_cpu="$(read_cpu_usec)" || exit 1
prev_ms=$(( $(date +%s%N) / 1000000 ))

while [[ $running == 1 ]]; do
  sleep "$INTERVAL"
  [[ -d "/proc/$PID" ]] || break
  cpu="$(read_cpu_usec)" || break
  mem="$(read_mem_bytes)" || break
  now_ms=$(( $(date +%s%N) / 1000000 ))
  wall_usec=$(( (now_ms - prev_ms) * 1000 ))
  pct=$(awk -v d=$((cpu - prev_cpu)) -v w=$wall_usec 'BEGIN {printf "%.1f", (w > 0 ? 100*d/w : 0)}')
  echo "{\"ts_ms\":$now_ms,\"cpu_usec\":$cpu,\"cpu_pct\":$pct,\"mem_bytes\":$mem}" >> "$OUT"
  prev_cpu=$cpu
  prev_ms=$now_ms
done
