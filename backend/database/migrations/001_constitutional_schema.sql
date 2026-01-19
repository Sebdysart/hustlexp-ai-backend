-- ============================================================================
-- Migration 001: Apply Constitutional Schema
-- ============================================================================
-- This migration applies the complete constitutional schema from HUSTLEXP-DOCS
-- 
-- IMPORTANT: This is a full schema replacement. Existing data may need migration.
-- Run this in a transaction and verify before committing.
-- ============================================================================

-- Note: The full schema is in ../constitutional-schema.sql
-- This file references it for clarity, but the actual SQL is in that file.

-- This migration should be run by executing:
-- psql $DATABASE_URL -f backend/database/constitutional-schema.sql

-- Or via the migration runner script
