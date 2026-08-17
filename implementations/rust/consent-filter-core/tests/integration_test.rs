/// Integration test: simulate HTTP requests through the consent filter logic.
/// This doesn't require a running proxy — it tests the plugin's decision logic directly.

use consent_filter_core::routing::{decide, strip_cookies, RoutingDecision};
use consent_filter_core::tcf::TcfConsent;

#[test]
fn test_full_consent_passes_content() {
    let tcf = TcfConsent {
        version: 2,
        purposes_consent: 0x0FFF, // all purposes
    };
    let decision = decide(Some(&tcf), false); // content endpoint
    assert_eq!(decision, RoutingDecision::Pass);
}

#[test]
fn test_full_consent_passes_ads() {
    let tcf = TcfConsent {
        version: 2,
        purposes_consent: 0x0FFF,
    };
    let decision = decide(Some(&tcf), true); // ad endpoint
    assert_eq!(decision, RoutingDecision::Pass);
}

#[test]
fn test_no_consent_blocks_ads() {
    let tcf = TcfConsent {
        version: 2,
        purposes_consent: 0x0000,
    };
    let decision = decide(Some(&tcf), true); // ad endpoint
    assert_eq!(decision, RoutingDecision::Block { status: 204 });
}

#[test]
fn test_no_consent_strips_on_content() {
    let tcf = TcfConsent {
        version: 2,
        purposes_consent: 0x0000,
    };
    match decide(Some(&tcf), false) {
        RoutingDecision::StripHeaders { headers, cookies } => {
            assert!(!headers.is_empty());
            assert!(!cookies.is_empty());
            assert!(headers.contains(&"x-user-id"));
            assert!(cookies.contains(&"_ga"));
        }
        other => panic!("expected StripHeaders, got {:?}", other),
    }
}

#[test]
fn test_missing_consent_cookie_blocks_ads() {
    // No consent cookie present at all
    let decision = decide(None, true);
    assert_eq!(decision, RoutingDecision::Block { status: 204 });
}

#[test]
fn test_storage_only_consent() {
    let tcf = TcfConsent {
        version: 2,
        purposes_consent: 0x0001, // purpose 1 only
    };

    // Content page: allows the page but strips ad-targeting headers
    match decide(Some(&tcf), false) {
        RoutingDecision::StripHeaders { headers, .. } => {
            assert!(headers.contains(&"x-advertising-id"), "should strip ad headers on content");
        }
        other => panic!("expected StripHeaders for content with storage-only, got {:?}", other),
    }

    // Ad endpoint: should block (no ad consent)
    let decision = decide(Some(&tcf), true);
    assert_eq!(decision, RoutingDecision::Block { status: 204 });
}

#[test]
fn test_cookie_stripping_preserves_consent() {
    let cookie_header = "_ga=GA1.2.123; euconsent-v2=CPXX; _fbp=fb.1.456";
    let to_strip = vec!["_ga", "_fbp"];
    let cleaned = strip_cookies(cookie_header, &to_strip);

    assert!(cleaned.contains("euconsent-v2"), "consent cookie must be preserved");
    assert!(!cleaned.contains("_ga"), "_ga should be stripped");
    assert!(!cleaned.contains("_fbp"), "_fbp should be stripped");
}

#[test]
fn test_realistic_request_flow_content_no_consent() {
    // Simulate a content request with no consent cookie
    let path = "/article/news";
    let is_ad = path.starts_with("/ads/");

    let decision = decide(None, is_ad);

    // Should strip headers but not block
    match decision {
        RoutingDecision::StripHeaders { .. } => {
            // Expected: forward the request but without tracking identifiers
        }
        other => panic!("content page without consent should strip, not {:?}", other),
    }
}

#[test]
fn test_realistic_request_flow_ad_endpoint_no_consent() {
    // Simulate an ad request with no consent
    let path = "/ads/request";
    let is_ad = path.starts_with("/ads/");

    let decision = decide(None, is_ad);

    // Should block
    assert_eq!(decision, RoutingDecision::Block { status: 204 });
}

#[test]
fn test_purpose_1_gates_all_tracking() {
    // Without purpose 1 (storage), no tracking should happen
    let tcf_no_purpose_1 = TcfConsent {
        version: 2,
        purposes_consent: 0x0FFE, // all except purpose 1
    };

    let decision = decide(Some(&tcf_no_purpose_1), false);
    match decision {
        RoutingDecision::StripHeaders { headers, cookies } => {
            // Should strip the core tracking identifiers
            assert!(headers.contains(&"x-user-id"));
            assert!(cookies.contains(&"_ga"));
        }
        other => panic!("should strip when purpose 1 missing, got {:?}", other),
    }
}
