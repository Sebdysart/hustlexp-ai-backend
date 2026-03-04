# R2 Photo Upload (Messaging) + FCM Token Registration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the hardcoded mock photo URL in the messaging conversation screen with a real R2 upload, and fix FCM token registration to survive the pre-auth race condition and properly deregister on logout.

**Architecture:** Backend adds a `purpose` field to the upload presigned-URL endpoint to route message photos to a `messages/` key prefix. iOS wires the existing `ProofService` upload pipeline into `ConversationScreen`. FCM token is persisted to `UserDefaults` on arrival, then flushed to the backend immediately after every successful login, and deregistered on logout. The broken `PushNotificationService.swift` is deleted.

**Tech Stack:** TypeScript (Hono + tRPC + Zod), Swift (SwiftUI, `@MainActor`, `UserDefaults`, Firebase Messaging SDK)

---

## Part A: R2 Photo Upload in Messaging

### Task 1: Add `purpose` param to backend upload router

**Files:**
- Modify: `backend/src/routers/upload.ts:63-64` (input schema + key generation)

**Step 1: Add `purpose` to the Zod input schema**

In `upload.ts`, find the `.input(z.object({...}))` block (line ~63). After the `fileSize` field, add:

```typescript
      purpose: z.enum(['proof', 'message']).default('proof').optional(),
```

**Step 2: Update key generation to use the purpose prefix**

Find the line (line ~72):
```typescript
      const key = `proofs/${input.taskId}/${ctx.user.id}/${Date.now()}_${input.filename}`;
```

Replace with:
```typescript
      const prefix = input.purpose === 'message' ? 'messages' : 'proofs';
      const key = `${prefix}/${input.taskId}/${ctx.user.id}/${Date.now()}_${input.filename}`;
```

**Step 3: Verify TypeScript compiles**

```bash
cd /Users/sebastiandysart/Desktop/hustlexp-ai-backend
npx tsc --noEmit -p backend/tsconfig.json
```

Expected: no errors.

**Step 4: Commit**

```bash
git add backend/src/routers/upload.ts
git commit -m "feat(upload): add purpose param to getPresignedUrl for message vs proof key prefix"
```

---

### Task 2: Add `purpose` param to iOS `ProofService.getUploadURL`

**Files:**
- Modify: `hustleXP final1/Services/ProofService.swift:53-70`

**Step 1: Update the method signature and input struct**

Find `getUploadURL` starting at line 53. Replace the entire method with:

```swift
func getUploadURL(
    taskId: String,
    filename: String,
    contentType: String = "image/jpeg",
    purpose: String = "proof"
) async throws -> PresignedUploadURL {
    struct GetURLInput: Codable {
        let taskId: String
        let filename: String
        let contentType: String
        let purpose: String
    }

    let response: PresignedUploadURL = try await trpc.call(
        router: "upload",
        procedure: "getPresignedUrl",
        input: GetURLInput(taskId: taskId, filename: filename, contentType: contentType, purpose: purpose)
    )

    HXLogger.info("ProofService: Got pre-signed URL for \(filename) (purpose: \(purpose))", category: "Task")
    return response
}
```

**Step 2: Verify existing callers are unaffected**

Search for all calls to `getUploadURL` — the default `purpose: "proof"` keeps them backward-compatible:

```bash
grep -rn "getUploadURL" "/Users/sebastiandysart/HustleXP/HUSTLEXPFINAL1/hustleXP final1/" --include="*.swift"
```

Expected: only `ProofService.swift:114` and any proof submission screens — all use the default, no changes needed.

**Step 3: Build check** — open Xcode and build (Cmd+B). Expected: success.

**Step 4: Commit**

```bash
cd /Users/sebastiandysart/HustleXP/HUSTLEXPFINAL1
git add "hustleXP final1/Services/ProofService.swift"
git commit -m "feat(upload): pass purpose param to getPresignedUrl tRPC call"
```

---

### Task 3: Wire real R2 upload in `ConversationScreen.sendPhotoMessage`

**Files:**
- Modify: `hustleXP final1/Screens/Shared/ConversationScreen.swift:276-315`

**Step 1: Replace `sendPhotoMessage(imageData:)` body**

Find the function at line 276. The current body creates a mock URL. Replace the entire function body with the real upload path:

