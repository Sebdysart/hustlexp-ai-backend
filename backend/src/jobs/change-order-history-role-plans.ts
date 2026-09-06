export const CHANGE_ORDER_HISTORY_BUILDER =
  'public.hxos_build_change_order_history_actor_request_v13(text,jsonb)';
export const CHANGE_ORDER_HISTORY_COMMAND =
  'public.hxos_read_authenticated_change_order_history_v13(text,jsonb)';
export const CHANGE_ORDER_HISTORY_FUNCTIONS = [
  CHANGE_ORDER_HISTORY_BUILDER,
  CHANGE_ORDER_HISTORY_COMMAND,
] as const;
