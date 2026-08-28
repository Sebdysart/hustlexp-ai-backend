/**
 * Deprecated import bridge for the historical quote-payment recovery lane.
 * New financial effects use FinancialProviderPorts and the Universal V1
 * financial application service.
 */
export type {
  LegacyQuotePaymentRecoveryPort,
  QuotePaymentRecoveryReason,
  RecoverLegacyQuoteFinancialSecurityInput,
  RecoverLegacyQuoteFinancialSecurityResult,
} from './LegacyQuotePaymentRecoveryPort.js';

export type {
  LegacyQuotePaymentRecoveryPort as QuotePaymentProvider,
  RecoverLegacyQuoteFinancialSecurityInput as RecoverQuotePaymentInput,
  RecoverLegacyQuoteFinancialSecurityResult as RecoverQuotePaymentResult,
} from './LegacyQuotePaymentRecoveryPort.js';
