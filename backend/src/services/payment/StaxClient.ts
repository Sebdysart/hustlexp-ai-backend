import crypto from 'node:crypto';

const STAX_BASE_URL = 'https://apiprod.fattlabs.com';
export interface StaxRequestOptions { apiKey?: string; }

export async function staxRequest<T>(
  path: string,
  init: RequestInit = {},
  options: StaxRequestOptions = {},
): Promise<T> {
  const credential = options.apiKey ?? process.env.STAX_JWT;
  if (!credential?.trim()) throw new Error('Stax API credential is required.');
  const response = await fetch(`${STAX_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      `Stax API ${response.status}: ${JSON.stringify(body)}`,
    );
  }

  return body as T;
}

export async function listStaxCustomers() {
  return staxRequest('/customer', {
    method: 'GET',
  });
}

export interface StaxChargeInput {
  paymentMethodId: string;
  amountCents: number;
  idempotencyId?: string;
  preAuth?: boolean;
  meta?: Record<string, unknown>;
  apiKey?: string;
}

export interface StaxTransaction {
  id: string;
  type?: string;
  success?: boolean;
  status?: string;

  total?: number | string;
  currency?: string;

  payment_method_id?: string;
  customer_id?: string;

  pre_auth?: boolean;
  is_voided?: boolean;
  total_refunded?: number | string;

  idempotency_id?: string | null;

  meta?: Record<string, unknown>;

  response?: {
    succeeded?: boolean;
    state?: string;
    amount?: number;
    currency_code?: string;
    on_test_gateway?: boolean;
    [key: string]: unknown;
  };

  [key: string]: unknown;
}

export async function chargeStaxPaymentMethod(
  input: StaxChargeInput,
): Promise<StaxTransaction> {
  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0
  ) {
    throw new Error(
      'Stax charge amount must be a positive integer number of cents.',
    );
  }

  return staxRequest<StaxTransaction>('/charge', {
    method: 'POST',
    body: JSON.stringify({
      payment_method_id: input.paymentMethodId,
      total: input.amountCents / 100,
      pre_auth: input.preAuth ?? false,
      idempotency_id:
        input.idempotencyId ?? crypto.randomUUID(),
      meta: input.meta ?? {},
    }),
  },
  { apiKey: input.apiKey },
  );
}

export async function getStaxTransaction(
  transactionId: string,
  options: StaxRequestOptions = {},
): Promise<StaxTransaction> {
  if (!transactionId.trim()) {
    throw new Error('Stax transaction ID is required.');
  }

  return staxRequest<StaxTransaction>(
    `/transaction/${encodeURIComponent(transactionId)}`,
    {
      method: 'GET',
    },
    options,
  );
}

export interface StaxCreditInput {
  paymentMethodId: string;
  amountCents: number;
  idempotencyId?: string;
  meta?: Record<string, unknown>;
  apiKey?: string;
}

export async function creditStaxPaymentMethod(
  input: StaxCreditInput,
): Promise<StaxTransaction> {
  if (!input.paymentMethodId.trim()) {
    throw new Error(
      'Stax credit requires a payment method ID.',
    );
  }

  if (
    !Number.isInteger(input.amountCents)
    || input.amountCents <= 0
  ) {
    throw new Error(
      'Stax credit amount must be a positive integer number of cents.',
    );
  }

  return staxRequest<StaxTransaction>(
    '/credit',
    {
      method: 'POST',
      body: JSON.stringify({
        payment_method_id: input.paymentMethodId,
        total: input.amountCents / 100,
        idempotency_id:
          input.idempotencyId
          ?? crypto.randomUUID(),
        meta: input.meta ?? {},
      }),
    },
    { apiKey: input.apiKey },
  );
}






