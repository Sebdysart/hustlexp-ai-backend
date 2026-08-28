-- Forward convergence for databases that applied the initial normalized
-- major-action ledger before every dynamically classified automation source
-- was registered. The existing mirror trigger classifies PAYMENT_* and
-- COMPLETION_MESSAGE_* events into their consequential domain classes.

INSERT INTO major_action_source_registry(
  action_class,platform,source_table,trigger_name,source_contract_version,privacy_contract
) VALUES
  ('PAYMENT','ENGINE','engine_automation_events','major_action_engine_automation_events',
   'payment-reconciliation-policy-v1','provider payload and free text excluded'),
  ('NOTIFICATION','ENGINE','engine_automation_events','major_action_engine_automation_events',
   'completion-delivery-policy-v1','message content, channel destination, and provider payload excluded')
ON CONFLICT (action_class,platform,source_table) DO NOTHING;
