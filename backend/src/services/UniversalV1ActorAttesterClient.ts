import { randomBytes } from 'node:crypto';

import type { QueryFn } from '../db.js';
import { db } from '../db.js';
import {
  actorAttesterRequestSignaturePayload,
  actorAttesterResponseSignaturePayload,
  equalLowerHex,
  hmacSha256LowerHex,
  parseUniversalV1ActorCommandPayload,
  sha256LowerHex,
  UNIVERSAL_V1_ACTOR_ATTESTATION_PATH,
  UNIVERSAL_V1_ACTOR_ATTESTATION_MAX_CLOCK_SKEW_MS,
  UNIVERSAL_V1_ACTOR_ATTESTATION_RESPONSE_LIMIT_BYTES,
  UniversalV1ActorAttestationResponseSchema,
  UniversalV1ActorAttestationTransportBodySchema,
  UniversalV1CanonicalActorRequestSchema,
  type UniversalV1ActorAttestationHandle,
  type UniversalV1ActorAttestationResponse,
  type UniversalV1ActorCommand,
  type UniversalV1ActorEnvironment,
  type UniversalV1CanonicalActorRequest,
} from '../auth/universal-v1-actor-attestation-contracts.js';
import {
  resolveUniversalV1ActorReleaseBinding,
  type UniversalV1ActorReleaseBinding,
} from './UniversalV1ActorAttestationReleaseAuthority.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const TRANSPORT_SECRET_MIN_CHARACTERS = 32;
const DEFAULT_TIMEOUT_MS = 1_500;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 2_000;

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export class UniversalV1ActorAttestationClientError extends Error {
  constructor(readonly code: string) {
    super(`UNIVERSAL_V1_ACTOR_ATTESTATION_REFUSED:${code}`);
    this.name = 'UniversalV1ActorAttestationClientError';
  }
}

export interface UniversalV1CanonicalRequestDigestPort {
  digest(canonicalRequest: Record<string, unknown>): Promise<string>;
}

export class PostgresUniversalV1CanonicalRequestDigest implements UniversalV1CanonicalRequestDigestPort {
  constructor(private readonly query: QueryFn = db.query) {}

  async digest(canonicalRequest: Record<string, unknown>): Promise<string> {
    const result = await this.query<{ digest: string }>(
      `SELECT pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to($1::JSONB::TEXT, 'UTF8')),
          'hex'
        ) AS digest`,
      [canonicalRequest]
    );
    const digest = result.rows[0]?.digest;
    if (!digest || !SHA256.test(digest)) {
      throw new UniversalV1ActorAttestationClientError('CANONICAL_DIGEST_UNAVAILABLE');
    }
    return digest;
  }
}

export interface UniversalV1CanonicalRequestAuthorityResult {
  readonly targetAuthorityId: string;
  readonly environment: UniversalV1ActorEnvironment;
  readonly releaseManifestSha256: string;
  readonly canonicalRequest: UniversalV1CanonicalActorRequest;
  readonly canonicalRequestSha256: string;
}

export interface UniversalV1CanonicalRequestAuthorityPort {
  build(command: UniversalV1ActorCommand): Promise<UniversalV1CanonicalRequestAuthorityResult>;
}

interface CanonicalAuthorityRow extends Record<string, unknown> {
  target_authority_id: string;
  environment: string;
  release_manifest_sha256: string;
  canonical_request: unknown;
  actor_request_sha256: string;
}

export class PostgresUniversalV1CanonicalRequestAuthority implements UniversalV1CanonicalRequestAuthorityPort {
  constructor(private readonly query: QueryFn = db.query) {}

