/**
 * Firebase token cache TTL in seconds.
 * Must be kept ≤ 5 minutes to limit the revocation window.
 */
export const TOKEN_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes — do not increase above 300

/**
 * Revocation marker TTL — set to TOKEN_CACHE_TTL_SECONDS * 2 + 120 (720s) to
 * guarantee the marker outlives any cached session regardless of when the session
 * was last refreshed. The previous 60s buffer was too narrow: a session refreshed
 * near the marker expiry could survive past the marker's lifetime.
 */
export const REVOCATION_MARKER_TTL_SECONDS = TOKEN_CACHE_TTL_SECONDS * 2 + 120; // 720s
