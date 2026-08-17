/// Platform-agnostic consent-filter logic, shared by every deployment target
/// (Nginx/proxy-wasm, Fastly Compute, Cloudflare Workers).
///
/// No proxy-wasm, WASI, or platform SDK dependencies — pure request-shaped
/// inputs (header strings, paths) to routing decisions.

pub mod http;
pub mod routing;
pub mod synthetic;
pub mod tcf;
