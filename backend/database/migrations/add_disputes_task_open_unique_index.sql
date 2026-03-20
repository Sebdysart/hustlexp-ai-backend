-- Migration: Add partial UNIQUE index on disputes(task_id) for non-RESOLVED disputes
-- Purpose: Prevent concurrent duplicate dispute creation at the DB level (BUG R-8)
--
-- Two concurrent requests for the same task can both pass the in-memory/router-layer
-- check and both enter the DisputeService transaction. The SELECT FOR UPDATE in the
-- service serializes them, but only if the unique index exists to make the second
-- INSERT fail. Without this index there is no DB-level guard.
--
-- The partial index covers only rows WHERE state != 'RESOLVED' so that a task can
-- have a new dispute opened after a previous one is resolved (e.g. reopen after new
-- proof submission), while still preventing two simultaneous open disputes.

CREATE UNIQUE INDEX IF NOT EXISTS disputes_task_open_unique
  ON disputes(task_id)
  WHERE state != 'RESOLVED';
