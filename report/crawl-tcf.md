# The Runway For Ads: Benchmarking TCF Consent At The Edge

Purpose: by the end of this you will know what the IAB TCF framework actually is, why deciding it at the edge is a genuinely interesting performance problem, and how I set up a benchmark to measure it across four platforms.

This part is the lay of the land. No code to run yet, just the map and the control.

## Why you should care

You have had this conversation. A friend or a family member tells you something happened that they cannot explain. They searched for a mattress once, on their laptop, and the next morning there are mattress ads on their Facebook app. They never typed a word about mattresses into Facebook.

They assume the phone is listening.

The phone is not listening. What actually happened is duller and much more interesting:

1. Their consent state got read.
2. An identifier got attached to their request.
3. An ad exchange matched that identifier against one it already had.

The whole handoff took less time than the page took to paint.

## The runway for ads

That handoff is what the IAB Transparency and Consent Framework governs. TCF is the *runway* for ads. It decides, per request, whether the tracking identifiers are allowed to fly.

And it comes in flavors:

- **TCF v2** for GDPR in Europe
- **US privacy strings** for CCPA and the state variants that followed it
- **Global Privacy Platform**, trying to unify the first two
- Whatever a given Consent Management Platform layers on top

It comes with laws attached, which is the part that makes it unlike most performance work. The two ways to fail are not symmetric, and neither of them is survivable:

- **Strip too much.** You drop identifiers that were legitimately consented to, and the advertising revenue goes to zero that day.
- **Pass too much.** You forwarded tracking data for a user who declined, and now it is a regulatory fine rather than a bug report.

There is no forgiving middle. Most performance work lets you trade a little correctness for speed; here the trade is illegal in one direction and unpaid in the other.

## Why it is a good technical problem

Here is the shape of it, stripped of the legal weight.

Every single request that reaches the edge carries a cookie. Inside that cookie is a base64url-encoded packed bitfield. You have to decode it, read a 12-bit field out of the middle of it, decide from one bit whether this request may carry an identifier, then either forward it, strip it, or short-circuit the whole thing with a 204. You do this before the request reaches the origin, on every request, at whatever traffic your busiest day looks like.

So it is a parsing problem in the hot path of a proxy. It is about raw speed, and it is about doing the parse without allocating your way into a CPU spike that degrades throughput for everybody. That is a nice problem. It has a right answer and the answer is measurable.

The interesting wrinkle is where the code runs. The industry has moved from native proxy modules toward sandboxed WebAssembly, so the same filter logic can run inside Nginx, inside Fastly, inside a Cloudflare Worker. Which raises the question this whole benchmark exists to answer: what does the sandbox actually cost, and does it cost the same everywhere?

## What a consent string actually is

Before building anything, we agree on the input. A TCF v2 string looks like this:

```
CPXxRfAPXxRfAAfKABENB-CgAAAAAAAAAAYgAAAAAAAA
```

That is base64url with the padding stripped. Decode it and you get bytes, and the fields are packed at bit offsets, not byte offsets:

```
bits 0-5      Version          must be 2
bits 152-163  PurposesConsent  12 bits, one per IAB purpose
```

Purpose 1 is "Store and/or access information on a device." It is the baseline gate. If that bit is clear, no persistent tracking identifier should pass, no matter what else the string says. Purpose 3 is "Create a personalised ads profile" and purpose 4 is "Select personalised ads." Those are the ones the money rides on.

Two details in the spec will bite you, and they bit me:

Bits are read most-significant-first within each byte, which is not what a naive shift loop does. And inside the 12-bit purposes field, the wire format puts purpose 1 at the *most* significant position, so the field arrives reversed relative to how you want to index it.

```rust
let bit_idx = 7 - (bit_pos % 8); // MSB-first within each byte
```

```rust
// The TCF spec stores purpose 1 in the most-significant position of the
// 12-bit field, so we reverse the bit order so that bit 0 = purpose 1.
for i in 0..12u8 {
    let tcf_bit = (raw_purposes >> (11 - i)) & 1;
    purposes_consent |= (tcf_bit as u16) << i;
}
```

That is the entire domain. A base64 decode, a bounds check, two bit reads, and a reversal. Everything else in this project is infrastructure around those twenty lines.

## What we are going to test

The filter shall...

- Decode a TCF v2 string from the `euconsent-v2` cookie on every request.
- Let a fully consented request through untouched.
- Strip tracking identifiers when consent is absent, without breaking the page.
- Short-circuit ad requests with a 204 when consent is absent, before the origin hop.
- Produce the same six answers on every platform it runs on.
- Not require a rewrite to move from Nginx to a CDN.

