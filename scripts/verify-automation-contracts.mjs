import { existsSync, readFileSync } from 'node:fs';

const checks = [];
function source(file) {
  if (!existsSync(file)) {
    checks.push({ ok: false, contract: file, reason: 'missing_file' });
    return '';
  }
  return readFileSync(file, 'utf8');
}
function requirePattern(contract, text, pattern) {
  const ok = pattern.test(text);
  checks.push({ ok, contract, reason: ok ? 'present' : 'missing_symbol_or_schema' });
}
function forbidPattern(contract, text, pattern) {
  const ok = !pattern.test(text);
  checks.push({ ok, contract, reason: ok ? 'absent' : 'forbidden_contract_present' });
}

const task = [
  'backend/src/routers/task.ts', 'backend/src/routers/TaskCreateProcedures.ts',
  'backend/src/routers/TaskExecutionProcedures.ts', 'backend/src/routers/TaskReadProcedures.ts',
].map(source).join('\n');
const escrow = [
  'backend/src/routers/escrow.ts', 'backend/src/routers/escrow-payment-procedures.ts',
  'backend/src/routers/escrow-release-procedures.ts',
].map(source).join('\n');
const assignment = source('backend/src/routers/assignment.ts');
const trpc = source('backend/src/trpc.ts');
const index = source('backend/src/routers/index.ts');
const location = source('backend/src/services/TaskLocationService.ts');
const reservation = source('backend/src/services/TaskReservationService.ts');
const automation = source('backend/src/routers/automation.ts');
const lifecycle = source('backend/src/services/AutomationLifecycleService.ts');
const lifecycleRead = source('backend/src/services/AutomationLifecycleReadService.ts');
const paymentPolicy = source('backend/src/services/EscrowPaymentPolicy.ts');
const migration = source('backend/database/migrations/20260710_engine_automation_contracts.sql');
const webOps = source('backend/src/routers/web/ops.ts');
const workers = [
  'backend/src/jobs/workers.ts', 'backend/src/jobs/worker-registration.ts',
  'backend/src/jobs/worker-schedules.ts',
].map(source).join('\n');

requirePattern('E3 task.create', task, /\bcreate\s*:/);
requirePattern('E3 client idempotency schema', trpc, /clientIdempotencyKey/);
requirePattern('E3 rough-area schema', trpc, /roughArea/);
requirePattern('E2 dispatch expiry create contract', trpc, /dispatchExpiresAt/);
requirePattern('E3 payment intent', escrow, /createPaymentIntent\s*:/);
requirePattern('E3 confirm funding', escrow, /confirmFunding\s*:/);
requirePattern('E5 engine reservation', assignment, /\breserve\s*:/);
requirePattern('E5 idempotency witness', reservation, /task_reservation_requests/);
requirePattern('assignment router registered', index, /assignment:\s*assignmentRouter/);
requirePattern('exact address release', task, /releaseExactLocation\s*:/);
requirePattern('exact address vault', location, /task_location_vault/);
requirePattern('E4 proof submission', task, /submitProof\s*:/);
requirePattern('E1 admin lifecycle read', automation, /listTasks\s*:/);
requirePattern('E1 webOps compatibility endpoint', webOps, /listEngineTasks\s*:/);
requirePattern('E1 lifecycle facade', lifecycle, /AutomationLifecycleReadService/);
requirePattern('E1 bounded cursor query', lifecycleRead, /LIMIT \$3/);
forbidPattern('E1 lifecycle read omits exact address', lifecycleRead, /task_location_vault|exact_location|t\.location\b/i);
requirePattern('E2 unfilled expiry command', automation, /expireUnfilled\s*:/);
requirePattern('E2 bounded expiry scheduler', automation, /expireDue\s*:/);
requirePattern('E2 repeatable expiry scheduler registration', workers, /dispatch\.expire_unfilled/);
requirePattern('E2 idempotency witness schema', migration, /task_dispatch_expiry_requests/);
requirePattern('E4 completion delivery evidence', automation, /recordCompletionDelivery\s*:/);
requirePattern('E4 verified poster completion', automation, /confirmPosterCompletion\s*:/);
requirePattern('canonical traveling progress', automation, /markWorkerTraveling\s*:/);
requirePattern('retention canonical poster rating', automation, /submitPosterRating\s*:/);
requirePattern('E4 unattended completion', automation, /completeUnattended\s*:/);
requirePattern('E4 payout-ready evidence', migration, /payout_ready_at/);
requirePattern('exact payment amount policy', paymentPolicy, /callerAmountCents === taskPriceCents/);
forbidPattern('public open-task query does not select exact location', task, /listOpen[\s\S]{0,4000}SELECT[\s\S]{0,800}\bt\.location\b/i);

const failed = checks.filter((check) => !check.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks, failed }, null, 2));
if (failed.length > 0) process.exit(1);
