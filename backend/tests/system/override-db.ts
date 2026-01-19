/**
 * Override db import for system integrity tests
 * 
 * This allows tests to use local Postgres instead of Neon serverless
 * without modifying production code.
 */

import { testDb } from './test-db';

// Override the db import for services that use it
// This is a test-only override - production code remains unchanged
export const db = testDb;
