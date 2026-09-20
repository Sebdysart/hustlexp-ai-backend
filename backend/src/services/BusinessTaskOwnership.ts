/** The immutable service assignment must agree with the task's current binding. */
export function businessTaskOwnershipSql(task: string, organization: string): string {
  return `(${task}.business_fulfiller_organization_id = ${organization}
    OR (${task}.provider_organization_id = ${organization}
      AND EXISTS (
        SELECT 1 FROM business_service_task_assignments assignment
        WHERE assignment.id = ${task}.provider_assignment_id
          AND assignment.task_id = ${task}.id
          AND assignment.provider_organization_id = ${organization}
          AND assignment.service_profile_id = ${task}.provider_service_profile_id
          AND assignment.fulfiller_user_id = ${task}.worker_id
          AND assignment.payout_recipient_user_id = ${task}.payout_recipient_user_id
      )))`;
}
