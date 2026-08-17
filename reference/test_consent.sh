#!/bin/bash
# Test the consent filter plugin against the mock server
# Make sure the Docker server is running: docker-compose up

set -e

BASE_URL="${1:-http://localhost:8080}"
ECHO_SEP="echo -e '\n\n'"

echo "Consent Filter Integration Tests"
echo "================================="
echo "Testing against: $BASE_URL"
echo ""

# Test 1: Full consent — should PASS
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 1: Full Consent (All Purposes Granted)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Request: GET /article/news with full TCF consent"
echo ""
curl -s -H "Cookie: euconsent-v2=CAAAAAAAAAAAAAAAAAAAAAAAAP_wAA" \
     "$BASE_URL/article/news" | jq '.'

echo ""
echo ""

# Test 2: No consent on content — should STRIP headers
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 2: No Consent (Content Page)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Request: GET /article/news with NO consent"
echo "Expected: StripHeaders decision"
echo ""
curl -s -H "Cookie: euconsent-v2=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" \
     "$BASE_URL/article/news" | jq '.'

echo ""
echo ""

# Test 3: No consent on ad endpoint — should BLOCK (204)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 3: No Consent (Ad Endpoint)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Request: GET /ads/request with NO consent"
echo "Expected: Block decision (204)"
echo ""
curl -s -H "Cookie: euconsent-v2=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" \
     "$BASE_URL/ads/request" | jq '.'

echo ""
echo ""

# Test 4: Full consent on ad endpoint — should PASS
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 4: Full Consent (Ad Endpoint)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Request: GET /ads/request with full consent"
echo "Expected: Pass decision"
echo ""
curl -s -H "Cookie: euconsent-v2=CAAAAAAAAAAAAAAAAAAAAAAAAP_wAA" \
     "$BASE_URL/ads/request" | jq '.'

echo ""
echo ""

# Test 5: Storage only (Purpose 1 only) — should BLOCK ads
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 5: Storage Only (Purpose 1 Only)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Request: GET /ads/request with Purpose 1 only"
echo "Expected: Block decision (no ad consent)"
echo ""
curl -s -H "Cookie: euconsent-v2=CAAAAAAAAAAAAAAAAAAAAAAAAIAAAA" \
     "$BASE_URL/ads/request" | jq '.'

echo ""
echo ""

# Test 6: No cookie at all — should BLOCK ads
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 6: No Consent Cookie Present"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Request: GET /ads/request with NO cookie"
echo "Expected: Block decision"
echo ""
curl -s "$BASE_URL/ads/request" | jq '.'

echo ""
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "All tests complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