Six scenarios, because six is what it takes to cover the decision matrix. Each one is a real assertion in `bench/functional-check.sh`, and every cell has to pass all six before it is allowed to be benchmarked:

```
full consent / content page   →  200, pass
no consent   / content page   →  200, strip
no consent   / ad endpoint    →  204, block
full consent / ad endpoint    →  200, pass
storage-only / ad endpoint    →  204, block
no cookie    / ad endpoint    →  204, block
```

The storage-only row is the one that matters most. Purpose 1 granted, purpose 4 denied. The user agreed to have a cookie stored and did not agree to personalised ads. A filter that treats consent as a boolean passes this request and earns a fine. It has to block.

## The control: nginx-local

Every measurement needs something to measure against, and here it is deliberately boring. The `nginx-local` cell is Nginx with Kong's `ngx_wasm_module` running the filter through Wasmtime, proxying to an echo origin on the same machine.

```nginx
worker_processes 1;
error_log /dev/stderr warn;

wasm {
    module consent_filter /wasm/consent_filter.wasm;
}

http {
    access_log off;

    upstream host_origin {
        server 127.0.0.1:3131;
        keepalive 32;
    }

    server {
        listen 3132 reuseport;

        location = /healthz {
            return 200 "ok\n";
        }

        location / {
            proxy_wasm consent_filter;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_pass http://host_origin;
        }
    }
}
```

Two choices in there are about measurement hygiene rather than performance. `worker_processes 1` so CPU attribution in the resource monitor is clean instead of smeared across workers. `access_log off` so disk writes do not contaminate the latency numbers. If you were running this for throughput you would set workers to `auto`, and you would get a different and less useful graph.

This control lands at 0.75ms p50 on the full-consent content path. Everything else in the benchmark gets read relative to that number.

Could it get faster than 1ms? Sure. There is a persistent-instance trick here that is worth a whole section later, and past that you are into kernel tuning and connection reuse.

But that is not where the bottleneck is. Shaving the parse would be optimising a millisecond when the wins are somewhere else entirely: cutting hops, short-circuiting the request with a 204 before it ever reaches the origin, and making sure the edge network actually peers well with where the user is. Those are worth tens of milliseconds each. The parse is worth a rounding error.

The filter is microseconds. The interesting variance lives somewhere else entirely, and finding out where is the point of the next part.

## Why Nginx, and what I actually want to run

I picked Nginx because it is approachable. Almost everyone reading this has configured it, or has inherited something that had it in front. Nobody has to take my word for what the control is doing; the config fits on one screen and you have probably written most of it before.

That is the whole reason. It is not the fastest possible host and it is not what I would reach for last.

Because what I actually want is the comparison table nobody has honestly filled in. The same six assertions, the same consent string, decoded by:

- Spring Boot, and Kotlin next to it, since the JVM's warm steady-state number and its cold number are two different stories
- Go, with a plain mux and no framework
- Python with FastAPI, where I expect the answer to be bad in an interesting and specific way
- Rust, which is what I choose and sets the floor

I am dying to see those other numbers. But none of them mean anything without a starting point I know like the back of my hand. A benchmark against a control you do not fully understand is not a benchmark, it is an anecdote with a chart.

## What is the industry average, and what counts as good?

Here is the honest problem with the number I just gave you. I have a control that answers in 0.75ms, and no idea whether that is remarkable or table stakes, because nobody publishes what consent actually costs in production.

So I started collecting captures. First one, jetbrains.com, cold load with no consent cookie:

```
GET     200  +23566.0ms  1197.61ms  cdn.cookiehub.eu/c2/0acea1b9.js
POST    200  +24785.0ms   896.40ms  region-eu.cookiehub.net
OPTIONS 204  +24786.0ms   740.91ms  region-eu.cookiehub.net
GET     200  +25712.0ms   349.12ms  resources.jetbrains.com/.../styles.css
GET     200  +25714.0ms   920.11ms  cdn.cookiehub.eu/client/0acea1b9/en.json
GET     200  +26068.0ms   545.74ms  cdn.cookiehub.eu/client/0acea1b9/en.json
```

Six requests, and the decision has not been made yet. Then I clicked accept:

```
POST    200  +11396.0ms   327.70ms  consent-eu.cookiehub.net     <- the accept
GET     204  +11524.0ms   713.60ms  analytics.google.com/g/collect
GET     204  +11526.0ms   750.40ms  stats.g.doubleclick.net/g/collect
GET     204  +11541.0ms   435.80ms  www.google.com/ccm/collect
GET     200  +11543.0ms   724.50ms  googleadservices.com/pagead/set_partitioned_cookie
GET     200  +11545.0ms  1019.20ms  ad.doubleclick.net/ccm/s/collect
POST    200  +11598.0ms   862.60ms  logx.optimizely.com/v1/events
```

