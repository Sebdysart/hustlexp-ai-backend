/** Independent provider-signature verification; no human command delegation. */
export const FAKE_FINANCIAL_WEBHOOK_INGRESS =
  'public.hxos_record_authenticated_fake_financial_webhook_v13(uuid,bytea,text,text)';
export const FAKE_FINANCIAL_WEBHOOK_FUNCTIONS = [
  FAKE_FINANCIAL_WEBHOOK_INGRESS,
  'hx_authority.guard_fake_financial_webhook_key_v13()',
  'hx_authority.mark_fake_financial_webhook_verification_v13()',
] as const;
export const FAKE_FINANCIAL_WEBHOOK_DEPENDENCIES = [
  'public.initialize_provider_event_processing_state()',
  'public.reject_provider_event_inbox_mutation()',
  'public.validate_provider_event_processing_state_transition()',
  'public.reject_provider_event_processing_state_removal()',
] as const;
export const FAKE_FINANCIAL_WEBHOOK_KEYS = 'hx_authority.fake_financial_webhook_keys_v13';
export const FAKE_FINANCIAL_WEBHOOK_REVOCATIONS =
  'hx_authority.fake_financial_webhook_key_revocations_v13';
export const FAKE_FINANCIAL_WEBHOOK_VERIFICATIONS =
  'hx_authority.fake_financial_webhook_verifications_v13';
export const FAKE_FINANCIAL_WEBHOOK_PROCESSING = 'public.provider_event_processing_state';
export const FAKE_FINANCIAL_WEBHOOK_RELATIONS = [
  FAKE_FINANCIAL_WEBHOOK_KEYS,
  FAKE_FINANCIAL_WEBHOOK_REVOCATIONS,
  FAKE_FINANCIAL_WEBHOOK_VERIFICATIONS,
  FAKE_FINANCIAL_WEBHOOK_PROCESSING,
] as const;