  async build(
    command: UniversalV1ActorCommand
  ): Promise<UniversalV1CanonicalRequestAuthorityResult> {
    const commandPayload = parseUniversalV1ActorCommandPayload(
      command.commandKind,
      command.commandPayload
    );
    const builder =
      command.commandKind === 'READ_FAKE_CHANGE_ORDER_KIND' ||
      command.commandKind === 'PREPARE_FAKE_CHANGE_ORDER' ||
      command.commandKind === 'FINALIZE_FAKE_CHANGE_ORDER'
        ? 'public.hxos_build_change_order_materialization_actor_request_v13'
        : command.commandKind === 'PROPOSE_FAKE_CHANGE_ORDER' ||
            command.commandKind === 'DECIDE_FAKE_CHANGE_ORDER'
          ? 'public.hxos_build_change_order_actor_request_v13'
          : command.commandKind === 'PREPARE_FAKE_FINANCIAL_COMMAND'
            ? 'public.hxos_build_fake_financial_preparation_actor_request_v13'
            : command.commandKind === 'READ_FAKE_FINANCIAL_REQUEST_PROGRESS'
              ? 'public.hxos_build_fake_financial_progress_actor_request_v13'
              : command.commandKind === 'READ_FAKE_FINANCIAL_PREDECESSOR'
                ? 'public.hxos_build_fake_financial_predecessor_actor_request_v13'
                : command.commandKind === 'READ_FAKE_WORK_ORDER_HISTORY'
                  ? 'public.hxos_build_work_order_history_actor_request_v13'
                  : command.commandKind === 'READ_FAKE_CHANGE_ORDER_HISTORY'
                    ? 'public.hxos_build_change_order_history_actor_request_v13'
                    : 'public.hxos_build_universal_v1_work_order_actor_request_v1';
    const result = await this.query<CanonicalAuthorityRow>(
      `SELECT target_authority_id,
              environment,
              release_manifest_sha256,
              canonical_request,
              actor_request_sha256
         FROM ${builder}(
           $1::TEXT,
           $2::JSONB
         )`,
      [command.commandKind, commandPayload]
    );
    const row = result.rows[0];
    const parsed = UniversalV1CanonicalActorRequestSchema.safeParse(row?.canonical_request);
    if (
      result.rows.length !== 1 ||
      !row ||
      !parsed.success ||
      !SHA256.test(row.actor_request_sha256)
    ) {
      throw new UniversalV1ActorAttestationClientError('CANONICAL_AUTHORITY_UNAVAILABLE');
    }
    const canonicalPayload = parseUniversalV1ActorCommandPayload(
      parsed.data.command_kind,
      parsed.data.command_payload
    );
    if (
      parsed.data.command_kind !== command.commandKind ||
      JSON.stringify(canonicalPayload) !== JSON.stringify(commandPayload) ||
      parsed.data.target_authority.id !== row.target_authority_id ||
      parsed.data.target_authority.environment !== row.environment ||
      parsed.data.target_authority.release !== row.release_manifest_sha256 ||
      parsed.data.release_manifest_sha256 !== row.release_manifest_sha256
    ) {
      throw new UniversalV1ActorAttestationClientError('CANONICAL_AUTHORITY_BINDING_MISMATCH');
    }
    return {
      targetAuthorityId: row.target_authority_id,
      environment: parsed.data.target_authority.environment,
      releaseManifestSha256: parsed.data.release_manifest_sha256,
      canonicalRequest: parsed.data,
      canonicalRequestSha256: row.actor_request_sha256,
    };
  }
}

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}

type AttesterFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<FetchResponseLike>;

export interface UniversalV1ActorAttesterClientDependencies {
  readonly env?: Environment;
  readonly releaseBinding?: () => UniversalV1ActorReleaseBinding;
  readonly canonicalAuthority?: UniversalV1CanonicalRequestAuthorityPort;
  readonly fetch?: AttesterFetch;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
}

function timeoutMs(env: Environment): number {
  const raw = env.HX_ACTOR_ATTESTER_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    throw new UniversalV1ActorAttestationClientError('TIMEOUT_CONFIGURATION_INVALID');
  }
  return parsed;
}

function exactTransportSecret(env: Environment): string {
  const secret = env.HX_ACTOR_ATTESTER_TRANSPORT_SECRET?.trim() ?? '';
  if (secret.length < TRANSPORT_SECRET_MIN_CHARACTERS) {
    throw new UniversalV1ActorAttestationClientError('TRANSPORT_SECRET_REQUIRED');
  }
  return secret;
}

function attesterUrl(env: Environment, environment: UniversalV1ActorEnvironment): URL {
  const raw = env.HX_ACTOR_ATTESTER_URL?.trim() ?? '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UniversalV1ActorAttestationClientError('INTERNAL_ATTESTER_URL_INVALID');
  }
  if (
    parsed.pathname !== UNIVERSAL_V1_ACTOR_ATTESTATION_PATH ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new UniversalV1ActorAttestationClientError('INTERNAL_ATTESTER_URL_INVALID');
  }
  if (environment === 'local') {
    if (
      parsed.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    ) {
      throw new UniversalV1ActorAttestationClientError('LOCAL_ATTESTER_MUST_BE_LOOPBACK');
    }
  } else {
    const expectedHost = env.HX_ACTOR_ATTESTER_INTERNAL_HOST?.trim().toLowerCase() ?? '';
    if (
      parsed.protocol !== 'https:' ||
      !expectedHost ||
      parsed.hostname.toLowerCase() !== expectedHost ||
      !expectedHost.endsWith('.railway.internal')
    ) {
      throw new UniversalV1ActorAttestationClientError('DEPLOYED_ATTESTER_NOT_INTERNAL');
    }
  }
  return parsed;
}

