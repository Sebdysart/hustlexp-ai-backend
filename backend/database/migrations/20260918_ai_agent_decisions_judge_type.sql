ALTER TABLE ai_agent_decisions
DROP CONSTRAINT ai_agent_decisions_agent_type_check;

ALTER TABLE ai_agent_decisions
ADD CONSTRAINT ai_agent_decisions_agent_type_check
CHECK (
  agent_type = ANY (
    ARRAY[
      'scoper'::text,
      'logistics'::text,
      'dispute'::text,
      'reputation'::text,
      'judge'::text
    ]
  )
);
