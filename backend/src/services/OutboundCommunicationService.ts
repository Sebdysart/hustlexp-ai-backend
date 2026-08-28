import { createHash } from 'node:crypto';
import sgMail from '@sendgrid/mail';
import { sendgridBreaker } from '../middleware/circuit-breaker.js';
import { sendEmailToSmtpSink } from './SmtpSinkEmailAdapter.js';
import { sendSMS } from './TwilioSMSService.js';

export { sendEmailToSmtpSink } from './SmtpSinkEmailAdapter.js';

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type OutboundProviderKind = 'smtp_sink' | 'http_sink' | 'sendgrid' | 'twilio';

export interface OutboundDeliveryReceipt {
  providerKind: OutboundProviderKind;
  providerMessageId: string;
  liveDelivery: boolean;
}

export interface OutboundEmailMessage {
  idempotencyKey: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  emailId: string;
  userId?: string;
}

export interface OutboundSmsMessage {
  idempotencyKey: string;
  to: string;
  body: string;
  smsId: string;
  notificationId?: string;
}

export interface OutboundEmailPort {
  readonly providerKind: OutboundProviderKind;
  deliver(message: OutboundEmailMessage): Promise<OutboundDeliveryReceipt>;
}

export interface OutboundSmsPort {
  readonly providerKind: OutboundProviderKind;
  deliver(message: OutboundSmsMessage): Promise<OutboundDeliveryReceipt>;
}

interface OutboundTransportDependencies {
  smtpSend(url: URL, message: OutboundEmailMessage): Promise<string>;
  fetch: typeof globalThis.fetch;
  liveEmail(message: OutboundEmailMessage, env: Environment): Promise<string>;
  liveSms(message: OutboundSmsMessage): Promise<string>;
}

interface PortOptions {
  env?: Environment;
  transports?: OutboundTransportDependencies;
}

const NONPRODUCTION_ENVIRONMENTS = new Set(['development', 'local', 'test', 'preview', 'staging']);

export class OutboundDeliveryDeniedError extends Error {
  readonly code = 'OUTBOUND_DELIVERY_DENIED';

  constructor(reason: string) {
    super(`Outbound delivery denied: ${reason}`);
    this.name = 'OutboundDeliveryDeniedError';
  }
}

function exactEnvironmentValue(env: Environment, name: string): string {
  return env[name]?.trim().toLowerCase() ?? '';
}

function requireExact(env: Environment, name: string, expected: string): void {
  if (exactEnvironmentValue(env, name) !== expected) {
    throw new OutboundDeliveryDeniedError(`${name} must be ${expected}`);
  }
}

function requirePresent(env: Environment, names: readonly string[]): void {
  for (const name of names) {
    if (!env[name]?.trim()) {
      throw new OutboundDeliveryDeniedError(`${name} is required for the selected live provider`);
    }
  }
}

function deliveryEnvironment(env: Environment): string {
  return (
    exactEnvironmentValue(env, 'HX_ENVIRONMENT') ||
    exactEnvironmentValue(env, 'NODE_ENV') ||
    'development'
  );
}

function assertSinkAuthority(env: Environment, channelModeName: string): void {
  const environment = deliveryEnvironment(env);
  if (!NONPRODUCTION_ENVIRONMENTS.has(environment)) {
    throw new OutboundDeliveryDeniedError(`sink delivery is forbidden in ${environment}`);
  }
  requireExact(env, 'HX_OUTBOUND_COMMUNICATION_MODE', 'sink');
  requireExact(env, channelModeName, 'sink');
  requireExact(env, 'HX_LIVE_DELIVERY', 'false');
  requireExact(env, 'HX_LIVE_PROVIDER_ACCESS', 'false');
  requireExact(env, 'HX_EXTERNAL_VALUE', 'false');
}

function assertLiveAuthority(
  env: Environment,
  channelModeName: string,
  providerKind: 'sendgrid' | 'twilio'
): void {
  if (
    deliveryEnvironment(env) !== 'production' ||
    exactEnvironmentValue(env, 'NODE_ENV') !== 'production'
  ) {
    throw new OutboundDeliveryDeniedError(
      'live providers require the production runtime and environment'
    );
  }
  requireExact(env, 'HX_OUTBOUND_COMMUNICATION_MODE', 'live_provider');
  requireExact(env, channelModeName, providerKind);
  requireExact(env, 'HX_LIVE_DELIVERY', 'true');
  requireExact(env, 'HX_LIVE_PROVIDER_ACCESS', 'true');
  requireExact(env, 'HX_EXTERNAL_VALUE', 'true');
}

