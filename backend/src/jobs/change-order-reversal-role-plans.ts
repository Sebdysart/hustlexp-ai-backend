export const CHANGE_ORDER_REVERSAL_EXECUTION_FUNCTION =
  'hx_authority.assert_worker_change_order_reversal_execution_v13(uuid)';
export const CHANGE_ORDER_REVERSAL_PREPARATION_FUNCTION =
  'public.hxos_prepare_change_order_compensation_reversal_v13(uuid,text,text,text,uuid,text)';
export const CHANGE_ORDER_REVERSAL_INTERNAL_FUNCTIONS = [
  CHANGE_ORDER_REVERSAL_EXECUTION_FUNCTION,
  'hx_authority.assert_worker_change_order_reversal_v13(uuid,uuid,uuid,text,boolean)',
  'hx_authority.require_worker_change_order_reversal_preparation_v13()',
] as const;
export const CHANGE_ORDER_REVERSAL_PREPARATIONS =
  'hx_authority.fake_financial_change_order_reversal_preparations_v13';
