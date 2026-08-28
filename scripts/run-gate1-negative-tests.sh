#!/bin/bash

# Gate-1 Negative Path Tests
# Phase 2: Auth Negative Paths
# Phase 3: Out-of-Order Tests

HOST="https://hustlexp-ai-backend-production.up.railway.app"

HUSTLER_TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6Ijk1MTg5MTkxMTA3NjA1NDM0NGUxNWUyNTY0MjViYjQyNWVlYjNhNWMiLCJ0eXAiOiJKV1QifQ.eyJ0ZXN0QWNjb3VudCI6dHJ1ZSwicm9sZSI6Imh1c3RsZXIiLCJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vaHVzdGxleHAtZmx5LW5ldyIsImF1ZCI6Imh1c3RsZXhwLWZseS1uZXciLCJhdXRoX3RpbWUiOjE3NjUzNjA1NDIsInVzZXJfaWQiOiJ0ZXN0LWh1c3RsZXItMDAxIiwic3ViIjoidGVzdC1odXN0bGVyLTAwMSIsImlhdCI6MTc2NTM2MDU0MiwiZXhwIjoxNzY1MzY0MTQyLCJmaXJlYmFzZSI6eyJpZGVudGl0aWVzIjp7fSwic2lnbl9pbl9wcm92aWRlciI6ImN1c3RvbSJ9fQ.Yp2eSly9UjMh32NIiTrd7ZlNzLZjNC6mfrJpkiaQpzNWEpOb0aYnkMjkP5-3xy6hfjAUtxNeA9ur0qo3vpH3slaZyLWH6pgKqtiqmG4g7qSUPxuce6iNFvlzaewPFuo6b30tFOMkNOze00iEboCr9JqWNshEDeMnfSccO-G09Z5yYHyBXXe0Zo5dzs9PUX_vlPQQmHHwFGpndGD_x9pWnS3i3dvE2OgEv2v-4dyxvN5eq0OZHO2YYve92nhswe1ASvDWLOsr5uuRsl5hVkDIQMpE7tQRpBqvLC7DSewNIONvP-53hOnlJCEb8dpcBevnmbKVJQ_dEn0lB0Xb8K82og"

POSTER_TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6Ijk1MTg5MTkxMTA3NjA1NDM0NGUxNWUyNTY0MjViYjQyNWVlYjNhNWMiLCJ0eXAiOiJKV1QifQ.eyJ0ZXN0QWNjb3VudCI6dHJ1ZSwicm9sZSI6InBvc3RlciIsImlzcyI6Imh0dHBzOi8vc2VjdXJldG9rZW4uZ29vZ2xlLmNvbS9odXN0bGV4cC1mbHktbmV3IiwiYXVkIjoiaHVzdGxleHAtZmx5LW5ldyIsImF1dGhfdGltZSI6MTc2NTM2MDU0MiwidXNlcl9pZCI6InRlc3QtcG9zdGVyLTAwMSIsInN1YiI6InRlc3QtcG9zdGVyLTAwMSIsImlhdCI6MTc2NTM2MDU0MiwiZXhwIjoxNzY1MzY0MTQyLCJmaXJlYmFzZSI6eyJpZGVudGl0aWVzIjp7fSwic2lnbl9pbl9wcm92aWRlciI6ImN1c3RvbSJ9fQ.a8X8_mV93CDB_F7C3Sioz4MgzkaH9qAJGGUHzSQYU9pSty2kklnsNcGTXp7jdSdAbneoSHQhI0FMTEXLuhenbaPBZvv_Svx4QUvjxPAaouOQXq-2uMy17Jcx3elvt7r5eqXFIk7doETZOB-zp0fn2UXcJ_a9K6wl7tQBADWUGAGCftd4fTl8VLkbJCO3LWm_-tRC6kgT9taLrtg8TnU8fsOvaT4jZ59N3XmWHirY90Oj6thf8IX96esnHoKB2isY_TZvqQaH2XqBuo0kS8cPwz0BR2j6o3PVFM8cD44lDb4uTG3CNVxF8pBgRJTAvgRSg1NeaAmKBsNxcyKW_4DC8Q"

