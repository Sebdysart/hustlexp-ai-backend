-- Converge the AI decision audit contract created by historical bootstrap
-- schemas. Those schemas predate the active Judge service and left the named
-- agent-type check unable to record its proposal-only decisions.
--
-- This changes no existing audit row and preserves the closed allowed set.

BEGIN;

ALTER TABLE public.ai_agent_decisions
  DROP CONSTRAINT IF EXISTS ai_agent_decisions_agent_type_check;

ALTER TABLE public.ai_agent_decisions
  ADD CONSTRAINT ai_agent_decisions_agent_type_check
  CHECK (agent_type IN (
    'scoper',
    'judge',
    'matchmaker',
    'dispute',
    'reputation',
    'onboarding',
    'logistics'
  )) NOT VALID;

ALTER TABLE public.ai_agent_decisions
  VALIDATE CONSTRAINT ai_agent_decisions_agent_type_check;

COMMIT;
