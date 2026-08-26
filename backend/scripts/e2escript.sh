#!/usr/bin/env bash

set -euo pipefail

BASE_URL="http://localhost:5000"
MY_AUTH_TOKEN=$(../myscripts/getToken.sh | jq -r '.idToken')
BUSINESS_AUTH_TOKEN=$(../myscripts/getbusinesstoken.sh | jq -r '.idToken')


echo "==> 1. Creating link claim..."

taskDraftId=$(../myscripts/posttask.sh | jq -r '.result.data.taskDraftId')

token=$(curl -sS -X POST \
  "$BASE_URL/trpc/webOps.createBusinessClaimLink" \
  -H "Authorization: Bearer $MY_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw "{
    \"task_draft_id\": \"$taskDraftId\",
    \"expires_in_hours\": 72
  }" | jq -r '.result.data.token')

read quoteId quoteVersionId < <(
  curl -sS -X POST \
    "$BASE_URL/trpc/businessClaim.claim" \
    -H "Authorization: Bearer $BUSINESS_AUTH_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-raw "{
      \"token\": \"$token\",
      \"organizationId\": \"56cac28c-fac0-4b94-91c1-f636055843b3\",
      \"serviceProfileId\": \"5c316529-9541-401a-b538-70a18ae06287\",
      \"businessLocationId\": \"4b53be05-79c5-41a2-add8-247cd748ea06\",
      \"proposedCustomerTotalCents\": 25100,
      \"proposedPayoutCents\": 20000
    }" |
    jq -r '.result.data | "\(.quoteId) \(.quoteVersionId)"'
)

echo "==> 2. Creating quote payment..."

PAYMENT_RESPONSE="$(
  curl -sS -X POST \
    "$BASE_URL/trpc/quotePayment.createPaymentIntent" \
    -H "Authorization: Bearer $MY_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    --data-raw "{
      \"quoteId\": \"$quoteId\",
      \"quoteVersionId\": \"$quoteVersionId\"
    }"
)"
echo "$PAYMENT_RESPONSE"
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
    -H "Authorization: Bearer $MY_AUTH_TOKEN" \
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
    -H "Authorization: Bearer $MY_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    --data-raw "{
      \"quoteId\": \"$quoteId\",
      \"quoteVersionId\": \"$quoteVersionId\",
      \"paymentIntentId\": \"$PAYMENT_INTENT_ID\"
    }"
)"
echo "$FINALIZE_RESPONSE"
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
echo "Quote:          $quoteId"
echo "Quote version:  $quoteVersionId"
echo "Payment:        $PAYMENT_INTENT_ID"
echo "Task:           $TASK_ID"
echo "Escrow:         $ESCROW_ID"
echo "========================================"

echo
echo "==> 5. Starting task manually as business..."

START_RESPONSE="$(
  curl -sS -X POST \
    "$BASE_URL/trpc/task.startManualBusiness" \
    -H "Authorization: Bearer $BUSINESS_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    --data-raw "{
      \"taskId\": \"$TASK_ID\"
    }"
)"

echo "$START_RESPONSE" | jq .

ACTIVE_SCOPE_VERSION_ID="$(echo "$START_RESPONSE" | jq -r '.result.data.active_scope_version_id')"
SCOPE_HASH="$(echo "$START_RESPONSE" | jq -r '.result.data.scope_hash')"

echo
echo "==> Task started successfully."

FILE="image.jpg"

if [[ ! -f "$FILE" ]]; then
  echo "ERROR: File not found: $FILE" >&2
  exit 1
fi

case "${FILE,,}" in
  *.jpg|*.jpeg)
    ;;
  *)
    echo "ERROR: File must be a JPEG (.jpg or .jpeg)" >&2
    exit 1
    ;;
esac

FILE_SIZE="$(stat -c%s "$FILE")"
FILENAME="$(basename "$FILE")"

echo
echo "==> 6. Requesting upload receipt..."
echo "File: $FILENAME"
echo "Size: $FILE_SIZE bytes"
echo "Task: $TASK_ID"

UPLOAD_RESPONSE="$(
  curl -sS -X POST \
    "$BASE_URL/trpc/upload.getPresignedUrl" \
    -H "Authorization: Bearer $BUSINESS_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    --data-raw "{
      \"taskId\": \"$TASK_ID\",
      \"filename\": \"$FILENAME\",
      \"contentType\": \"image/jpeg\",
      \"fileSize\": $FILE_SIZE,
      \"purpose\": \"proof\"
    }"
)"

