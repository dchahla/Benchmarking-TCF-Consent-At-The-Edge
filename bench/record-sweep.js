#!/usr/bin/env node
// Append one named-sweep record to bench/results/sweeps.jsonl.
//
//   node bench/record-sweep.js <name> <run-dir-id>...
//
// Each line is one sweep: {name, slug, timestamp_utc, git_sha, runs: [ids]}.
// Append-only — re-running the same --label again just adds another record
// (e.g. a re-run after fixing a failed cell), so build-report.js always
// treats the *last* record for a given slug as authoritative.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const [, , name, ...runs] = process.argv;
if (!name || runs.length === 0) {
  console.error('usage: record-sweep.js <name> <run-dir-id>...');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'bench', 'results', 'sweeps.jsonl');

const slug = name
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

let gitSha = 'unknown';
try { gitSha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch {}

const record = {
  name,
  slug,
  timestamp_utc: new Date().toISOString(),
  git_sha: gitSha,
  runs,
};

fs.appendFileSync(OUT, JSON.stringify(record) + '\n');
console.log(`recorded sweep "${name}" (${slug}): ${runs.length} run(s)`);
