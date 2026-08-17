/// IAB TCF v2 consent string parser.
///
/// TCF strings are base64url-encoded (no padding) packed bitfields.
/// Layout reference: https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/IAB%20Tech%20Lab%20-%20Consent%20string%20and%20vendor%20list%20formats%20v2.md
///
/// We only need to evaluate the core segment (segment type 0, always first).
/// The fields we care about for edge routing:
///   - Version           bits 0-5    (must be 2)
///   - PurposesConsent   bits 152-163 (12 bits, one per IAB purpose 1-12)
///
/// Purpose 1 ("Store and/or access information on a device") is the gating
/// signal: if not set, no tracking cookies or identifiers should pass.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

#[derive(Debug, PartialEq)]
pub enum TcfError {
    InvalidBase64,
    TooShort,
    UnsupportedVersion(u8),
}

impl core::fmt::Display for TcfError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            TcfError::InvalidBase64 => write!(f, "invalid base64url encoding"),
            TcfError::TooShort => write!(f, "consent string too short to parse"),
            TcfError::UnsupportedVersion(v) => write!(f, "unsupported TCF version: {}", v),
        }
    }
}

/// Minimal decoded view of a TCF v2 core segment.
#[derive(Debug, Clone, PartialEq)]
pub struct TcfConsent {
    pub version: u8,
    /// Bit N (0-indexed) = consent for IAB purpose N+1.
    /// purposes_consent & (1 << 0) → purpose 1 consent.
    pub purposes_consent: u16,
}

impl TcfConsent {
    /// Returns true if the user has granted consent for the given IAB purpose number (1-indexed).
    pub fn has_purpose(&self, purpose: u8) -> bool {
        if purpose == 0 || purpose > 12 {
            return false;
        }
        let bit = 1u16 << (purpose - 1);
        self.purposes_consent & bit != 0
    }

    /// Convenience: purpose 1 is "Store and/or access information on a device".
    /// This is the baseline gate for any persistent tracking identifier.
    pub fn allows_storage(&self) -> bool {
        self.has_purpose(1)
    }

    /// Purpose 3: "Create a personalised ads profile". Required for ad targeting.
    pub fn allows_ad_profile(&self) -> bool {
        self.has_purpose(3)
    }

    /// Purpose 4: "Select personalised ads".
    pub fn allows_personalised_ads(&self) -> bool {
        self.has_purpose(4)
    }
}

/// Reads `count` bits starting at bit offset `offset` from a byte slice.
/// Returns the value as a u64. Panics if the range exceeds 64 bits.
fn read_bits(buf: &[u8], offset: usize, count: usize) -> u64 {
    debug_assert!(count <= 64);
    let mut result = 0u64;
    for i in 0..count {
        let bit_pos = offset + i;
        let byte_idx = bit_pos / 8;
        let bit_idx = 7 - (bit_pos % 8); // MSB-first within each byte
        if byte_idx < buf.len() {
            let bit = ((buf[byte_idx] >> bit_idx) & 1) as u64;
            result = (result << 1) | bit;
        }
    }
    result
}

