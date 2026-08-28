-- Migration: Add firebase_uid and bio columns to users table
-- Purpose: firebase_uid enables Firebase Auth lookup; bio supports user profiles
-- Safe: Uses IF NOT EXISTS for idempotent re-application

-- Add firebase_uid column for Firebase Authentication
ALTER TABLE users
ADD COLUMN IF NOT EXISTS firebase_uid TEXT UNIQUE;

-- Add bio column for user profiles
ALTER TABLE users
ADD COLUMN IF NOT EXISTS bio TEXT;

-- Index for fast user lookup by firebase_uid (used in auth middleware)
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);