ADMIN_TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6Ijk1MTg5MTkxMTA3NjA1NDM0NGUxNWUyNTY0MjViYjQyNWVlYjNhNWMiLCJ0eXAiOiJKV1QifQ.eyJ0ZXN0QWNjb3VudCI6dHJ1ZSwicm9sZSI6ImFkbWluIiwiaXNzIjoiaHR0cHM6Ly9zZWN1cmV0b2tlbi5nb29nbGUuY29tL2h1c3RsZXhwLWZseS1uZXciLCJhdWQiOiJodXN0bGV4cC1mbHktbmV3IiwiYXV0aF90aW1lIjoxNzY1MzYwNTQzLCJ1c2VyX2lkIjoidGVzdC1hZG1pbi0wMDEiLCJzdWIiOiJ0ZXN0LWFkbWluLTAwMSIsImlhdCI6MTc2NTM2MDU0MywiZXhwIjoxNzY1MzY0MTQzLCJmaXJlYmFzZSI6eyJpZGVudGl0aWVzIjp7fSwic2lnbl9pbl9wcm92aWRlciI6ImN1c3RvbSJ9fQ.cFnibHwaUbc_JyQDW7jd53c3cgm6akPOTMDuZgvmT2Qf7WhOSzcVwcmHGe58Z3Vl2LJQpZA6suZG5WjMWJEf2cSTdV5b9z29j_ztKEXi6NKVFGdNsvhWKm_QeNvvM2--uQZzar0hGQqcBhpglDHY63a01Vfl74Fes_EwOwE0GUVGbwJ84pRANyqBHuaCK4BRP6bUIdBn8meiqSeB--k_0rjuDFrlf8wfQu23YFhSiJ_CoZDw8TmlriIXgt--5mnJJ5TR_0l5bHkPbkproqX2G_6qD9F8LpUmNu-7fBSHDR9CNUibwWh0dU0P4dm7xE03GfnnSpiHx2RymUDjcDgqvA"

RANDOM_TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6Ijk1MTg5MTkxMTA3NjA1NDM0NGUxNWUyNTY0MjViYjQyNWVlYjNhNWMiLCJ0eXAiOiJKV1QifQ.eyJ0ZXN0QWNjb3VudCI6dHJ1ZSwiaXNzIjoiaHR0cHM6Ly9zZWN1cmV0b2tlbi5nb29nbGUuY29tL2h1c3RsZXhwLWZseS1uZXciLCJhdWQiOiJodXN0bGV4cC1mbHktbmV3IiwiYXV0aF90aW1lIjoxNzY1MzYwNTQzLCJ1c2VyX2lkIjoidGVzdC1yYW5kb20tMDAxIiwic3ViIjoidGVzdC1yYW5kb20tMDAxIiwiaWF0IjoxNzY1MzYwNTQzLCJleHAiOjE3NjUzNjQxNDMsImZpcmViYXNlIjp7ImlkZW50aXRpZXMiOnt9LCJzaWduX2luX3Byb3ZpZGVyIjoiY3VzdG9tIn19.iu4CWEZFN3vbY6J2gBdV425PpHSHFSce8XUSgGi8UZfoff9qkHEmGarpY99vsCXZR0SrDM4Aan25Y9PqppiHYux1PNcoGAhXDQzshyUI9GT_XurLMwes4UN9VpfkgdoN9_whwygztMHMFyUtg77-OLaGvdFNmwYg7jSPiX40_m3pfICVea4wzLsxi969aejTez7H9RaKP17njam5y17slNKnHD8qXu_VDpO3CWarq9q_IT7XA7cQ6cX64X9W9158J2OingpsG7xObc1JbcCV0n_olhqTQ-V2TDMZnduGbgNhhdQz6gll7HKv35fi8qZeQuSFStll0CQQN7Ml2gwTzA"

HUSTLER_UID="test-hustler-001"
POSTER_UID="test-poster-001"

echo "========================================"
echo "GATE-1 NEGATIVE PATH TESTS"
echo "========================================"
echo ""

# Track results
PASS=0
FAIL=0