async function readBoundedResponse(response: FetchResponseLike): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > UNIVERSAL_V1_ACTOR_ATTESTATION_RESPONSE_LIMIT_BYTES)
  ) {
    throw new UniversalV1ActorAttestationClientError('ATTESTER_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > UNIVERSAL_V1_ACTOR_ATTESTATION_RESPONSE_LIMIT_BYTES) {
        throw new UniversalV1ActorAttestationClientError('ATTESTER_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

export class UniversalV1ActorAttesterClient {
  private readonly env: Environment;
  private readonly releaseBinding: () => UniversalV1ActorReleaseBinding;
  private readonly canonicalAuthority: UniversalV1CanonicalRequestAuthorityPort;
  private readonly fetchImplementation: AttesterFetch;
  private readonly now: () => Date;
  private readonly random: (size: number) => Buffer;

  constructor(dependencies: UniversalV1ActorAttesterClientDependencies = {}) {
    this.env = dependencies.env ?? process.env;
    this.releaseBinding =
      dependencies.releaseBinding ?? (() => resolveUniversalV1ActorReleaseBinding(this.env));
    this.canonicalAuthority =
      dependencies.canonicalAuthority ?? new PostgresUniversalV1CanonicalRequestAuthority();
    this.fetchImplementation = dependencies.fetch ?? (fetch as AttesterFetch);
    this.now = dependencies.now ?? (() => new Date());
    this.random = dependencies.randomBytes ?? randomBytes;
  }

  async issue(
    originalBearer: string,
    command: UniversalV1ActorCommand
  ): Promise<UniversalV1ActorAttestationResponse> {
    const release = this.releaseBinding();
    const url = attesterUrl(this.env, release.environment);
    const secret = exactTransportSecret(this.env);
    const authority = await this.canonicalAuthority.build(command);
    if (
      authority.environment !== release.environment ||
      authority.releaseManifestSha256 !== release.releaseManifestSha256
    ) {
      throw new UniversalV1ActorAttestationClientError('CANONICAL_AUTHORITY_BINDING_MISMATCH');
    }
    const transport = UniversalV1ActorAttestationTransportBodySchema.safeParse({
      schema_version: 1,
      environment: release.environment,
      command_kind: command.commandKind,
      canonical_request: authority.canonicalRequest,
      canonical_request_sha256: authority.canonicalRequestSha256,
    });
    if (!transport.success) {
      throw new UniversalV1ActorAttestationClientError('CANONICAL_AUTHORITY_BINDING_MISMATCH');
    }
    const canonicalRequestSha256 = authority.canonicalRequestSha256;
    const transportBody = JSON.stringify(transport.data);
    const requestTimestamp = this.now().getTime();
    if (!Number.isSafeInteger(requestTimestamp)) {
      throw new UniversalV1ActorAttestationClientError('CLOCK_INVALID');
    }
    const nonce = this.random(16).toString('hex');
    if (!/^[0-9a-f]{32}$/u.test(nonce)) {
      throw new UniversalV1ActorAttestationClientError('NONCE_ENTROPY_UNAVAILABLE');
    }
    const bodySha256 = sha256LowerHex(transportBody);
    const bearerSha256 = sha256LowerHex(originalBearer);
    const signature = hmacSha256LowerHex(
      secret,
      actorAttesterRequestSignaturePayload({
        timestampMs: requestTimestamp,
        nonce,
        bodySha256,
        bearerSha256,
      })
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs(this.env));
    let response: FetchResponseLike;
    try {
      response = await this.fetchImplementation(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${originalBearer}`,
          'content-type': 'application/json',
          'x-hx-attester-timestamp-ms': String(requestTimestamp),
          'x-hx-attester-nonce': nonce,
          'x-hx-attester-signature': signature,
        },
        body: transportBody,
      });
    } catch {
      throw new UniversalV1ActorAttestationClientError('ATTESTER_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }

    const responseBody = await readBoundedResponse(response);
    if (!response.ok || response.status !== 200) {
      throw new UniversalV1ActorAttestationClientError('ATTESTER_REFUSED');
    }
    const responseSignature = response.headers.get('x-hx-attester-response-signature') ?? '';
    const expectedResponseSignature = hmacSha256LowerHex(
      secret,
      actorAttesterResponseSignaturePayload({
        requestNonce: nonce,
        status: response.status,
        bodySha256: sha256LowerHex(responseBody),
      })
    );
    if (!equalLowerHex(responseSignature, expectedResponseSignature)) {
      throw new UniversalV1ActorAttestationClientError('ATTESTER_RESPONSE_AUTHENTICATION_FAILED');
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(responseBody);
    } catch {
      throw new UniversalV1ActorAttestationClientError('ATTESTER_RESPONSE_MALFORMED');
    }
    const parsed = UniversalV1ActorAttestationResponseSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new UniversalV1ActorAttestationClientError('ATTESTER_RESPONSE_MALFORMED');
    }
    const assertionExpiresAtMs = Date.parse(parsed.data.assertion_expires_at);
    if (
      parsed.data.command_kind !== command.commandKind ||
      !equalLowerHex(parsed.data.canonical_request_sha256, canonicalRequestSha256) ||
      !Number.isSafeInteger(assertionExpiresAtMs) ||
      assertionExpiresAtMs <= this.now().getTime() ||
      assertionExpiresAtMs >
        requestTimestamp + 60_000 + UNIVERSAL_V1_ACTOR_ATTESTATION_MAX_CLOCK_SKEW_MS
    ) {
      throw new UniversalV1ActorAttestationClientError('ATTESTER_RESPONSE_BINDING_MISMATCH');
    }
    return parsed.data;
  }
}

export function createUniversalV1ActorAttestationHandle(
  originalBearer: string,
  client: UniversalV1ActorAttesterClient = new UniversalV1ActorAttesterClient()
): UniversalV1ActorAttestationHandle {
  return Object.freeze({
    issue: (command: UniversalV1ActorCommand) => client.issue(originalBearer, command),
  });
}
