export const WORKER_COUNTER_POLICY_VERSION = 'hxos-worker-counter-v1';

export const WORKER_COUNTER_LIMITS = Object.freeze({
  marginFloorBps: 1_000,
  maximumPayoutIncreaseBps: 2_000,
  maximumCustomerIncreaseBps: 2_500,
  maximumAbsolutePayoutIncreaseCents: 5_000,
  minimumPayoutIncreaseCents: 100,
  expiresMinutes: 30,
});

export interface WorkerCounterCorridorInput {
  customerTotalCents: number;
  payoutCents: number;
  platformMarginCents: number;
}

export interface WorkerCounterCorridor {
  policyVersion: typeof WORKER_COUNTER_POLICY_VERSION;
  eligible: boolean;
  blockingReasons: string[];
  currentCustomerTotalCents: number;
  currentPayoutCents: number;
  platformMarginCents: number;
  minimumCounterPayoutCents: number;
  maximumCounterPayoutCents: number;
  customerMaximumCents: number;
  marginFloorBps: number;
}

function integer(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function buildWorkerCounterCorridor(input: WorkerCounterCorridorInput): WorkerCounterCorridor {
  const blockers: string[] = [];
  if (!integer(input.customerTotalCents) || input.customerTotalCents <= 0) blockers.push('customer_total_invalid');
  if (!integer(input.payoutCents) || input.payoutCents <= 0) blockers.push('payout_invalid');
  if (!integer(input.platformMarginCents)) blockers.push('margin_invalid');
  if (input.payoutCents + input.platformMarginCents !== input.customerTotalCents) blockers.push('economics_do_not_reconcile');
  if (input.platformMarginCents * 10_000 < input.customerTotalCents * WORKER_COUNTER_LIMITS.marginFloorBps) {
    blockers.push('current_margin_below_floor');
  }

  const minimumCounterPayoutCents = input.payoutCents + WORKER_COUNTER_LIMITS.minimumPayoutIncreaseCents;
  const customerMaximumCents = Math.floor(
    input.customerTotalCents * (10_000 + WORKER_COUNTER_LIMITS.maximumCustomerIncreaseBps) / 10_000,
  );
  const percentageMaximum = Math.floor(
    input.payoutCents * (10_000 + WORKER_COUNTER_LIMITS.maximumPayoutIncreaseBps) / 10_000,
  );
  const absoluteMaximum = input.payoutCents + WORKER_COUNTER_LIMITS.maximumAbsolutePayoutIncreaseCents;
  const customerMaximumPayout = customerMaximumCents - input.platformMarginCents;
  const marginMaximumPayout = Math.floor(
    input.platformMarginCents * (10_000 - WORKER_COUNTER_LIMITS.marginFloorBps)
      / WORKER_COUNTER_LIMITS.marginFloorBps,
  );
  const maximumCounterPayoutCents = Math.min(
    percentageMaximum,
    absoluteMaximum,
    customerMaximumPayout,
    marginMaximumPayout,
  );
  if (maximumCounterPayoutCents < minimumCounterPayoutCents) blockers.push('no_bounded_counter_room');

  return {
    policyVersion: WORKER_COUNTER_POLICY_VERSION,
    eligible: blockers.length === 0,
    blockingReasons: blockers,
    currentCustomerTotalCents: input.customerTotalCents,
    currentPayoutCents: input.payoutCents,
    platformMarginCents: input.platformMarginCents,
    minimumCounterPayoutCents,
    maximumCounterPayoutCents,
    customerMaximumCents,
    marginFloorBps: WORKER_COUNTER_LIMITS.marginFloorBps,
  };
}

export function evaluateWorkerCounter(
  input: WorkerCounterCorridorInput & { proposedPayoutCents: number },
): WorkerCounterCorridor & { accepted: boolean; proposedCustomerTotalCents: number } {
  const corridor = buildWorkerCounterCorridor(input);
  const proposedCustomerTotalCents = input.proposedPayoutCents + input.platformMarginCents;
  const accepted = corridor.eligible
    && Number.isInteger(input.proposedPayoutCents)
    && input.proposedPayoutCents >= corridor.minimumCounterPayoutCents
    && input.proposedPayoutCents <= corridor.maximumCounterPayoutCents
    && proposedCustomerTotalCents <= corridor.customerMaximumCents
    && input.platformMarginCents * 10_000 >= proposedCustomerTotalCents * corridor.marginFloorBps;
  return { ...corridor, accepted, proposedCustomerTotalCents };
}