test_result() {
    local name="$1"
    local expected="$2"
    local actual="$3"
    
    if [[ "$actual" == *"$expected"* ]] || [[ "$actual" == "$expected" ]]; then
        echo "✅ PASS: $name (expected $expected)"
        ((PASS++))
    else
        echo "❌ FAIL: $name (expected $expected, got $actual)"
        ((FAIL++))
    fi
}

echo "=== PHASE 2: AUTH NEGATIVE PATHS ==="
echo ""

# Test 1: Hustler tries escrow/create (should get 403 - wrong role)
echo "TEST 1: Hustler tries escrow/create"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$HOST/api/escrow/create" \
  -H "Authorization: Bearer $HUSTLER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId": "test-task-001", "amount": 4000}')
HTTP_CODE=$(echo "$RESP" | tail -n1)
BODY=$(echo "$RESP" | sed '$d')
echo "Response: $HTTP_CODE - $BODY"
test_result "Hustler escrow/create blocked" "403\|INSUFFICIENT_ROLE" "$RESP"
echo ""

# Test 2: Poster tries connect/create (should get 403 - wrong role)
echo "TEST 2: Poster tries connect/create"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$HOST/api/stripe/connect/create" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId": "test-poster-001", "email": "poster@test.com"}')
HTTP_CODE=$(echo "$RESP" | tail -n1)
BODY=$(echo "$RESP" | sed '$d')
echo "Response: $HTTP_CODE - $BODY"
test_result "Poster connect/create blocked" "403\|INSUFFICIENT_ROLE" "$RESP"
echo ""

# Test 3: No token on escrow/create (should get 401)
echo "TEST 3: No token on escrow/create"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$HOST/api/escrow/create" \
  -H "Content-Type: application/json" \
  -d '{"taskId": "test-task-001", "amount": 4000}')
HTTP_CODE=$(echo "$RESP" | tail -n1)
BODY=$(echo "$RESP" | sed '$d')
echo "Response: $HTTP_CODE - $BODY"
test_result "No token rejected" "401\|MISSING_TOKEN" "$RESP"
echo ""

# Test 4: Random user (no role) tries escrow/create
echo "TEST 4: Random user (no role) tries escrow/create"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$HOST/api/escrow/create" \
  -H "Authorization: Bearer $RANDOM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId": "test-task-001", "amount": 4000}')
HTTP_CODE=$(echo "$RESP" | tail -n1)
echo "Response: $HTTP_CODE"
test_result "No-role user blocked" "403\|401\|INSUFFICIENT" "$RESP"
echo ""

# Test 5: Poster tries payout endpoint (should get 403 - not a hustler)  
echo "TEST 5: Poster tries to access hustler payout status"
RESP=$(curl -s -w "\n%{http_code}" -X GET "$HOST/api/stripe/connect/$HUSTLER_UID/status" \
  -H "Authorization: Bearer $POSTER_TOKEN")
HTTP_CODE=$(echo "$RESP" | tail -n1)
BODY=$(echo "$RESP" | sed '$d')
echo "Response: $HTTP_CODE - $BODY"
test_result "Poster accessing hustler connect blocked" "403\|401\|Unauthorized" "$RESP"
echo ""

echo "=== PHASE 2B: OWNER-BOUNDARY TESTS ==="
echo ""

# Test 6: Random user tries to view hustler's connect status
echo "TEST 6: Random user tries to view hustler's connect status"
RESP=$(curl -s -w "\n%{http_code}" -X GET "$HOST/api/stripe/connect/$HUSTLER_UID/status" \
  -H "Authorization: Bearer $RANDOM_TOKEN")
HTTP_CODE=$(echo "$RESP" | tail -n1)
echo "Response: $HTTP_CODE"
test_result "Random user blocked from hustler status" "403\|401\|Unauthorized" "$RESP"
echo ""

# Test 7: No auth on connect status (should get 401)
echo "TEST 7: Unauthenticated tries connect status"
RESP=$(curl -s -w "\n%{http_code}" -X GET "$HOST/api/stripe/connect/$HUSTLER_UID/status")
HTTP_CODE=$(echo "$RESP" | tail -n1)
echo "Response: $HTTP_CODE"
test_result "Unauthenticated blocked from connect status" "401\|MISSING" "$RESP"
echo ""

