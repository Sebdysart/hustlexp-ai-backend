ALTER TABLE public.business_assessment_requests
  DROP CONSTRAINT IF EXISTS business_assessment_requests_platform_fee_ck;

ALTER TABLE public.business_assessment_requests
  DROP COLUMN IF EXISTS assessment_platform_fee_cents;

ALTER TABLE public.assessment_payments
  DROP CONSTRAINT IF EXISTS assessment_payments_platform_fee_cents_check;

ALTER TABLE public.assessment_payments
  DROP COLUMN IF EXISTS platform_fee_cents;
