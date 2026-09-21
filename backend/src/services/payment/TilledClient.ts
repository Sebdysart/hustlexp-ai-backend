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
  ) {
    super('Tilled payment service is unavailable or rejected the request.');
    this.name = 'TilledApiError';
  }
}

type Fetcher = typeof fetch;

export class TilledClient {
  constructor(
    private readonly config: TilledConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  private async request<T>(
    accountId: string,
    path: string,
    init: { method?: 'GET' | 'POST'; body?: object } = {},
  ): Promise<T> {
    if (!/^acct_[A-Za-z0-9_]+$/.test(accountId)) {
      throw new TilledApiError('INVALID_ACCOUNT');
    }
    let response: Response;
    try {
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
      logger.warn({ provider: 'tilled', operation: init.method ?? 'GET', errorName: error instanceof Error ? error.name : 'unknown' }, 'Tilled request failed');
      throw new TilledApiError('PROVIDER_UNAVAILABLE');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TilledApiError('INVALID_PROVIDER_RESPONSE', response.status);
    }
    if (!response.ok) {
      const code = typeof payload === 'object' && payload !== null && 'code' in payload && typeof payload.code === 'string'
        ? payload.code : 'PROVIDER_REJECTED';
      logger.warn({ provider: 'tilled', operation: init.method ?? 'GET', httpStatus: response.status, errorCode: code }, 'Tilled rejected request');
      throw new TilledApiError(code, response.status);
    }
    return payload as T;
  }

  createPaymentIntent(input: {
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
    return this.request(input.accountId, '/v1/payment-intents', {
      method: 'POST',
      body: {
        amount: input.amountCents,
        currency: 'usd',
        payment_method_types: ['card'],
        capture_method: 'automatic',
        platform_fee_amount: input.platformFeeCents,
        metadata: input.metadata,
      },
    });
  }

  getPaymentIntent(accountId: string, intentId: string): Promise<TilledPaymentIntent> {
    return this.request(accountId, `/v1/payment-intents/${encodeURIComponent(intentId)}`);
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
    );
    if (!Array.isArray(page.items)) throw new TilledApiError('INVALID_PROVIDER_RESPONSE');
    return page.items.filter((intent) => intent.metadata?.hustlexp_payment_id === localPaymentId);
  }
}
