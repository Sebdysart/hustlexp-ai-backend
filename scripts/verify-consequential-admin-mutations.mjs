#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultInventoryPath = join(
  repositoryRoot,
  'backend',
  'governance',
  'consequential-admin-mutations.json'
);

export const classifications = [
  'READ',
  'BOUNDED_SINGLE_OPERATOR',
  'TWO_PERSON',
  'HELD',
  'FORBIDDEN',
];

const administratorProcedures = [
  'adminProcedure',
  'platformAdminProcedure',
  'financialAdminProcedure',
  'escrowAdminProcedure',
  'userManagementAdminProcedure',
  'disputeAdminProcedure',
  'trustAdminProcedure',
  'safetyAdminProcedure',
  'operationsAdminProcedure',
  'operationsStepUpProcedure',
  'adminOrEngineBridgeProcedure',
  'heldPlatformAdminProcedure',
  'heldFinancialAdminProcedure',
  'heldEscrowAdminProcedure',
  'heldUserManagementAdminProcedure',
  'heldTrustAdminProcedure',
  'heldSafetyAdminProcedure',
  'heldOperationsAdminProcedure',
  'heldAdminOrEngineBridgeProcedure',
];
const procedureAlternation = administratorProcedures.join('|');
const adminProcedurePattern = new RegExp(`\\b(${procedureAlternation})\\b`, 'gu');
const routeStartPattern = new RegExp(
  `^\\s{2}([A-Za-z_$][A-Za-z0-9_$]*):\\s*(${procedureAlternation})\\b`
);
const nextRoutePattern = /^\s{2}[A-Za-z_$][A-Za-z0-9_$]*:\s/;

function normalizedPath(path) {
  return path.split(sep).join('/');
}

function routerFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return routerFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    })
    .sort();
}

