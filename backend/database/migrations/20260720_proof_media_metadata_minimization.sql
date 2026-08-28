-- HX/OS 2.0 proof media metadata minimization
--
-- Raw EXIF data may be evaluated during a request, but only derived validation
-- outcomes may persist. This separate migration reaches installations that
-- already recorded the original proof-verification signal contract.

BEGIN;

UPDATE proof_submissions
SET exif_timestamp = NULL,
    exif_gps_lat = NULL,
    exif_gps_lng = NULL,
    exif_device_model = NULL
WHERE exif_timestamp IS NOT NULL
   OR exif_gps_lat IS NOT NULL
   OR exif_gps_lng IS NOT NULL
   OR exif_device_model IS NOT NULL;

ALTER TABLE proof_submissions
  DROP CONSTRAINT IF EXISTS proof_submissions_raw_media_metadata_stripped_ck;

ALTER TABLE proof_submissions
  ADD CONSTRAINT proof_submissions_raw_media_metadata_stripped_ck
    CHECK (
      exif_timestamp IS NULL
      AND exif_gps_lat IS NULL
      AND exif_gps_lng IS NULL
      AND exif_device_model IS NULL
    );

COMMENT ON CONSTRAINT proof_submissions_raw_media_metadata_stripped_ck ON proof_submissions IS
  'Raw EXIF timestamp, GPS, and device model are evaluated ephemerally and may never be persisted.';

COMMIT;
