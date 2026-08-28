import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverAdminSurfaces,
  featureFlagAuthorityErrors,
  loadInventory,
  verifyInventory,
  verifyRepository,
} from './verify-consequential-admin-mutations.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function currentEvidence() {
  return {
    inventory: loadInventory(),
    discovered: discoverAdminSurfaces(),
  };
}

test('the exact consequential-admin inventory covers every current administrator surface', () => {
  const result = verifyRepository();
  assert.deepEqual(result, {
    surfaceCount: 141,
    mutationCount: 73,
    queryCount: 68,
    classifications: {
      READ: 68,
      BOUNDED_SINGLE_OPERATOR: 53,
      TWO_PERSON: 5,
      HELD: 14,
      FORBIDDEN: 1,
    },
  });
});

test('an added administrator mutation fails until it is explicitly classified', () => {
  const { inventory, discovered } = currentEvidence();
  discovered.push({
    surfaceId: 'backend/src/routers/newSurface.ts#mutate',
    sourcePath: 'backend/src/routers/newSurface.ts',
    routeName: 'mutate',
    procedure: 'platformAdminProcedure',
    transport: 'mutation',
    callsTwoPersonRail: false,
    explicitlyForbidden: false,
  });
  assert.throws(
    () => verifyInventory(inventory, discovered),
    /unclassified administrator surfaces: backend\/src\/routers\/newSurface\.ts#mutate/u
  );
});

test('stale inventory entries fail instead of silently outliving removed routes', () => {
  const { inventory, discovered } = currentEvidence();
  const changed = structuredClone(inventory);
  changed.surfaces['backend/src/routers/removed.ts#legacyMutation'] = 'HELD';
  changed.surfaces = Object.fromEntries(Object.entries(changed.surfaces).sort());
  assert.throws(
    () => verifyInventory(changed, discovered),
    /stale inventory surfaces: backend\/src\/routers\/removed\.ts#legacyMutation/u
  );
});

test('held, two-person, and forbidden labels are verified against executable controls', () => {
  const { inventory, discovered } = currentEvidence();

  const heldDrift = structuredClone(inventory);
  heldDrift.surfaces['backend/src/routers/admin.ts#setUserBan'] = 'BOUNDED_SINGLE_OPERATOR';
  assert.throws(
    () => verifyInventory(heldDrift, discovered),
    /held\*Procedure must be classified HELD/u
  );

  const twoPersonDrift = structuredClone(inventory);
  twoPersonDrift.surfaces['backend/src/routers/flags.ts#requestDisable'] =
    'BOUNDED_SINGLE_OPERATOR';
  assert.throws(
    () => verifyInventory(twoPersonDrift, discovered),
    /OperatorAuthorityService command routes must be classified TWO_PERSON/u
  );

  const forbiddenDrift = structuredClone(inventory);
  forbiddenDrift.surfaces['backend/src/routers/referral.ts#issueReward'] = 'HELD';
  assert.throws(
    () => verifyInventory(forbiddenDrift, discovered),
    /explicit policy tombstones must be classified FORBIDDEN/u
  );
});

test('every uncovered trust and safety mutation is explicitly terminally held', () => {
  const { inventory, discovered } = currentEvidence();
  const uncovered = new Set([
    'backend/src/routers/capabilityCoreRoutes.ts#approveLicense',
    'backend/src/routers/capabilityCoreRoutes.ts#rejectLicense',
  ]);
  const relevant = discovered.filter((surface) => uncovered.has(surface.surfaceId));
  assert.equal(relevant.length, uncovered.size);
  for (const surface of relevant) {
    assert.match(surface.procedure, /^held/u, surface.surfaceId);
    assert.equal(inventory.surfaces[surface.surfaceId], 'HELD', surface.surfaceId);
  }
});

test('direct feature-flag mutation or enablement fails the authority verifier', () => {
  const sources = {
    routeSource: readFileSync(
      join(repositoryRoot, 'backend', 'src', 'routers', 'flags.ts'),
      'utf8'
    ),
    serviceSource: readFileSync(
      join(repositoryRoot, 'backend', 'src', 'services', 'FlagsService.ts'),
      'utf8'
    ),
    operatorAuthoritySource: readFileSync(
      join(repositoryRoot, 'backend', 'src', 'services', 'OperatorAuthorityService.ts'),
      'utf8'
    ),
  };
  assert.deepEqual(featureFlagAuthorityErrors(sources), []);
  assert.match(
    featureFlagAuthorityErrors({
      ...sources,
      serviceSource: `${sources.serviceSource}\nsetFlag: async () => db.query('UPDATE feature_flags SET enabled = true')`,
    }).join('\n'),
    /FlagsService must remain read-only/u
  );
  assert.match(
    featureFlagAuthorityErrors({
      ...sources,
      routeSource: sources.routeSource.replace('z.literal(false)', 'z.literal(true)'),
    }).join('\n'),
    /must not accept a direct feature-enable payload/u
  );
  assert.match(
    featureFlagAuthorityErrors({
      ...sources,
      operatorAuthoritySource: sources.operatorAuthoritySource.replace(
        'SET enabled = false',
        'SET enabled = true'
      ),
    }).join('\n'),
    /disable-only feature-flag write boundary/u
  );
});
