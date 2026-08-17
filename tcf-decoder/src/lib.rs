use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use wasm_bindgen::prelude::*;

mod tcf;
use tcf::parse;

/// Decode a TCF v2 consent string and return a JSON object with:
/// { version, purposes: [...], allows_storage, allows_ads }
#[wasm_bindgen(js_name = "decodeTcf")]
pub fn decode_tcf(consent_string: &str) -> Result<JsValue, JsValue> {
    match parse(consent_string.trim()) {
        Ok(tcf) => {
            let obj = js_sys::Object::new();
            js_sys::Reflect::set(&obj, &"version".into(), &JsValue::from_f64(tcf.version as f64))
                .ok();

            // Build purposes array
            let purposes = js_sys::Array::new();
            for i in 1..=12u8 {
                let has = tcf.has_purpose(i);
                purposes.push(&JsValue::from_bool(has));
            }
            js_sys::Reflect::set(&obj, &"purposes".into(), &purposes).ok();

            js_sys::Reflect::set(&obj, &"allows_storage".into(), &JsValue::from_bool(tcf.allows_storage()))
                .ok();
            js_sys::Reflect::set(&obj, &"allows_personalised_ads".into(), &JsValue::from_bool(tcf.allows_personalised_ads()))
                .ok();

            Ok(JsValue::from(obj))
        }
        Err(e) => Err(JsValue::from_str(&format!("Parse error: {}", e))),
    }
}

/// Evaluate routing decision for a given consent string and endpoint type.
/// Returns { decision: "Pass|Strip|Block", reason, affected_headers, affected_cookies }
#[wasm_bindgen(js_name = "evaluateRouting")]
pub fn evaluate_routing(consent_string: &str, is_ad_endpoint: bool) -> Result<JsValue, JsValue> {
    let tcf = match parse(consent_string.trim()) {
        Ok(t) => t,
        Err(e) => return Err(JsValue::from_str(&e.to_string())),
    };

    let (decision, reason, headers, cookies) = match (tcf.allows_storage(), is_ad_endpoint) {
        (true, _) => (
            "Pass",
            "Full storage consent granted; request passes unmodified",
            vec![],
            vec![],
        ),
        (false, true) => (
            "Block",
            "No storage consent; ad endpoint blocked (204 No Content)",
            vec![],
            vec![],
        ),
        (false, false) => (
            "Strip",
            "No storage consent; stripping tracking identifiers from content request",
            vec!["x-user-id", "x-advertising-id", "x-session-token", "x-device-fingerprint"],
            vec!["_ga", "_gid", "_fbp", "_gcl_au", "uid", "TDID", "TDCPM", "criteo_userid"],
        ),
    };

    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &"decision".into(), &JsValue::from_str(decision)).ok();
    js_sys::Reflect::set(&obj, &"reason".into(), &JsValue::from_str(reason)).ok();

    let headers_arr = js_sys::Array::new();
    for h in headers {
        headers_arr.push(&JsValue::from_str(h));
    }
    js_sys::Reflect::set(&obj, &"affected_headers".into(), &headers_arr).ok();

    let cookies_arr = js_sys::Array::new();
    for c in cookies {
        cookies_arr.push(&JsValue::from_str(c));
    }
    js_sys::Reflect::set(&obj, &"affected_cookies".into(), &cookies_arr).ok();

    Ok(JsValue::from(obj))
}

/// Get all 12 IAB purposes with descriptions.
#[wasm_bindgen(js_name = "getPurposes")]
pub fn get_purposes() -> Vec<JsValue> {
    let purposes = vec![
        ("Store and/or access information on a device", "Cookies, device IDs, pixels, beacons — the foundation for all tracking"),
        ("Select basic ads", "Non-personalised ads based on current activity"),
        ("Create a personalised ads profile", "Build a profile of interests/demographics for ad targeting"),
        ("Select personalised ads", "Deliver interest-based advertising"),
        ("Create a personalised content profile", "Build a profile of interests for content personalization"),
        ("Select personalised content", "Deliver interest-based content recommendations"),
        ("Measure ad performance", "Track which ads convert and how much they cost"),
        ("Measure content performance", "Understand content engagement metrics"),
        ("Apply market research to generate audience insights", "Combine data to create audience segments"),
        ("Develop and improve products", "Use feedback to build better services"),
        ("Select ads delivery", "Control where/when/how ads appear"),
        ("Select content delivery", "Control where/when/how content appears"),
    ];

    purposes
        .into_iter()
        .enumerate()
        .map(|(i, (name, desc))| {
            let obj = js_sys::Object::new();
            js_sys::Reflect::set(&obj, &"number".into(), &JsValue::from_f64((i + 1) as f64)).ok();
            js_sys::Reflect::set(&obj, &"name".into(), &JsValue::from_str(name)).ok();
            js_sys::Reflect::set(&obj, &"description".into(), &JsValue::from_str(desc)).ok();
            JsValue::from(obj)
        })
        .collect()
}

/// Generate a TCF v2 string with given purposes enabled (bitmask, purposes 1-12).
#[wasm_bindgen(js_name = "generateTcf")]
pub fn generate_tcf(purposes_mask: u32) -> String {
    let mut bytes = vec![0u8; 22];
    bytes[0] = 2 << 2; // version 2

    let purposes_consent = (purposes_mask & 0x0FFF) as u16;
    let mut raw: u16 = 0;
    for i in 0..12u8 {
        let bit = (purposes_consent >> i) & 1;
        raw |= (bit as u16) << (11 - i);
    }
    bytes[19] = (raw >> 4) as u8;
    bytes[20] = ((raw & 0x0F) << 4) as u8;

    URL_SAFE_NO_PAD.encode(&bytes)
}

/// Get sample TCF strings for quick testing.
#[wasm_bindgen(js_name = "getSamples")]
pub fn get_samples() -> Vec<JsValue> {
    let samples = vec![
        ("Full Consent", "All purposes granted", 0x0FFF),
        ("Storage Only", "Purpose 1 only (no ad targeting)", 0x0001),
        ("No Consent", "All purposes denied", 0x0000),
        ("Essential Only", "Purposes 1, 10, 11 (essential)", 0x0601),
    ];

    samples
        .into_iter()
        .map(|(name, desc, mask)| {
            let tcf = generate_tcf(mask);
            let obj = js_sys::Object::new();
            js_sys::Reflect::set(&obj, &"name".into(), &JsValue::from_str(name)).ok();
            js_sys::Reflect::set(&obj, &"description".into(), &JsValue::from_str(desc)).ok();
            js_sys::Reflect::set(&obj, &"tcf".into(), &JsValue::from_str(&tcf)).ok();
            JsValue::from(obj)
        })
        .collect()
}
