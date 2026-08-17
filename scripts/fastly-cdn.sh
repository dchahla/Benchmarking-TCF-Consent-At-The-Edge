#!/usr/bin/env bash
# Scripted lifecycle for the Fastly free CDN cell (consent-cdn).
#
#   scripts/fastly-cdn.sh up       create service+backend+domain, activate, save state
#   scripts/fastly-cdn.sh down     delete the service (reads state file), remove state
#   scripts/fastly-cdn.sh status   show saved state + live smoke test
#
# State (service id etc.) is saved to scripts/state/fastly-cdn.json so later
# commands are never blind to the service id.
set -euo pipefail

NAME="consent-cdn"
DOMAIN="consent-cdn-dchahla.global.ssl.fastly.net"
BACKEND_ADDR="consent.gumball.pro"
STATE_DIR="$(cd "$(dirname "$0")" && pwd)/state"
STATE_FILE="$STATE_DIR/fastly-cdn.json"

service_id_by_name() {
  fastly service search --name "$NAME" --json 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('ID',''))" 2>/dev/null || true
}

service_id() {
  if [[ -f "$STATE_FILE" ]]; then
    python3 -c "import json; print(json.load(open('$STATE_FILE'))['service_id'])"
  else
    service_id_by_name
  fi
}

save_state() {
  mkdir -p "$STATE_DIR"
  cat > "$STATE_FILE" <<EOF
{
  "service_id": "$1",
  "service_name": "$NAME",
  "domain": "$DOMAIN",
  "url": "https://$DOMAIN",
  "backend": "$BACKEND_ADDR:443",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  echo "state saved: $STATE_FILE"
}

case "${1:-}" in
  up)
    existing="$(service_id_by_name)"
    if [[ -n "$existing" ]]; then
      echo "service '$NAME' already exists: $existing"
      save_state "$existing"
      exit 0
    fi
    fastly service create --name "$NAME" --type vcl
    id="$(service_id_by_name)"
    [[ -n "$id" ]] || { echo "ERROR: could not resolve service id after create" >&2; exit 1; }
    # Domain goes in BEFORE first activation — one editable version 1, one activate.
    fastly backend create -s "$id" --version latest --name origin \
      --address "$BACKEND_ADDR" --port 443 --use-ssl \
      --ssl-sni-hostname "$BACKEND_ADDR" --override-host "$BACKEND_ADDR"
    fastly service domain create -s "$id" --version latest --name "$DOMAIN"
    fastly service version activate -s "$id" --version latest
    save_state "$id"
    echo "live: https://$DOMAIN"
    ;;

  down)
    id="$(service_id)"
    [[ -n "$id" ]] || { echo "no service found (no state file, no '$NAME' on account)"; exit 0; }
    fastly service delete -s "$id" --force
    rm -f "$STATE_FILE"
    echo "deleted service $id, state removed"
    ;;

  status)
    if [[ -f "$STATE_FILE" ]]; then cat "$STATE_FILE"; else echo "(no state file)"; fi
    id="$(service_id)"
    [[ -n "$id" ]] && fastly service describe -s "$id" 2>/dev/null | sed -n '1,8p'
    echo "--- smoke test:"
    curl -s -m 10 "https://$DOMAIN/tunnel-check" | head -c 200; echo
    ;;

  *)
    echo "usage: $0 {up|down|status}" >&2
    exit 1
    ;;
esac
