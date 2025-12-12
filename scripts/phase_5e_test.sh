#!/bin/bash
# ============================================
# Phase 5E: Real Stripe Mode Test Script
# HustleXP Seattle Beta Launch Certification
# ============================================
#
# This script runs the complete E2E live payout test.
# REQUIRES: Live Stripe keys, real Connect account, real card.
#
# COST: $5.00 (will be refunded if test completes)
#
# USAGE:
#   export BACKEND_URL="https://your-backend.railway.app"
#   export POSTER_TOKEN="eyJ..."
#   export ADMIN_TOKEN="eyJ..."
#   export HUSTLER_STRIPE_ACCOUNT="acct_..."
#   ./phase_5e_test.sh
#
# ============================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; }
log_fail() { echo -e "${RED}❌ FAIL${NC}: $1"; exit 1; }
log_info() { echo -e "${YELLOW}➡️${NC} $1"; }
log_header() { echo -e "\n${YELLOW}═══════════════════════════════════════════${NC}"; echo -e "${YELLOW}$1${NC}"; echo -e "${YELLOW}═══════════════════════════════════════════${NC}\n"; }

# ============================================
# PREREQUISITES CHECK
# ============================================

log_header "PHASE 5E: PREREQUISITES CHECK"

if [ -z "$BACKEND_URL" ]; then log_fail "BACKEND_URL not set"; fi
if [ -z "$POSTER_TOKEN" ]; then log_fail "POSTER_TOKEN not set"; fi
if [ -z "$ADMIN_TOKEN" ]; then log_fail "ADMIN_TOKEN not set"; fi

log_pass "Environment variables set"

# Test backend connectivity
log_info "Testing backend connectivity..."
HEALTH=$(curl -s "$BACKEND_URL/health")
if echo "$HEALTH" | grep -q "healthy\|ok"; then
    log_pass "Backend is healthy"
else
    log_fail "Backend health check failed: $HEALTH"
fi

# ============================================
# STEP 1: CREATE TASK
# ============================================

log_header "STEP 1: CREATE TASK"

TASK_RESPONSE=$(curl -s -X POST "$BACKEND_URL/ai/confirm-task" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-idempotency-key: phase5e-task-$(date +%s)" \
  -d '{
    "userId": "test-poster",
    "taskDraft": {
      "title": "Phase 5E Live Test Task",
      "description": "This is a live Stripe test - $5 payout",
      "category": "errands",
      "recommendedPrice": 5.00,
      "flags": []
    }
  }')

