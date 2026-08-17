/// Consent filter — Fastly Compute adapter.
///
/// Same decision pipeline as the Nginx/proxy-wasm plugin, mapped onto
/// Fastly's Request/Response model. Dual-mode:
///
///   - default: Pass/Strip return a synthetic JSON echo (no origin forward)
///     so benchmarks isolate filter-execution cost
///   - `x-bench-origin` header present: Pass/Strip forward to the `origin`
///     backend (the tunnel-exposed local echo server), exercising the real
///     proxy path end-to-end
///
/// Block always returns the bare status at the edge, exactly like the
/// proxy-wasm plugin.

use fastly::http::StatusCode;
use fastly::{mime, Error, Request, Response};

// Full copies of the platform-agnostic modules (from consent-filter-core),
// vendored per-platform so `diff -r` against the original shows exactly what
// each platform port changed.
// (dead_code allowed: the copies keep their full API surface for clean diffs,
// even parts this adapter doesn't call.)
#[allow(dead_code)]
mod http;
#[allow(dead_code)]
mod routing;
#[allow(dead_code)]
mod synthetic;
#[allow(dead_code)]
mod tcf;

use crate::http::{extract_cookie, is_ad_path};
use crate::routing::{decide, strip_cookies, RoutingDecision};
use crate::synthetic::response_json;
use crate::tcf::parse;

/// Backend name registered on the Fastly service (points at the tunnel origin).
const ORIGIN_BACKEND: &str = "origin";

#[fastly::main]
fn main(mut req: Request) -> Result<Response, Error> {
    let path = req.get_path().to_owned();
    let cookie_header = req.get_header_str("cookie").unwrap_or("").to_owned();
    let forward = req.remove_header("x-bench-origin").is_some();

    let consent_string = extract_cookie(&cookie_header, "euconsent-v2");
    let parsed = consent_string.as_deref().and_then(|s| parse(s).ok());
    let is_ad_endpoint = is_ad_path(&path);

    match decide(parsed.as_ref(), is_ad_endpoint) {
        RoutingDecision::Block { status } => Ok(Response::from_status(
            StatusCode::from_u16(status as u16).unwrap_or(StatusCode::NO_CONTENT),
        )),

        RoutingDecision::Pass if forward => Ok(req.send(ORIGIN_BACKEND)?),

        RoutingDecision::StripHeaders { headers, cookies } if forward => {
            for h in &headers {
                req.remove_header(*h);
            }
            let cleaned = strip_cookies(&cookie_header, &cookies);
            if cleaned.is_empty() {
                req.remove_header("cookie");
            } else if cleaned != cookie_header {
                req.set_header("cookie", cleaned);
            }
            Ok(req.send(ORIGIN_BACKEND)?)
        }

        d => {
            let body = response_json(&path, is_ad_endpoint, parsed.is_some(), &d);
            Ok(Response::from_status(StatusCode::OK)
                .with_content_type(mime::APPLICATION_JSON)
                .with_body(body))
        }
    }
}
