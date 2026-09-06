export const FAKE_FINANCIAL_PREDECESSOR_BUILDER =
  'public.hxos_build_fake_financial_predecessor_actor_request_v13(text,jsonb)';
export const FAKE_FINANCIAL_PREDECESSOR_READER =
  'hx_authority.read_fake_financial_predecessor_v13(jsonb)';
export const FAKE_FINANCIAL_PREDECESSOR_COMMAND =
  'public.hxos_read_authenticated_fake_financial_predecessor_v13(text,jsonb)';
export const FAKE_FINANCIAL_PREDECESSOR_FUNCTIONS = [
  FAKE_FINANCIAL_PREDECESSOR_BUILDER,
  FAKE_FINANCIAL_PREDECESSOR_READER,
  FAKE_FINANCIAL_PREDECESSOR_COMMAND,
] as const;
