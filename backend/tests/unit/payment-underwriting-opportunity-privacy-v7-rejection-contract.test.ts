import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_CONDITIONAL_HOLD_MAX_TTL_SECONDS_V7,
  PAYMENT_OPPORTUNITY_AUTHORITY_V7,
  PAYMENT_OPPORTUNITY_SAFE_PREVIEW_FIELDS_V7,
  PAYMENT_PROVIDER_ELIGIBILITY_REQUIRED_FLAGS_V7,
  paymentOpportunityPreviewBlockersV7,
  paymentProviderEligibilityBlockersV7,
} from '../../src/contracts/PaymentUnderwritingOpportunityV7.js';

const root = resolve(import.meta.dirname, '../../..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const hash = (character: string): string => character.repeat(64);

const validPreview = Object.freeze({
  categoryCode: 'YARD_WORK',
  generalAreaCode: 'US-WA-SEA-NORTH',
  scheduleWindowStart: '2026-08-23T18:00:00.000Z',
  scheduleWindowEnd: '2026-08-23T20:00:00.000Z',
  scopeSummarySha256: hash('a'),
  requirementsSha256: hash('b'),
  pricingLane: 'PLATFORM_PRICED',
  grossEarningsMinCents: 8_000,
  grossEarningsMaxCents: 10_000,
  currency: 'usd',
});

const validEligibility = Object.freeze({
  eligibilityState: 'ELIGIBLE',
  fundingState: 'READY',
  observedAt: '2026-08-22T20:58:00.000Z',
  expiresAt: '2026-08-23T20:00:00.000Z',
  bankReferencePresent: true,
  hasBlockingRestrictions: false,
  paymentEligible: true,
  merchantContextApproved: true,
  categoryEligible: true,
  credentialsEligible: true,
  trustEligible: true,
  availabilityEligible: true,
});

describe('payment underwriting opportunity privacy v7', () => {
  it('pins the exact D3 source authority and remains operationally inert', () => {
    expect(PAYMENT_OPPORTUNITY_AUTHORITY_V7).toEqual({
      googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
      driveRevision: '7',
      docsRevision:
        'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
      textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
      acceptedD2Commit: '2abbddf7ababcbfe1c8f3ba96147f562421be2e5',
      contractVersion: 7,
      operationallyEnabled: false,
    });
    expect(PAYMENT_CONDITIONAL_HOLD_MAX_TTL_SECONDS_V7).toBe(15 * 60);
  });

  it('defines a closed redacted-preview vocabulary and rejects private fields', () => {
    expect(PAYMENT_OPPORTUNITY_SAFE_PREVIEW_FIELDS_V7).toEqual([
      'categoryCode',
      'generalAreaCode',
      'scheduleWindowStart',
      'scheduleWindowEnd',
      'scopeSummarySha256',
      'requirementsSha256',
      'pricingLane',
      'grossEarningsMinCents',
      'grossEarningsMaxCents',
      'currency',
    ]);
    expect(paymentOpportunityPreviewBlockersV7(validPreview)).toEqual([]);
    expect(
      paymentOpportunityPreviewBlockersV7({
        ...validPreview,
        exactAddress: '100 Main Street',
        customerEmail: 'customer@example.invalid',
        accessInstructions: 'door code',
        paymentToken: 'tok_secret',
      })
    ).toEqual([
      'unsafe_field:accessInstructions',
      'unsafe_field:customerEmail',
      'unsafe_field:exactAddress',
      'unsafe_field:paymentToken',
    ]);
    expect(
      paymentOpportunityPreviewBlockersV7({
        ...validPreview,
        scheduleWindowEnd: '2026-08-23T17:59:59.000Z',
        grossEarningsMaxCents: 7_999,
      })
    ).toEqual(['invalid_schedule_window', 'invalid_earnings_range']);
  });

  it('requires complete, fresh provider and task eligibility before a soft hold', () => {
    expect(PAYMENT_PROVIDER_ELIGIBILITY_REQUIRED_FLAGS_V7).toEqual([
      'paymentEligible',
      'merchantContextApproved',
      'categoryEligible',
      'credentialsEligible',
      'trustEligible',
      'availabilityEligible',
    ]);
    expect(
      paymentProviderEligibilityBlockersV7(validEligibility, '2026-08-22T21:00:00.000Z')
    ).toEqual([]);
    expect(
      paymentProviderEligibilityBlockersV7(
        {
          ...validEligibility,
          fundingState: 'PENDING',
          bankReferencePresent: false,
          hasBlockingRestrictions: true,
          merchantContextApproved: false,
          categoryEligible: false,
          credentialsEligible: false,
          trustEligible: false,
          availabilityEligible: false,
        },
        '2026-08-24T00:00:00.000Z'
      )
    ).toEqual([
      'funding_not_ready',
      'provider_evidence_expired',
      'provider_evidence_stale',
      'bank_reference_missing',
      'blocking_restrictions',
      'merchant_context_unapproved',
      'category_ineligible',
      'credentials_ineligible',
      'trust_ineligible',
      'availability_ineligible',
    ]);
    expect(
      paymentProviderEligibilityBlockersV7(
        {
          ...validEligibility,
          observedAt: '2026-08-22T21:00:06.000Z',
        },
        '2026-08-22T21:00:00.000Z'
      )
    ).toEqual(['provider_evidence_future']);
  });

  it('freezes opportunity, link, interest, revalidation, and hold evidence without money authority', () => {
    const migration = source(
      'backend/database/migrations/20260821_payment_underwriting_opportunity_privacy_v7.sql'
    );
    for (const table of [
      'payment_task_opportunity_previews_v7',
      'payment_opportunity_signing_keys_v7',
      'payment_task_opportunity_links_v7',
      'payment_opportunity_admin_authorities_v7',
      'payment_task_opportunity_link_revocations_v7',
      'payment_task_opportunity_interests_v7',
      'payment_task_revalidations_v7',
      'payment_conditional_provider_hold_events_v7',
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const functionName of [
      'hxos_payment_opportunity_link_material_sha256_v7',
      'hxos_payment_opportunity_link_signature_sha256_v7',
      'hxos_payment_opportunity_link_verification_sha256_v7',
      'hxos_payment_opportunity_signing_key_authority_sha256_v7',
      'hxos_payment_opportunity_admin_authority_sha256_v7',
      'hxos_reject_payment_underwriting_d3_mutation_v7',
      'hxos_enforce_payment_opportunity_signing_key_v7',
      'hxos_enforce_payment_opportunity_admin_authority_v7',
      'hxos_enforce_payment_task_opportunity_v7',
      'hxos_enforce_payment_opportunity_preview_v7',
      'hxos_enforce_payment_opportunity_link_v7',
      'hxos_enforce_payment_opportunity_link_revocation_v7',
      'hxos_enforce_payment_opportunity_interest_v7',
      'hxos_enforce_payment_task_revalidation_v7',
      'hxos_enforce_payment_conditional_provider_hold_v7',
      'hxos_enforce_payment_conditional_hold_event_v7',
    ]) {
      expect(migration).toContain(functionName);
    }
    expect(migration).toContain('payment_conditional_provider_hold_status_v7');
    expect(migration).toContain("INTERVAL '15 minutes'");
    expect(migration).toContain("INTERVAL '7 days'");
    expect(migration).toContain('recipient_binding_sha256 IS NOT NULL');
    expect(migration).toContain('link_material_sha256 CHAR(64) NOT NULL UNIQUE');
    expect(migration).toContain('signature_key_id TEXT NOT NULL');
    expect(migration).toContain('signature_verified_at TIMESTAMPTZ NOT NULL');
    expect(migration).toContain('signature_verification_sha256 CHAR(64) NOT NULL UNIQUE');
    expect(migration).toContain("algorithm TEXT NOT NULL CHECK (algorithm = 'HMAC_SHA256')");
    expect(migration).toContain("current_setting('hxp.opportunity_link_signing_secret', true)");
    expect(migration).toContain("role IN ('admin', 'founder')");
    expect(migration).toContain(
      'FOREIGN KEY (admin_authority_id, revoked_by_user_id, opportunity_link_id, reason_code)'
    );
    expect(migration).toContain("v_stage IS DISTINCT FROM 'PROVIDER_SOURCING'");
    expect(migration.match(/v_stage IS DISTINCT FROM 'PROVIDER_SOURCING'/g)).toHaveLength(3);
    expect(migration).toContain(
      "actor_type TEXT NOT NULL CHECK (actor_type IN ('PROVIDER', 'POSTER', 'SYSTEM'))"
    );
    expect(migration).toContain('v_provider.expires_at < NEW.valid_until');
    expect(migration).toContain('v_provider.expires_at < NEW.expires_at');
    expect(migration).toMatch(/octet_length\([\s\S]*opportunity_link_signing_secret[\s\S]*\) < 32/);
    expect(migration).toContain("interest_kind = 'EXPRESS_INTEREST'");
    expect(migration).toContain('task_open AND quote_current AND schedule_valid');
    expect(migration).toContain("NEW.observed_at < v_now - INTERVAL '5 minutes'");
    expect(migration).not.toContain("'CONSUMED'");
    expect(migration).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)/i);
    expect(migration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?payment_financial_security_events_v7/i
    );
    expect(migration).not.toMatch(/paymentIntents|refunds\.create|transfers\.create/i);
  });

  it('keeps D3 outside runtime startup and binds truthful dependency evidence', () => {
    const registry = source('backend/src/jobs/engine-automation-migration-files.ts');
    expect(registry).not.toContain('20260821_payment_underwriting_opportunity_privacy_v7');

    const manifest = JSON.parse(
      source('docs/underwriting/payment-underwriting-d3-opportunity-privacy-v7.json')
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: 'HX_PAYMENT_UNDERWRITING_TRACEABILITY_V7',
      slice: 'D3_OPPORTUNITY_PRIVACY_PROVIDER_ELIGIBILITY_CONDITIONAL_HOLD',
      parentCommit: 'adbe29d14495392d60efea431c3b18f15c3868bb',
      rejectedPredecessorCommit: 'adbe29d14495392d60efea431c3b18f15c3868bb',
      supersededRejectedCommits: [
        '119b70f5ad7755aaba9fca5e69dd8b69f457dc0c',
        'adbe29d14495392d60efea431c3b18f15c3868bb',
      ],
      acceptedDependencyCommit: '2abbddf7ababcbfe1c8f3ba96147f562421be2e5',
      acceptedDependencyTree: '93362123c41609307077365302e7348f8a680113',
      migration: '20260821_payment_underwriting_opportunity_privacy_v7',
      startupRegistered: false,
      operationallyEnabled: false,
      runtimeAuthority: 'NONE_SCHEMA_ARTIFACT_ONLY',
      legacyExternalBridge: 'CURRENT_TASK_BASED_NOT_D3_AUTHORITY',
    });
    expect(manifest.invariants).toEqual(
      expect.arrayContaining([
        'NO_REGISTERED_CURRENT_SIGNING_KEY_AND_VALID_HMAC_NO_LINK',
        'NO_CURRENT_PROVIDER_SOURCING_STAGE_NO_LINK',
        'NO_CURRENT_PROVIDER_SOURCING_STAGE_NO_EXPRESS_INTEREST',
        'NO_CURRENT_ADMIN_ROLE_AND_BOUND_AUTHORITY_NO_ADMIN_REVOCATION',
        'NO_PROVIDER_VALIDITY_COVERING_REVALIDATION_AND_HOLD_NO_SOFT_HOLD',
        'HOLD_TRANSITIONS_ACCEPT_ONLY_BOUND_PROVIDER_POSTER_OR_SYSTEM_ACTORS',
      ])
    );
  });
});
