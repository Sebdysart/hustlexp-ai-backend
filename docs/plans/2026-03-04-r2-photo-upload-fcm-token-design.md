# Design: R2 Photo Upload (Messaging) + FCM Token Registration

**Date:** 2026-03-04
**Repos:** hustlexp-ai-backend, hustlexp-ios
**Status:** Approved

---

## Feature 1: Real R2 Photo Upload in Messaging

### Problem

`ConversationScreen.swift:288` fabricates a URL (`https://storage.hustlexp.com/chat/{filename}`) without uploading anything. The photo message API call succeeds, but the stored URL is dead.

### Existing Infrastructure (no reinvention needed)

- `backend/src/routers/upload.ts` — `upload.getPresignedUrl` tRPC procedure (real R2 presigned PUT URLs)
- `ProofService.swift` — complete iOS upload pipeline: `getUploadURL` → `uploadImage` → returns public R2 URL
- `backend/src/routers/messaging.ts` — `messaging.sendPhotoMessage` expects already-uploaded `photoUrls: string[]`

### Changes

**Backend — `backend/src/routers/upload.ts`**

Add optional `purpose: z.enum(['proof', 'message']).default('proof')` to `getPresignedUrl` input. Use it to set the R2 key prefix:
- `'proof'` → `proofs/{taskId}/{userId}/{timestamp}_{filename}` (existing)
- `'message'` → `messages/{taskId}/{userId}/{timestamp}_{filename}` (new)

No DB migration. No other backend changes.

**iOS — `ConversationScreen.swift`**

Replace the 3-line mock in `sendPhotoMessage(imageData:)` with the real upload path:

1. Convert `Data` → `UIImage` (guard already exists)
2. Call `ProofService.shared.getUploadURL(taskId: conversationId, filename:, contentType: "image/jpeg")` — backend now uses `messages/` prefix
3. Call `ProofService.shared.uploadImage(image, to: presignedURL)` → returns `publicUrl: String`
4. Call `messagingService.sendPhotoMessage(taskId: conversationId, photoUrls: [publicUrl], caption: nil)`

UI: While uploading, show a local thumbnail bubble with the `isSending` spinner. On failure, show the existing `showError` banner.

**Scope:** ~8 lines backend, ~20 lines iOS. No DB changes.

---

## Feature 2: FCM Token Registration (Full Lifecycle)

### Problems

1. **Race condition:** FCM token arrives before Firebase auth token is set → `protectedProcedure` returns 401 → token silently discarded, device never registered.
2. **Dead code:** `PushNotificationService.swift` calls backend with `{token, platform, deviceId}` but backend's `registerDeviceToken` expects `{fcmToken, deviceType}` — wrong contract, silently broken.
3. **No deregistration on logout:** stale tokens accumulate in `device_tokens` table, causing spurious push delivery attempts.

### Existing Infrastructure

- `PushNotificationManager.swift` — Firebase-integrated, correct contract `{fcmToken, deviceType: "ios"}`, wired in `AppDelegate`
- `backend/src/routers/notification.ts` — `notification.registerDeviceToken` + `notification.unregisterDeviceToken` both exist and work
- `AuthService.swift` — 5 `isAuthenticated = true` callsites (email sign-in, Apple, Google, email sign-up, session restore)

### Changes

**`PushNotificationManager.swift`**

Extend `handleFCMToken(_:)`:
- Try to register with backend
- On any failure (including pre-auth 401), persist token to `UserDefaults` key `"hx.pendingFCMToken"`

New method `flushPendingToken()`:
- Read `"hx.pendingFCMToken"` from UserDefaults
- If present, call `notification.registerDeviceToken`
- On success, delete the UserDefaults key

New method `deregisterCurrentToken()`:
- Read `"hx.pendingFCMToken"` or `fcmToken` published property
- Call `notification.unregisterDeviceToken`
- Clear UserDefaults key and nil out `fcmToken`

**`AuthService.swift`**

At every `isAuthenticated = true` site (5 callsites), after `trpc.setAuthToken(...)`:
```swift
Task { await PushNotificationManager.shared.flushPendingToken() }
```

In `signOut()`, before clearing credentials:
```swift
await PushNotificationManager.shared.deregisterCurrentToken()
```

**Cleanup**

Delete `PushNotificationService.swift` — broken API contract, fully superseded by `PushNotificationManager`.

**Scope:** ~40 lines iOS across 2 files, 0 backend changes.

---

## Non-Goals

- Multi-photo batch upload in messaging (MESSAGING_SPEC allows 1-3 but UI only picks 1 at a time — extend later)
- Push notification analytics / delivery receipts
- Token rotation detection beyond Firebase's built-in `didReceiveRegistrationToken` callback
