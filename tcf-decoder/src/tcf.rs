/// IAB TCF v2 consent string parser — adapted for WASM decoder.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

#[derive(Debug, PartialEq)]
pub enum TcfError {
    InvalidBase64,
    TooShort,
    UnsupportedVersion(u8),
}

impl std::fmt::Display for TcfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TcfError::InvalidBase64 => write!(f, "invalid base64url encoding"),
            TcfError::TooShort => write!(f, "consent string too short (need 21+ bytes)"),
            TcfError::UnsupportedVersion(v) => write!(f, "unsupported TCF version: {}", v),
        }
    }
}

/// Decoded TCF v2 core segment.
#[derive(Debug, Clone)]
pub struct TcfConsent {
    pub version: u8,
    pub purposes_consent: u16,
}

impl TcfConsent {
    pub fn has_purpose(&self, purpose: u8) -> bool {
        if purpose == 0 || purpose > 12 {
            return false;
        }
        let bit = 1u16 << (purpose - 1);
        self.purposes_consent & bit != 0
    }

    pub fn allows_storage(&self) -> bool {
        self.has_purpose(1)
    }

    pub fn allows_personalised_ads(&self) -> bool {
        self.has_purpose(4)
    }
}

fn read_bits(buf: &[u8], offset: usize, count: usize) -> u64 {
    let mut result = 0u64;
    for i in 0..count {
        let bit_pos = offset + i;
        let byte_idx = bit_pos / 8;
        let bit_idx = 7 - (bit_pos % 8);
        if byte_idx < buf.len() {
            let bit = ((buf[byte_idx] >> bit_idx) & 1) as u64;
            result = (result << 1) | bit;
        }
    }
    result
}

pub fn parse(consent_string: &str) -> Result<TcfConsent, TcfError> {
    let trimmed = consent_string.trim().trim_end_matches('=');

    let bytes = URL_SAFE_NO_PAD
        .decode(trimmed)
        .map_err(|_| TcfError::InvalidBase64)?;

    if bytes.len() < 21 {
        return Err(TcfError::TooShort);
    }

    let version = read_bits(&bytes, 0, 6) as u8;
    if version != 2 {
        return Err(TcfError::UnsupportedVersion(version));
    }

    let raw_purposes = read_bits(&bytes, 152, 12) as u16;

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
