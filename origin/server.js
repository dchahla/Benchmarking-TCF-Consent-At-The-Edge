#!/usr/bin/env node
/**
 * Shared benchmark origin: echo server + consent-demo frontend host.
 *
 * Every platform's "forward" path lands here — local Nginx proxies directly
 * (localhost), Fastly CDN / Cloudflare reach it through the gumball tunnel
 * (https://consent.gumball.pro). Routes:
 *
 *   /  /consent          the consent-form demo page (browser WASM via tcf-decoder)
 *   /pkg/*               tcf-decoder wasm-bindgen package assets
 *   anything else        JSON echo of the request path + received headers, so
 *                        functional checks verify what was stripped upstream
 *
 * Static assets are preloaded into memory at startup so the echo path stays
 * fast and allocation-free under k6 load.
 *
 * Usage: node origin/server.js   (PORT env var, default 3131)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const port = parseInt(process.env.PORT || '3131', 10);
const repoRoot = path.resolve(__dirname, '..');

function preload(relPath, contentType) {
  const body = fs.readFileSync(path.join(repoRoot, relPath));
  return {
    body,
    headers: {
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'public, max-age=300',
    },
  };
}

const statics = {
  '/': preload('frontend/consent-demo.html', 'text/html; charset=utf-8'),
  '/pkg/tcf_decoder.js': preload('tcf-decoder/pkg/tcf_decoder.js', 'application/javascript'),
  '/pkg/tcf_decoder_bg.wasm': preload('tcf-decoder/pkg/tcf_decoder_bg.wasm', 'application/wasm'),
};
statics['/consent'] = statics['/'];

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];

  const asset = statics[pathname];
  if (asset) {
    res.writeHead(200, asset.headers);
    res.end(asset.body);
    return;
  }

  const body = JSON.stringify({
    origin: true,
    method: req.method,
    path: req.url,
    headers: req.headers,
  });
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`bench origin listening on 0.0.0.0:${port}`);
  console.log(`  consent demo: http://localhost:${port}/consent`);
  console.log(`  echo:         http://localhost:${port}/<anything-else>`);
});
