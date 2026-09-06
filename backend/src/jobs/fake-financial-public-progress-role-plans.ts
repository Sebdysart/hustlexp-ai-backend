export const FAKE_FINANCIAL_PUBLIC_PROGRESS_BUILDER =
  'public.hxos_build_fake_financial_progress_actor_request_v13(text,jsonb)';
export const FAKE_FINANCIAL_PUBLIC_PROGRESS_READER =
  'hx_authority.read_fake_financial_public_progress_v13(uuid)';
export const FAKE_FINANCIAL_PUBLIC_PROGRESS_COMMAND =
  'public.hxos_read_authenticated_fake_financial_progress_v13(text,jsonb)';
export const FAKE_FINANCIAL_PUBLIC_PROGRESS_FUNCTIONS = [
  FAKE_FINANCIAL_PUBLIC_PROGRESS_BUILDER,
  FAKE_FINANCIAL_PUBLIC_PROGRESS_READER,
  FAKE_FINANCIAL_PUBLIC_PROGRESS_COMMAND,
] as const;
