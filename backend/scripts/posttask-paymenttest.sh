#!/usr/bin/env bash

set -euo pipefail

echo "LEGACY_NON_EXECUTABLE: pay-first quote creation/finalization is tombstoned; use the Universal V1 fake-finance lifecycle." >&2
exit 78

BASE_URL="http://localhost:5000"
AUTH_TOKEN="JWT BEARER TOKEN HERE"

SUBMISSION_ID="$(cat /proc/sys/kernel/random/uuid)"

echo "==> 1. Creating task draft + quote..."

POSTTASK_RESPONSE="$(
  curl -X POST 'http://localhost:5000/trpc/webPostTask.start' \
  -H 'content-type: application/json' \
  --data-raw "{
    \"lead\": {
      \"submission_id\": \"$(uuidgen)\",
      \"lead_type\": \"poster\",
      \"email\": \"martin-test@hustlexp.app\",
      \"name\": \"Martin Test\",
      \"phone\": \"+15550009999\",
      \"region\": \"WA\",
      \"zip\": \"98004\",
      \"answers\": {
        \"preferred_contact\": \"email\",
        \"company\": false,
        \"returning_customer\": false
      },
      \"utm\": {
        \"source\": \"linkedin\",
        \"medium\": \"social\",
        \"campaign\": \"backend-test\",
        \"content\": \"post-task-flow\"
      },
      \"consent_version\": \"v1\",
      \"ip_hash\": \"optional-precomputed-sha256\"
    },

    \"task\": {
      \"category\": \"yard\",
      \"title\": \"Ground-level yard cleanup\",
      \"raw_input\": \"Ground-level yard cleanup and haul away the debris. Clear leaves, trim light overgrowth, and remove yard waste.\",
      \"scope_summary\": \"Basic residential yard cleanup including leaf removal, light trimming, and debris haul-away.\",
      \"structured\": {
        \"answers\": {
          \"preferred_window\": \"this_week\",
          \"risk_level\": \"green\",
          \"required_worker_count\": \"1\",
          \"required_vehicle\": \"cargo_vehicle\",
          \"required_tools\": [
            \"yard_tools\"
          ],
          \"included_work\": [
            \"Remove leaves\",
            \"Trim light overgrowth\",
            \"Haul away yard debris\"
          ],
          \"excluded_work\": [
            \"Tree removal\",
            \"Stump grinding\"
          ],
          \"safety_restrictions\": [],
          \"debris\": \"haul_away\",
          \"equipment_provided\": \"no\",
          \"pressure_washing\": \"yes\",
          \"scope_policy_version\": \"task_scope_v1\",
          \"scope_confirmed_at\": \"$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")\"
        },
        \"missing_questions\": [],
        \"risk_flags\": [],
        \"scope_confirmed\": true
      },
      \"est_price_min_cents\": 5000,
      \"est_price_max_cents\": 9000,
      \"photo_count\": 3,
      \"zip\": \"98004\",
      \"region\": \"WA\",
      \"source\": \"website\",
      \"utm\": {
        \"source\": \"linkedin\",
        \"medium\": \"social\",
        \"campaign\": \"backend-test\"
      },
      \"ip_hash\": \"optional-precomputed-sha256\"
    }
  }"
)"

echo "$POSTTASK_RESPONSE" | jq .

echo "POSTTASK_RESPONSE:"
echo "$POSTTASK_RESPONSE" | jq .

echo
echo "EXTRACTED QUOTE_ID:"
echo "$POSTTASK_RESPONSE" | jq -r '.result.data.quote.quoteId'

echo "EXTRACTED VERSION_ID:"
echo "$POSTTASK_RESPONSE" | jq -r '.result.data.quote.versionId'

QUOTE_ID="$(echo "$POSTTASK_RESPONSE" | jq -r '.result.data.quote.quoteId')"
QUOTE_VERSION_ID="$(echo "$POSTTASK_RESPONSE" | jq -r '.result.data.quote.versionId')"

if [[ -z "$QUOTE_ID" || "$QUOTE_ID" == "null" ]]; then
  echo "ERROR: quoteId missing"
  exit 1
fi

if [[ -z "$QUOTE_VERSION_ID" || "$QUOTE_VERSION_ID" == "null" ]]; then
  echo "ERROR: quoteVersionId missing"
  exit 1
fi

echo
echo "Quote: $QUOTE_ID"
echo "Quote version: $QUOTE_VERSION_ID"

echo
echo "==> 2. Creating quote payment..."

PAYMENT_RESPONSE="$(
  curl -sS -X POST \
    "$BASE_URL/trpc/quotePayment.createPaymentIntent" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    --data-raw "{
      \"quoteId\": \"$QUOTE_ID\",
      \"quoteVersionId\": \"$QUOTE_VERSION_ID\"
    }"
)"

echo "$PAYMENT_RESPONSE" | jq .

PAYMENT_INTENT_ID="$(echo "$PAYMENT_RESPONSE" | jq -r '.result.data.paymentIntentId')"

if [[ -z "$PAYMENT_INTENT_ID" || "$PAYMENT_INTENT_ID" == "null" ]]; then
  echo "ERROR: paymentIntentId missing"
  exit 1
fi

echo
echo "PaymentIntent: $PAYMENT_INTENT_ID"

echo
echo "==> 3. Confirm test payment..."

CONFIRM_RESPONSE="$(
  curl -sS -X POST \
    "$BASE_URL/trpc/quotePayment.confirmTestPayment" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    --data-raw "{
      \"paymentIntentId\": \"$PAYMENT_INTENT_ID\"
    }"
)"

echo "$CONFIRM_RESPONSE" | jq .

PAYMENT_STATUS="$(echo "$CONFIRM_RESPONSE" | jq -r '.result.data.status')"

if [[ "$PAYMENT_STATUS" != "succeeded" ]]; then
  echo "ERROR: payment did not succeed"
  exit 1
fi

echo
echo "==> 4. Finalizing paid quote..."

FINALIZE_RESPONSE="$(
  curl -sS -X POST \
    "$BASE_URL/trpc/quotePayment.finalize" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    --data-raw "{
      \"quoteId\": \"$QUOTE_ID\",
      \"quoteVersionId\": \"$QUOTE_VERSION_ID\",
      \"paymentIntentId\": \"$PAYMENT_INTENT_ID\"
    }"
)"

echo "$FINALIZE_RESPONSE" | jq .

TASK_ID="$(echo "$FINALIZE_RESPONSE" | jq -r '.result.data.taskId')"
ESCROW_ID="$(echo "$FINALIZE_RESPONSE" | jq -r '.result.data.escrowId')"

if [[ -z "$TASK_ID" || "$TASK_ID" == "null" ]]; then
  echo "ERROR: taskId missing from finalization"
  exit 1
fi

if [[ -z "$ESCROW_ID" || "$ESCROW_ID" == "null" ]]; then
  echo "ERROR: escrowId missing from finalization"
  exit 1
fi

echo
echo "========================================"
echo "PAYMENT E2E TEST SUCCESS"
echo "========================================"
echo "Quote:          $QUOTE_ID"
echo "Quote version:  $QUOTE_VERSION_ID"
echo "Payment:        $PAYMENT_INTENT_ID"
echo "Task:           $TASK_ID"
echo "Escrow:         $ESCROW_ID"
echo "========================================"