function routeTransport(block, sourcePath, routeName) {
  const mutationIndex = block.search(/\.mutation\s*\(/u);
  const queryIndex = block.search(/\.query\s*\(/u);
  if (mutationIndex < 0 && queryIndex < 0) {
    throw new Error(`${sourcePath}#${routeName}: expected a .query(...) or .mutation(...) call`);
  }
  if (mutationIndex < 0) return 'query';
  if (queryIndex < 0) return 'mutation';
  return mutationIndex < queryIndex ? 'mutation' : 'query';
}

export function discoverAdminSurfaces(root = repositoryRoot) {
  const routersRoot = join(root, 'backend', 'src', 'routers');
  const discovered = [];

  for (const absolutePath of routerFiles(routersRoot)) {
    const sourcePath = normalizedPath(relative(root, absolutePath));
    const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/u);

    for (let index = 0; index < lines.length; index += 1) {
      const start = routeStartPattern.exec(lines[index]);
      if (!start) continue;

      let end = index + 1;
      while (end < lines.length && !nextRoutePattern.test(lines[end])) end += 1;
      const block = lines.slice(index, end).join('\n');
      const sourceAdminProcedures = [...block.matchAll(adminProcedurePattern)].map(
        (match) => match[1]
      );
      const uniqueProcedures = [...new Set(sourceAdminProcedures)];
      if (uniqueProcedures.length !== 1 || uniqueProcedures[0] !== start[2]) {
        throw new Error(`${sourcePath}#${start[1]}: ambiguous administrator procedure chain`);
      }

      discovered.push({
        surfaceId: `${sourcePath}#${start[1]}`,
        sourcePath,
        routeName: start[1],
        procedure: start[2],
        transport: routeTransport(block, sourcePath, start[1]),
        callsTwoPersonRail: /\bOperatorAuthorityService\.(?:request|approve|reject)\s*\(/u.test(
          block
        ),
        explicitlyForbidden: /\bforbiddenConsequentialAdminMutation\s*\(/u.test(block),
      });
    }
  }

  return discovered.sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
}

export function loadInventory(path = defaultInventoryPath) {
  if (!existsSync(path)) throw new Error(`Missing consequential-admin inventory: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertExactKeys(value, expected, label, errors) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    errors.push(`${label}: keys must be exactly ${wanted.join(', ')}`);
  }
}

export function featureFlagAuthorityErrors({
  routeSource,
  serviceSource,
  operatorAuthoritySource,
}) {
  const errors = [];
  if (/\bsetFlag\s*:/u.test(routeSource) || /FlagsService\.setFlag\s*\(/u.test(routeSource)) {
    errors.push('flags router must not expose or call the direct FlagsService.setFlag mutation');
  }
  if (
    /enabled\s*:\s*z\.boolean/u.test(routeSource) ||
    /enabled\s*:\s*z\.literal\(true\)/u.test(routeSource)
  ) {
    errors.push('flags router must not accept a direct feature-enable payload');
  }
  if (
    !/requestDisable\s*:\s*operationsStepUpProcedure/u.test(routeSource) ||
    !/enabled\s*:\s*z\.literal\(false\)/u.test(routeSource) ||
    !/OperatorAuthorityService\.request\s*\(/u.test(routeSource)
  ) {
    errors.push(
      'flags router disable requests must use the stepped-up two-person OperatorAuthorityService rail'
    );
  }
  if (
    /\bsetFlag\s*:/u.test(serviceSource) ||
    /\b(?:INSERT\s+INTO|UPDATE)\s+feature_flags\b/iu.test(serviceSource)
  ) {
    errors.push('FlagsService must remain read-only with no direct feature-flag mutation method');
  }
  if (
    !/UPDATE\s+feature_flags[\s\S]*?SET\s+enabled\s*=\s*false/iu.test(operatorAuthoritySource) ||
    /SET\s+enabled\s*=\s*true/iu.test(operatorAuthoritySource)
  ) {
    errors.push('OperatorAuthorityService must be the disable-only feature-flag write boundary');
  }
  return errors;
}

export function verifyInventory(inventory, discovered, root = repositoryRoot) {
  const errors = [];
  assertExactKeys(
    inventory,
    ['schemaVersion', 'authority', 'classifications', 'classificationPolicy', 'surfaces'],
    'inventory',
    errors
  );
  if (inventory.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (inventory.authority !== 'hustlexp-ai-backend/PostgreSQL') {
    errors.push('authority must remain hustlexp-ai-backend/PostgreSQL');
  }
  if (JSON.stringify(inventory.classifications) !== JSON.stringify(classifications)) {
    errors.push('classifications must match the closed classification set in stable order');
  }
  if (
    !inventory.classificationPolicy ||
    typeof inventory.classificationPolicy !== 'object' ||
    Array.isArray(inventory.classificationPolicy)
  ) {
    errors.push('classificationPolicy must be an object');
  } else {
    const policyKeys = Object.keys(inventory.classificationPolicy);
    if (JSON.stringify(policyKeys) !== JSON.stringify(classifications)) {
      errors.push('classificationPolicy must document every classification in stable order');
    }
    for (const classification of classifications) {
      if (
        typeof inventory.classificationPolicy[classification] !== 'string' ||
        inventory.classificationPolicy[classification].trim().length < 12
      ) {
        errors.push(`classificationPolicy.${classification} must be meaningful`);
      }
    }
  }
  if (
    !inventory.surfaces ||
    typeof inventory.surfaces !== 'object' ||
    Array.isArray(inventory.surfaces)
  ) {
    errors.push('surfaces must be an object keyed by source surface');
  }
  if (errors.length)
    throw new Error(`Consequential-admin inventory verification failed:\n- ${errors.join('\n- ')}`);

  const inventoryIds = Object.keys(inventory.surfaces);
  if (JSON.stringify(inventoryIds) !== JSON.stringify([...inventoryIds].sort())) {
    errors.push('surfaces must be sorted by surfaceId');
  }

  const discoveredById = new Map(discovered.map((entry) => [entry.surfaceId, entry]));
  const missing = discovered.filter((entry) => !(entry.surfaceId in inventory.surfaces));
  const stale = inventoryIds.filter((surfaceId) => !discoveredById.has(surfaceId));
  if (missing.length)
    errors.push(
      `unclassified administrator surfaces: ${missing.map((entry) => entry.surfaceId).join(', ')}`
    );
  if (stale.length) errors.push(`stale inventory surfaces: ${stale.join(', ')}`);

  for (const [surfaceId, classification] of Object.entries(inventory.surfaces)) {
    const actual = discoveredById.get(surfaceId);
    if (!actual) continue;
    if (!classifications.includes(classification)) {
      errors.push(`${surfaceId}: unknown classification ${String(classification)}`);
    }
    if (actual.transport === 'query' && classification !== 'READ') {
      errors.push(`${surfaceId}: query surfaces must be classified READ`);
    }
    if (actual.transport === 'mutation' && classification === 'READ') {
      errors.push(`${surfaceId}: mutation surfaces cannot be classified READ`);
    }
    if (classification === 'HELD' && !actual.procedure.startsWith('held')) {
      errors.push(`${surfaceId}: HELD mutations must use an explicit held*Procedure`);
    }
    if (actual.procedure.startsWith('held') && classification !== 'HELD') {
      errors.push(`${surfaceId}: held*Procedure must be classified HELD`);
    }
    if (classification === 'TWO_PERSON' && !actual.callsTwoPersonRail) {
      errors.push(
        `${surfaceId}: TWO_PERSON mutations must call the OperatorAuthorityService command rail`
      );
    }
    if (actual.callsTwoPersonRail && classification !== 'TWO_PERSON') {
      errors.push(
        `${surfaceId}: OperatorAuthorityService command routes must be classified TWO_PERSON`
      );
    }
    if (classification === 'FORBIDDEN' && !actual.explicitlyForbidden) {
      errors.push(
        `${surfaceId}: FORBIDDEN mutations must invoke forbiddenConsequentialAdminMutation`
      );
    }
    if (actual.explicitlyForbidden && classification !== 'FORBIDDEN') {
      errors.push(`${surfaceId}: explicit policy tombstones must be classified FORBIDDEN`);
    }
  }

  errors.push(
    ...featureFlagAuthorityErrors({
      routeSource: readFileSync(join(root, 'backend', 'src', 'routers', 'flags.ts'), 'utf8'),
      serviceSource: readFileSync(
        join(root, 'backend', 'src', 'services', 'FlagsService.ts'),
        'utf8'
      ),
      operatorAuthoritySource: readFileSync(
        join(root, 'backend', 'src', 'services', 'OperatorAuthorityService.ts'),
        'utf8'
      ),
    })
  );

  if (errors.length) {
    throw new Error(`Consequential-admin inventory verification failed:\n- ${errors.join('\n- ')}`);
  }

  return {
    surfaceCount: discovered.length,
    mutationCount: discovered.filter((entry) => entry.transport === 'mutation').length,
    queryCount: discovered.filter((entry) => entry.transport === 'query').length,
    classifications: Object.fromEntries(
      classifications.map((classification) => [
        classification,
        Object.values(inventory.surfaces).filter((value) => value === classification).length,
      ])
    ),
  };
}

export function verifyRepository(root = repositoryRoot) {
  return verifyInventory(
    loadInventory(join(root, 'backend', 'governance', 'consequential-admin-mutations.json')),
    discoverAdminSurfaces(root),
    root
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyRepository();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
