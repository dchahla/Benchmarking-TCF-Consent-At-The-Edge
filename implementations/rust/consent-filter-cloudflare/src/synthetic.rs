/// Synthetic origin response shared by the Fastly and Cloudflare adapters.
///
/// On managed platforms the benchmark deliberately short-circuits instead of
/// forwarding to a real origin, so measurements isolate filter-execution cost.
/// The JSON shape mirrors reference/consent-test-server.py so the same
/// functional checks run against every target.

use crate::routing::RoutingDecision;

pub fn decision_label(decision: &RoutingDecision) -> &'static str {
    match decision {
        RoutingDecision::Pass => "Pass",
        RoutingDecision::StripHeaders { .. } => "Strip",
        RoutingDecision::Block { .. } => "Block",
    }
}

/// Build the synthetic JSON body for a non-Block decision.
pub fn response_json(
    path: &str,
    is_ad_endpoint: bool,
    tcf_parsed: bool,
    decision: &RoutingDecision,
) -> String {
    let (headers, cookies): (&[&str], &[&str]) = match decision {
        RoutingDecision::StripHeaders { headers, cookies } => (headers, cookies),
        _ => (&[], &[]),
    };
    format!(
        r#"{{"decision":"{}","path":"{}","is_ad_endpoint":{},"tcf_parsed":{},"headers_stripped":{},"cookies_stripped":{}}}"#,
        decision_label(decision),
        escape(path),
        is_ad_endpoint,
        tcf_parsed,
        string_array(headers),
        string_array(cookies),
    )
}

fn string_array(items: &[&str]) -> String {
    let quoted: Vec<String> = items.iter().map(|s| format!("\"{}\"", escape(s))).collect();
    format!("[{}]", quoted.join(","))
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::decide;

    #[test]
    fn pass_decision_renders_empty_arrays() {
        let body = response_json("/article/news", false, true, &RoutingDecision::Pass);
        assert_eq!(
            body,
            r#"{"decision":"Pass","path":"/article/news","is_ad_endpoint":false,"tcf_parsed":true,"headers_stripped":[],"cookies_stripped":[]}"#
        );
    }

    #[test]
    fn strip_decision_lists_stripped_names() {
        let decision = decide(None, false); // no consent on content page → Strip
        let body = response_json("/article/news", false, false, &decision);
        assert!(body.contains(r#""decision":"Strip""#));
        assert!(body.contains(r#""x-user-id""#));
        assert!(body.contains(r#""_ga""#));
    }

    #[test]
    fn path_is_escaped() {
        let body = response_json(r#"/we"ird"#, false, false, &RoutingDecision::Pass);
        assert!(body.contains(r#""path":"/we\"ird""#));
    }
}
