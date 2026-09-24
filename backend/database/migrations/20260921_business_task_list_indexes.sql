-- Find service assignments for one organization before joining canonical tasks.
CREATE INDEX IF NOT EXISTS business_service_assignments_org_task_idx
  ON public.business_service_task_assignments(provider_organization_id,task_id);

-- Bounded title/provenance lookup after task pagination.
CREATE INDEX IF NOT EXISTS task_drafts_task_provenance_idx
  ON public.task_drafts(task_id,created_at DESC,id DESC)
  WHERE task_id IS NOT NULL;