```swift
private func sendPhotoMessage(imageData: Data) {
    guard let image = UIImage(data: imageData) else { return }

    isSending = true

    Task {
        do {
            let timestamp = Int(Date().timeIntervalSince1970)
            let filename = "msg_\(conversationId)_\(timestamp).jpg"

            // Step 1: Get presigned URL for message photo (uses messages/ key prefix)
            let presignedURL = try await ProofService.shared.getUploadURL(
                taskId: conversationId,
                filename: filename,
                contentType: "image/jpeg",
                purpose: "message"
            )

            // Step 2: Upload image bytes to R2
            let publicUrl = try await ProofService.shared.uploadImage(image, to: presignedURL)

            // Step 3: Send photo message via tRPC (stores real R2 URL in DB)
            let sentMessage = try await messagingService.sendPhotoMessage(
                taskId: conversationId,
                photoUrls: [publicUrl],
                caption: nil
            )

            // Step 4: Append to local message list
            let chatMessage = ChatMessage(
                id: sentMessage.id,
                text: "📷 Photo",
                isFromCurrentUser: true,
                timestamp: sentMessage.timestamp,
                senderName: sentMessage.senderName
            )

            withAnimation(.spring(response: 0.3)) {
                messages.append(chatMessage)
            }

            HXLogger.info("Conversation: Photo message sent (R2 key: \(presignedURL.key))", category: "General")
        } catch {
            errorMessage = "Failed to send photo: \(error.localizedDescription)"
            showError = true
        }
        isSending = false
    }
}
```

**Step 2: Build check** — Cmd+B in Xcode. Expected: success.

**Step 3: Manual smoke test**

- Run app in simulator
- Open a task conversation (task must be in ACCEPTED state)
- Tap the attachment icon, pick a photo
- Verify: photo uploads (network call to R2 presigned URL), message appears in conversation
- Check backend logs for the `PHOTO` message type in `task_messages`

**Step 4: Commit**

```bash
git add "hustleXP final1/Screens/Shared/ConversationScreen.swift"
git commit -m "feat(messaging): replace mock photo URL with real R2 upload via ProofService"
```

---

## Part B: FCM Token Registration (Full Lifecycle)

### Task 4: Extend `PushNotificationManager` with pending-token storage, flush, and deregister

**Files:**
- Modify: `hustleXP final1/Services/PushNotificationManager.swift`

**Step 1: Add the UserDefaults key constant and three new methods**

Find the `// MARK: - FCM Token Management` section (after `registerForRemoteNotifications`). Replace just `handleFCMToken` with this updated version, plus add two new methods below it:

```swift
// MARK: - FCM Token Management

private static let pendingTokenKey = "hx.pendingFCMToken"

/// Handles a new FCM token: tries to register immediately, falls back to UserDefaults on failure.
func handleFCMToken(_ token: String) async {
    self.fcmToken = token
    HXLogger.info("[PushNotificationManager] FCM token received: \(token.prefix(20))...", category: "Push")

    do {
        try await registerToken(token)
        // Success: clear any previously stored pending token
        UserDefaults.standard.removeObject(forKey: Self.pendingTokenKey)
        HXLogger.info("[PushNotificationManager] Device token registered with backend", category: "Push")
    } catch {
        // Pre-auth or network failure: persist for retry after login
        UserDefaults.standard.set(token, forKey: Self.pendingTokenKey)
        HXLogger.info("[PushNotificationManager] Token stored as pending (will retry after login): \(error.localizedDescription)", category: "Push")
    }
}

/// Called after every successful login. Flushes any pending FCM token to the backend.
func flushPendingToken() async {
    guard let token = UserDefaults.standard.string(forKey: Self.pendingTokenKey)
                   ?? fcmToken else { return }

    do {
        try await registerToken(token)
        UserDefaults.standard.removeObject(forKey: Self.pendingTokenKey)
        HXLogger.info("[PushNotificationManager] Pending FCM token flushed after login", category: "Push")
    } catch {
        HXLogger.error("[PushNotificationManager] Pending token flush failed: \(error.localizedDescription)", category: "Push")
    }
}

/// Called on logout. Deregisters the current token from the backend and clears local state.
func deregisterCurrentToken() async {
    let token = UserDefaults.standard.string(forKey: Self.pendingTokenKey) ?? fcmToken
    guard let token else { return }

    do {
        let _: EmptyResponse = try await TRPCClient.shared.call(
            router: "notification",
            procedure: "unregisterDeviceToken",
            type: .mutation,
            input: ["fcmToken": token]
        )
        HXLogger.info("[PushNotificationManager] Device token deregistered", category: "Push")
    } catch {
        HXLogger.error("[PushNotificationManager] Token deregistration failed: \(error.localizedDescription)", category: "Push")
    }

    UserDefaults.standard.removeObject(forKey: Self.pendingTokenKey)
    self.fcmToken = nil
}

// Private helper: raw backend registration call
private func registerToken(_ token: String) async throws {
    let _: EmptyResponse = try await TRPCClient.shared.call(
        router: "notification",
        procedure: "registerDeviceToken",
        type: .mutation,
        input: [
            "fcmToken": token,
            "deviceType": "ios"
        ]
    )
}
```

Note: `EmptyResponse` is already declared as a private struct at the bottom of `PushNotificationManager.swift` — do not redeclare it.