echo "$UPLOAD_RESPONSE" | jq .

UPLOAD_URL="$(echo "$UPLOAD_RESPONSE" | jq -r '.result.data.uploadUrl')"
RECEIPT_ID="$(echo "$UPLOAD_RESPONSE" | jq -r '.result.data.receiptId')"

if [[ -z "$UPLOAD_URL" || "$UPLOAD_URL" == "null" ]]; then
  echo "ERROR: uploadUrl missing" >&2
  exit 1
fi

if [[ -z "$RECEIPT_ID" || "$RECEIPT_ID" == "null" ]]; then
  echo "ERROR: receiptId missing" >&2
  exit 1
fi

echo
echo "==> 7. Uploading JPEG..."
echo "Receipt ID: $RECEIPT_ID"

curl -sS --fail-with-body -X PUT \
  -H "Content-Type: image/jpeg" \
  --data-binary "@$FILE" \
  "$UPLOAD_URL"

echo
echo "==> JPEG uploaded successfully."

echo
echo "==> 8. Finalizing upload..."

sleep 15

UPLOAD_FINALIZE_RESPONSE="$(
  curl -sS -X POST \
    "$BASE_URL/trpc/upload.finalizeImageUpload" \
    -H "Authorization: Bearer $BUSINESS_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    --data-raw "{
      \"taskId\": \"$TASK_ID\",
      \"receiptId\": \"$RECEIPT_ID\",
      \"purpose\": \"proof\"
    }"
)"

echo "$UPLOAD_FINALIZE_RESPONSE" | jq .

UPLOAD_RECEIPT_ID="$(echo "$UPLOAD_FINALIZE_RESPONSE" | jq -r '.result.data.uploadReceiptId')"
CHECKSUM_SHA256="$(echo "$UPLOAD_FINALIZE_RESPONSE" | jq -r '.result.data.checksumSha256')"
FINAL_CONTENT_TYPE="$(echo "$UPLOAD_FINALIZE_RESPONSE" | jq -r '.result.data.contentType')"
FINAL_FILE_SIZE="$(echo "$UPLOAD_FINALIZE_RESPONSE" | jq -r '.result.data.fileSizeBytes')"

echo
echo "========================================"
echo "TASK START + PROOF UPLOAD SUCCESS"
echo "========================================"
echo "Task:       $TASK_ID"
echo "Receipt:    $RECEIPT_ID"
echo "File:       $FILENAME"
echo "File size:  $FILE_SIZE bytes"
echo "========================================"


for ((i=0; i<=7; i++)); do
  echo "==> Completing checklist item $i..."

  curl -sS -X POST \
    "http://localhost:5000/trpc/task.setScopeChecklistItem" \
    -H "Authorization: Bearer $BUSINESS_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    --data-raw "{
      \"taskId\": \"$TASK_ID\",
      \"versionId\": \"$ACTIVE_SCOPE_VERSION_ID\",
      \"itemIndex\": $i,
      \"completed\": true
    }"

  echo
done

echo
echo "==> 9. Submitting proof..."

SUBMIT_PROOF_RESPONSE="$(
  curl -sS -X POST \
    "$BASE_URL/trpc/task.submitProof" \
    -H "Authorization: Bearer $BUSINESS_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    --data-raw "{
      \"taskId\": \"$TASK_ID\",
      \"description\": \"Business completed the approved yard cleanup.\",
      \"photoEvidence\": [
	  {
	    \"uploadReceiptId\": \"$UPLOAD_RECEIPT_ID\",
	    \"contentType\": \"$FINAL_CONTENT_TYPE\",
	    \"fileSizeBytes\": $FINAL_FILE_SIZE,
	    \"checksumSha256\": \"$CHECKSUM_SHA256\"
	  }
	],
      \"scopeVersionId\": \"$ACTIVE_SCOPE_VERSION_ID\",
      \"scopeHash\": \"$SCOPE_HASH\"
    }"
)"

echo "$SUBMIT_PROOF_RESPONSE" | jq .

echo "==> 10. Completing task $TASK_ID..."

curl -sS -X POST \
  "$BASE_URL/trpc/task.complete" \
  -H "Authorization: Bearer $MY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  --data-raw "{
    \"taskId\": \"$TASK_ID\"
  }" | jq .

echo
echo "==> Done."