/// Parse a TCF v2 consent string (the value of the `euconsent-v2` cookie).
///
/// Returns a [`TcfConsent`] on success or a [`TcfError`] if the string is
/// malformed, truncated, or not TCF v2.
pub fn parse(consent_string: &str) -> Result<TcfConsent, TcfError> {
    // TCF strings may be URL-encoded or have padding stripped — normalize first.
    let trimmed = consent_string.trim().trim_end_matches('=');

    let bytes = URL_SAFE_NO_PAD
        .decode(trimmed)
        .map_err(|_| TcfError::InvalidBase64)?;

    // Minimum viable length: we need at least 164 bits = 21 bytes to reach
    // the end of the PurposesConsent field.
    if bytes.len() < 21 {
        return Err(TcfError::TooShort);
    }

    let version = read_bits(&bytes, 0, 6) as u8;
    if version != 2 {
        return Err(TcfError::UnsupportedVersion(version));
    }

    // PurposesConsent: bits 152-163 (12 bits, MSB = purpose 1)
    let raw_purposes = read_bits(&bytes, 152, 12) as u16;

    // The TCF spec stores purpose 1 in the most-significant position of the
    // 12-bit field, so we reverse the bit order so that bit 0 = purpose 1.
    let mut purposes_consent = 0u16;
    for i in 0..12u8 {
        let tcf_bit = (raw_purposes >> (11 - i)) & 1;
        purposes_consent |= (tcf_bit as u16) << i;
    }

    Ok(TcfConsent {
        version,
        purposes_consent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid TCF v2 byte array (22 bytes) with the given purposes.
    /// `purposes` is a bitmask where bit 0 = purpose 1, bit 1 = purpose 2, etc.
    /// All other fields (timestamps, CMP info, etc.) are zeroed — we only test the parser.
    fn build_tcf_bytes(purposes_consent: u16) -> Vec<u8> {
        let mut bytes = vec![0u8; 22];
        // Version 2 occupies bits 0-5 (MSB-first). 2 << 2 places it in the high bits.
        bytes[0] = 2 << 2; // = 0x08

        // PurposesConsent is a 12-bit field at bits 152-163.
        // In TCF wire format the MSB of the 12-bit field = purpose 1.
        // We flip our input so purpose 1 (bit 0) maps to the wire MSB (bit 11).
        let mut raw: u16 = 0;
        for i in 0..12u8 {
            let bit = (purposes_consent >> i) & 1;
            raw |= (bit as u16) << (11 - i);
        }
        // raw bits 11-4 → byte 19; raw bits 3-0 → high nibble of byte 20.
        bytes[19] = (raw >> 4) as u8;
        bytes[20] = ((raw & 0x0F) << 4) as u8;
        bytes
    }

    fn build_tcf_string(purposes_consent: u16) -> String {
        URL_SAFE_NO_PAD.encode(build_tcf_bytes(purposes_consent))
    }

    #[test]
    fn rejects_invalid_base64() {
        assert_eq!(parse("not!!valid@@"), Err(TcfError::InvalidBase64));
    }

    #[test]
    fn rejects_too_short() {
        assert_eq!(parse("AAAA"), Err(TcfError::TooShort));
    }

    #[test]
    fn full_consent_parses_correctly() {
        let s = build_tcf_string(0x0FFF); // all 12 purposes
        let tcf = parse(&s).expect("should parse");
        assert_eq!(tcf.version, 2);
        assert!(tcf.allows_storage(), "purpose 1 must be set");
        assert!(tcf.allows_ad_profile(), "purpose 3 must be set");
        assert!(tcf.allows_personalised_ads(), "purpose 4 must be set");
    }

    #[test]
    fn no_consent_parses_correctly() {
        let s = build_tcf_string(0x0000);
        let tcf = parse(&s).expect("should parse");
        assert!(!tcf.allows_storage());
        assert!(!tcf.allows_personalised_ads());
    }

    #[test]
    fn purpose_1_only_grants_storage_not_ads() {
        let s = build_tcf_string(0x0001); // bit 0 = purpose 1
        let tcf = parse(&s).expect("should parse");
        assert!(tcf.allows_storage());
        assert!(!tcf.allows_personalised_ads());
    }

    #[test]
    fn purpose_indexing_is_1_based() {
        let tcf = TcfConsent {
            version: 2,
            purposes_consent: 0b0000_0000_0010, // bit 1 = purpose 2
        };
        assert!(!tcf.has_purpose(1));
        assert!(tcf.has_purpose(2));
        assert!(!tcf.has_purpose(3));
    }

    #[test]
    fn out_of_range_purposes_return_false() {
        let tcf = TcfConsent { version: 2, purposes_consent: 0xFFFF };
        assert!(!tcf.has_purpose(0));
        assert!(!tcf.has_purpose(13));
    }

    #[test]
    fn read_bits_basic() {
        let buf = [0xA0u8]; // 0b10100000
        assert_eq!(read_bits(&buf, 0, 1), 1);
        assert_eq!(read_bits(&buf, 1, 1), 0);
        assert_eq!(read_bits(&buf, 2, 1), 1);
        assert_eq!(read_bits(&buf, 0, 3), 0b101);
    }

    #[test]
    fn roundtrip_each_purpose() {
        for purpose in 1u8..=12 {
            let mask = 1u16 << (purpose - 1);
            let s = build_tcf_string(mask);
            let tcf = parse(&s).expect("should parse");
            assert!(tcf.has_purpose(purpose), "purpose {} should be set", purpose);
            // No other purpose should leak.
            for other in 1u8..=12 {
                if other != purpose {
                    assert!(
                        !tcf.has_purpose(other),
                        "purpose {} should NOT be set when only {} is granted",
                        other, purpose
                    );
                }
            }
        }
    }
}