**Step 2: Build check** — Cmd+B. Expected: success.

**Step 3: Commit**

```bash
git add "hustleXP final1/Services/PushNotificationManager.swift"
git commit -m "feat(push): add pending token persistence, flushPendingToken, and deregisterCurrentToken"
```

---

### Task 5: Call `flushPendingToken` at all login callsites in `AuthService`

**Files:**
- Modify: `hustleXP final1/Services/AuthService.swift` — 6 callsites

**Step 1: Locate all `isAuthenticated = true` lines**

```bash
grep -n "isAuthenticated = true" "/Users/sebastiandysart/HustleXP/HUSTLEXPFINAL1/hustleXP final1/Services/AuthService.swift"
```

Expected output — 6 lines: 91, 135, 185, 292, 365, 428.

**Step 2: After each `appState?.login(...)` call at those sites, add the flush**

The pattern to add is identical at all 6 locations. After the line `appState?.login(userId: ..., role: ...)`, insert:

```swift
Task { await PushNotificationManager.shared.flushPendingToken() }
```

Do this at all 6 callsites:
- Line 92 (mock sign-up)
- Line 136 (real sign-up)
- Line 186 (mock sign-in)
- Line 293 (Apple sign-in)
- Line 366 (Google sign-in)
- Line 429 (session restore)

**Step 3: Build check** — Cmd+B. Expected: success.

**Step 4: Commit**

```bash
git add "hustleXP final1/Services/AuthService.swift"
git commit -m "feat(push): flush pending FCM token after every successful login"
```

---

### Task 6: Deregister token on logout

**Files:**
- Modify: `hustleXP final1/Services/AuthService.swift:384-405` (`signOut` method)

**Step 1: Add deregister call at the start of `signOut`**

Find the `signOut()` function. At the very top of the function body, before the demo mode guard, add:

```swift
// Deregister push token before clearing credentials
Task { await PushNotificationManager.shared.deregisterCurrentToken() }
```

The function should start like:

```swift
func signOut() {
    // Deregister push token before clearing credentials
    Task { await PushNotificationManager.shared.deregisterCurrentToken() }

    // Demo mode - just clear state
    if Self.isDemoMode {
        ...
```

**Step 2: Build check** — Cmd+B. Expected: success.

**Step 3: Commit**

```bash
git add "hustleXP final1/Services/AuthService.swift"
git commit -m "feat(push): deregister FCM device token on logout"
```

---

### Task 7: Delete `PushNotificationService.swift`

**Context:** This file has the wrong API contract (`{token, platform, deviceId}` vs backend's `{fcmToken, deviceType}`), is not wired into `AppDelegate`, and is fully superseded by `PushNotificationManager`. The only usage is `PushNotificationService.shared.requestPermission()` in one location and `updateFCMToken` — neither is connected to Firebase's actual token callbacks.

**Step 1: Verify no live callers remain**

```bash
grep -rn "PushNotificationService" "/Users/sebastiandysart/HustleXP/HUSTLEXPFINAL1/hustleXP final1/" --include="*.swift"
```

If any callers remain, replace them with `PushNotificationManager.shared` equivalents:
- `requestPermission()` → `PushNotificationManager.shared.requestAuthorization()`
- `updateFCMToken(_:)` → `PushNotificationManager.shared.handleFCMToken(_:)` (call with `await` inside a `Task`)

**Step 2: Delete the file**

```bash
rm "/Users/sebastiandysart/HustleXP/HUSTLEXPFINAL1/hustleXP final1/Services/PushNotificationService.swift"
```

Then remove it from the Xcode project: open Xcode → find `PushNotificationService.swift` in navigator → Delete → "Move to Trash".

**Step 3: Build check** — Cmd+B. Expected: success (no unresolved references).

**Step 4: Commit**

```bash
git add -A
git commit -m "chore(push): delete PushNotificationService.swift (broken API contract, superseded by PushNotificationManager)"
```

---

## Manual Verification Checklist

### R2 Photo Upload
- [ ] Send a photo in a task conversation (ACCEPTED state)
- [ ] Check backend `task_messages` table: `message_type = 'PHOTO'`, `photo_urls` contains a real `messages/` R2 URL
- [ ] Open the R2 URL in a browser — image loads correctly
- [ ] Try sending when network is slow — `isSending` spinner shows, error banner appears on failure

### FCM Token
- [ ] Fresh install: grant notification permission → log shows "Token stored as pending"
- [ ] Sign in → log shows "Pending FCM token flushed after login"
- [ ] Check `device_tokens` table in DB: row with `is_active = true` for the test user
- [ ] Sign out → log shows "Device token deregistered"
- [ ] Check `device_tokens` table: row now has `is_active = false`
- [ ] Send a push notification to the signed-out user — it should not be delivered
