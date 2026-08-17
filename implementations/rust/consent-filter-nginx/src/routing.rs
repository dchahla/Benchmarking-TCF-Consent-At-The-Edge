/// Edge routing decisions based on consent state.
///
/// Three possible outcomes for any incoming request:
///   Pass        — full consent granted, request is untouched
///   StripHeaders— consent is partial; scrub tracking identifiers before forwarding
///   Block       — no storage consent at all; return 204 No Content (ad calls)
///                 or redirect to a consent wall (content pages)

use crate::tcf::TcfConsent;

/// Headers that carry persistent user identifiers. These are stripped when
/// storage consent (purpose 1) is absent but the request should still be served.
///
/// In a real deployment this list lives in plugin config, not hardcoded.
pub const TRACKING_HEADERS: &[&str] = &[
    "x-user-id",
    "x-advertising-id",
    "x-session-token",
    "x-device-fingerprint",
];

/// Cookie names that carry tracking identifiers and must be stripped on
/// partial/no consent. The euconsent-v2 cookie itself is preserved.
pub const TRACKING_COOKIES: &[&str] = &[
    "_ga",
    "_gid",
    "_fbp",
    "_gcl_au",
    "uid",
    "TDID",
    "TDCPM",
    "criteo_userid",
];

#[derive(Debug, PartialEq, Clone)]
pub enum RoutingDecision {
    /// Request passes unmodified.
    Pass,
    /// Forward the request but strip tracking headers/cookies first.
    StripHeaders { headers: Vec<&'static str>, cookies: Vec<&'static str> },
    /// Drop the request at the edge. Used for pure ad/tracking endpoints
    /// where there is no meaningful non-tracking fallback.
    Block { status: u32 },
}

/// Classify a request based on its consent state and destination type.
///
/// `is_ad_endpoint`: true for requests destined for ad servers, pixel trackers,
/// or analytics endpoints. When false, the request is a content page — blocking
/// outright would break the user experience.
pub fn decide(consent: Option<&TcfConsent>, is_ad_endpoint: bool) -> RoutingDecision {
    match consent {
        None => {
            // No consent cookie present at all — treat as no consent.
            if is_ad_endpoint {
                RoutingDecision::Block { status: 204 }
            } else {
                RoutingDecision::StripHeaders {
                    headers: TRACKING_HEADERS.to_vec(),
                    cookies: TRACKING_COOKIES.to_vec(),
                }
            }
        }
        Some(tcf) if !tcf.allows_storage() => {
            // Storage/access (purpose 1) denied — no persistent identifiers allowed.
            if is_ad_endpoint {
                RoutingDecision::Block { status: 204 }
            } else {
                RoutingDecision::StripHeaders {
                    headers: TRACKING_HEADERS.to_vec(),
                    cookies: TRACKING_COOKIES.to_vec(),
                }
            }
        }
        Some(tcf) if !tcf.allows_personalised_ads() => {
            // Storage OK but no personalised ad consent — pass content, strip ad IDs.
            if is_ad_endpoint {
                RoutingDecision::Block { status: 204 }
            } else {
                // Strip ad-specific cookies but not session/content cookies.
                let ad_cookies: Vec<&'static str> = TRACKING_COOKIES
                    .iter()
                    .copied()
                    .filter(|c| !matches!(*c, "_ga" | "_gid"))
                    .collect();
                RoutingDecision::StripHeaders {
                    headers: vec!["x-advertising-id", "x-device-fingerprint"],
                    cookies: ad_cookies,
                }
            }
        }
        Some(_) => RoutingDecision::Pass,
    }
}

/// Given a raw `Cookie:` header value, strip the specified cookie names and
/// return the cleaned header string. The euconsent-v2 cookie is always preserved.
pub fn strip_cookies(cookie_header: &str, to_strip: &[&str]) -> String {
    cookie_header
        .split(';')
        .map(str::trim)
        .filter(|pair| {
            let name = pair.split('=').next().unwrap_or("").trim();
            !to_strip.contains(&name)
        })
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tcf::TcfConsent;

    fn full_consent() -> TcfConsent {
        TcfConsent { version: 2, purposes_consent: 0x0FFF } // all 12 purposes
    }

    fn storage_only() -> TcfConsent {
        TcfConsent { version: 2, purposes_consent: 0x0001 } // purpose 1 only
    }

    fn no_consent() -> TcfConsent {
        TcfConsent { version: 2, purposes_consent: 0x0000 }
    }

    #[test]
    fn full_consent_passes_content() {
        assert_eq!(decide(Some(&full_consent()), false), RoutingDecision::Pass);
    }

    #[test]
    fn full_consent_passes_ads() {
        assert_eq!(decide(Some(&full_consent()), true), RoutingDecision::Pass);
    }

    #[test]
    fn no_consent_blocks_ad_endpoints() {
        assert_eq!(decide(Some(&no_consent()), true), RoutingDecision::Block { status: 204 });
    }

    #[test]
    fn no_storage_consent_blocks_ads() {
        assert_eq!(decide(Some(&no_consent()), true), RoutingDecision::Block { status: 204 });
    }

    #[test]
    fn no_consent_strips_on_content_pages() {
        match decide(Some(&no_consent()), false) {
            RoutingDecision::StripHeaders { headers, cookies } => {
                assert!(headers.contains(&"x-user-id"));
                assert!(cookies.contains(&"_fbp"));
            }
            other => panic!("expected StripHeaders, got {:?}", other),
        }
    }

    #[test]
    fn missing_cookie_treated_as_no_consent() {
        assert_eq!(decide(None, true), RoutingDecision::Block { status: 204 });
    }

    #[test]
    fn storage_only_consent_strips_ad_ids_on_content() {
        match decide(Some(&storage_only()), false) {
            RoutingDecision::StripHeaders { headers, .. } => {
                assert!(headers.contains(&"x-advertising-id"));
            }
            other => panic!("expected StripHeaders, got {:?}", other),
        }
    }

    #[test]
    fn strip_cookies_removes_named_cookies() {
        let header = "_ga=GA1.2.123; euconsent-v2=CPXX; _fbp=fb.1.456; uid=abc";
        let cleaned = strip_cookies(header, &["_ga", "_fbp", "uid"]);
        assert!(cleaned.contains("euconsent-v2"), "consent cookie must survive");
        assert!(!cleaned.contains("_ga"), "_ga should be stripped");
        assert!(!cleaned.contains("_fbp"), "_fbp should be stripped");
        assert!(!cleaned.contains("uid"), "uid should be stripped");
    }

    #[test]
    fn strip_cookies_preserves_unmatched() {
        let header = "session=xyz; _ga=GA1.2.123";
        let cleaned = strip_cookies(header, &["_ga"]);
        assert!(cleaned.contains("session=xyz"));
    }
}
