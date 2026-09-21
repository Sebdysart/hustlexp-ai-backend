import { logger } from '../../logger.js';
import type { TilledConfig } from './TilledConfig.js';

// Fields consumed from Tilled's public PaymentIntent contract only.
export interface TilledPaymentIntent {
  id: string;
  account_id: string;
  amount: number;
  amount_received: number;
  currency: string;
  status: string;
  capture_method: string;
  client_secret: string;
  metadata?: Record<string, string>;
  platform_fee_amount?: number;
}

export class TilledApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus?: number,
    public readonly details: {
      kind?: 'provider_rejected' | 'provider_server_error' | 'timeout' | 'network' | 'invalid_response';
      providerErrorType?: string;
      providerMessage?: string;
      correlationId?: string;
      contentType?: string;
    } = {},
  ) {
    super('Tilled payment service is unavailable or rejected the request.');
    this.name = 'TilledApiError';
  }
}

export type TilledOnboardingStatus =
  | 'created'
  | 'started'
  | 'submitted'
  | 'active'
  | 'disabled'
  | 'in_review'
  | 'rejected'
  | 'withdrawn';

export interface TilledAccountCapability {
  id: string;
  status: TilledOnboardingStatus;
  onboarding_application_url?: string;
  pricing_template?: {
    id?: string;
    payment_method_type?: string;
  };
}

export interface TilledConnectedAccount {
  id: string;
  status?: string;
  email?: string;
  name?: string;
  metadata?: Record<string, string>;
  capabilities: TilledAccountCapability[];
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value)
    ? value : undefined;
}

function safeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const message = value.trim().slice(0, 240);
  if (!message || (process.env.TILLED_SECRET_KEY && message.includes(process.env.TILLED_SECRET_KEY))
    || /(?:tilled-api-key|client_secret|authorization|\bsk_[A-Za-z0-9]+|\b\d{13,19}\b)/i.test(message)) {
    return undefined;
  }
  return message.replace(/[\r\n\t]/g, ' ');
}

function providerErrorFields(payload: unknown): {
  code?: string; type?: string; message?: string;
} {
  if (!payload || typeof payload !== 'object') return {};
  const root = payload as Record<string, unknown>;
  const nested = root.error && typeof root.error === 'object'
    ? root.error as Record<string, unknown> : root;
  return {
    code: safeIdentifier(nested.code ?? root.code),
    type: safeIdentifier(nested.type ?? root.type),
    message: safeProviderMessage(nested.message ?? root.message),
  };
}

function isPaymentIntent(value: unknown): value is TilledPaymentIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Record<string, unknown>;
  return typeof intent.id === 'string' && /^pi_[A-Za-z0-9_]+$/.test(intent.id)
    && typeof intent.account_id === 'string' && /^acct_[A-Za-z0-9_]+$/.test(intent.account_id)
    && Number.isSafeInteger(intent.amount) && Number.isSafeInteger(intent.amount_received)
    && typeof intent.currency === 'string' && typeof intent.status === 'string'
    && typeof intent.capture_method === 'string' && typeof intent.client_secret === 'string';
}

const onboardingStatuses = new Set<TilledOnboardingStatus>([
  'created',
  'started',
  'submitted',
  'active',
  'disabled',
  'in_review',
  'rejected',
  'withdrawn',
]);

function isConnectedAccount(value: unknown): value is TilledConnectedAccount {
  if (!value || typeof value !== 'object') return false;
  const account = value as Record<string, unknown>;
  if (typeof account.id !== 'string' || !/^acct_[A-Za-z0-9_]+$/.test(account.id)
    || !Array.isArray(account.capabilities)) return false;
  return account.capabilities.every((value) => {
    if (!value || typeof value !== 'object') return false;
    const capability = value as Record<string, unknown>;
    return typeof capability.id === 'string'
      && typeof capability.status === 'string'
      && onboardingStatuses.has(capability.status as TilledOnboardingStatus)
      && (capability.onboarding_application_url === undefined
        || typeof capability.onboarding_application_url === 'string');
  });
}

