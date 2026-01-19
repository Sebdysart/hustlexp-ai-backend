# Step 11 — Realtime Transport Verification Checklist

**Total time:** 20–30 minutes  
**Goal:** Prove that `task.progress_updated` travels from DB → UI without refresh, duplication, or regression.

---

## Preconditions (do not skip)

### A. Services running

* API server running (`npm run dev` or equivalent)
* Workers running:

  ```bash
  npm run dev:workers
  ```
* Redis running (BullMQ)
* Database migrated and seeded

### B. Two valid users

* **Poster account** (owns the task)
* **Worker account** (accepts the task)

Both must have valid auth tokens.

---

## Phase 1 — SSE Connection Sanity

### 1. Open two browser windows

* Window A: Poster
* Window B: Worker

Open DevTools → **Network tab** in both.

### 2. Connect to SSE

In both windows, load:

```
GET /realtime/stream
```

**Expected (both):**

* Status: `200`
* Content-Type: `text/event-stream`
* Connection stays open (no close, no retry spam)

**Fail immediately if:**

* Connection closes
* Auth fails
* Multiple connections created per refresh

---

## Phase 2 — Baseline State Check (REST)

### 3. Fetch task via REST (both users)

```
GET /tasks/{taskId}
```

**Expected:**

* `progress_state = POSTED`
* `progress_updated_at` present
* UI shows "Task posted" (or equivalent neutral state)

This confirms **rehydration works**.

---

## Phase 3 — ACCEPTED (System-driven)

### 4. Worker accepts task

Trigger via normal UI or API:

```
POST /tasks/{taskId}/accept
```

**Expected (both windows, without refresh):**

* SSE event arrives:

  ```json
  {
    "event": "task.progress_updated",
    "data": {
      "taskId": "...",
      "from": "POSTED",
      "to": "ACCEPTED",
      ...
    }
  }
  ```
* UI updates immediately

**Critical checks:**

* Exactly **one** event
* No duplicate delivery
* No backward animation

Fail if duplicated or delayed >2s.

---

## Phase 4 — "Hustler on the Way" (Core Moment)

### 5. Worker advances to TRAVELING

Trigger:

```
advanceProgress → TRAVELING
```

**Expected (both):**

* SSE event with `to: TRAVELING`
* Poster UI explicitly shows:
  **"Hustler is on the way"**
* No refresh required

This is the **key anxiety-reducing moment**.

If this fails, Pillar A is not real.

---

## Phase 5 — WORKING

### 6. Worker advances to WORKING

**Expected:**

* SSE event arrives
* UI updates to "Working" / equivalent
* No replays of previous states
* No ACCEPTED/TRAVELING reruns

---

## Phase 6 — COMPLETED → CLOSED (System-driven)

### 7. Worker marks task COMPLETED

**Expected:**

* SSE event: `WORKING → COMPLETED`
* UI reflects completion

### 8. Trigger escrow terminalization

(Release / Refund / Split — any valid path)

**Expected (both):**

* SSE event: `COMPLETED → CLOSED`
* UI shows final state
* No further progress transitions possible

---

## Phase 7 — Reconnect Safety

### 9. Kill SSE connection (Poster)

* Close tab or disable network
* Reopen `/realtime/stream`

### 10. Rehydrate via REST

```
GET /tasks/{taskId}
```

**Expected:**

* `progress_state = CLOSED`
* UI renders correctly
* **No replay storm**
* **No stale state**

This proves **stateless transport correctness**.

---

## Phase 8 — Negative / Guard Tests (Fast)

### 11. Duplicate trigger attempt

Try to advance progress again (any direction).

**Expected:**

* No SSE event
* No UI change
* Backend returns no-op or rejection

### 12. Unauthorized transition

Try worker → CLOSED directly.

**Expected:**

* Rejected
* No SSE event emitted

---

## PASS / FAIL CRITERIA

### PASS if all are true:

* Zero duplicate events
* Zero backward transitions
* "Hustler on the way" appears live
* Reconnect + REST rehydrate cleanly
* No UI refresh required at any step

### FAIL if any occur:

* Duplicate SSE events
* Missing TRAVELING state
* UI desync after reconnect
* SSE closes unexpectedly
* State regression

---

## What to do after PASS

Only after this passes should you proceed.

Your next valid move is **Step 9: Monetization hooks**, because:

* You now have *felt* user value
* You can price certainty, not features

---

## Forced Next Choice (after you run this)

Reply with **one line only**:

* **"Step 11 passed — proceed to Step 9."**
* **"Step 11 failed at step X — issue is Y."**

No commentary. No theory. Just truth.
