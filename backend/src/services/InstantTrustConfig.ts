/**
 * Instant Mode Trust Tier Configuration
 * 
 * Enforces minimum trust tier requirements for Instant Execution Mode.
 */

// Minimum trust tier to accept Instant tasks (v1)
export const MIN_INSTANT_TIER = 2;

// Minimum trust tier for sensitive Instant tasks (v1)
export const MIN_SENSITIVE_INSTANT_TIER = 3;

// Minimum trust tier for Smart Dispatch (lower bar — routing mechanism, not IEM)
// Set to 0 so new unverified accounts (default tier) can receive pings immediately.
export const MIN_SMART_DISPATCH_TIER = 0;