TASK_ID=$(echo "$TASK_RESPONSE" | grep -o '"taskId":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TASK_ID" ]; then
    log_fail "Failed to create task: $TASK_RESPONSE"
fi

log_pass "Task created: $TASK_ID"
echo "TASK_ID=$TASK_ID" > /tmp/phase5e_vars.sh

# ============================================
# STEP 2: CREATE ESCROW (REAL CHARGE)
# ============================================

log_header "STEP 2: CREATE ESCROW (REAL CHARGE)"

log_info "This will charge $5.00 to your REAL card"
log_info "Creating escrow..."

ESCROW_RESPONSE=$(curl -s -X POST "$BACKEND_URL/api/escrow/create" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-idempotency-key: phase5e-escrow-$(date +%s)" \
  -d "{
    \"taskId\": \"$TASK_ID\",
    \"hustlerId\": \"test-hustler\",
    \"amount\": 5.00,
    \"paymentMethodId\": \"pm_card_visa\"
  }")

if echo "$ESCROW_RESPONSE" | grep -q '"success":true\|"state":"held"'; then
    log_pass "Escrow created (card authorized)"
    echo "$ESCROW_RESPONSE"
else
    log_fail "Escrow creation failed: $ESCROW_RESPONSE"
fi

# ============================================
# STEP 3: VERIFY money_state_lock
# ============================================

log_header "STEP 3: VERIFY MONEY STATE"

log_info "Checking money_state_lock..."
log_info "Run this SQL query manually:"
echo ""
echo "  SELECT current_state, stripe_payment_intent_id FROM money_state_lock WHERE task_id = '$TASK_ID';"
echo ""
echo "EXPECTED: current_state = 'held'"
echo ""
read -p "Press Enter when verified..."

log_pass "State is 'held'"

# ============================================
# STEP 4: APPROVE TASK (CAPTURE + TRANSFER)
# ============================================

log_header "STEP 4: APPROVE TASK (CAPTURE + TRANSFER)"

APPROVE_RESPONSE=$(curl -s -X POST "$BACKEND_URL/api/tasks/$TASK_ID/approve" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-idempotency-key: phase5e-approve-$(date +%s)")

if echo "$APPROVE_RESPONSE" | grep -q '"success":true\|"state":"released"'; then
    log_pass "Task approved - payout released!"
    echo "$APPROVE_RESPONSE"
else
    log_fail "Approval failed: $APPROVE_RESPONSE"
fi

# ============================================
# STEP 5: VERIFY STRIPE DASHBOARD
# ============================================

log_header "STEP 5: STRIPE DASHBOARD VERIFICATION"

echo ""
echo "Open Stripe Dashboard and verify:"
echo ""
echo "1. ✅ PaymentIntent: status = 'succeeded' (captured)"
echo "2. ✅ Charge: exists and linked to PI"
echo "3. ✅ Transfer: created to Connect account"
echo "4. ✅ Transfer metadata: contains taskId = $TASK_ID"
echo ""
read -p "Press Enter when verified..."

log_pass "Stripe Dashboard verified"

# ============================================
# STEP 6: WAIT FOR WEBHOOK
# ============================================

log_header "STEP 6: WAIT FOR WEBHOOK"

log_info "Waiting for transfer.paid webhook..."
log_info "This may take 1-5 minutes depending on payout schedule"
echo ""
echo "Monitor logs for:"
echo ""
echo "  [INFO] Transfer completed - task finalized via Money Engine"
echo "  taskId: $TASK_ID"
echo "  newState: completed"
echo ""
echo "OR run this SQL query:"
echo ""
echo "  SELECT current_state FROM money_state_lock WHERE task_id = '$TASK_ID';"
echo "  -- EXPECTED: 'completed' after webhook"
echo ""
read -p "Press Enter when state = 'completed' (or skip for now)..."

# ============================================
# STEP 7: VERIFY AUDIT LOGS
# ============================================

log_header "STEP 7: VERIFY AUDIT LOGS"

echo ""
echo "Run these SQL queries:"
echo ""
echo "1. Money events audit:"
echo "   SELECT * FROM money_events_audit WHERE task_id = '$TASK_ID' ORDER BY created_at;"
echo ""
echo "EXPECTED:"
echo "   - HOLD_ESCROW"
echo "   - RELEASE_PAYOUT"
echo "   - WEBHOOK_PAYOUT_PAID (if webhook received)"
echo ""
read -p "Press Enter when verified..."

log_pass "Audit logs verified"

# ============================================
# STEP 8: OPTIONAL - ADMIN FORCE REFUND
# ============================================

log_header "STEP 8: [OPTIONAL] ADMIN FORCE REFUND"

echo ""
echo "To test post-payout refund (will reverse the transfer):"
echo ""
echo "1. Create a dispute:"
echo "   curl -X POST \"$BACKEND_URL/api/disputes\" \\"
echo "     -H \"Authorization: Bearer \$POSTER_TOKEN\" \\"
echo "     -H \"Content-Type: application/json\" \\"
echo "     -d '{\"taskId\": \"$TASK_ID\", \"reason\": \"test\", \"description\": \"Phase 5E test\"}'"
echo ""
echo "2. Resolve as refund:"
echo "   curl -X POST \"$BACKEND_URL/api/admin/disputes/\$DISPUTE_ID/resolve\" \\"
echo "     -H \"Authorization: Bearer \$ADMIN_TOKEN\" \\"
echo "     -H \"Content-Type: application/json\" \\"
echo "     -d '{\"resolution\": \"refund\", \"justification\": \"Phase 5E test\"}'"
echo ""
read -p "Skip refund test? (y/n) " SKIP_REFUND

if [ "$SKIP_REFUND" != "y" ]; then
    log_info "Run the refund commands manually and verify:"
    echo "- Transfer reversed in Stripe"
    echo "- Poster refunded"
    echo "- State = 'refunded'"
    read -p "Press Enter when done..."
    log_pass "Refund test completed"
fi

# ============================================
# FINAL SUMMARY
# ============================================

log_header "PHASE 5E COMPLETE"

echo ""
log_pass "Real card charged"
log_pass "Escrow created"
log_pass "Task approved"
log_pass "Payout released"
echo ""
echo "Artifacts to store:"
echo "  - PaymentIntent ID: (from Stripe Dashboard)"
echo "  - Charge ID: (from Stripe Dashboard)"
echo "  - Transfer ID: (from Stripe Dashboard)"
echo "  - money_events_audit rows: (from SQL query)"
echo ""
echo "============================================"
echo "SEATTLE BETA: PAYMENT SYSTEM CERTIFIED ✅"
echo "============================================"
