export const WORK_ORDER_HISTORY_BUILDER =
  'public.hxos_build_work_order_history_actor_request_v13(text,jsonb)';
export const WORK_ORDER_HISTORY_COMMAND =
  'public.hxos_read_authenticated_work_order_history_v13(text,jsonb)';
export const WORK_ORDER_HISTORY_FUNCTIONS = [
  WORK_ORDER_HISTORY_BUILDER,
  WORK_ORDER_HISTORY_COMMAND,
] as const;
