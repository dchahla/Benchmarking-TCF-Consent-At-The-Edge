#!/usr/bin/env python3
"""Run inventory and jitter statistics over bench/results/.

Two different quantities get reported, because they rank the cells differently:

  run-to-run jitter   stdev of p50 across repeats of an identical run.
                      Reproducibility. Answers "if I run this again, how
                      much does the number move?"

  within-run jitter   p99 minus p50 inside a single run. Tail spread.
                      Answers "how bad is a slow request relative to a
                      typical one?"

Only fully clean runs count: every scenario present, non-zero p50, zero
errors. Run-to-run jitter additionally holds load fixed, because a VU sweep
mixed into a stability number produces a meaningless CV (the nginx-wasm rows
on 2026-08-13 are a 1->32 VU sweep, not repeats).

Usage:  python3 ~/repos/wasm/bench/analyze-jitter.py
"""

import glob
import json
import os
import statistics as st
from collections import Counter, defaultdict
from datetime import datetime

RESULTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
SCENARIOS = [
    "full_content",
    "none_content",
    "none_ad",
    "full_ad",
    "storage_ad",
    "nocookie_ad",
]
# The load every headline number in the writeup is quoted at.
CANONICAL_VUS = 10
CANONICAL_DURATION = "20s"


def load_runs():
    runs = []
    for path in sorted(glob.glob(os.path.join(RESULTS, "*T*Z"))):
        summary = os.path.join(path, "k6-summary.json")
        if not os.path.exists(summary):
            runs.append({"dir": os.path.basename(path), "sc": {}, "meta": {}})
            continue
        k6 = json.load(open(summary))
        meta_path = os.path.join(path, "meta.json")
        meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
        name = os.path.basename(path)
        runs.append(
            {
                "dir": name,
                "cell": meta.get("cell") or name.rsplit("-", 2)[0],
                "mode": k6.get("mode") or meta.get("mode"),
                "vus": meta.get("vus"),
                "duration": meta.get("duration_per_scenario"),
                "ts": datetime.strptime(name.split("-")[-1], "%Y%m%dT%H%M%SZ"),
                "sc": k6.get("scenarios", {}),
                "meta": meta,
            }
        )
    return runs


def defects(run):
    """Why a run is unusable, empty list if it is fine."""
    if not run["sc"]:
        return ["no k6-summary.json"]
    out = []
    for s in SCENARIOS:
        d = run["sc"].get(s)
        if not d or not d.get("p50_ms") or not d.get("count"):
            out.append(f"{s}: no data")
        elif d.get("error_rate"):
            out.append(f"{s}: {d['error_rate']:.0%} errors")
    return out


def requests_in(runs):
    return sum(sum(d.get("count") or 0 for d in r["sc"].values()) for r in runs)


