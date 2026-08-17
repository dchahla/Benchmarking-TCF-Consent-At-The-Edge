/// Consent filter — Cloudflare Workers adapter (workers-rs).
///
/// Same decision pipeline as the Nginx/proxy-wasm plugin, mapped onto the
/// Workers Request/Response model. Dual-mode:
///
///   - default: Pass/Strip return a synthetic JSON echo (no origin fetch)
///     so benchmarks isolate filter-execution cost
///   - `x-bench-origin` header present: Pass/Strip fetch the edge-hosted
///     origin Worker via the ORIGIN service binding, exercising the real
///     proxy path end-to-end without leaving Cloudflare's edge
///
/// Block always returns the bare status at the edge.

use worker::*;

// Full copies of the platform-agnostic modules (from consent-filter-core),
// vendored per-platform so `diff -r` against the original shows exactly what
// each platform port changed.
pub mod http;
pub mod routing;
pub mod synthetic;
pub mod tcf;

use crate::http::{extract_cookie, is_ad_path};
use crate::routing::{decide, strip_cookies, RoutingDecision};
use crate::synthetic::response_json;
use crate::tcf::parse;

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = req.url()?;
    let path = url.path().to_owned();

    // Consent-demo assets, served from the Worker itself (baked in at build
    // time). Routed BEFORE the filter — the demo page must load regardless of
    // consent state; it's how users set their consent in the first place.
    match path.as_str() {
        "/consent" => {
            return static_response(
                include_str!("../../../../frontend/consent-demo.html").as_bytes(),
                "text/html; charset=utf-8",
            );
        }
        "/pkg/tcf_decoder.js" => {
            return static_response(
                include_str!("../../../../tcf-decoder/pkg/tcf_decoder.js").as_bytes(),
                "application/javascript",
            );
        }
        "/pkg/tcf_decoder_bg.wasm" => {
            return static_response(
                include_bytes!("../../../../tcf-decoder/pkg/tcf_decoder_bg.wasm"),
                "application/wasm",
            );
        }
        _ => {}
    }

    let query = url.query().map(str::to_owned);
    let cookie_header = req.headers().get("cookie")?.unwrap_or_default();
    let forward = req.headers().get("x-bench-origin")?.is_some();

    let consent_string = extract_cookie(&cookie_header, "euconsent-v2");
    let parsed = consent_string.as_deref().and_then(|s| parse(s).ok());
    let is_ad_endpoint = is_ad_path(&path);

    match decide(parsed.as_ref(), is_ad_endpoint) {
        RoutingDecision::Block { status } => {
            Ok(Response::empty()?.with_status(status as u16))
        }

        RoutingDecision::Pass if forward => {
            forward_to_origin(&req, &env, &path, query.as_deref(), &[], &cookie_header).await
        }

        RoutingDecision::StripHeaders { headers, cookies } if forward => {
            let cleaned = strip_cookies(&cookie_header, &cookies);
            forward_to_origin(&req, &env, &path, query.as_deref(), &headers, &cleaned).await
        }

        d => {
            let body = response_json(&path, is_ad_endpoint, parsed.is_some(), &d);
            let headers = Headers::new();
            headers.set("content-type", "application/json")?;
            Ok(Response::ok(body)?.with_headers(headers))
        }
    }
}

fn static_response(body: &[u8], content_type: &str) -> Result<Response> {
    let headers = Headers::new();
    headers.set("content-type", content_type)?;
    headers.set("cache-control", "public, max-age=300")?;
    Ok(Response::from_bytes(body.to_vec())?.with_headers(headers))
}

/// Re-issue the request against the origin Worker with tracking headers
/// removed and the Cookie header replaced by its cleaned form. Sent through
/// the ORIGIN service binding: a plain fetch() to a sibling workers.dev host
/// is a same-zone subrequest, which bypasses Workers routes and gets the
/// workers.dev placeholder 404 instead of the target Worker.
async fn forward_to_origin(
    req: &Request,
    env: &Env,
    path: &str,
    query: Option<&str>,
    strip_headers: &[&str],
    cleaned_cookie: &str,
) -> Result<Response> {
    let origin = env.var("ORIGIN_URL")?.to_string();
    let target = match query {
        Some(q) => format!("{}{}?{}", origin.trim_end_matches('/'), path, q),
        None => format!("{}{}", origin.trim_end_matches('/'), path),
    };

    let headers = Headers::new();
    for (name, value) in req.headers().entries() {
        let lower = name.to_ascii_lowercase();
        if lower == "cookie"
            || lower == "x-bench-origin"
            || lower == "host"
            || strip_headers.iter().any(|h| *h == lower)
        {
            continue;
        }
        headers.set(&name, &value)?;
    }
    if !cleaned_cookie.is_empty() {
        headers.set("cookie", cleaned_cookie)?;
    }

    let mut init = RequestInit::new();
    init.with_method(req.method()).with_headers(headers);
    let origin_req = Request::new_with_init(&target, &init)?;
    env.service("ORIGIN")?.fetch_request(origin_req).await
}
