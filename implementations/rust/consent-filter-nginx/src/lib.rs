/// Consent filter proxy-wasm plugin (Nginx / ngx_wasm_module adapter).
///
/// All consent logic lives in `consent-filter-core`; this crate only maps
/// proxy-wasm host callbacks onto it.
///
/// Hooks: on_http_request_headers
///   1. Read the Cookie header
///   2. Find the euconsent-v2 cookie and parse the TCF v2 string
///   3. Evaluate the consent decision
///   4. Pass / strip tracking cookies+headers / block (204)

use proxy_wasm::traits::{Context, HttpContext, RootContext};
use proxy_wasm::types::{Action, ContextType, LogLevel};

// Full copies of the platform-agnostic modules (from consent-filter-core),
// vendored per-platform so `diff -r` against the original shows exactly what
// each platform port changed. No synthetic.rs here: Nginx always proxies to a
// real upstream, never fabricates origin responses.
pub mod http;
pub mod routing;
pub mod tcf;

use crate::http::{extract_cookie, is_ad_path};
use crate::routing::{decide, strip_cookies};
use crate::tcf::parse;

proxy_wasm::main! {{
    proxy_wasm::set_log_level(LogLevel::Info);
    proxy_wasm::set_root_context(|_| -> Box<dyn RootContext> {
        Box::new(ConsentRoot)
    });
}}

struct ConsentRoot;

impl Context for ConsentRoot {}

impl RootContext for ConsentRoot {
    fn get_type(&self) -> Option<ContextType> {
        Some(ContextType::HttpContext)
    }

    fn create_http_context(&self, _context_id: u32) -> Option<Box<dyn HttpContext>> {
        Some(Box::new(ConsentFilter))
    }
}

struct ConsentFilter;

impl Context for ConsentFilter {}

impl HttpContext for ConsentFilter {
    fn on_http_request_headers(&mut self, _num_headers: usize, _end_of_stream: bool) -> Action {
        // 1. Pull the Cookie header. Missing = no consent.
        let cookie_header = self
            .get_http_request_header("cookie")
            .unwrap_or_default();

        // 2. Extract euconsent-v2 cookie value.
        let consent_string = extract_cookie(&cookie_header, "euconsent-v2");

        // 3. Parse TCF string (None if missing/malformed).
        let parsed = consent_string.as_deref().and_then(|s| {
            match parse(s) {
                Ok(tcf) => Some(tcf),
                Err(e) => {
                    proxy_wasm::hostcalls::log(
                        LogLevel::Warn,
                        &format!("consent-filter: TCF parse error: {}", e),
                    )
                    .ok();
                    None
                }
            }
        });

        // 4. Determine if this request is headed to an ad/tracking endpoint.
        let path = self
            .get_http_request_header(":path")
            .unwrap_or_default();
        let is_ad_endpoint = is_ad_path(&path);

        // 5. Route.
        match decide(parsed.as_ref(), is_ad_endpoint) {
            routing::RoutingDecision::Pass => Action::Continue,

            routing::RoutingDecision::StripHeaders { headers, cookies } => {
                // Host quirk (ngx_wasm_module prerelease-0.6.0): header REMOVAL
                // only sets the entry's hash to 0 in r->headers_in, which hides
                // it from the filter's own view but nginx's proxy module still
                // forwards hash-0 entries upstream. In-place VALUE replacement
                // keeps the hash valid and does propagate — so we scrub tracking
                // headers by blanking their values instead of removing them.
                for h in &headers {
                    if self.get_http_request_header(h).is_some() {
                        self.set_http_request_header(h, Some(""));
                    }
                }
                // Rewrite the Cookie header with tracking cookies removed
                // (same in-place replacement mechanism, proven to propagate).
                let cleaned = strip_cookies(&cookie_header, &cookies);
                if cleaned != cookie_header {
                    self.set_http_request_header("cookie", Some(&cleaned));
                }
                Action::Continue
            }

            routing::RoutingDecision::Block { status } => {
                self.send_http_response(status, vec![], Some(b""));
                Action::Pause
            }
        }
    }
}