def main():
    runs = load_runs()
    clean = [r for r in runs if not defects(r)]
    dirty = [r for r in runs if defects(r)]

    print("=" * 78)
    print("RUN INVENTORY")
    print("=" * 78)
    print(f"result directories        {len(runs)}")
    print(f"with a k6 summary         {sum(1 for r in runs if r['sc'])}")
    print(f"clean (complete, no err)  {len(clean)}")
    print(f"discarded                 {len(dirty)}")
    for r in dirty:
        print(f"    {r['dir']:52s} {'; '.join(defects(r))}")

    ts = [r["ts"] for r in clean]
    print()
    print(f"span            {min(ts).date()} to {max(ts).date()} ({(max(ts) - min(ts)).days} days)")
    print(f"active days     {len({t.date() for t in ts})}")
    print(f"requests        {requests_in(clean):,}")
    print(f"scenario execs  {sum(len(r['sc']) for r in clean)}")
    print()
    for (cell, mode), n in sorted(Counter((r["cell"], r["mode"]) for r in clean).items()):
        print(f"    {cell:26s} {mode:10s} {n}")

    # Load profile matters: repeats and sweeps look identical on disk.
    print()
    print("load profiles present among clean runs:")
    for (v, d), n in sorted(Counter((r["vus"], r["duration"]) for r in clean).items(),
                            key=lambda kv: -kv[1]):
        tag = "  <- canonical" if (v, d) == (CANONICAL_VUS, CANONICAL_DURATION) else ""
        print(f"    {str(v):>4s} VU x {str(d):<5s} {n:3d} runs{tag}")

    canon = [
        r
        for r in clean
        if r["vus"] == CANONICAL_VUS and r["duration"] == CANONICAL_DURATION
    ]
    print()
    print(f"canonical set   {len(canon)} runs, {requests_in(canon):,} requests")

    agg = defaultdict(list)
    for r in canon:
        for s in SCENARIOS:
            agg[(r["cell"], r["mode"], s)].append(r["sc"][s])

    print()
    print("=" * 78)
    print(f"RUN-TO-RUN JITTER  (stdev of p50 across repeats @ {CANONICAL_VUS} VU x {CANONICAL_DURATION})")
    print("=" * 78)
    print(f"{'cell':26s} {'mode':10s} {'scenario':13s} {'n':>2s} {'mean':>8s} {'sd':>7s} {'CV%':>6s}")
    per_cell = defaultdict(list)
    for key in sorted(agg):
        vals = [d["p50_ms"] for d in agg[key]]
        if len(vals) < 3:
            continue
        mean, sd = st.mean(vals), st.stdev(vals)
        per_cell[(key[0], key[1])].append(100 * sd / mean)
        print(
            f"{key[0]:26s} {key[1]:10s} {key[2]:13s} {len(vals):2d} "
            f"{mean:8.2f} {sd:7.2f} {100 * sd / mean:6.1f}"
        )

    print()
    print("mean run-to-run CV per cell (lower is more reproducible):")
    for key in sorted(per_cell, key=lambda k: st.mean(per_cell[k])):
        fc = agg[(key[0], key[1], "full_content")]
        v = [d["p50_ms"] for d in fc]
        print(
            f"    {key[0]:26s} {key[1]:10s} {st.mean(per_cell[key]):5.1f}%"
            f"   full_content {st.mean(v):7.2f}ms +/- {st.stdev(v):.2f}"
        )

    print()
    print("=" * 78)
    print("WITHIN-RUN JITTER  (tail spread, median across canonical runs)")
    print("=" * 78)
    print(f"{'cell':26s} {'mode':10s} {'scenario':13s} {'p50':>7s} {'p95':>8s} {'p99':>8s} {'p99-p50':>8s} {'ratio':>6s}")
    for key in sorted(agg):
        ds = agg[key]
        p50 = st.median(d["p50_ms"] for d in ds)
        p95 = st.median(d["p95_ms"] for d in ds)
        p99 = st.median(d["p99_ms"] for d in ds)
        print(
            f"{key[0]:26s} {key[1]:10s} {key[2]:13s} "
            f"{p50:7.2f} {p95:8.2f} {p99:8.2f} {p99 - p50:8.2f} {p99 / p50:5.1f}x"
        )

    # The writeup claims the blocked-204 column agrees across providers.
    print()
    print("=" * 78)
    print("BLOCKED-204 AGREEMENT, PER SWEEP")
    print("=" * 78)
    sweeps_path = os.path.join(RESULTS, "sweeps.jsonl")
    if os.path.exists(sweeps_path):
        for line in open(sweeps_path):
            sweep = json.loads(line)
            p50s = {}
            for d in sweep["runs"]:
                sfile = os.path.join(RESULTS, d, "k6-summary.json")
                mfile = os.path.join(RESULTS, d, "meta.json")
                if not os.path.exists(sfile):
                    continue
                k6 = json.load(open(sfile))
                meta = json.load(open(mfile)) if os.path.exists(mfile) else {}
                cell = meta.get("cell", d)
                if cell in ("nginx-wasm", "viceroy"):
                    continue  # local cells, no WAN, not comparable here
                sc = k6.get("scenarios", {}).get("nocookie_ad")
                if sc and sc.get("p50_ms") and not sc.get("error_rate"):
                    p50s[f"{cell}/{k6.get('mode')}"] = sc["p50_ms"]
            if len(p50s) < 2:
                continue
            vals = list(p50s.values())
            print(f"\n  sweep {sweep['name']}  ({len(vals)} edge cells)")
            for k, v in sorted(p50s.items()):
                print(f"      {k:40s} {v:7.2f}ms")
            print(f"      {'stdev':40s} {st.stdev(vals):7.2f}ms   mean {st.mean(vals):.2f}ms")


if __name__ == "__main__":
    main()
