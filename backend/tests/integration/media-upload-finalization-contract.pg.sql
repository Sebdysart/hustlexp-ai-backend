\set ON_ERROR_STOP on

BEGIN;
SET LOCAL hustlexp.is_test='true';

CREATE OR REPLACE FUNCTION pg_temp.hxmedia_assert(condition BOOLEAN,message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'HXMEDIA assertion failed: %',message; END IF;
END;
$$;

INSERT INTO users(
  id,email,full_name,default_mode,date_of_birth,is_minor,is_verified,phone,
  account_status,trust_tier,trust_hold,is_banned,plan
) VALUES
  ('d1000000-0000-4000-8000-000000000001','hxmedia-poster@e2e.invalid','HX Media Poster',
   'poster','1990-01-01',FALSE,FALSE,'+12065550201','ACTIVE',2,FALSE,FALSE,'free'),
  ('d1000000-0000-4000-8000-000000000002','hxmedia-worker@e2e.invalid','HX Media Worker',
   'worker','1990-01-01',FALSE,FALSE,'+12065550202','ACTIVE',2,FALSE,FALSE,'free'),
  ('d1000000-0000-4000-8000-000000000003','hxmedia-admin@e2e.invalid','HX Media Admin',
   'poster','1990-01-01',FALSE,FALSE,'+12065550203','ACTIVE',3,FALSE,FALSE,'free')
ON CONFLICT (id) DO NOTHING;

INSERT INTO admin_roles(user_id,role,can_modify_trust)
VALUES ('d1000000-0000-4000-8000-000000000003','moderator',TRUE)
ON CONFLICT (user_id) DO UPDATE
SET role=EXCLUDED.role,can_modify_trust=EXCLUDED.can_modify_trust;

CREATE OR REPLACE FUNCTION pg_temp.hxmedia_policy_snapshot(p region_policies,p_category TEXT,p_risk TEXT)
RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'policyId',p.id::text,'policyVersion',p.version,'policyHash',p.policy_hash,
    'regionCode',p.region_code,'locationState',split_part(p.region_code,'-',2),
    'licenseRequired',(p.policy_document#>>ARRAY['categories',p_category,'credentials','licenseRequired'])::BOOLEAN,
    'insuranceRequired',(p.policy_document#>>ARRAY['categories',p_category,'credentials','insuranceRequired'])::BOOLEAN,
    'backgroundCheckRequired',(p.policy_document#>>ARRAY['categories',p_category,'credentials','backgroundCheckRequired'])::BOOLEAN,
    'proofRequired',(p.policy_document#>>ARRAY['categories',p_category,'evidence','proofRequired'])::BOOLEAN,
    'proofMinPhotos',(p.policy_document#>>ARRAY['categories',p_category,'evidence','minPhotos'])::INTEGER,
    'proofMaxPhotos',(p.policy_document#>>ARRAY['categories',p_category,'evidence','maxPhotos'])::INTEGER,
    'proofGpsRequired',(p.policy_document#>>ARRAY['categories',p_category,'evidence','gpsRequired'])::BOOLEAN,
    'recordingAllowed',(p.policy_document#>>'{recording,allowed}')::BOOLEAN,
    'recordingStandaloneConsentRequired',(p.policy_document#>>'{recording,standaloneConsentRequired}')::BOOLEAN,
    'screeningStandaloneConsentRequired',(p.policy_document#>>'{workerRights,standaloneScreeningConsentRequired}')::BOOLEAN,
    'screeningReportAccessRequired',(p.policy_document#>>'{workerRights,reportAccessRequired}')::BOOLEAN,
    'screeningDisputeAndAppealRequired',(p.policy_document#>>'{workerRights,disputeAndAppealRequired}')::BOOLEAN,
    'screeningAdverseActionNoticeRequired',(p.policy_document#>>'{workerRights,adverseActionNoticeRequired}')::BOOLEAN,
    'safetyIncidentIntakeRequired',(p.policy_document#>>'{safety,incidentIntakeRequired}')::BOOLEAN,
    'safetyTimedCheckinRequired',(p.policy_document#>'{safety,timedCheckinRiskLevels}') ? p_risk,
    'safetyCheckinIntervalsMinutes',p.policy_document#>'{safety,checkinIntervalsMinutes}',
    'safetyLocationRetentionDays',(p.policy_document#>>'{safety,locationRetentionDays}')::INTEGER,
    'safetyAlternateEmergencyActionRequired',(p.policy_document#>>'{safety,alternateEmergencyActionRequired}')::BOOLEAN,
    'currency',p.policy_document#>>'{financial,currency}'
  )
$$;

INSERT INTO tasks(
  id,poster_id,state,progress_state,title,description,price,
  hustler_payout_cents,platform_margin_cents,category,risk_level,requires_proof,
  automation_classification,region_code,region_policy_id,region_policy_version,
  region_policy_hash,region_policy_snapshot,trade_type,location_state,
  license_required,insurance_required,background_check_required,proof_min_photos,
  proof_max_photos,proof_gps_required,currency
)
SELECT
  'd2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001',
  'OPEN','POSTED','HX media receipt task','Purpose-bound media receipt contract',7500,
  6000,1500,'moving','LOW',TRUE,'CONTROLLED_TEST',p.region_code,p.id,p.version,
  p.policy_hash,pg_temp.hxmedia_policy_snapshot(p,'moving','LOW'),'moving','WA',
  (p.policy_document#>>'{categories,moving,credentials,licenseRequired}')::BOOLEAN,
  (p.policy_document#>>'{categories,moving,credentials,insuranceRequired}')::BOOLEAN,
  (p.policy_document#>>'{categories,moving,credentials,backgroundCheckRequired}')::BOOLEAN,
  (p.policy_document#>>'{categories,moving,evidence,minPhotos}')::INTEGER,
  (p.policy_document#>>'{categories,moving,evidence,maxPhotos}')::INTEGER,
  (p.policy_document#>>'{categories,moving,evidence,gpsRequired}')::BOOLEAN,
  p.policy_document#>>'{financial,currency}'
FROM region_policies p
WHERE p.region_code='US-WA' AND p.policy_state='ACTIVE'
ORDER BY p.effective_from DESC LIMIT 1
ON CONFLICT (id) DO NOTHING;

SELECT pg_temp.hxmedia_assert(
  (SELECT relrowsecurity FROM pg_class WHERE oid='media_upload_receipts'::regclass),
  'receipt table must enforce RLS'
);
SELECT pg_temp.hxmedia_assert(
  (SELECT relrowsecurity FROM pg_class WHERE oid='media_access_log'::regclass),
  'media access audit table must enforce RLS'
);
SELECT pg_temp.hxmedia_assert(
  NOT EXISTS (
    SELECT 1
    FROM pg_class c,
         LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) privilege
    WHERE c.oid='media_upload_receipts'::regclass
      AND privilege.grantee=0
      AND privilege.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
  ),
  'PUBLIC must not receive media receipt privileges'
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    IF has_table_privilege('anon','public.media_upload_receipts','SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'anon unexpectedly received media receipt privileges';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    IF has_table_privilege('authenticated','public.media_upload_receipts','SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'authenticated unexpectedly received media receipt privileges';
    END IF;
  END IF;
END;
$$;

INSERT INTO media_upload_receipts(
  id,task_id,uploader_id,purpose,quarantine_key,expected_content_type,
  expected_size_bytes,quarantine_expires_at,expires_at
) VALUES (
  'd3000000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000002','PROOF',
  'quarantine/proof/d200/d100/d300.jpg','image/jpeg',321,
  NOW()+INTERVAL '15 minutes',NOW()+INTERVAL '24 hours'
);

UPDATE media_upload_receipts
SET status='FINALIZED',
    canonical_key='media/proof/d200/d100/d300.jpg',
    canonical_content_type='image/jpeg',canonical_size_bytes=300,
    canonical_checksum_sha256=repeat('a',64),pixel_width=5,pixel_height=4,
    source_metadata_detected=TRUE,raw_deleted_at=NOW(),finalized_at=NOW()
WHERE id='d3000000-0000-4000-8000-000000000001';

SELECT pg_temp.hxmedia_assert(
  (SELECT status='FINALIZED' AND raw_deleted_at IS NOT NULL
     AND canonical_url IS NULL
     AND source_metadata_detected IS TRUE
   FROM media_upload_receipts WHERE id='d3000000-0000-4000-8000-000000000001'),
  'quarantined receipt must finalize with a complete canonical attestation'
);

DO $$
DECLARE
  v_before TIMESTAMPTZ;
BEGIN
  BEGIN
    UPDATE media_upload_receipts SET task_id='d2000000-0000-4000-8000-000000000002'
    WHERE id='d3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'immutable receipt authority unexpectedly changed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXMEDIA1:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE media_upload_receipts
    SET canonical_url='https://media.invalid/permanent-public-url.jpg'
    WHERE id='d3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'permanent canonical URL unexpectedly persisted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXMEDIA5:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE media_upload_receipts SET canonical_checksum_sha256=repeat('b',64)
    WHERE id='d3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'finalized media attestation unexpectedly changed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXMEDIA3:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE media_upload_receipts
    SET status='CONSUMED',consumed_kind='PROOF',
        consumed_id='d4000000-0000-4000-8000-000000000001',consumed_at=NOW()
    WHERE id='d3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'forced transaction rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'forced transaction rollback' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM media_upload_receipts
    WHERE id='d3000000-0000-4000-8000-000000000001' AND status='FINALIZED'
  ) THEN
    RAISE EXCEPTION 'failed message/proof transaction consumed the receipt';
  END IF;

  UPDATE media_upload_receipts
  SET status='CONSUMED',consumed_kind='PROOF',
      consumed_id='d4000000-0000-4000-8000-000000000001',consumed_at=NOW()
  WHERE id='d3000000-0000-4000-8000-000000000001';

  SELECT updated_at INTO v_before FROM media_upload_receipts
  WHERE id='d3000000-0000-4000-8000-000000000001';
  UPDATE media_upload_receipts SET status=status
  WHERE id='d3000000-0000-4000-8000-000000000001';
  IF (SELECT updated_at FROM media_upload_receipts
      WHERE id='d3000000-0000-4000-8000-000000000001') IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'terminal no-op altered receipt audit time';
  END IF;

  BEGIN
    UPDATE media_upload_receipts SET rejection_code='tampered'
    WHERE id='d3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'consumed receipt unexpectedly changed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXMEDIA4:%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT pg_temp.hxmedia_assert(
  (SELECT status='CONSUMED' AND consumed_kind='PROOF'
     AND consumed_id='d4000000-0000-4000-8000-000000000001'
   FROM media_upload_receipts WHERE id='d3000000-0000-4000-8000-000000000001'),
  'finalized receipt must be consumed exactly once by its purpose'
);

INSERT INTO media_access_log(
  id,receipt_id,task_id,viewer_id,actor_kind,purpose,consumer_id,
  access_reason,signed_url_expires_at
) VALUES (
  'd5000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',
  'USER','PROOF','d4000000-0000-4000-8000-000000000001',
  'PROOF_REVIEW',NOW()+INTERVAL '5 minutes'
);

DO $$
BEGIN
  BEGIN
    UPDATE media_access_log SET access_reason='BIOMETRIC_ANALYSIS'
    WHERE id='d5000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'media access audit unexpectedly changed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXMEDIA6:%' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM media_access_log
    WHERE id='d5000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'media access audit unexpectedly deleted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXMEDIA6:%' THEN RAISE; END IF;
  END;

  BEGIN
    TRUNCATE media_access_log;
    RAISE EXCEPTION 'media access audit unexpectedly truncated';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXMEDIA6:%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT pg_temp.hxmedia_assert(
  (SELECT count(*)=1 FROM media_access_log
    WHERE receipt_id='d3000000-0000-4000-8000-000000000001'
      AND viewer_id='d1000000-0000-4000-8000-000000000001'
      AND signed_url_expires_at > accessed_at),
  'authorized private access must create one immutable expiry-bounded audit row'
);

INSERT INTO media_upload_receipts(
  id,task_id,uploader_id,purpose,quarantine_key,expected_content_type,
  expected_size_bytes,quarantine_expires_at,expires_at
) VALUES (
  'd3000000-0000-4000-8000-000000000005',
  'd2000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000002','MESSAGE',
  'quarantine/message/d200/d100/d305.jpg','image/jpeg',321,
  NOW()+INTERVAL '15 minutes',NOW()+INTERVAL '24 hours'
);

UPDATE media_upload_receipts
SET status='FINALIZED',
    canonical_key='media/message/d200/d100/d305.jpg',
    canonical_content_type='image/jpeg',canonical_size_bytes=300,
    canonical_checksum_sha256=repeat('c',64),pixel_width=5,pixel_height=4,
    source_metadata_detected=FALSE,raw_deleted_at=NOW(),finalized_at=NOW()
WHERE id='d3000000-0000-4000-8000-000000000005';

UPDATE media_upload_receipts
SET status='CONSUMED',consumed_kind='MESSAGE',
    consumed_id='d4000000-0000-4000-8000-000000000002',consumed_at=NOW()
WHERE id='d3000000-0000-4000-8000-000000000005';

INSERT INTO media_access_log(
  id,receipt_id,task_id,viewer_id,actor_kind,purpose,consumer_id,
  access_reason,signed_url_expires_at
) VALUES (
  'd5000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000005',
  'd2000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000003',
  'ADMIN','MESSAGE','d4000000-0000-4000-8000-000000000002',
  'MODERATION_REVIEW',NOW()+INTERVAL '5 minutes'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO media_access_log(
      receipt_id,task_id,viewer_id,actor_kind,purpose,consumer_id,
      access_reason,signed_url_expires_at
    ) VALUES (
      'd3000000-0000-4000-8000-000000000005',
      'd2000000-0000-4000-8000-000000000001',
      'd1000000-0000-4000-8000-000000000002',
      'ADMIN','MESSAGE','d4000000-0000-4000-8000-000000000002',
      'MODERATION_REVIEW',NOW()+INTERVAL '5 minutes'
    );
    RAISE EXCEPTION 'non-admin moderation access unexpectedly logged';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXMEDIA9:%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT pg_temp.hxmedia_assert(
  (SELECT count(*)=1 FROM media_access_log
    WHERE receipt_id='d3000000-0000-4000-8000-000000000005'
      AND viewer_id='d1000000-0000-4000-8000-000000000003'
      AND actor_kind='ADMIN' AND access_reason='MODERATION_REVIEW'
      AND signed_url_expires_at > accessed_at),
  'trust-admin moderation access must create one immutable expiry-bounded audit row'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO media_upload_receipts(
      id,task_id,uploader_id,purpose,status,quarantine_key,
      expected_content_type,expected_size_bytes,quarantine_expires_at,expires_at
    ) VALUES (
      'd3000000-0000-4000-8000-000000000002',
      'd2000000-0000-4000-8000-000000000001',
      'd1000000-0000-4000-8000-000000000002','MESSAGE','FINALIZED',
      'quarantine/message/d200/d100/d302.jpg','image/jpeg',100,
      NOW()+INTERVAL '15 minutes',NOW()+INTERVAL '24 hours'
    );
    RAISE EXCEPTION 'incomplete finalized state unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO media_upload_receipts(
      id,task_id,uploader_id,purpose,quarantine_key,
      expected_content_type,expected_size_bytes,quarantine_expires_at,expires_at
    ) VALUES (
      'd3000000-0000-4000-8000-000000000003',
      'd2000000-0000-4000-8000-000000000001',
      'd1000000-0000-4000-8000-000000000002','MESSAGE',
      'quarantine/message/d200/d100/d303.jpg','image/heic',100,
      NOW()+INTERVAL '15 minutes',NOW()+INTERVAL '24 hours'
    );
    RAISE EXCEPTION 'unsupported HEIC receipt unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO media_upload_receipts(
      id,task_id,uploader_id,purpose,quarantine_key,
      expected_content_type,expected_size_bytes,quarantine_expires_at,expires_at
    ) VALUES (
      'd3000000-0000-4000-8000-000000000004',
      'd2000000-0000-4000-8000-000000000001',
      'd1000000-0000-4000-8000-000000000002','MESSAGE',
      'quarantine/message/d200/d100/d304.jpg','image/jpeg',100,
      NOW()+INTERVAL '24 hours',NOW()+INTERVAL '15 minutes'
    );
    RAISE EXCEPTION 'reversed receipt expiry unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

ROLLBACK;

\echo 'MEDIA_UPLOAD_FINALIZATION_DATABASE_CONTRACT_OK'