function parseRequiredUrl(env: Environment, name: string): URL {
  const raw = env[name]?.trim();
  if (!raw) throw new OutboundDeliveryDeniedError(`${name} is required without a secret`);
  try {
    return new URL(raw);
  } catch {
    throw new OutboundDeliveryDeniedError(`${name} must be a valid URL`);
  }
}

function assertSinkUrlShape(parsed: URL, name: string, protocols: readonly string[]): void {
  if (!protocols.includes(parsed.protocol)) {
    throw new OutboundDeliveryDeniedError(`${name} must use ${protocols.join(' or ')}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new OutboundDeliveryDeniedError(
      `${name} may not contain credentials, query parameters, or fragments`
    );
  }
}

function isLocalSinkHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    !hostname.includes('.')
  );
}

function assertSinkNetworkBoundary(parsed: URL, name: string, environment: string): void {
  const hostname = parsed.hostname.toLowerCase();
  const deployedNonproduction = environment === 'preview' || environment === 'staging';
  if (deployedNonproduction && !hostname.endsWith('.railway.internal')) {
    throw new OutboundDeliveryDeniedError(`${name} must use Railway private networking`);
  }
  if (!deployedNonproduction && !isLocalSinkHost(hostname)) {
    throw new OutboundDeliveryDeniedError(
      `${name} must use loopback or local container networking`
    );
  }
}

function parseSinkUrl(env: Environment, name: string, protocols: readonly string[]): URL {
  const parsed = parseRequiredUrl(env, name);
  assertSinkUrlShape(parsed, name, protocols);
  assertSinkNetworkBoundary(parsed, name, deliveryEnvironment(env));
  return parsed;
}

function stableMessageId(channel: 'email' | 'sms', idempotencyKey: string): string {
  return createHash('sha256').update(`${channel}:${idempotencyKey}`, 'utf8').digest('hex');
}

function safeRequestHeader(value: string): string {
  if (/\r|\n/u.test(value)) throw new Error('Idempotency key may not contain line breaks');
  return value;
}

class SmtpSinkEmailAdapter implements OutboundEmailPort {
  readonly providerKind = 'smtp_sink' as const;

  constructor(
    private readonly url: URL,
    private readonly smtpSend: OutboundTransportDependencies['smtpSend']
  ) {}

  async deliver(message: OutboundEmailMessage): Promise<OutboundDeliveryReceipt> {
    const acceptedId = await this.smtpSend(this.url, message);
    return { providerKind: this.providerKind, providerMessageId: acceptedId, liveDelivery: false };
  }
}

class HttpSinkSmsAdapter implements OutboundSmsPort {
  readonly providerKind = 'http_sink' as const;

  constructor(
    private readonly url: URL,
    private readonly fetchImpl: OutboundTransportDependencies['fetch']
  ) {}

  async deliver(message: OutboundSmsMessage): Promise<OutboundDeliveryReceipt> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hustlexp-idempotency-key': safeRequestHeader(message.idempotencyKey),
      },
      body: JSON.stringify({
        to: message.to,
        body: message.body,
        smsId: message.smsId,
        notificationId: message.notificationId ?? null,
        idempotencyKey: message.idempotencyKey,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`SMS sink returned HTTP ${response.status}`);
    const evidence = (await response.json()) as Record<string, unknown>;
    if (evidence.providerKind !== 'sink' || evidence.liveDelivery !== false) {
      throw new Error('SMS sink did not attest non-live delivery');
    }
    const providerMessageId =
      typeof evidence.messageId === 'string' && evidence.messageId.trim()
        ? evidence.messageId
        : `sms-sink-${stableMessageId('sms', message.idempotencyKey)}`;
    return { providerKind: this.providerKind, providerMessageId, liveDelivery: false };
  }
}

class LiveEmailAdapter implements OutboundEmailPort {
  readonly providerKind = 'sendgrid' as const;

  constructor(
    private readonly env: Environment,
    private readonly send: OutboundTransportDependencies['liveEmail']
  ) {}

  async deliver(message: OutboundEmailMessage): Promise<OutboundDeliveryReceipt> {
    const providerMessageId = await this.send(message, this.env);
    return { providerKind: this.providerKind, providerMessageId, liveDelivery: true };
  }
}

class LiveSmsAdapter implements OutboundSmsPort {
  readonly providerKind = 'twilio' as const;

  constructor(private readonly send: OutboundTransportDependencies['liveSms']) {}

  async deliver(message: OutboundSmsMessage): Promise<OutboundDeliveryReceipt> {
    const providerMessageId = await this.send(message);
    return { providerKind: this.providerKind, providerMessageId, liveDelivery: true };
  }
}

function requiredHeader(value: string | string[] | undefined): string {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (!normalized?.trim()) throw new Error('SendGrid did not return a provider message ID');
  return normalized;
}

async function sendLiveEmail(message: OutboundEmailMessage, env: Environment): Promise<string> {
  const apiKey = env.SENDGRID_API_KEY?.trim();
  if (!apiKey)
    throw new OutboundDeliveryDeniedError('SENDGRID_API_KEY is required for approved live email');
  sgMail.setApiKey(apiKey);
  const [response] = await sendgridBreaker.execute(() =>
    sgMail.send({
      to: message.to,
      from: message.from,
      subject: message.subject,
      text: message.text,
      html: message.html,
      trackingSettings: {
        clickTracking: { enable: true },
        openTracking: { enable: true },
      },
      customArgs: { emailId: message.emailId, userId: message.userId ?? '' },
    })
  );
  return requiredHeader(response.headers['x-message-id']);
}

async function sendLiveSms(message: OutboundSmsMessage): Promise<string> {
  const result = await sendSMS(message.to, message.body);
  if (!result.success || !result.sid) {
    throw new Error(result.error || 'Twilio did not return a provider message ID');
  }
  return result.sid;
}

const defaultTransports: OutboundTransportDependencies = {
  smtpSend: sendEmailToSmtpSink,
  fetch: globalThis.fetch,
  liveEmail: sendLiveEmail,
  liveSms: sendLiveSms,
};

export function createOutboundEmailPort(options: PortOptions = {}): OutboundEmailPort {
  const env = options.env ?? process.env;
  const transports = options.transports ?? defaultTransports;
  const mode = exactEnvironmentValue(env, 'HX_EMAIL_DELIVERY_MODE');
  if (mode === 'sink') {
    assertSinkAuthority(env, 'HX_EMAIL_DELIVERY_MODE');
    return new SmtpSinkEmailAdapter(
      parseSinkUrl(env, 'SMTP_URL', ['smtp:', 'smtps:']),
      transports.smtpSend
    );
  }
  if (mode === 'sendgrid') {
    assertLiveAuthority(env, 'HX_EMAIL_DELIVERY_MODE', 'sendgrid');
    requirePresent(env, ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL']);
    return new LiveEmailAdapter(env, transports.liveEmail);
  }
  throw new OutboundDeliveryDeniedError(
    'HX_EMAIL_DELIVERY_MODE must explicitly select sink or sendgrid'
  );
}

export function createOutboundSmsPort(options: PortOptions = {}): OutboundSmsPort {
  const env = options.env ?? process.env;
  const transports = options.transports ?? defaultTransports;
  const mode = exactEnvironmentValue(env, 'HX_SMS_DELIVERY_MODE');
  if (mode === 'sink') {
    assertSinkAuthority(env, 'HX_SMS_DELIVERY_MODE');
    return new HttpSinkSmsAdapter(
      parseSinkUrl(env, 'HX_SMS_SINK_URL', ['http:', 'https:']),
      transports.fetch
    );
  }
  if (mode === 'twilio') {
    assertLiveAuthority(env, 'HX_SMS_DELIVERY_MODE', 'twilio');
    requirePresent(env, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_PHONE']);
    return new LiveSmsAdapter(transports.liveSms);
  }
  throw new OutboundDeliveryDeniedError(
    'HX_SMS_DELIVERY_MODE must explicitly select sink or twilio'
  );
}
