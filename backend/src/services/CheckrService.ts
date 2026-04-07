/**
 * CheckrService v1.0.0
 *
 * Real Checkr API integration for identity verification and background checks.
 *
 * Checkr Flow:
 * 1. Create Candidate → POST /v1/candidates
 * 2. Create Invitation → POST /v1/invitations (sends candidate a hosted link)
 * 3. Candidate completes verification on Checkr's hosted page
 * 4. Webhooks notify us of results (report.completed, etc.)
 *
 * @see https://docs.checkr.com
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import crypto from 'node:crypto';

const log = logger.child({ service: 'CheckrService' });

// ============================================================================
// TYPES
// ============================================================================

export interface CheckrCandidate {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  dob?: string;
  ssn?: string;
  uri: string;
}

export interface CheckrInvitation {
  id: string;
  status: string;
  uri: string;
  invitation_url: string;
  candidate_id: string;
  package: string;
}

export interface CheckrReport {
  id: string;
  status: string;
  result: string | null;
  candidate_id: string;
  package: string;
  completed_at: string | null;
}

// ============================================================================
// API HELPERS
// ============================================================================

function getApiKey(): string {
  const key = config.identity.checkr.apiKey;
  if (!key) {
    throw new Error('CHECKR_API_KEY not configured');
  }
  return key;
}

function getApiBase(): string {
  return config.identity.checkr.apiBase;
}

/**
 * Make an authenticated request to the Checkr API.
 * Checkr uses HTTP Basic Auth with the API key as the username.
 */
async function checkrFetch<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const apiKey = getApiKey();
  const url = `${getApiBase()}${path}`;

  const headers: Record<string, string> = {
    'Authorization': `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    'Content-Type': 'application/json',
  };

  const options: RequestInit = {
    method,
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  log.info({ method, path }, 'Checkr API request');

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'No body');
    log.error({
      method,
      path,
      status: response.status,
      body: errorBody,
    }, 'Checkr API error');
    throw new Error(`Checkr API ${method} ${path} failed: ${response.status} — ${errorBody}`);
  }

  return await response.json() as T;
}

// ============================================================================
// CANDIDATE MANAGEMENT
// ============================================================================

/**
 * Create a Checkr candidate (the person being verified).
 */
export async function createCandidate(params: {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  dob?: string; // YYYY-MM-DD
}): Promise<CheckrCandidate> {
  const body: Record<string, unknown> = {
    first_name: params.firstName,
    last_name: params.lastName,
    email: params.email,
  };

  if (params.phone) body.phone = params.phone;
  if (params.dob) body.dob = params.dob;

  const candidate = await checkrFetch<CheckrCandidate>('POST', '/v1/candidates', body);

  log.info({ candidateId: candidate.id, email: params.email }, 'Checkr candidate created');

  return candidate;
}

// ============================================================================
// INVITATION (HOSTED VERIFICATION FLOW)
// ============================================================================

/**
 * Create an invitation — sends the candidate a link to complete
 * identity verification and/or background check on Checkr's hosted page.
 *
 * @param candidateId - Checkr candidate ID
 * @param packageSlug - Checkr package slug (e.g. 'tasker_standard', 'driver_standard')
 *                      Default: 'tasker_standard' for basic ID + SSN trace
 */
export async function createInvitation(
  candidateId: string,
  packageSlug: string = 'tasker_standard',
  workLocations?: Array<{ state: string; country?: string }>
): Promise<CheckrInvitation> {
  const invitation = await checkrFetch<CheckrInvitation>('POST', '/v1/invitations', {
    candidate_id: candidateId,
    package: packageSlug,
    work_locations: workLocations ?? [{ country: 'US', state: 'all' }],
  });

  log.info({
    invitationId: invitation.id,
    candidateId,
    invitationUrl: invitation.invitation_url,
    package: packageSlug,
  }, 'Checkr invitation created');

  return invitation;
}

// ============================================================================
// REPORT RETRIEVAL
// ============================================================================

/**
 * Get a report by ID.
 */
export async function getReport(reportId: string): Promise<CheckrReport> {
  return await checkrFetch<CheckrReport>('GET', `/v1/reports/${reportId}`);
}

/**
 * Get a candidate by ID.
 */
export async function getCandidate(candidateId: string): Promise<CheckrCandidate> {
  return await checkrFetch<CheckrCandidate>('GET', `/v1/candidates/${candidateId}`);
}

// ============================================================================
// WEBHOOK VERIFICATION
// ============================================================================

/**
 * Verify Checkr webhook signature.
 * Checkr signs webhooks with HMAC-SHA256 using your webhook secret.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string
): boolean {
  const secret = config.identity.checkr.webhookSecret;
  if (!secret) {
    log.warn('CHECKR_WEBHOOK_SECRET not configured — skipping signature verification');
    return true; // Allow in dev
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

export default {
  createCandidate,
  createInvitation,
  getReport,
  getCandidate,
  verifyWebhookSignature,
};
