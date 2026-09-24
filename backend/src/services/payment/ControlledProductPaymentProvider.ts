import { LocalCertificationPaymentProvider } from '../LocalCertificationPaymentProvider.js';
import type { StandaloneProductPaymentProvider } from './StandaloneProductPaymentProvider.js';

export const ControlledProductPaymentProvider: StandaloneProductPaymentProvider = {
  create: (purchase) => LocalCertificationPaymentProvider.createProductIntent(purchase),
  verify: (purchase) => LocalCertificationPaymentProvider.verifyProductIntent(purchase),
};
