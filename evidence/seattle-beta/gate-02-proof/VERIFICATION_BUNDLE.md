# Gate 2: Proof & GPS — Verification Bundle

**Reusable verification scripts for photo upload and GPS validation.**

---

## Prerequisites

```bash
export HOST="https://your-backend.railway.app"
export HUSTLER_TOKEN="your-firebase-hustler-token"
export POSTER_TOKEN="your-firebase-poster-token"
export TASK_ID="test-task-uuid"

# Test coordinates
export SEATTLE_LAT="47.625"
export SEATTLE_LNG="-122.315"
export LA_LAT="34.0522"
export LA_LNG="-118.2437"
```

---

## Item 2.1: Photo Upload to R2

### Test Procedure

```bash
# Create base64 test image (or use a real photo)
export PHOTO_BASE64=$(echo "iVBORw0KGgo..." | head -c 1000)

curl -X POST "$HOST/api/proof/validated/submit" \
  -H "Authorization: Bearer $HUSTLER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "'$TASK_ID'",
    "lat": '$SEATTLE_LAT',
    "lng": '$SEATTLE_LNG',
    "accuracy": 10,
    "photoBase64": "data:image/jpeg;base64,'$PHOTO_BASE64'",
    "caption": "Task completed - verification test"
  }'
```

### Expected Output (PASS)

```json
{
  "success": true,
  "proofId": "proof_xxxxx",
  "photoUrl": "https://[bucket].r2.cloudflarestorage.com/proofs/[task_id]/[filename].jpg",
  "status": "pending_approval"
}
```

### Expected Output (FAIL)

```json
{
  "error": "Upload failed",
  "details": "R2 connection error"
}
```

### Verification

```bash
# Verify R2 URL is accessible
curl -I "[photoUrl from response]"
# Expected: HTTP 200
```

### DB Verification

```sql
SELECT id, task_id, photo_url, status, lat, lng, zone
FROM proof_photos
WHERE task_id = '[TASK_ID]'
ORDER BY created_at DESC
LIMIT 1;
```

**Expected:** Row exists with `photo_url` populated, `status` = 'pending'

### Cloudflare Dashboard Check

1. Go to: https://dash.cloudflare.com → R2 → your bucket
2. Navigate to `proofs/[task_id]/`
3. Verify image file exists

### Screenshot Required

- [ ] Cloudflare R2 → Bucket → proofs folder showing uploaded file

---

## Item 2.2: GPS Validation (Seattle Bounds)

### Test Procedure (INSIDE Seattle)

```bash
curl -X POST "$HOST/api/proof/validated/submit" \
  -H "Authorization: Bearer $HUSTLER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "'$TASK_ID'",
    "lat": 47.625,
    "lng": -122.315,
    "accuracy": 10,
    "photoBase64": "...",
    "caption": "Capitol Hill test"
  }'
```

### Expected Output (PASS - Inside Seattle)

```json
{
  "success": true,
  "proofId": "...",
  "zone": "capitol_hill",
  "city": "seattle"
}
```

### Test Procedure (OUTSIDE Seattle)

```bash
curl -X POST "$HOST/api/proof/validated/submit" \
  -H "Authorization: Bearer $HUSTLER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "'$TASK_ID'",
    "lat": 34.0522,
    "lng": -118.2437,
    "accuracy": 10,
    "photoBase64": "...",
    "caption": "LA test - should fail"
  }'
```

### Expected Output (PASS - Rejection)

```json
{
  "success": false,
  "error": "LOCATION_OUT_OF_BOUNDS",
  "message": "Proof location must be within Seattle area"
}
```

### Expected Output (FAIL)

LA coordinates accepted (this would be a bug)

---

## Item 2.3: Zone Detection

### Test Procedure

```bash
# Capitol Hill
curl -X POST "$HOST/api/location/resolve" \
  -H "Content-Type: application/json" \
  -d '{"lat": 47.625, "lng": -122.315}'

# Ballard
curl -X POST "$HOST/api/location/resolve" \
  -H "Content-Type: application/json" \
  -d '{"lat": 47.675, "lng": -122.38}'

# U-District
curl -X POST "$HOST/api/location/resolve" \
  -H "Content-Type: application/json" \
  -d '{"lat": 47.66, "lng": -122.31}'
```

### Expected Outputs (PASS)

Capitol Hill:
```json
{
  "city": {"id": "city_seattle", "name": "Seattle"},
  "zone": {"id": "zone_capitol_hill", "name": "Capitol Hill"},
  "inCoverage": true
}
```

Ballard:
```json
{
  "city": {"id": "city_seattle", "name": "Seattle"},
  "zone": {"id": "zone_ballard", "name": "Ballard"},
  "inCoverage": true
}
```

### FAIL Criteria

- Wrong zone returned
- `zone: null` for Seattle coords
- `inCoverage: false` for Seattle coords

---

## Item 2.4: Proof Approval → Payout Chain

### Test Procedure

```bash
# Poster approves proof
curl -X POST "$HOST/api/proof/validated/$TASK_ID/approve" \
  -H "Authorization: Bearer $POSTER_TOKEN"
```

### Expected Output (PASS)

```json
{
  "success": true,
  "payoutId": "po_xxxxx",
  "transferId": "tr_xxxxx",
  "amount": 3400
}
```

### Chain Verification

```sql
-- 1. Proof status
SELECT status FROM proof_photos WHERE task_id = '[TASK_ID]';
-- Expected: 'approved'

-- 2. Task status
SELECT status FROM tasks WHERE id = '[TASK_ID]';
-- Expected: 'completed'

-- 3. Escrow status
SELECT status, released_at, stripe_transfer_id FROM escrow WHERE task_id = '[TASK_ID]';
-- Expected: 'released', released_at populated

-- 4. Payout exists
SELECT * FROM payouts WHERE task_id = '[TASK_ID]';
-- Expected: Row exists
```

### FAIL Criteria

- Proof approved but escrow not released
- Task not marked completed
- No transfer in Stripe
- Payout record missing

---

## Evidence Checklist

| Item | Description | Screenshot | DB Query | Verified By | Date |
|------|-------------|------------|----------|-------------|------|
| 2.1 | Photo uploaded to R2 | ⬜ | ⬜ | | |
| 2.2 | GPS validation (accept/reject) | ⬜ | ⬜ | | |
| 2.3 | Zone detection | ⬜ | ⬜ | | |
| 2.4 | Approval → payout chain | ⬜ | ⬜ | | |

**Gate 2 Status:** ⬜ NOT PASSED / ✅ PASSED

---

## Failure Examples

### 2.1 Upload FAIL
```json
{
  "error": "R2_UPLOAD_FAILED",
  "details": "Missing credentials"
}
```

### 2.2 GPS FAIL (bug)
LA coordinates accepted:
```json
{
  "success": true,
  "zone": null  // Should have been rejected
}
```

---

*Bundle version: 1.0*
