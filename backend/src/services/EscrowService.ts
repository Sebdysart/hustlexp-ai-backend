/** Canonical escrow service facade. Operation modules own financial state transitions. */
import { getEscrowById, getEscrowByTaskId, createEscrow, syncPendingEscrowAmount } from './EscrowReadService.js';
import { fundEscrow } from './EscrowFundService.js';
import { releaseEscrow } from './EscrowReleaseService.js';
import { refundEscrow } from './EscrowRefundService.js';
import { lockEscrowForDispute } from './EscrowDisputeService.js';
import { partialRefundEscrow } from './EscrowPartialRefundService.js';
import {
  getValidEscrowTransitions,
  isTerminalEscrowState,
  isValidEscrowTransition,
} from './EscrowServiceShared.js';

export const EscrowService = {
  getById: getEscrowById,
  getByTaskId: getEscrowByTaskId,
  create: createEscrow,
  syncPendingAmount: syncPendingEscrowAmount,
  fund: fundEscrow,
  release: releaseEscrow,
  refund: refundEscrow,
  lockForDispute: lockEscrowForDispute,
  partialRefund: partialRefundEscrow,
  isTerminalState: isTerminalEscrowState,
  isValidTransition: isValidEscrowTransition,
  getValidTransitions: getValidEscrowTransitions,
};

export default EscrowService;
