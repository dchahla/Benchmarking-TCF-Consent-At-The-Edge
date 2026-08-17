/// HTTP-level helpers shared by all platform adapters: cookie extraction and
/// ad-endpoint classification. Pure string logic, no platform dependencies.

/// Extract a single named cookie value from a raw Cookie header string.
pub fn extract_cookie(header: &str, name: &str) -> Option<String> {
    for pair in header.split(';') {
        let pair = pair.trim();
        if let Some((k, v)) = pair.split_once('=') {
            if k.trim() == name {
                return Some(v.trim().to_owned());
            }
        }
    }
    None
}

/// Heuristic: is this request destined for an ad/tracking endpoint?
/// In production this would match against a configurable list of path prefixes
/// or a separate plugin config supplied by the root context.
pub fn is_ad_path(path: &str) -> bool {
    const AD_PREFIXES: &[&str] = &[
        "/ads/",
        "/pixel/",
        "/track/",
        "/beacon/",
        "/sync/",
        "/rtb/",
        "/prebid/",
    ];
    AD_PREFIXES.iter().any(|p| path.starts_with(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_cookie_finds_value() {
        let header = "session=abc; euconsent-v2=CPXX123; _ga=GA1.2";
        assert_eq!(
            extract_cookie(header, "euconsent-v2"),
            Some("CPXX123".to_owned())
        );
    }

    #[test]
    fn extract_cookie_returns_none_when_absent() {
        let header = "session=abc; _ga=GA1.2";
        assert_eq!(extract_cookie(header, "euconsent-v2"), None);
    }

    #[test]
    fn ad_path_detection() {
        assert!(is_ad_path("/ads/request"));
        assert!(is_ad_path("/pixel/1x1.gif"));
        assert!(is_ad_path("/rtb/bid"));
        assert!(!is_ad_path("/article/news-story"));
        assert!(!is_ad_path("/api/user"));
    }
}
