// k6 benchmark: the 6 canonical consent scenarios as SEPARATE named scenarios,
// run sequentially so Block-204 latency never blends into Pass latency.
//
//   TARGET_URL=http://localhost:3132 k6 run bench/k6/consent-scenarios.js
//
// Env:
//   TARGET_URL   required, base URL of the cell under test
//   MODE         synthetic (default) | forward  (forward adds x-bench-origin,
//                pushing Pass/Strip through tunnel -> origin on cloud cells;
//                local nginx always forwards regardless)
//   VUS          virtual users per scenario         (default 10)
//   DURATION     duration per scenario              (default 20s)
//   SUMMARY_PATH file for the JSON summary          (default bench-summary.json)

import http from 'k6/http';
import { check } from 'k6';

const TARGET = __ENV.TARGET_URL;
if (!TARGET) throw new Error('TARGET_URL is required');
const MODE = __ENV.MODE || 'synthetic';
// FILTERED=0: target has no consent filter (passthrough baseline like
// fastly-cdn) — every scenario reaches the origin and returns 200.
const FILTERED = (__ENV.FILTERED || '1') !== '0';
const VUS = parseInt(__ENV.VUS || '10', 10);
const DURATION = __ENV.DURATION || '20s';
const SUMMARY_PATH = __ENV.SUMMARY_PATH || 'bench-summary.json';

const FULL = 'euconsent-v2=CAAAAAAAAAAAAAAAAAAAAAAAAP_wAA==';
const NONE = 'euconsent-v2=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const STORAGE = 'euconsent-v2=CAAAAAAAAAAAAAAAAAAAAAAAAIAAAA==';

// name -> [path, cookie|null, expected status]
const CASES = {
  full_content:    ['/article/news', FULL, 200],
  none_content:    ['/article/news', NONE, 200],
  none_ad:         ['/ads/request', NONE, 204],
  full_ad:         ['/ads/request', FULL, 200],
  storage_ad:      ['/ads/request', STORAGE, 204],
  nocookie_ad:     ['/ads/request', null, 204],
};

function secs(d) {
  const m = String(d).match(/^(\d+)(s|m)?$/);
  if (!m) throw new Error(`DURATION must be like 20s or 2m, got ${d}`);
  return parseInt(m[1], 10) * (m[2] === 'm' ? 60 : 1);
}

const durationS = secs(DURATION);
const GAP = 2; // idle seconds between scenarios

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
  scenarios: Object.fromEntries(
    Object.keys(CASES).map((name, i) => [
      name,
      {
        executor: 'constant-vus',
        exec: 'hit',
        env: { CASE: name },
        vus: VUS,
        duration: DURATION,
        startTime: `${i * (durationS + GAP)}s`,
      },
    ])
  ),
  // Dummy thresholds force k6 to track per-scenario submetrics for the summary.
  thresholds: Object.fromEntries(
    Object.keys(CASES).flatMap((name) => [
      [`http_req_duration{scenario:${name}}`, ['p(99)<60000']],
      [`checks{scenario:${name}}`, ['rate>0']],
    ])
  ),
};

export function hit() {
  const [path, cookie, want] = CASES[__ENV.CASE];
  const headers = { 'x-user-id': 'u42' };
  if (cookie) headers['cookie'] = `_ga=track123; ${cookie}`;
  if (MODE === 'forward') headers['x-bench-origin'] = '1';

  const res = http.get(`${TARGET}${path}`, { headers });
  const expected = FILTERED ? want : 200;
  check(res, { 'expected status': (r) => r.status === expected });
}

export function handleSummary(data) {
  const scenarios = {};
  for (const name of Object.keys(CASES)) {
    const dur = data.metrics[`http_req_duration{scenario:${name}}`];
    const chk = data.metrics[`checks{scenario:${name}}`];
    if (!dur) continue;
    const v = dur.values;
    scenarios[name] = {
      count: chk ? chk.values.passes + chk.values.fails : null,
      rps: chk ? (chk.values.passes + chk.values.fails) / durationS : null,
      p50_ms: v['p(50)'] ?? v.med,
      p95_ms: v['p(95)'],
      p99_ms: v['p(99)'],
      avg_ms: v.avg,
      max_ms: v.max,
      error_rate: chk ? chk.values.fails / (chk.values.passes + chk.values.fails) : null,
    };
  }
  const summary = {
    target: TARGET,
    mode: MODE,
    vus: VUS,
    duration_per_scenario: DURATION,
    started_at: new Date(Date.now() - data.state.testRunDurationMs).toISOString(),
    k6_version: __ENV.K6_VERSION || null,
    scenarios,
  };
  return {
    [SUMMARY_PATH]: JSON.stringify(summary, null, 2),
    stdout: `\n${textSummary(summary)}\n`,
  };
}

function textSummary(s) {
  const rows = Object.entries(s.scenarios).map(
    ([n, v]) =>
      `  ${n.padEnd(14)} p50 ${fmt(v.p50_ms)}  p95 ${fmt(v.p95_ms)}  p99 ${fmt(v.p99_ms)}  ` +
      `rps ${v.rps?.toFixed(0)}  err ${(v.error_rate * 100).toFixed(2)}%`
  );
  return [`${s.target} (${s.mode}, ${s.vus} VUs × ${s.duration_per_scenario}/scenario)`, ...rows].join('\n');
}

function fmt(ms) {
  return ms == null ? 'n/a' : ms >= 100 ? `${ms.toFixed(0)}ms` : `${ms.toFixed(2)}ms`;
}