echo "=== PHASE 3: OUT-OF-ORDER TESTS ==="
echo ""

# Test 8: Approve before escrow exists
echo "TEST 8: Approve proof before escrow exists"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$HOST/api/proof/validated/nonexistent-task/approve" \
  -H "Authorization: Bearer $POSTER_TOKEN")
HTTP_CODE=$(echo "$RESP" | tail -n1)
BODY=$(echo "$RESP" | sed '$d')
echo "Response: $HTTP_CODE - $BODY"
test_result "Approve non-existent task blocked" "404\|400\|error\|Error" "$RESP"
echo ""

# Test 9: Refund before escrow exists
echo "TEST 9: Refund before escrow exists"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$HOST/api/proof/validated/nonexistent-task/reject" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "test", "action": "refund"}')
HTTP_CODE=$(echo "$RESP" | tail -n1)
echo "Response: $HTTP_CODE"
test_result "Refund non-existent task blocked" "404\|400\|error\|Error" "$RESP"
echo ""

# Test 10: Double escrow create attempt
echo "TEST 10: Double escrow create for same task"
# First create
RESP1=$(curl -s -X POST "$HOST/api/escrow/create" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId": "double-test-task", "amount": 4000}')
echo "First attempt: $RESP1"
# Second create (should be blocked or idempotent)
RESP2=$(curl -s -w "\n%{http_code}" -X POST "$HOST/api/escrow/create" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId": "double-test-task", "amount": 4000}')
HTTP_CODE=$(echo "$RESP2" | tail -n1)
echo "Second attempt: $RESP2"
test_result "Double escrow blocked or idempotent" "exists\|already\|error\|200" "$RESP2"
echo ""

echo "=== PHASE 3B: ADMIN ENDPOINT PROTECTION ==="
echo ""

# Test 11: Non-admin tries admin endpoint
echo "TEST 11: Poster tries admin disputes endpoint"
RESP=$(curl -s -w "\n%{http_code}" -X GET "$HOST/api/admin/disputes" \
  -H "Authorization: Bearer $POSTER_TOKEN")
HTTP_CODE=$(echo "$RESP" | tail -n1)
echo "Response: $HTTP_CODE"
test_result "Non-admin blocked from admin endpoint" "403\|401" "$RESP"
echo ""

# Test 12: Hustler tries admin endpoint
echo "TEST 12: Hustler tries admin users endpoint"
RESP=$(curl -s -w "\n%{http_code}" -X GET "$HOST/api/admin/users" \
  -H "Authorization: Bearer $HUSTLER_TOKEN")
HTTP_CODE=$(echo "$RESP" | tail -n1)
echo "Response: $HTTP_CODE"
test_result "Hustler blocked from admin endpoint" "403\|401" "$RESP"
echo ""

# Test 13: Admin CAN access admin endpoint (positive control)
echo "TEST 13: Admin CAN access admin endpoint"
RESP=$(curl -s -w "\n%{http_code}" -X GET "$HOST/api/admin/disputes" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
HTTP_CODE=$(echo "$RESP" | tail -n1)
echo "Response: $HTTP_CODE"
test_result "Admin can access admin endpoint" "200\|[]\|disputes" "$RESP"
echo ""

# Test 14: No-role user tries admin force-refund
echo "TEST 14: Random user tries admin force-refund"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$HOST/api/admin/tasks/test-task/force-refund" \
  -H "Authorization: Bearer $RANDOM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "test"}')
HTTP_CODE=$(echo "$RESP" | tail -n1)
echo "Response: $HTTP_CODE"
test_result "Random user blocked from force-refund" "403\|401" "$RESP"
echo ""

echo "========================================"
echo "SUMMARY"
echo "========================================"
echo "PASSED: $PASS"
echo "FAILED: $FAIL"
echo ""
if [ $FAIL -eq 0 ]; then
    echo "✅ ALL NEGATIVE PATH TESTS PASSED"
else
    echo "❌ SOME TESTS FAILED - REVIEW REQUIRED"
fi
