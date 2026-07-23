-- HX/OS clean/upgrade schema convergence repair.
--
-- The proof-signal contract installs canonical named constraints. Fresh
-- constitutional baselines historically also generated equivalent unnamed
-- `_check` constraints, leaving clean installs stricter only by duplication.
-- Remove those legacy aliases without rebuilding tables or weakening a rule.

BEGIN;

ALTER TABLE public.proof_submissions
  DROP CONSTRAINT IF EXISTS proof_submissions_biometric_signal_status_check,
  DROP CONSTRAINT IF EXISTS proof_submissions_biometric_provider_check,
  DROP CONSTRAINT IF EXISTS proof_submissions_metadata_check,
  DROP CONSTRAINT IF EXISTS proof_submissions_capture_source_check;

COMMIT;
