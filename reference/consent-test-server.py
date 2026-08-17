#!/usr/bin/env python3
"""
Mock consent filter server — simulates what the WASM plugin does.
Receives requests, parses TCF consent cookies, applies routing logic.
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import base64
import json
import sys

class ConsentFilter:
    """Minimal TCF v2 decoder (mirrors Rust plugin logic)"""

    @staticmethod
    def parse_tcf(tcf_string):
        """Parse a base64url TCF v2 string"""
        try:
            # Decode base64url
            # Add padding if needed
            padding = 4 - (len(tcf_string) % 4)
            if padding != 4:
                tcf_string += '=' * padding

            tcf_string = tcf_string.replace('-', '+').replace('_', '/')
            data = base64.b64decode(tcf_string)

            if len(data) < 21:
                return None

            # Read version (bits 0-5)
            version = (data[0] >> 2) & 0x3f
            if version != 2:
                return None

            # Read purposes consent (bits 152-163, 12 bits)
            # Byte 19 has bits 152-159, byte 20 has bits 160-167
            byte_19 = data[19]
            byte_20 = data[20]

            # Extract 12-bit value
            raw_purposes = ((byte_19 & 0xFF) << 4) | ((byte_20 >> 4) & 0x0F)

            # Reverse bit order (TCF stores purpose 1 in MSB)
            purposes = 0
            for i in range(12):
                bit = (raw_purposes >> (11 - i)) & 1
                purposes |= bit << i

            return {
                'version': version,
                'purposes_consent': purposes,
                'allows_storage': bool(purposes & 0x0001),  # Purpose 1
                'allows_personalised_ads': bool(purposes & 0x0008),  # Purpose 4
            }
        except Exception as e:
            print(f"TCF parse error: {e}", file=sys.stderr)
            return None

    @staticmethod
    def evaluate_routing(tcf_info, is_ad_endpoint):
        """Decide: Pass / Strip / Block"""
        if tcf_info is None:
            # No consent cookie
            if is_ad_endpoint:
                return 'Block', 204, [], []
            else:
                return 'Strip', 200, [
                    'x-user-id', 'x-advertising-id', 'x-session-token', 'x-device-fingerprint'
                ], ['_ga', '_gid', '_fbp', '_gcl_au', 'uid', 'TDID', 'TDCPM', 'criteo_userid']

        if not tcf_info['allows_storage']:
            # No storage consent
            if is_ad_endpoint:
                return 'Block', 204, [], []
            else:
                return 'Strip', 200, [
                    'x-user-id', 'x-advertising-id', 'x-session-token', 'x-device-fingerprint'
                ], ['_ga', '_gid', '_fbp', '_gcl_au', 'uid', 'TDID', 'TDCPM', 'criteo_userid']

        if not tcf_info['allows_personalised_ads']:
            # Storage OK but no ad targeting consent
            if is_ad_endpoint:
                return 'Block', 204, [], []
            else:
                # Strip ad-specific cookies but allow content
                return 'Strip', 200, [
                    'x-advertising-id', 'x-device-fingerprint'
                ], ['_fbp', '_gcl_au', 'uid', 'TDID', 'TDCPM', 'criteo_userid']

        # Full consent
        return 'Pass', 200, [], []


class ConsentFilterHandler(BaseHTTPRequestHandler):
    """HTTP handler that simulates the consent filter plugin"""

    def do_GET(self):
        path = urlparse(self.path).path

        # Extract cookie header
        cookie_header = self.headers.get('Cookie', '')

        # Extract euconsent-v2 cookie
        tcf_string = self._extract_cookie(cookie_header, 'euconsent-v2')

        # Parse TCF
        tcf_info = ConsentFilter.parse_tcf(tcf_string) if tcf_string else None

        # Determine if this is an ad endpoint
        is_ad_endpoint = any(path.startswith(prefix) for prefix in [
            '/ads/', '/pixel/', '/track/', '/beacon/', '/sync/', '/rtb/', '/prebid/'
        ])

        # Evaluate routing decision
        decision, status, strip_headers, strip_cookies = ConsentFilter.evaluate_routing(tcf_info, is_ad_endpoint)

        # Log the request
        print(f"\n{'='*70}")
        print(f"Request: {self.command} {path}")
        print(f"Is Ad Endpoint: {is_ad_endpoint}")
        print(f"TCF Cookie Present: {tcf_string is not None}")
        if tcf_info:
            print(f"  Version: {tcf_info['version']}")
            print(f"  Allows Storage: {tcf_info['allows_storage']}")
            print(f"  Allows Personalised Ads: {tcf_info['allows_personalised_ads']}")
        print(f"\nDecision: {decision}")
        print(f"Status: {status}")
        if strip_headers:
            print(f"Headers to Strip: {', '.join(strip_headers)}")
        if strip_cookies:
            print(f"Cookies to Strip: {', '.join(strip_cookies)}")
        print(f"{'='*70}\n")

        # Send response
        response_data = {
            'decision': decision,
            'path': path,
            'is_ad_endpoint': is_ad_endpoint,
            'tcf_parsed': tcf_info is not None,
            'headers_stripped': strip_headers,
            'cookies_stripped': strip_cookies,
        }

        response_body = json.dumps(response_data, indent=2).encode()

        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(response_body))
        self.end_headers()
        self.wfile.write(response_body)

    def _extract_cookie(self, header, name):
        """Extract a cookie value from a Cookie header"""
        for pair in header.split(';'):
            pair = pair.strip()
            if '=' in pair:
                k, v = pair.split('=', 1)
                if k.strip() == name:
                    return v.strip()
        return None

    def log_message(self, format, *args):
        """Suppress default logging"""
        pass


def main():
    port = 8080
    server = HTTPServer(('0.0.0.0', port), ConsentFilterHandler)
    print(f"Consent Filter Test Server listening on http://0.0.0.0:{port}")
    print("Send requests with 'Cookie: euconsent-v2=...' headers")
    print("Paths starting with /ads/, /pixel/, etc. are treated as ad endpoints\n")
    server.serve_forever()


if __name__ == '__main__':
    main()
