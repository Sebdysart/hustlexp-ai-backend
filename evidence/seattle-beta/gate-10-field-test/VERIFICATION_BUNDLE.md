# Gate 10: Field Test — Verification Bundle

**FINAL GATE: Real users, real tasks, real money.**

---

## Prerequisites

- [ ] Gates 1-9 PASSED
- [ ] 3-5 trusted testers identified
- [ ] App installed on their devices
- [ ] Testers have valid payment methods
- [ ] Testers are physically in Seattle

---

# Test Cohort

| Tester | Role | Device | Location | Contact |
|--------|------|--------|----------|---------|
| Tester 1 | Poster | iPhone | Capitol Hill | |
| Tester 2 | Hustler | Android | Ballard | |
| Tester 3 | Both | iPhone | U-District | |

---

# ITEM 10.1: Full End-to-End Flow

## Test Procedure (Per Tester Pair)

### Step 1: Poster Creates Task

**Action:**
1. Open app as Poster
2. Create task: "Help move boxes" for $40
3. Confirm escrow charge

**Evidence Required:**
- [ ] Screenshot: Task created in app
- [ ] Screenshot: Stripe PaymentIntent (Dashboard)
- [ ] DB Query: `SELECT * FROM tasks WHERE id = '[TASK_ID]'`

---

### Step 2: Hustler Accepts Task

**Action:**
1. Open app as Hustler
2. Find task in feed
3. Accept task

**Evidence Required:**
- [ ] Screenshot: Task accepted in app
- [ ] DB Query: `SELECT hustler_id, status FROM tasks WHERE id = '[TASK_ID]'`

---

### Step 3: Hustler Completes Work (Physical)

**Action:**
1. Hustler physically goes to location
2. Completes the work
3. Takes photo as proof

**Evidence Required:**
- [ ] Photo: Actual proof photo from field
- [ ] GPS coordinates confirm Seattle

---

### Step 4: Hustler Submits Proof

**Action:**
1. Submit proof in app with photo
2. GPS captured

**Evidence Required:**
- [ ] Screenshot: Proof submitted screen
- [ ] R2 Check: Photo URL accessible
- [ ] DB Query: `SELECT * FROM proof_photos WHERE task_id = '[TASK_ID]'`

---

### Step 5: Poster Reviews & Approves

**Action:**
1. Poster views proof
2. Approves work

**Evidence Required:**
- [ ] Screenshot: Approval screen
- [ ] DB Query: `SELECT status FROM proof_photos WHERE task_id = '[TASK_ID]'` — should be 'approved'

---

### Step 6: Payout Released

**Action:**
1. System releases escrow
2. Transfer to Hustler's Connect account

**Evidence Required:**
- [ ] Screenshot: Stripe Transfer (Dashboard)
- [ ] DB Query: `SELECT status FROM escrow WHERE task_id = '[TASK_ID]'` — should be 'released'
- [ ] DB Query: `SELECT * FROM payouts WHERE task_id = '[TASK_ID]'`

---

### Step 7: Hustler Sees Earnings

**Action:**
1. Hustler checks earnings in app
2. Confirms amount

**Evidence Required:**
- [ ] Screenshot: Earnings screen showing payout

---

## Test Runs

### Run 1: Poster A → Hustler B

| Step | Status | Screenshot | DB Verified | Stripe Verified |
|------|--------|------------|-------------|-----------------|
| 1. Create task | ⬜ | ⬜ | ⬜ | ⬜ |
| 2. Accept task | ⬜ | ⬜ | ⬜ | |
| 3. Physical work | ⬜ | ⬜ | | |
| 4. Submit proof | ⬜ | ⬜ | ⬜ | |
| 5. Approve proof | ⬜ | ⬜ | ⬜ | |
| 6. Payout released | ⬜ | | ⬜ | ⬜ |
| 7. Earnings visible | ⬜ | ⬜ | | |

---

### Run 2: Poster B → Hustler C

| Step | Status | Screenshot | DB Verified | Stripe Verified |
|------|--------|------------|-------------|-----------------|
| 1. Create task | ⬜ | ⬜ | ⬜ | ⬜ |
| 2. Accept task | ⬜ | ⬜ | ⬜ | |
| 3. Physical work | ⬜ | ⬜ | | |
| 4. Submit proof | ⬜ | ⬜ | ⬜ | |
| 5. Approve proof | ⬜ | ⬜ | ⬜ | |
| 6. Payout released | ⬜ | | ⬜ | ⬜ |
| 7. Earnings visible | ⬜ | ⬜ | | |

---

### Run 3: Poster C → Hustler A

| Step | Status | Screenshot | DB Verified | Stripe Verified |
|------|--------|------------|-------------|-----------------|
| 1. Create task | ⬜ | ⬜ | ⬜ | ⬜ |
| 2. Accept task | ⬜ | ⬜ | ⬜ | |
| 3. Physical work | ⬜ | ⬜ | | |
| 4. Submit proof | ⬜ | ⬜ | ⬜ | |
| 5. Approve proof | ⬜ | ⬜ | ⬜ | |
| 6. Payout released | ⬜ | | ⬜ | ⬜ |
| 7. Earnings visible | ⬜ | ⬜ | | |

---

## Issues Log

| Issue | Severity | Description | Resolution | Status |
|-------|----------|-------------|------------|--------|
| | | | | |
| | | | | |

---

## Gate 10 Summary

| Run | All 7 Steps | Evidence Complete |
|-----|-------------|-------------------|
| Run 1 | ⬜ | ⬜ |
| Run 2 | ⬜ | ⬜ |
| Run 3 | ⬜ | ⬜ |

**Gate 10 Status:** ⬜ **NOT PASSED** / ✅ **PASSED**

---

## Final Signoff

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Field Test Lead | | | |
| Engineering | | | |
| Product | | | |

---

## Post-Test Debrief Questions

1. Any confusion during the flow?
2. Any unexpected errors?
3. How long did each step take?
4. Any UI/UX issues?
5. Would you use this in real life?

---

*Bundle version: 1.0*
