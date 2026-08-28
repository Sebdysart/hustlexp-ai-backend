import { grantScreeningConsent } from '../src/services/WorkerScreeningRightsService.js';
import { LocalCertificationScreeningProvider } from '../src/services/LocalCertificationScreeningProvider.js';
import {
  LOCAL_CERTIFICATION_SCREENING_PROVIDER,
  LOCAL_CERTIFICATION_SCREENING_PURPOSE,
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
} from '../src/services/WorkerScreeningRightsPolicy.js';

const workerId = '23b205a5-3af0-426c-a9bd-2d441d484f77';

const consent = await grantScreeningConsent({
  workerId,
  provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER,
  purpose: LOCAL_CERTIFICATION_SCREENING_PURPOSE,
  disclosureVersion: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
  disclosureHash: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
  disclosurePresentedStandalone: true,
  consentGranted: true,
  purposeAcknowledged: true,
  rightsSummaryAcknowledged: true,
  providerNamed: true,
  idempotencyKey: 'local-test-hustler-screening-v1',
});

console.log('consent:', consent);

const screening = await LocalCertificationScreeningProvider.initiate({
  workerId,
  consentId: consent.consentId,
  idempotencyKey: 'local-test-hustler-screening-init-v1',
});

if (!screening.success) {
  throw new Error(
    `${screening.error.code}: ${screening.error.message}`,
  );
}

console.log('screening:', screening.data);

const cleared = await LocalCertificationScreeningProvider.completeClear({
  backgroundCheckId: screening.data.backgroundCheckId,
  workerId,
  actorId: workerId,
  idempotencyKey: 'local-test-hustler-screening-clear-v1',
});

if (!cleared.success) {
  throw new Error(
    `${cleared.error.code}: ${cleared.error.message}`,
  );
}

console.log('cleared:', cleared.data);