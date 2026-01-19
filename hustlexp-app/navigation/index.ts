/**
 * Navigation Root (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Root navigation structure.
 * No business logic. Routing only.
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. DECLARATIVE GUARDS: Guards reference state, they do not compute it.
 * 
 * 2. CANONICAL ENTRY: Each screen has exactly one entry point.
 * 
 * 3. NO BUSINESS LOGIC: Navigation defines structure only.
 * 
 * ============================================================================
 */

export * from './types';
export * from './guards';
export { RootNavigator } from './RootNavigator';