Six tracking hosts, none of them contacted before the click, all of them firing within 149ms of it. That is the mattress story from the top of this post, captured in a HAR.

Then a different site, running Stripe. This one looks impressive:

```
GET  200  74.42ms   js.stripe.com/v3/fingerprinted/js/stripe-cookies-45f4853c...js
     blocked 3.3ms · send 0.2ms · wait 60.5ms · receive 10.5ms
     66,119 bytes · gzip · x-cache: Hit from cloudfront · age 865s
```

74ms, warm connection, CDN cache hit, near-best-case. But that is 74ms to *download the code that manages cookies*. The 66KB library has not executed yet and not a single value has been stored. My filter decodes a consent string and makes the decision in microseconds.

To be fair to Stripe, that file is fraud plumbing rather than a consent check, and I am comparing a download to a computation. That is exactly the problem. Nobody publishes the number I want, so every comparison I can make from the outside is shaped like this one.

So I kept going, and the useful comparison turned out to be four sites that all run the same CMP vendor, OneTrust. Same product, four different architectures:

```
bk.com     11 req   1351ms   0 preflight   static CDN assets only
volvo       2 req   1105ms   1 preflight   regional endpoint (privacyportal-de)
hershey    19 req            1 preflight   + explicit geolocation lookup
lindt       0 req   ~190ms   0 preflight   first-party sGTM on their own domain
```

Burger King never calls home; it ships cached JavaScript and decides locally. Volvo and Hershey both ask a third party, and Hershey asks it twice, once to fetch config and once to ask where you are. Lindt moved the whole thing to `sgtm.lindtusa.com`, first-party, no third-party DNS and no CORS negotiation, and it is roughly an order of magnitude faster than everyone else.

That is the finding, and it has nothing to do with milliseconds. The cost of consent is set by how many strangers you have to ask before you can answer.

I threw out more captures than I kept.

The Hershey session had a Google search in front of it and carried state into the next site, so a sixteen-request identity sync I had happily attributed to one brand could just as easily have belonged to the previous tab. Bad measurement, not a slow one. Out.

Lindt I nearly cut too. It is the fastest consent path I recorded, and no consent cookie appeared anywhere in the capture while forty-six tracking requests fired starting at +1535ms. Some of that speed is genuinely good architecture. Some of it is that on a US load there was nothing to withhold, which is the same asymmetry from the top of this post showing up in someone's production config.

One capture is not data. Every number above came off the same laptop, the same uplink, and the same IP inside about an hour, because I could not get five different networks in an afternoon and would not have had a stable identity across them if I had. The numbers swing hard even so: the same Google beacon on the same page cost 1607ms cold and 87ms warm. So I am not going to tell you what the industry average is yet. I am going to go collect more of these, and the answer to what counts as good is the thing the next part is for.

## The cloud detour I am deliberately not taking

The same logic applies to the managed platforms, and this is where I have to argue with my own instincts.

I worked at Amazon. Internal tooling against AWS services is like a breakout board instead of soldering to the pins of a chip. Of course I want to see this on CloudFront, on Azure, on GCP. That urge is not wrong, it is just early.

Here is what happens if I follow it now. CloudFront Functions cannot run Wasmtime at all; it is a restricted custom JavaScript environment, so the entire premise of running one compiled filter everywhere is gone before I start. That pushes me to Lambda@Edge, where AWS's own guidance puts cold start in the tens of milliseconds for a lightweight function.

Look at what that does to the experiment. My hunch is I do not get anywhere good without a real bill and a hundred decisions about warming, placement, and provisioned concurrency. Every one of those decisions is a place for me to be wrong, and none of them are about consent parsing.

That is the trap. Say I publish a Lambda@Edge number today: every surprising result has two explanations, the platform or my configuration of it, and I cannot tell you which one you are looking at. It would be hearsay with a p99 attached.

So the boring control comes first. Once I know exactly what 0.75ms is made of, a managed-platform number becomes a measurement instead of a guess.

## Where this goes

That is the crawl. We have the domain, the six assertions, a control that answers in 0.75ms, and one capture from the wild that says the browser-side version of this decision costs seconds.

Next I run the same Rust filter on Nginx, on Fastly's Viceroy, and on a Cloudflare Worker, and we find out what the sandbox actually costs.

