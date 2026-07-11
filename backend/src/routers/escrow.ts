/** Canonical escrow router assembled from bounded procedure modules. */
import { router } from '../trpc.js';
import { escrowPaymentProcedures } from './escrow-payment-procedures.js';
import { escrowReadProcedures } from './escrow-read-procedures.js';
import { escrowReleaseProcedures } from './escrow-release-procedures.js';
import { escrowXpProcedures } from './escrow-xp-procedure.js';

export const escrowRouter = router({
  ...escrowReadProcedures,
  ...escrowPaymentProcedures,
  ...escrowReleaseProcedures,
  ...escrowXpProcedures,
});

export type EscrowRouter = typeof escrowRouter;
