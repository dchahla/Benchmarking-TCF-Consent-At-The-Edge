

The consent filter itself is effectively free. Full TCF v2 base64url decode + bit-field parse + routing decision, inside a real Nginx worker executing WASM: 0.23ms p50 for a block, 0.75ms p50 for a full proxied pass — and ~8,500 req/s from just 2 VUs on the block path. The logic is never the cost; the path is.

Instance lifecycle is a 7× latency lever — same runtime, same machine, same wasm bytes. nginx-wasm (one persistent Wasmtime instance per worker): 0.75ms p50. Viceroy (fresh instance per request, Fastly's isolation model): 5.4ms p50. Nothing else differed. Per-request instantiation cost was cleanly isolated, not inferred.

Blocking at the edge saves the entire origin trip — measured in one run, same WAN conditions. In cloudflare-edge forward mode: consent-denied ad calls die at the PoP in 29ms; consented traffic that must reach the origin pays 106ms and drops from 328 to 93 req/s. The ~70ms delta is the business case for edge consent enforcement.

Backend connection reuse dominates edge-platform choice for proxy workloads. Same tunnel, same origin: Fastly's CDN does the full PoP→origin→back path in ~33ms total (only ~4ms over a PoP-only turnaround), while the Worker's fetch() to the same origin costs ~106ms — connection pooling as core business vs per-fetch setup.

Block-in-forward-mode ≡ synthetic mode, physically. Cloudflare's blocked rows in forward runs (29.0–29.2ms) match its synthetic rows (29–31ms) within jitter — empirical proof the 204 short-circuit never touches the origin, exactly as the sequence diagram claims.

WAN jitter is ~±5ms between runs (identical Block paths measured 29 vs 36ms minutes apart) — so any single-digit cross-platform delta is noise, and the honest comparisons are within-run and within-cell.

The same ~150 lines of Rust ran unmodified on three different runtimes — Wasmtime-in-Nginx, Wasmtime-in-Viceroy, V8-on-Cloudflare's-production-edge — passing the identical 6-scenario functional gate on all of them, with in-flight header/cookie stripping verified by an origin echo, not assumed.

One host bug found and root-caused to C source: ngx_wasm_module's request-header removal only zeroes the entry's hash, which hides it from the filter while nginx's proxy module forwards it upstream anyway — silent privacy failure mode; in-place value blanking propagates correctly. Caught only because the functional gate asserts on what the origin actually received.

The through-line if you need one sentence: edge consent enforcement costs microseconds of compute; everything expensive is network topology and instance lifecycle — and we can now say where every millisecond lives.


Short answer: they're not the same test, so that gap isn't "Cloudflare beats Fastly" — and the one pair that is comparable tells a different story.

What each row actually measures:

cloudflare-edge (synthetic, ~29–31ms): k6 → Cloudflare PoP → wasm decides → straight back. One WAN round trip, terminates at the PoP, origin never involved.
fastly-cdn (~33ms): k6 → Fastly PoP → through your tunnel → origin on your laptop → all the way back. The full path, with zero filtering work.
So the honest reading is almost the opposite of the naive one: the entire Fastly-PoP → tunnel → laptop-origin → back extension costs only ~3–4ms more than Cloudflare's turn-around-at-the-PoP. That says the gumball tunnel server has good proximity/peering to Fastly's Chicago pop and warm keepalive connections — it doesn't say Cloudflare is faster than Fastly.

The fair pairing is cloudflare-edge·fwd vs fastly-cdn — same path shape (client → PoP → tunnel → your origin → back), differing only in filter presence and how each platform fetches from a backend. And there Fastly wins enormously: 33ms vs 106ms. Both cross the same tunnel to the same origin, so that ~70ms delta lives in the PoP→origin leg: Fastly's CDN pools and reuses backend connections as core business, while a Worker's fetch() to an external origin pays connection setup (TCP+TLS to the tunnel server) far more often. That's a genuinely interesting finding — backend connection reuse dominates edge-platform choice for proxy workloads — and a much better interview line than "CF was 2ms faster."

Two more fairness caveats worth having ready:

Run-to-run WAN variance is on the order of the gap you're asking about. Look at cloudflare's Block rows: 29.0ms synthetic vs 36.1ms forward — Block never touches the origin, so those should be identical; the 7ms spread is just jitter between two 20s runs done minutes apart. A 2–4ms CF-vs-Fastly delta is within that noise. If you want a defensible number, interleave repeated runs of both cells.
The comparison we'd actually want — WASM-at-edge on both platforms — is impossible on this plan. No Fastly Compute means fastly-cdn is a control row, not a competitor row. The report's caveat box says this, but it's worth saying crisply when presenting.

---


(the free-tier cap doesn't un-hit itself mid-day; if you'd crossed 100k requests, the re-run would have failed too, with the functional gate catching the 429s). Worth watching though: each cloudflare run at these rps burns ~30–40k requests of the daily 100k.

On the ~70ms delta — you've found the money chart. All three rows are the same run, same minute, same WAN conditions, so this is the cleanest comparison in the whole benchmark. The difference is where each request's journey ends:

storage_ad / nocookie_ad / none_ad (~29ms): the request crosses the WAN to the PoP, the WASM filter decodes the cookie, decide() says Block, and the Worker answers 204 right there. One WAN round trip — note it's within a millisecond of the synthetic cloudflare rows (29–31ms), which proves Block-in-forward-mode and synthetic mode are physically the same path.
full_ad / full_content (~106ms): decide() says Pass, so the Worker must now fetch() your origin: PoP → WAN leg #2 to the tunnel server → tunnel down your home uplink → origin → all the way back → then PoP → you. That extra ~77ms is the origin round trip as seen from the edge — second WAN leg, tunnel transport, and the Worker paying TLS/TCP setup to an external backend far more often than a CDN would (the same connection-reuse story as the fastly-cdn comparison: Fastly does that whole backend leg in ~4ms).
And that delta is the entire business case for edge consent enforcement, measured: denied traffic is cheap — it dies at the PoP without ever touching your origin; allowed traffic pays full fare. You can see it in throughput too: 328 rps on the blocked path vs 93 rps on the proxied path with identical load. At scale, every consent-denied ad call blocked at the edge is an origin request that never happened — no origin CPU, no egress, ~70ms less user-visible latency. That's the sentence to say in the interview when someone asks why this belongs at the edge instead of at the origin.