type Fetcher = typeof fetch;

export class TilledClient {
  constructor(
    private readonly config: Pick<TilledConfig, 'environment' | 'apiBaseUrl' | 'secretKey'>,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  private async request<T>(
    accountId: string,
    path: string,
    init: { method?: 'GET' | 'POST'; body?: object; operation?: string } = {},
  ): Promise<T> {
    if (!/^acct_[A-Za-z0-9_]+$/.test(accountId)) {
      throw new TilledApiError('INVALID_ACCOUNT');
    }
    let response: Response;
    try {
      logger.info({ provider: 'tilled', operation: init.operation ?? 'read_payment_intent',
        stage: 'send_tilled_request', provider_account_id: accountId,
        environment: this.config.environment }, 'Sending Tilled request');
      response = await this.fetcher(`${this.config.apiBaseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'tilled-api-key': this.config.secretKey,
          'tilled-account': accountId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError'
        || error.name === 'AbortError' || /timeout/i.test(error.message));
      const kind = timeout ? 'timeout' : 'network';
      logger.warn({ provider: 'tilled', operation: init.operation ?? 'read_payment_intent',
        stage: 'send_tilled_request', provider_account_id: accountId,
        environment: this.config.environment, error_name: error instanceof Error ? error.name : 'unknown',
        network_error_kind: kind }, 'Tilled request failed before HTTP response');
      throw new TilledApiError(timeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', undefined, { kind });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const contentType = response.headers?.get('content-type') ?? undefined;
      logger.warn({ provider: 'tilled', operation: init.operation ?? 'read_payment_intent',
        stage: 'parse_tilled_response', provider_account_id: accountId,
        environment: this.config.environment, http_status: response.status,
        content_type: contentType }, 'Tilled returned a non-JSON response');
      throw new TilledApiError('INVALID_PROVIDER_RESPONSE', response.status,
        { kind: 'invalid_response', contentType });
    }
    if (!response.ok) {
      const fields = providerErrorFields(payload);
      const code = fields.code ?? 'PROVIDER_REJECTED';
      const correlationId = safeIdentifier(response.headers?.get('x-request-id')
        ?? response.headers?.get('request-id'));
      const kind = response.status >= 500 ? 'provider_server_error' : 'provider_rejected';
      logger.warn({ provider: 'tilled', operation: init.operation ?? 'read_payment_intent',
        stage: 'parse_tilled_response', provider_account_id: accountId,
        environment: this.config.environment, http_status: response.status,
        provider_error_code: code, provider_error_type: fields.type,
        provider_error_message: fields.message, correlation_id: correlationId }, 'Tilled rejected request');
      throw new TilledApiError(code, response.status, {
        kind, providerErrorType: fields.type,
        providerMessage: fields.message, correlationId,
      });
    }
    logger.info({ provider: 'tilled', operation: init.operation ?? 'read_payment_intent',
      stage: 'parse_tilled_response', provider_account_id: accountId,
      environment: this.config.environment, http_status: response.status }, 'Tilled response parsed');
    return payload as T;
  }

  async createPaymentIntent(input: {
    accountId: string;
    amountCents: number;
    platformFeeCents: number;
    metadata: Record<string, string>;
  }): Promise<TilledPaymentIntent> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0
      || !Number.isSafeInteger(input.platformFeeCents) || input.platformFeeCents < 0
      || input.platformFeeCents > input.amountCents) {
      throw new TilledApiError('INVALID_PAYMENT_ECONOMICS');
    }
    const intent = await this.request<unknown>(input.accountId, '/v1/payment-intents', {
      method: 'POST',
      operation: 'create_payment_intent',
      body: {
        amount: input.amountCents,
        currency: 'usd',
        payment_method_types: ['card'],
        capture_method: 'automatic',
        platform_fee_amount: input.platformFeeCents,
        metadata: input.metadata,
      },
    });
    if (!isPaymentIntent(intent)) {
      logger.warn({ provider: 'tilled', operation: 'create_payment_intent',
        stage: 'parse_tilled_response', provider_account_id: input.accountId,
        environment: this.config.environment }, 'Tilled Payment Intent response is malformed');
      throw new TilledApiError('INVALID_PROVIDER_RESPONSE', undefined, { kind: 'invalid_response' });
    }
    return intent;
  }

  async getPaymentIntent(accountId: string, intentId: string): Promise<TilledPaymentIntent> {
    const intent = await this.request<unknown>(accountId, `/v1/payment-intents/${encodeURIComponent(intentId)}`,
      { operation: 'get_payment_intent' });
    if (!isPaymentIntent(intent)) {
      logger.warn({ provider: 'tilled', operation: 'get_payment_intent',
        stage: 'parse_tilled_response', provider_account_id: accountId,
        environment: this.config.environment }, 'Tilled Payment Intent response is malformed');
      throw new TilledApiError('INVALID_PROVIDER_RESPONSE', undefined, { kind: 'invalid_response' });
    }
    return intent;
  }

  async createConnectedAccount(input: {
    platformAccountId: string;
    email: string;
    name: string;
    pricingTemplateId: string;
    metadata: Record<string, string>;
  }): Promise<TilledConnectedAccount> {
    const account = await this.request<unknown>(
      input.platformAccountId,
      '/v1/accounts/connected',
      {
        method: 'POST',
        operation: 'create_connected_account',
        body: {
          email: input.email,
          name: input.name,
          pricing_template_ids: [input.pricingTemplateId],
          metadata: input.metadata,
        },
      },
    );
    if (!isConnectedAccount(account)) {
      throw new TilledApiError(
        'INVALID_PROVIDER_RESPONSE',
        undefined,
        { kind: 'invalid_response' },
      );
    }
    return account;
  }

  async getConnectedAccount(accountId: string): Promise<TilledConnectedAccount> {
    const account = await this.request<unknown>(
      accountId,
      '/v1/accounts',
      { operation: 'get_connected_account' },
    );
    if (!isConnectedAccount(account)) {
      throw new TilledApiError(
        'INVALID_PROVIDER_RESPONSE',
        undefined,
        { kind: 'invalid_response' },
      );
    }
    return account;
  }

  async findConnectedAccountsByMetadata(input: {
    platformAccountId: string;
    metadata: Record<string, string>;
  }): Promise<TilledConnectedAccount[]> {
    const params = new URLSearchParams({ limit: '2' });
    for (const [key, value] of Object.entries(input.metadata)) {
      params.set(`metadata[${key}]`, value);
    }
    const page = await this.request<{ items?: unknown[] }>(
      input.platformAccountId,
      `/v1/accounts/connected?${params.toString()}`,
      { operation: 'list_connected_accounts' },
    );
    if (!Array.isArray(page.items) || !page.items.every(isConnectedAccount)) {
      throw new TilledApiError(
        'INVALID_PROVIDER_RESPONSE',
        undefined,
        { kind: 'invalid_response' },
      );
    }
    return page.items.filter((account) => Object.entries(input.metadata)
      .every(([key, value]) => account.metadata?.[key] === value));
  }

  async findPaymentIntentsByLocalPaymentId(
    accountId: string,
    localPaymentId: string,
  ): Promise<TilledPaymentIntent[]> {
    const params = new URLSearchParams({
      'metadata[hustlexp_payment_id]': localPaymentId,
      limit: '100',
    });
    const page = await this.request<{ items?: TilledPaymentIntent[] }>(
      accountId,
      `/v1/payment-intents?${params.toString()}`,
      { operation: 'list_payment_intents' },
    );
    if (!Array.isArray(page.items)) throw new TilledApiError('INVALID_PROVIDER_RESPONSE');
    if (!page.items.every(isPaymentIntent)) {
      throw new TilledApiError('INVALID_PROVIDER_RESPONSE', undefined, { kind: 'invalid_response' });
    }
    return page.items.filter((intent) => intent.metadata?.hustlexp_payment_id === localPaymentId);
  }
}
