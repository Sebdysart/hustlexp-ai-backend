-- HX/OS 2.0 sensitive-media ingestion shutdown
--
-- Proof and task-message images have a receipt-backed quarantine,
-- decode/re-encode, metadata-stripping, private-delivery, and access-audit
-- contract. Other historical media fields do not. Clear those untrusted
-- references and keep them closed until an equivalent purpose-specific
-- receipt contract exists.

BEGIN;

LOCK TABLE users, worker_skills, license_verifications,
  insurance_verifications, tasks, proof_submissions IN ACCESS EXCLUSIVE MODE;

UPDATE users
SET avatar_url = NULL
WHERE avatar_url IS NOT NULL;

UPDATE worker_skills
SET license_url = NULL,
    verified = FALSE,
    verified_at = NULL
WHERE license_url IS NOT NULL;

UPDATE license_verifications
SET document_url = NULL
WHERE document_url IS NOT NULL;

UPDATE insurance_verifications
SET document_url = NULL
WHERE document_url IS NOT NULL;

UPDATE tasks
SET before_photo_url = NULL
WHERE before_photo_url IS NOT NULL;

UPDATE proof_submissions
SET photo_url = NULL,
    lidar_depth_map_url = NULL
WHERE photo_url IS NOT NULL
   OR lidar_depth_map_url IS NOT NULL;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_avatar_receipt_only_ck;
ALTER TABLE users
  ADD CONSTRAINT users_avatar_receipt_only_ck
  CHECK (avatar_url IS NULL);

ALTER TABLE worker_skills
  DROP CONSTRAINT IF EXISTS worker_skills_license_receipt_only_ck;
ALTER TABLE worker_skills
  ADD CONSTRAINT worker_skills_license_receipt_only_ck
  CHECK (license_url IS NULL);

ALTER TABLE license_verifications
  DROP CONSTRAINT IF EXISTS license_verifications_document_receipt_only_ck;
ALTER TABLE license_verifications
  ADD CONSTRAINT license_verifications_document_receipt_only_ck
  CHECK (document_url IS NULL);

ALTER TABLE insurance_verifications
  DROP CONSTRAINT IF EXISTS insurance_verifications_document_receipt_only_ck;
ALTER TABLE insurance_verifications
  ADD CONSTRAINT insurance_verifications_document_receipt_only_ck
  CHECK (document_url IS NULL);

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_before_photo_receipt_only_ck;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_before_photo_receipt_only_ck
  CHECK (before_photo_url IS NULL);

ALTER TABLE proof_submissions
  DROP CONSTRAINT IF EXISTS proof_submissions_receipt_only_media_ck;
ALTER TABLE proof_submissions
  ADD CONSTRAINT proof_submissions_receipt_only_media_ck
  CHECK (photo_url IS NULL AND lidar_depth_map_url IS NULL);

COMMENT ON CONSTRAINT users_avatar_receipt_only_ck ON users IS
  'Avatar media is disabled until profile uploads have receipt-backed metadata stripping and private lifecycle controls.';
COMMENT ON CONSTRAINT worker_skills_license_receipt_only_ck ON worker_skills IS
  'Direct skill-license media references are prohibited; credential facts may be reviewed without ingesting an untrusted URL.';
COMMENT ON CONSTRAINT license_verifications_document_receipt_only_ck ON license_verifications IS
  'Direct license document references are prohibited until a private credential-media receipt contract exists.';
COMMENT ON CONSTRAINT insurance_verifications_document_receipt_only_ck ON insurance_verifications IS
  'Direct insurance document references are prohibited until a private credential-media receipt contract exists.';
COMMENT ON CONSTRAINT tasks_before_photo_receipt_only_ck ON tasks IS
  'Legacy task before-photo URLs are prohibited; task proof images use proof_photos plus consumed media receipts.';
COMMENT ON CONSTRAINT proof_submissions_receipt_only_media_ck ON proof_submissions IS
  'Proof media authority lives in proof_photos and consumed media receipts; legacy photo/depth URL duplicates are prohibited.';

COMMIT;
