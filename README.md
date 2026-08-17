# TCF Consent Filter: Edge Benchmark

Measure the real cost of privacy consent filtering at the edge. Run the same IAB TCF v2 filter across local Nginx, Fastly, and Cloudflare Workers. Compare latency, tail spread, and reproducibility.

## What this is

A working implementation of TCF v2 consent parsing and routing logic, deployed identically to three platforms:

- **Local Nginx** (Kong's `ngx_wasm_module` + Wasmtime)
- **Fastly Compute** (native WASM runtime)
- **Cloudflare Workers** (V8 isolates)

Each platform runs the same six test scenarios:
- Full consent, no consent, storage-only consent
- Content page (pass/strip tracking) and ad endpoint (block or pass)

The benchmark captures:
- p50/p95/p99 latency per scenario
- Run-to-run reproducibility (how much does p50 move between identical runs)
- Within-run tail spread (p99 − p50, is a slow request rare or common)
- Local CPU/memory cost (Nginx only)

See [blog post](https://chahla.net/posts?pid=1786977825371/) for the full analysis and findings.

## Run the benchmarks

### Prerequisites

```bash
cargo install wasm-pack wasm-bindgen-cli
rustup target add wasm32-unknown-unknown wasm32-wasip1

# Mac/Linux package managers or https://k6.io/docs/getting-started/installation/
brew install k6                          # macOS
sudo apt install k6                      # Ubuntu
```

Requires: Rust 1.70+, podman, Docker Compose, Node 18+

### 1. Build the filter

```bash
cd implementations/rust
cargo build --release --target wasm32-unknown-unknown -p consent-filter-nginx
cargo build --release --target wasm32-wasip1 -p consent-filter-fastly
cd ../.. && wrangler deploy --project-name consent-filter-cloudflare
```

### 2. Run functional tests

```bash
cd reference
bash test_consent.sh         # 6 scenarios, all should pass
```

### 3. Benchmark local Nginx

```bash
cd local-nginx
bash build.sh                # Builds Kong ngx_wasm_module + Nginx from source (~5 min)
cd ../bench
bash orchestrate.sh nginx-wasm --mode synthetic --vus 10 --duration 20s
bash orchestrate.sh viceroy --mode synthetic --vus 10 --duration 20s
```

### 4. Benchmark Fastly and Cloudflare

```bash
# Fastly (requires account + CLI auth)
cd implementations/rust/consent-filter-fastly
fastly compute serve --addr 127.0.0.1:7676 &
cd ../../../bench
bash orchestrate.sh fastly-cdn --mode synthetic --vus 10 --duration 20s

# Cloudflare (requires account + wrangler auth)
wrangler deploy
bash orchestrate.sh cloudflare-edge --mode synthetic --vus 10 --duration 20s
```

### 5. Analyze results

```bash
python3 bench/analyze-jitter.py
```

Prints:
- Run inventory (how many clean runs, what failed and why)
- Run-to-run jitter (stdev of p50 across repeats)
- Within-run jitter (p99 − p50 distribution)
- Blocked request agreement (filter consistency across providers)

## Repository layout

```
implementations/rust/
├── consent-filter-core/          # TCF parser + routing (zero deps, shared)
├── consent-filter-nginx/         # proxy-wasm for Kong ngx_wasm_module
├── consent-filter-fastly/        # fastly crate, wasm32-wasip1
└── consent-filter-cloudflare/    # workers-rs, wasm32-unknown-unknown

local-nginx/
├── Dockerfile                    # Kong ngx_wasm_module + Nginx build
└── build.sh

bench/
├── k6/consent-scenarios.js       # Test scenarios (full/no/storage consent × content/ad)
├── orchestrate.sh                # Spin up platform, run k6, collect results
├── analyze-jitter.py             # Stats: run-to-run reproducibility, tail spread
└── results/                      # Timestamped output (gitignored)

reference/
├── test_consent.sh               # Functional tests (6 scenarios, curl-based)
└── consent-test-server.py        # Local functional reference (not for perf)
```

## Key findings

**Instantiation cost is fixed:** Viceroy (fresh instance per request) adds 4.27ms regardless of what the filter decides. Same cost across all six scenarios.

**Run-to-run stability:**
- Local cells: 5–11% coefficient of variation (nginx 5.9%, viceroy 8–11%)
- Edge cells: 28–45% variation (WAN dominates)

**Within-run tail spread:**
- Nginx: 20× p99/p50 on ad blocks (0.43ms median, 9.7ms p99)
- Cloudflare synthetic: 1.6× (flat because fixed WAN dominates median)
- Viceroy: 10–13× (per-request instantiation variance)

**Blocked request consistency:** Across three providers (Cloudflare synthetic, Cloudflare fwd-edge, Fastly), blocked ad requests agree to within 1.04ms in a single sweep. Run-to-run variation is 11–14ms per cell because each sweep samples a different network moment.



## Code quality

- Consent filter core: 21 unit tests + 10 integration tests, all passing
- Six functional scenarios verified on every platform before benchmarking
- Results are reproducible: run `analyze-jitter.py` on any `results/` directory



## Backlog items

- The same six assertions, the same consent string, decoded by Spring Boot, by Go, by Python, and by the Rust that set the floor here. 
- AWS / Azure / GCP vs Fastly a battle of managed providers. 

