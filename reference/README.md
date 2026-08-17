# Reference implementation (functional check only)

`consent-test-server.py` is a plain-Python mirror of the consent-filter routing
logic, served over HTTP on port 8080 (`podman-compose up -d consent-test-server`
from the repo root). `test_consent.sh` runs 6 curl scenarios against it
(full / no / storage-only consent × content-page / ad-endpoint).

**Role:** quick functional-logic reference and the starting point for the
Phase 3 Python ports (Fastly `componentize-py`, Cloudflare Python Workers).

**Not a performance baseline.** It executes no WASM and runs no Nginx — for
latency/resource measurement use the real `local-nginx-wasm` service (Kong
`ngx_wasm_module` loading `consent_filter.wasm`) and the `bench/` harness.
