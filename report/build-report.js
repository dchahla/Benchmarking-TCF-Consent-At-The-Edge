#!/usr/bin/env node
/**
 * Build the self-contained benchmark comparison report(s).
 *
 *   node report/build-report.js
 *
 * Always reads bench/results/* and (re)writes report/comparison.html from
 * the LATEST run per cell+mode — unchanged default behavior, safe to run
 * after every sweep.
 *
 * Additionally, if bench/results/sweeps.jsonl has named-sweep records (see
 * bench/run-all.sh --label), writes one standalone, frozen report per sweep
 * to report/sweeps/<slug>.html (exact run set that sweep captured — never
 * overwritten by later runs of the same cell) plus report/sweeps/index.html
 * listing them all by friendly name for later reference.
 *
 * No dependencies. Charts are inline SVG; palette is the validated dataviz
 * default (4 categorical slots, light+dark, checked with the palette
 * validator on 2026-07-11 — light WARN on aqua/yellow contrast is relieved by
 * text row-labels + the table view; dark CVD floor is relieved the same way).
 *
 * Fixed identity slots (never cycled; extend the map for new cells):
 *   nginx-wasm: blue · viceroy: teal · cloudflare-edge: yellow · cloudflare-edge-fwd-edge: amber · fastly-cdn: green
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'bench', 'results');
const OUT = path.join(__dirname, 'comparison.html');

// ---- palette (see report header comment) ------------------------------------
const SLOTS = {
  'nginx-wasm': { light: '#2a78d6', dark: '#3987e5' },
  'viceroy': { light: '#1baf7a', dark: '#199e70' },
  'cloudflare-edge': { light: '#eda100', dark: '#c98500' },
  'cloudflare-edge-fwd-edge': { light: '#f59e0b', dark: '#d97706' },
  'fastly-cdn': { light: '#008300', dark: '#008300' },
};
const FALLBACK = [
  { light: '#4a3aa7', dark: '#9085e9' },
  { light: '#e34948', dark: '#e66767' },
  { light: '#e87ba4', dark: '#d55181' },
  { light: '#eb6834', dark: '#d95926' },
];
let fallbackIdx = 0;
function slot(cell) {
  if (!SLOTS[cell]) SLOTS[cell] = FALLBACK[fallbackIdx++ % FALLBACK.length];
  return SLOTS[cell];
}

const SCENARIOS = [
  ['full_content', 'Full consent · content page (Pass, proxied)'],
  ['none_content', 'No consent · content page (Strip, proxied)'],
  ['none_ad', 'No consent · ad endpoint (Block 204 at edge)'],
  ['full_ad', 'Full consent · ad endpoint (Pass, proxied)'],
  ['storage_ad', 'Storage-only · ad endpoint (Block 204 at edge)'],
  ['nocookie_ad', 'No cookie · ad endpoint (Block 204 at edge)'],
];

// ---- load runs ---------------------------------------------------------------
function loadRuns() {
  if (!fs.existsSync(RESULTS)) return [];
  return fs
    .readdirSync(RESULTS)
    .filter((d) => fs.existsSync(path.join(RESULTS, d, 'k6-summary.json')))
    .map((d) => {
      const dir = path.join(RESULTS, d);
      const summary = JSON.parse(fs.readFileSync(path.join(dir, 'k6-summary.json')));
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'))); } catch {}
      const resources = loadJsonl(path.join(dir, 'resources.jsonl'));
      const originRes = loadJsonl(path.join(dir, 'origin-resources.jsonl'));
      return { id: d, cell: meta.cell || d.split('-')[0], mode: meta.mode || 'synthetic', summary, meta, resources, originRes };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function loadJsonl(p) {
  if (!fs.existsSync(p)) return null;
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Keep only the latest run per cell+mode (older ones stay on disk, not in report).
function latestRuns(runs) {
  const byKey = new Map();
  for (const r of runs) byKey.set(`${r.cell}|${r.mode}`, r); // sorted asc, last wins
  return [...byKey.values()];
}

// ---- svg helpers ---------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fmtMs = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

// ---- latency small-multiple (dot + whisker, log x) ------------------------------
function latencyChart(scenKey, runs, xmin, xmax) {
  const rows = runs.filter((r) => r.summary.scenarios[scenKey]);
  if (!rows.length) return '';
  const W = 860, LABELW = 190, RIGHT = 80, ROWH = 34, TOP = 8, BOT = 26;
  const H = TOP + rows.length * ROWH + BOT;
  const plotW = W - LABELW - RIGHT;
  const x = (v) => LABELW + ((Math.log10(v) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin))) * plotW;

  const ticks = [0.05, 0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000].filter((t) => t >= xmin && t <= xmax);
  let g = '';
  for (const t of ticks) {
    g += `<line x1="${x(t)}" y1="${TOP}" x2="${x(t)}" y2="${H - BOT}" class="grid"/>`;
    g += `<text x="${x(t)}" y="${H - BOT + 16}" class="tick" text-anchor="middle">${t < 1 ? t : t}ms</text>`;
  }

  let marks = '';
  rows.forEach((r, i) => {
    const s = r.summary.scenarios[scenKey];
    const cy = TOP + i * ROWH + ROWH / 2;
    const c = slot(r.cell);
    const filled = r.mode !== 'forward';
    const tip = `${r.cell} · ${r.mode} — p50 ${fmtMs(s.p50_ms)}ms · p95 ${fmtMs(s.p95_ms)}ms · p99 ${fmtMs(s.p99_ms)}ms · ${Math.round(s.rps)} rps · err ${(s.error_rate * 100).toFixed(2)}%`;
    marks += `<text x="${LABELW - 10}" y="${cy + 4}" class="rowlabel" text-anchor="end">${esc(r.cell)}${r.mode === 'forward' ? ' · fwd' : ''}</text>`;
    marks += `<g class="mark" data-tip="${esc(tip)}">`;
    marks += `<line x1="${x(s.p50_ms)}" y1="${cy}" x2="${x(s.p99_ms)}" y2="${cy}" stroke="var(--c-${cssName(r.cell)})" stroke-width="2" stroke-linecap="round"/>`;
    marks += `<line x1="${x(s.p95_ms)}" y1="${cy - 5}" x2="${x(s.p95_ms)}" y2="${cy + 5}" stroke="var(--c-${cssName(r.cell)})" stroke-width="2"/>`;
    marks += filled
      ? `<circle cx="${x(s.p50_ms)}" cy="${cy}" r="5" fill="var(--c-${cssName(r.cell)})" stroke="var(--surface)" stroke-width="2"/>`
      : `<circle cx="${x(s.p50_ms)}" cy="${cy}" r="5" fill="var(--surface)" stroke="var(--c-${cssName(r.cell)})" stroke-width="2"/>`;
    marks += `<rect x="${LABELW}" y="${cy - ROWH / 2}" width="${plotW + RIGHT - 6}" height="${ROWH}" fill="transparent"/>`;
    marks += `</g>`;
    marks += `<text x="${x(s.p50_ms)}" y="${cy - 9}" class="vlabel" text-anchor="middle">${fmtMs(s.p50_ms)}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(scenKey)} latency">
    <line x1="${LABELW}" y1="${H - BOT}" x2="${W - RIGHT + 40}" y2="${H - BOT}" class="axis"/>
    ${g}${marks}</svg>`;
}

const cssName = (cell) => cell.replace(/[^a-z0-9]/gi, '-');

// ---- cpu line chart -------------------------------------------------------------
function cpuChart(run) {
  const series = [];
  if (run.resources && run.resources.length > 3)
    series.push({ name: run.cell, pts: run.resources, cls: `c-${cssName(run.cell)}`, varname: `var(--c-${cssName(run.cell)})` });
  if (run.originRes && run.originRes.length > 3)
    series.push({ name: 'origin (node)', pts: run.originRes, cls: 'muted', varname: 'var(--muted)' });
  if (!series.length) return '';

  const W = 860, H = 150, L = 55, R = 20, T = 10, B = 22;
  const t0 = Math.min(...series.map((s) => s.pts[0].ts_ms));
  const t1 = Math.max(...series.map((s) => s.pts[s.pts.length - 1].ts_ms));
  const maxCpu = Math.max(10, ...series.flatMap((s) => s.pts.map((p) => p.cpu_pct || 0))) * 1.15;
  const x = (ts) => L + ((ts - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / maxCpu) * (H - T - B);

  let g = '';
  for (const yv of [0, Math.round(maxCpu / 2), Math.round(maxCpu)]) {
    g += `<line x1="${L}" y1="${y(yv)}" x2="${W - R}" y2="${y(yv)}" class="grid"/><text x="${L - 8}" y="${y(yv) + 4}" class="tick" text-anchor="end">${yv}%</text>`;
  }
  let lines = '';
  for (const s of series) {
    const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts_ms).toFixed(1)},${y(p.cpu_pct || 0).toFixed(1)}`).join('');
    lines += `<path d="${d}" fill="none" stroke="${s.varname}" stroke-width="2" stroke-linejoin="round"/>`;
  }
  const secs = ((t1 - t0) / 1000).toFixed(0);
  const stats = series
    .map((s) => {
      const cpus = s.pts.map((p) => p.cpu_pct || 0);
      const mems = s.pts.map((p) => p.mem_bytes || 0);
      return `${s.name}: avg ${(cpus.reduce((a, b) => a + b, 0) / cpus.length).toFixed(1)}% · peak ${Math.max(...cpus).toFixed(1)}% CPU · peak mem ${(Math.max(...mems) / 1048576).toFixed(1)}MB`;
    })
    .join('&nbsp;&nbsp;·&nbsp;&nbsp;');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="CPU over time">${g}${lines}
    <text x="${W - R}" y="${H - 6}" class="tick" text-anchor="end">${secs}s window</text></svg>
    <p class="stats">${stats}</p>`;
}

// ---- sequence diagrams -----------------------------------------------------------
// Generic renderer: actors across the top, hairline lifelines, labeled arrows.
// ret:true = dashed response arrow. Accent = the cell's categorical slot.
function seqSvg(actors, steps, accentVar) {
  const W = 860, X0 = 90, XN = W - 90;
  const colW = actors.length > 1 ? (XN - X0) / (actors.length - 1) : 0;
  const x = (i) => X0 + i * colW;
  const TOP = 34, STEP = 36, H = TOP + steps.length * STEP + 18;

  let g = `<defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--ink2)"/>
    </marker></defs>`;

  actors.forEach((a, i) => {
    g += `<text x="${x(i)}" y="14" text-anchor="middle" class="actor">${esc(a)}</text>`;
    g += `<line x1="${x(i)}" y1="22" x2="${x(i)}" y2="${H - 6}" class="lifeline"/>`;
  });

  steps.forEach((s, idx) => {
    const y = TOP + idx * STEP + 14;
    const x1 = x(s.f), x2 = x(s.t);
    const dash = s.ret ? ' stroke-dasharray="5 4"' : '';
    const stroke = s.accent ? accentVar : 'var(--ink2)';
    g += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${stroke}" stroke-width="1.5"${dash} marker-end="url(#arr)"/>`;
    g += `<text x="${(x1 + x2) / 2}" y="${y - 6}" text-anchor="middle" class="steplabel">${esc(s.label)}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
}

// ---- per-scenario sequence diagrams ----------------------------------------
// One diagram per benchmark scenario, specific about every stage: the consent
// choice, the exact cookie, the bits the parser reads, the purpose gates, and
// what survives. Runtime-agnostic — this pipeline is identical in every cell.
function scenarioSeqs() {
  const A = ['👤 user', '🖥 client (k6 / browser)', '🛡 consent filter (any cell)', 'origin / synthetic'];
  const seq = (steps) => seqSvg(A, steps, 'var(--ink2)');
  return {
    full_content: {
      why: 'Baseline correctness and cost: the filter does full base64url + bit-field parsing on every request and must still add ~nothing. This row is what “the filter is effectively free” means in numbers.',
      svg: seq([
        { f: 0, t: 1, label: 'consents to ALL 12 purposes → euconsent-v2 …P_wAA== (k6 pre-bakes the same cookie)' },
        { f: 1, t: 2, label: 'GET /article/news · cookie: euconsent-v2 + _ga · header x-user-id: u42' },
        { f: 2, t: 3, label: 'decode: version 2 ✓ · bits 152–163 all set → P1 storage ✓, P4 ads ✓ ⇒ PASS, untouched' },
        { f: 3, t: 1, label: '200 content — x-user-id and _ga survive (verified via origin echo)', ret: true },
      ]),
    },
    none_content: {
      why: 'The GDPR workhorse: refusing consent must NOT break the page — serve the content, remove the identifiers. This row verifies strip correctness and prices it against Pass.',
      svg: seq([
        { f: 0, t: 1, label: 'declines everything → euconsent-v2 …AAAAAA== (all purpose bits zero)' },
        { f: 1, t: 2, label: 'GET /article/news · cookie: _ga + euconsent-v2 · header x-user-id' },
        { f: 2, t: 3, label: 'decode ✓ → P1 storage ✗ ⇒ STRIP: x-user-id/x-advertising-id/… blanked · _ga/_fbp/… cut, euconsent-v2 kept' },
        { f: 3, t: 1, label: '200 content — page intact, tracking identifiers gone', ret: true },
      ]),
    },
    none_ad: {
      why: 'The enforcement teeth: an ad call without consent dies at the edge. Also the shortest possible path — no proxy hop — which is why these are the fastest rows in every filtered cell.',
      svg: seq([
        { f: 0, t: 1, label: 'declines everything → euconsent-v2 …AAAAAA==' },
        { f: 1, t: 2, label: 'GET /ads/request — path matches ad prefixes (/ads/, /pixel/, /rtb/, …)' },
        { f: 2, t: 1, label: 'decode ✓ → P1 ✗ + ad endpoint ⇒ BLOCK: 204 No Content — origin never contacted', ret: true },
      ]),
    },
    full_ad: {
      why: 'The revenue path: with genuine consent, ad requests must flow unhindered. Confirms the filter does not over-block — false positives here cost money, not privacy.',
      svg: seq([
        { f: 0, t: 1, label: 'consents to ALL 12 purposes → euconsent-v2 …P_wAA==' },
        { f: 1, t: 2, label: 'GET /ads/request (ad endpoint) · full identifiers attached' },
        { f: 2, t: 3, label: 'decode ✓ → P1 storage ✓ AND P4 personalised-ads ✓ ⇒ PASS with identifiers intact' },
        { f: 3, t: 1, label: '200 ad response', ret: true },
      ]),
    },
    storage_ad: {
      why: 'The subtle one: partial consent. Storage alone (a “necessary only” choice) must not enable ad targeting — this catches bit-indexing bugs, since P1 and P4 are different bits of the same 12-bit field.',
      svg: seq([
        { f: 0, t: 1, label: 'grants ONLY purpose 1 (storage) → euconsent-v2 …AIAAAA==' },
        { f: 1, t: 2, label: 'GET /ads/request' },
        { f: 2, t: 1, label: 'decode ✓ → P1 ✓ but P4 personalised-ads ✗ + ad endpoint ⇒ BLOCK 204', ret: true },
      ]),
    },
    nocookie_ad: {
      why: 'The default-deny guarantee: absence of consent is not consent. A brand-new or incognito visitor is protected before they have ever seen a banner.',
      svg: seq([
        { f: 0, t: 1, label: 'has never interacted with the consent form — no euconsent-v2 cookie exists' },
        { f: 1, t: 2, label: 'GET /ads/request · no consent cookie (only _ga + x-user-id)' },
        { f: 2, t: 1, label: 'no consent string ⇒ treated as no consent + ad endpoint ⇒ BLOCK 204', ret: true },
      ]),
    },
  };
}

const T = '🖥 k6 (this machine)';
let SEQCARDS = null;
function seqCards() {
  if (SEQCARDS) return SEQCARDS;
  SEQCARDS = [
    {
      cell: 'nginx-wasm',
      title: 'nginx-wasm — self-hosted proxy, persistent WASM instance',
      hoverNote: 'always proxies — no synthetic mode',
      syn: seqSvg(
        [T, 'nginx :3132', 'consent_filter.wasm (Wasmtime, lives per worker)', 'origin :3131'],
        [
          { f: 0, t: 1, label: 'GET /path · cookie: euconsent-v2' },
          { f: 1, t: 2, label: 'on_http_request_headers → parse TCF, decide()', accent: true },
          { f: 2, t: 0, label: 'Block ⇒ 204 short-circuit (origin never touched)', ret: true },
          { f: 1, t: 3, label: 'Pass/Strip ⇒ proxy upstream (tracking headers blanked, cookie cleaned)' },
          { f: 3, t: 0, label: '200 echo (proves what survived the filter)', ret: true },
        ],
        'var(--c-nginx-wasm)'
      ),
      why: `This is the classic self-hosted edge: the deployment shape of an Nginx/ATS
        shop running consent enforcement in-process. Zero network in the path, one
        long-lived WASM instance per worker — so its numbers are the <b>floor</b>: pure
        filter-execution cost that every other row is read against. It is also the only
        cell with kernel-level CPU/memory accounting (cgroup v2), so per-request cost
        and footprint claims come from here.`,
    },
    {
      cell: 'viceroy',
      title: 'viceroy — Fastly’s runtime model, fresh instance per request',
      hoverNote: 'both modes drawn below',
      syn: seqSvg(
        [T, 'Viceroy :7676', 'consent_filter.wasm (NEW instance per request)'],
        [
          { f: 0, t: 1, label: 'GET /path · cookie: euconsent-v2' },
          { f: 1, t: 2, label: 'instantiate module → decide()', accent: true },
          { f: 2, t: 0, label: 'synthetic JSON (Pass/Strip) or 204 (Block)', ret: true },
        ],
        'var(--c-viceroy)'
      ),
      fwdTitle: 'viceroy · fwd — fresh instance per request, then proxied to the localhost origin',
      fwd: seqSvg(
        [T, 'Viceroy :7676', 'consent_filter.wasm (NEW instance per request)', 'origin :3131'],
        [
          { f: 0, t: 1, label: 'GET /path · cookie: euconsent-v2 + x-bench-origin: 1' },
          { f: 1, t: 2, label: 'instantiate module → parse TCF, decide()', accent: true },
          { f: 2, t: 0, label: 'Block ⇒ 204 straight back (origin untouched)', ret: true },
          { f: 2, t: 3, label: 'Pass/Strip ⇒ send to origin backend (localhost — no tunnel involved)' },
          { f: 3, t: 0, label: '200 echo — shows exactly which headers/cookies survived', ret: true },
        ],
        'var(--c-viceroy)'
      ),
      why: `Same machine, same Wasmtime, same wasm bytes as nginx-wasm — but Fastly’s
        isolation model: a <b>fresh instance per request</b>. The gap between this row and
        nginx-wasm (~7× at p50) is therefore pure instance-lifecycle cost, cleanly isolated.
        It is also our Fastly WASM execution cell (the account has no Compute plan), running
        the identical wasm32-wasip1 package that would ship to Fastly’s edge.`,
    },
    {
      cell: 'cloudflare-edge',
      title: 'cloudflare-edge — the real production edge (V8 isolates)',
      hoverNote: 'both modes drawn below',
      syn: seqSvg(
        [T, 'Cloudflare PoP (V8 isolate)', 'workers-rs wasm filter'],
        [
          { f: 0, t: 1, label: 'GET workers.dev URL — real WAN, ~RTT to nearest PoP' },
          { f: 1, t: 2, label: 'fetch event → parse TCF, decide()', accent: true },
          { f: 2, t: 0, label: 'synthetic JSON or 204 — back across the WAN', ret: true },
        ],
        'var(--c-cloudflare-edge)'
      ),
      fwdTitle: 'cloudflare-edge · fwd — edge filter, then proxied back to your origin through the tunnel',
      fwd: seqSvg(
        [T, 'Cloudflare PoP (V8 isolate)', 'wasm filter', 'gumball tunnel', 'origin :3131 (this machine)'],
        [
          { f: 0, t: 1, label: 'GET workers.dev URL · cookie + x-bench-origin: 1 — WAN trip #1' },
          { f: 1, t: 2, label: 'fetch event → parse TCF, decide()', accent: true },
          { f: 2, t: 0, label: 'Block ⇒ 204 straight back (one WAN trip, origin untouched)', ret: true },
          { f: 2, t: 3, label: 'Pass/Strip ⇒ fetch consent.gumball.pro — WAN trip #2' },
          { f: 3, t: 4, label: 'tunnel delivers to the origin on this machine' },
          { f: 4, t: 0, label: '200 echo back through tunnel + PoP (double WAN total)', ret: true },
        ],
        'var(--c-cloudflare-edge)'
      ),
      why: `The only cell where the filter runs on a <b>real production edge network</b> —
        actual user-facing latency, cold isolates, V8 instead of Wasmtime. Synthetic mode
        measures what a global user would experience with edge-terminated consent decisions.
        Forward mode proves real proxy behavior end-to-end: the origin’s echo shows exactly
        which tracking headers/cookies the edge removed in flight — but its latency
        characterizes the double-WAN tunnel path, not the filter.`,
    },
    {
      cell: 'fastly-cdn',
      title: 'fastly-cdn — control group: the same path with no filter at all',
      hoverNote: 'no WASM — always full path',
      syn: seqSvg(
        [T, 'Fastly PoP (VCL Deliver)', 'gumball tunnel', 'origin :3131 (this machine)'],
        [
          { f: 0, t: 1, label: 'GET consent-cdn…fastly.net — real WAN' },
          { f: 1, t: 2, label: 'VCL passthrough — no WASM, nothing stripped', accent: true },
          { f: 2, t: 3, label: 'tunnel → local origin' },
          { f: 3, t: 0, label: '200 echo, headers untouched (every scenario)', ret: true },
        ],
        'var(--c-fastly-cdn)'
      ),
      why: `The <b>control</b>. Same WAN, same tunnel, same origin — zero consent logic.
        Subtract this row from a filtered edge row and what remains is the cost of the
        filter plus runtime, with the infrastructure cancelled out. It also answers the
        baseline question honestly: at these path lengths the WASM filter is invisible —
        the network is the cost. (Expected status is 200 everywhere; there is nothing to
        return a 204.)`,
    },
    {
      cell: 'cloudflare-edge-fwd-edge',
      title: 'cloudflare-edge-fwd-edge — filter + origin both on Cloudflare',
      hoverNote: 'forward mode only; origin at edge',
      fwdTitle: 'cloudflare-edge-fwd-edge — filter forwards to origin Worker on same edge',
      fwd: seqSvg(
        [T, 'Cloudflare PoP (V8 isolate — filter)', 'wasm filter', 'Cloudflare Edge (origin)'],
        [
          { f: 0, t: 1, label: 'GET filter worker URL · cookie + x-bench-origin: 1 — WAN trip #1' },
          { f: 1, t: 2, label: 'fetch event → parse TCF, decide()', accent: true },
          { f: 2, t: 0, label: 'Block ⇒ 204 straight back (one WAN trip, origin untouched)', ret: true },
          { f: 2, t: 3, label: 'Pass/Strip ⇒ fetch origin Worker (stays on Cloudflare edge, ~1ms local)' },
          { f: 3, t: 0, label: '200 echo back to client (no tunnel, one WAN trip total)', ret: true },
        ],
        'var(--c-cloudflare-edge-fwd-edge)'
      ),
      why: `Same filter as cloudflare-edge, but the origin lives on Cloudflare Workers instead
        of tunneling back home. <b>Isolates the origin-location cost</b>: compare this to
        cloudflare-edge·fwd (106ms) to quantify the ~70ms savings of keeping your origin at
        the edge instead of on a home server. Real deployment model when your data/service
        runs on Cloudflare KV, D1, or another Worker — eliminates the tunnel + cold fetch
        overhead entirely.`,
    },
  ];
  return SEQCARDS;
}

function seqSection() {
  return seqCards()
    .map(
      (c) => `
  <div class="seqcard">
    <h3>${c.title} <span class="hovernote">${c.hoverNote}</span></h3>
    ${c.fwd ? '<p class="modelabel">synthetic mode</p>' : ''}
    ${c.syn}
    ${c.fwd ? `<p class="modelabel">forward mode — ${esc(c.fwdTitle)}</p>${c.fwd}` : ''}
    <p class="why">${c.why}</p>
  </div>`
    )
    .join('\n');
}

// ---- assemble -------------------------------------------------------------------
// Renders one complete self-contained HTML report from a run set. Shared by
// the default (latest-per-cell) comparison.html and every named sweep report.
function renderReport(runs, { title, subtitle }) {
const allVals = runs.flatMap((r) => Object.values(r.summary.scenarios)).flatMap((s) => [s.p50_ms, s.p99_ms]);
const xmin = Math.max(0.02, Math.min(...allVals) * 0.7);
const xmax = Math.max(...allVals) * 1.4;

const cardByCell = Object.fromEntries(seqCards().map((c) => [c.cell, c]));

// One legend chip per RUN (cell + mode), each popping its own complete
// sequence diagram on hover — a forward-mode row is a first-class entry with
// the full path drawn from the first request, never "the other diagram plus
// a hop". Solid swatch = synthetic row, hollow ring = forward row (matches
// the p50 dot style in the charts).
const runKeys = runs.map((r) => ({ cell: r.cell, mode: r.mode }));
const legend = runKeys
  .map(({ cell, mode }, i) => {
    const card = cardByCell[cell];
    const isFwd = mode === 'forward';
    const label = `${cell}${isFwd ? ' · fwd' : ''}`;
    const swatch = isFwd
      ? `<span class="swatch hollow" style="border-color:var(--c-${cssName(cell)})"></span>`
      : `<span class="swatch" style="background:var(--c-${cssName(cell)})"></span>`;
    const svg = card ? (isFwd ? card.fwd : card.syn) : null;
    const title = card ? (isFwd ? card.fwdTitle : card.title) : null;
    const side = i >= runKeys.length - 2 ? ' pop-right' : '';
    const pop = svg
      ? `<span class="pop${side}"><span class="poptitle">${esc(title)}</span>${svg}</span>`
      : '';
    return `<span class="key${svg ? ' haspop' : ''}">${swatch}${esc(label)}${pop}</span>`;
  })
  .join('');

const SCENSEQ = scenarioSeqs();
const charts = SCENARIOS.map(([key, title]) => {
  const sq = SCENSEQ[key];
  const pop = sq
    ? `<span class="pop"><span class="poptitle">${esc(title)} — what this scenario tests</span>${sq.svg}<span class="popnote">${sq.why}</span></span>`
    : '';
  return `
  <h3 class="${sq ? 'haspop' : ''}">${esc(title)}${pop}</h3>
  ${latencyChart(key, runs, xmin, xmax) || '<p class="stats">no data yet</p>'}`;
}).join('\n');

const tableRows = runs
  .flatMap((r) =>
    SCENARIOS.filter(([k]) => r.summary.scenarios[k]).map(([k]) => {
      const s = r.summary.scenarios[k];
      return `<tr><td>${esc(r.cell)}</td><td>${esc(r.mode)}</td><td>${k}</td><td>${fmtMs(s.p50_ms)}</td><td>${fmtMs(s.p95_ms)}</td><td>${fmtMs(s.p99_ms)}</td><td>${Math.round(s.rps)}</td><td>${(s.error_rate * 100).toFixed(2)}%</td></tr>`;
    })
  )
  .join('\n');

const resourceSections = runs
  .filter((r) => r.resources || r.originRes)
  .map((r) => `<h3>${esc(r.cell)} · ${esc(r.mode)}</h3>${cpuChart(r)}`)
  .join('\n');

const runMeta = runs
  .map((r) => {
    const m = r.meta;
    return `<tr><td>${esc(r.cell)}</td><td>${esc(r.mode)}</td><td>${esc(m.timestamp_utc || '')}</td><td>${m.vus ?? ''} × ${esc(m.duration_per_scenario || '')}</td><td>${esc(m.git_sha || '')}</td><td>${esc((m.host && m.host.cpu) || '')}</td></tr>`;
  })
  .join('\n');

const colorVars = (mode) =>
  Object.entries(SLOTS)
    .map(([cell, c]) => `--c-${cssName(cell)}: ${c[mode]};`)
    .join(' ');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
:root {
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e;
  --muted: #898781; --grid: #e1e0d9; --axis: #c3c2b7;
  --border: rgba(11,11,11,0.10); ${colorVars('light')}
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink2: #c3c2b7;
    --muted: #898781; --grid: #2c2c2a; --axis: #383835;
    --border: rgba(255,255,255,0.10); ${colorVars('dark')}
  }
}
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--page);
  color: var(--ink); max-width: 980px; margin: 0 auto; padding: 20px; line-height: 1.6; }
h1 { font-size: 26px; } h2 { margin-top: 0; } h3 { color: var(--ink2); font-size: 14px; margin: 18px 0 4px; }
.section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 20px; margin: 20px 0; }
.subtitle { color: var(--ink2); margin-top: -8px; }
svg { width: 100%; height: auto; display: block; }
.grid { stroke: var(--grid); stroke-width: 1; } .axis { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.rowlabel { fill: var(--ink2); font-size: 12px; }
.vlabel { fill: var(--ink2); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.key { display: inline-flex; align-items: center; gap: 6px; margin-right: 18px; font-size: 13px; color: var(--ink2); }
.haspop { position: relative; cursor: help; }
.key.haspop, h3.haspop { border-bottom: 1px dotted var(--muted); display: inline-block; }
.pop { display: none; position: absolute; top: calc(100% + 8px); left: 0; width: 680px;
  max-width: 86vw; background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 12px 16px 14px; z-index: 30;
  box-shadow: 0 10px 28px rgba(0,0,0,0.22); }
.pop-right { left: auto; right: 0; }
.haspop:hover .pop { display: block; }
.poptitle { display: block; font-size: 13px; font-weight: 600; color: var(--ink); margin-bottom: 4px; }
.popnote { display: block; font-size: 12px; color: var(--ink2); margin-top: 4px; }
.swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.swatch.hollow { background: var(--surface); border: 2px solid var(--muted); border-radius: 50%; width: 9px; height: 9px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--grid); }
td:nth-child(n+4) { font-variant-numeric: tabular-nums; }
th { color: var(--ink2); font-weight: 600; }
.stats { color: var(--ink2); font-size: 12.5px; margin: 4px 0 0; }
.caveat { border-left: 4px solid var(--axis); padding: 2px 14px; color: var(--ink2); font-size: 14px; }
.actor { fill: var(--ink); font-size: 12px; font-weight: 600; }
.lifeline { stroke: var(--grid); stroke-width: 1; stroke-dasharray: 3 4; }
.steplabel { fill: var(--ink2); font-size: 11px; }
.seqcard { margin: 6px 0 22px; }
.seqcard h3 { font-size: 14.5px; color: var(--ink); margin-bottom: 2px; }
.hovernote { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 8px; }
.modelabel { color: var(--muted); font-size: 12px; margin: 10px 0 0; text-transform: uppercase; letter-spacing: 0.04em; }
.why { color: var(--ink2); font-size: 13.5px; margin: 6px 0 0; }
#tip { position: fixed; display: none; background: var(--ink); color: var(--page);
  font-size: 12px; padding: 6px 10px; border-radius: 6px; pointer-events: none;
  max-width: 460px; z-index: 10; }
</style>
</head>
<body>
<h1>🛡️ ${esc(title)}</h1>
<p class="subtitle">${subtitle}</p>

<div class="section caveat">
<p><b>Read the numbers honestly:</b> local cells (nginx-wasm, viceroy) have no network hop —
they measure runtime + filter execution. Edge cells traverse the real WAN, and
<b>forward</b>-mode edge runs additionally cross the tunnel to a home-uplink origin twice —
those numbers characterize the path, not the filter. fastly-cdn executes no WASM
(VCL passthrough baseline). Block-204 scenarios short-circuit at the filter and never
touch an origin, which is why they are the fastest rows in proxied cells.
Comparisons are fair <i>within</i> a cell across scenarios, and across local cells;
cross-environment comparisons need these caveats attached.</p>
<p><b>Path lengths per row:</b> nginx-wasm and viceroy are localhost (zero network);
viceroy·fwd adds one localhost hop to the origin; edge cells cross the real WAN
(~RTT to the nearest pop); edge·fwd crosses the WAN twice via the tunnel.
<b>nginx-wasm vs viceroy</b> is an instance-lifecycle story, not a runtime one —
both run Wasmtime, but ngx_wasm_module reuses one long-lived instance per worker
while Viceroy (matching Fastly's production isolation model, minus its optimized
instantiation) creates a fresh instance per request.</p>
<p><b>Reading cloudflare vs fastly honestly:</b> cloudflare-edge (synthetic) and
fastly-cdn are different tests — the first turns around at the PoP after one WAN
round trip; the second traverses the full PoP → tunnel → origin path with zero
filtering work. That fastly-cdn costs only ~3–4ms more than Cloudflare's
PoP-only turnaround speaks to tunnel proximity and warm backend connections, not
platform speed. The <i>fair</i> pairing is <b>cloudflare-edge·fwd vs fastly-cdn</b>
(same path shape, same tunnel, same origin): Fastly's ~33ms vs the Worker's
~106ms puts the delta in the PoP→origin leg — a CDN pools and reuses backend
connections as core business, while a Worker's <code>fetch()</code> to an external
origin pays connection setup far more often. Backend connection reuse dominates
edge-platform choice for proxy workloads. Two caveats: run-to-run WAN jitter is
~±5ms (cloudflare's Block rows differ 29 vs 36ms across runs despite identical
paths), so single-digit cross-platform deltas are noise; and the comparison we'd
actually want — WASM at the edge on both platforms — is impossible on this
account plan, which is why fastly-cdn is a control row, not a competitor row.</p>
<p><b>Why AWS and Azure aren't here:</b> Fastly and Cloudflare run WASM natively at
the edge, enabling a fair apples-to-apples comparison of the same consent filter
across different runtimes. AWS Lambda@Edge is JavaScript/Python (no WASM). Azure
CDN edge functions are also JavaScript/Python. Including them would require
rewriting the filter in a different language <i>and</i> running on a different
compute model, conflating language choice and platform choice in a way that
obscures the actual comparison. This benchmark stays within the WASM ecosystem
where the filter logic remains constant across platforms, isolating the real
variable: runtime performance and network characteristics.</p>
</div>

<div class="section">
<h2>Latency by scenario</h2>
<p class="stats">dot = p50 (hollow = forward-mode row) · tick = p95 · whisker ends at p99 · log scale — hover a legend entry for its full request path, hover any row for numbers</p>
<p>${legend}</p>
${charts}
</div>

<div class="section">
<h2>What each cell measures</h2>
<p class="stats">every mode drawn in full — each diagram is the complete path from the first request</p>
${seqSection()}
</div>

<div class="section">
<h2>All numbers</h2>
<table>
<thead><tr><th>cell</th><th>mode</th><th>scenario</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>req/s</th><th>errors</th></tr></thead>
<tbody>
${tableRows}
</tbody>
</table>
</div>

${resourceSections ? `<div class="section">
<h2>Local resource usage (CPU% over the run)</h2>
<p class="stats">container cgroup v2 / proc sampling at ~4Hz during the k6 window; origin line shown when it participated</p>
${resourceSections}
</div>` : ''}

<div class="section">
<h2>Run details</h2>
<table>
<thead><tr><th>cell</th><th>mode</th><th>timestamp</th><th>load</th><th>git</th><th>host cpu</th></tr></thead>
<tbody>
${runMeta}
</tbody>
</table>
</div>

<div id="tip"></div>
<script>
const tip = document.getElementById('tip');
document.querySelectorAll('.mark').forEach(m => {
  m.addEventListener('mousemove', e => {
    tip.textContent = m.dataset.tip;
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });
  m.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
});
</script>
</body>
</html>
`;

return html;
}

// ---- default report (latest run per cell+mode) — unchanged behavior --------------
const allRuns = loadRuns();
const latest = latestRuns(allRuns);
if (!latest.length) {
  console.error('no results in bench/results/ — run bench/orchestrate.sh first');
  process.exit(1);
}

fs.writeFileSync(
  OUT,
  renderReport(latest, {
    title: 'Consent Filter — Edge Benchmark Comparison',
    subtitle: `Same IAB TCF v2 consent logic (Rust → WASM) measured across runtimes. Generated ${new Date().toISOString().slice(0, 16)}Z from bench/results/.`,
  })
);
console.log(`wrote ${OUT} (${latest.length} runs: ${latest.map((r) => `${r.cell}/${r.mode}`).join(', ')})`);

// ---- named sweeps (bench/run-all.sh --label) — frozen, browsable by name ---------
const SWEEPS_JSONL = path.join(RESULTS, 'sweeps.jsonl');
const SWEEPS_OUT_DIR = path.join(__dirname, 'sweeps');

function loadSweepRecords() {
  if (!fs.existsSync(SWEEPS_JSONL)) return [];
  return fs
    .readFileSync(SWEEPS_JSONL, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const sweepRecords = loadSweepRecords();
if (sweepRecords.length) {
  fs.mkdirSync(SWEEPS_OUT_DIR, { recursive: true });

  // Append-only log — last record per slug wins (e.g. a re-labeled re-run).
  const bySlug = new Map();
  for (const rec of sweepRecords) bySlug.set(rec.slug, rec);

  const runsById = new Map(allRuns.map((r) => [r.id, r]));
  const sweepIndex = [];

  for (const rec of bySlug.values()) {
    const runs = rec.runs.map((id) => runsById.get(id)).filter(Boolean);
    if (!runs.length) {
      console.error(`sweep "${rec.name}" (${rec.slug}): no matching run dirs found, skipping`);
      continue;
    }
    const dateStr = rec.timestamp_utc.slice(0, 16).replace('T', ' ') + 'Z';
    const outFile = path.join(SWEEPS_OUT_DIR, `${rec.slug}.html`);
    fs.writeFileSync(
      outFile,
      renderReport(runs, {
        title: `Consent Filter — ${rec.name}`,
        subtitle: `Named sweep "${esc(rec.name)}" · captured ${dateStr} · git ${esc(rec.git_sha)} · ${runs.length} run(s). Frozen — later benchmark runs do not change this page.`,
      })
    );
    sweepIndex.push({ ...rec, runs, outFile });
    console.log(`wrote ${outFile} (sweep "${rec.name}": ${runs.map((r) => `${r.cell}/${r.mode}`).join(', ')})`);
  }

  sweepIndex.sort((a, b) => b.timestamp_utc.localeCompare(a.timestamp_utc));
  const indexRows = sweepIndex
    .map((s) => {
      const cells = s.runs.map((r) => `${r.cell}${r.mode === 'forward' ? '·fwd' : ''}`).join(', ');
      const dateStr = s.timestamp_utc.slice(0, 16).replace('T', ' ') + 'Z';
      return `<tr><td><a href="${esc(s.slug)}.html">${esc(s.name)}</a></td><td>${esc(dateStr)}</td><td>${esc(cells)}</td><td>${esc(s.git_sha)}</td></tr>`;
    })
    .join('\n');

  fs.writeFileSync(
    path.join(SWEEPS_OUT_DIR, 'index.html'),
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Consent Filter — Named Sweeps</title>
<style>
:root { --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e; --grid: #e1e0d9; --border: rgba(11,11,11,0.10); }
@media (prefers-color-scheme: dark) {
  :root { --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink2: #c3c2b7; --grid: #2c2c2a; --border: rgba(255,255,255,0.10); }
}
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--page);
  color: var(--ink); max-width: 820px; margin: 0 auto; padding: 20px; line-height: 1.6; }
table { border-collapse: collapse; width: 100%; font-size: 14px; margin-top: 14px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--grid); }
th { color: var(--ink2); font-weight: 600; }
a { color: var(--ink); }
.subtitle { color: var(--ink2); margin-top: -8px; }
</style>
</head>
<body>
<h1>Named Sweeps</h1>
<p class="subtitle">Each row is a same-day, same-label run of <code>bench/run-all.sh --label</code> — frozen at capture time, unaffected by later benchmark runs. See <a href="../comparison.html">comparison.html</a> for the always-latest view.</p>
<table>
<thead><tr><th>name</th><th>captured</th><th>cells</th><th>git</th></tr></thead>
<tbody>
${indexRows}
</tbody>
</table>
</body>
</html>
`
  );
  console.log(`wrote ${path.join(SWEEPS_OUT_DIR, 'index.html')} (${sweepIndex.length} sweep(s))`);
}
