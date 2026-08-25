import { LocalCertificationPayoutProvider } from '../src/services/LocalCertificationPayoutProvider.js';

const organizationId = '56cac28c-fac0-4b94-91c1-f636055843b3';
const payoutRecipientUserId = '48c135b9-db68-46d3-94b2-83e03cd96dbd';

// Can be the same Business owner for this local test.
const actorId = payoutRecipientUserId;

const result =
  await LocalCertificationPayoutProvider.activateBusinessDestination(
    organizationId,
    payoutRecipientUserId,
    actorId,
  );

console.log(JSON.stringify(result, null, 2));