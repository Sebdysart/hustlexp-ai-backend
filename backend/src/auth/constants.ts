/**
 * Firebase token cache TTL in seconds.
 * Must be kept ≤ 5 minutes to limit the revocation window.
 */
export const TOKEN_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes — do not increase above 300

/**
 * Revocation marker TTL — must exceed TOKEN_CACHE_TTL_SECONDS by at least 60s
 * to ensure the marker is still present when the cached token expires.
 */
export const REVOCATION_MARKER_TTL_SECONDS = TOKEN_CACHE_TTL_SECONDS + 60; // 360s
