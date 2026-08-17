#!/usr/bin/env bash
# Functional check: the 6 canonical consent scenarios against any cell.
#
#   bench/functional-check.sh <base-url> [extra curl args...]
#
# Works against both kinds of cell, auto-detected per response:
#   - synthetic cells (Worker/Viceroy default mode): body carries {"decision":...}
#   - proxy cells (nginx-wasm; forward mode): body is the origin echo — we
#     assert on which headers/cookies actually survived the filter
#
# Exit code = number of failed scenarios.

set -uo pipefail

BASE="${1:?usage: $0 <base-url> [extra curl args...]}"; shift || true

# Drop empty args defensively — an empty string reaching curl becomes a bogus
# extra URL and corrupts the -w status capture.
extra_args=()
for a in "$@"; do [[ -n "$a" ]] && extra_args+=("$a"); done
set -- "${extra_args[@]}"

FULL="euconsent-v2=CAAAAAAAAAAAAAAAAAAAAAAAAP_wAA=="
NONE="euconsent-v2=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
STORAGE="euconsent-v2=CAAAAAAAAAAAAAAAAAAAAAAAAIAAAA=="

fails=0

# run <name> <path> <cookie|-> <expected_status> <expectation>
# expectation: pass | strip | block
run() {
  local name="$1" path="$2" cookie="$3" want_status="$4" expect="$5"
  shift 5   # remaining args = extra curl flags only
  local hdr_args=(-H "x-user-id: u42")
  [[ "$cookie" != "-" ]] && hdr_args+=(--cookie "_ga=track123; $cookie")

  local tmp; tmp="$(mktemp)"
  local status
  status="$(curl -s -m 15 -o "$tmp" -w '%{http_code}' "${hdr_args[@]}" "$@" "$BASE$path")"
  local body; body="$(cat "$tmp")"; rm -f "$tmp"

  local ok=1 why=""
  if [[ "$status" != "$want_status" ]]; then
    ok=0; why="status $status != $want_status"
  elif [[ "$expect" == "block" ]]; then
    : # status was the whole assertion
  elif [[ "$body" == *'"decision"'* ]]; then
    # synthetic cell: assert the decision label
    local want_decision; want_decision="$([[ "$expect" == "pass" ]] && echo Pass || echo Strip)"
    [[ "$body" == *"\"decision\":\"$want_decision\""* ]] || { ok=0; why="decision != $want_decision"; }
  elif [[ "$body" == *'"origin":true'* ]]; then
    # proxy cell: assert what actually reached the origin
    if [[ "$expect" == "pass" ]]; then
      [[ "$body" == *'"x-user-id"'* && "$body" == *'_ga=track123'* ]] \
        || { ok=0; why="pass should preserve x-user-id and _ga"; }
    else
      # stripped = absent entirely, or scrubbed to an empty value (nginx cell:
      # host can only blank request headers in place, not remove them)
      [[ "$body" != *'"x-user-id"'* || "$body" == *'"x-user-id":""'* ]] \
        || { ok=0; why="x-user-id not stripped"; }
      [[ "$body" != *'_ga=track123'* ]] || { ok=0; why="_ga cookie not stripped"; }
      [[ "$cookie" == "-" || "$body" == *'euconsent-v2'* ]] \
        || { ok=0; why="euconsent-v2 must survive stripping"; }
    fi
  else
    ok=0; why="unrecognized body (neither synthetic decision nor origin echo)"
  fi

  if [[ $ok == 1 ]]; then
    printf 'PASS  %-42s (%s)\n' "$name" "$status"
  else
    printf 'FAIL  %-42s %s\n' "$name" "$why"
    fails=$((fails + 1))
  fi
}

echo "functional check → $BASE"
run "full consent / content page"   /article/news "$FULL"    200 pass  "$@"
run "no consent / content page"     /article/news "$NONE"    200 strip "$@"
run "no consent / ad endpoint"      /ads/request  "$NONE"    204 block "$@"
run "full consent / ad endpoint"    /ads/request  "$FULL"    200 pass  "$@"
run "storage-only / ad endpoint"    /ads/request  "$STORAGE" 204 block "$@"
run "no cookie / ad endpoint"       /ads/request  "-"        204 block "$@"

echo "---"
if [[ $fails == 0 ]]; then echo "all 6 scenarios passed"; else echo "$fails scenario(s) FAILED"; fi
exit "$fails"
