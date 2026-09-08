import crypto from 'node:crypto';

const STAX_BASE_URL = 'https://apiprod.fattlabs.com';

export async function staxRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${STAX_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.STAX_JWT}`,
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
}

export interface StaxTransaction {
  id: string;
  success?: boolean;
  total?: number | string;
  status?: string;
  type?: string;
  payment_method_id?: string;
  customer_id?: string;
  meta?: Record<string, unknown>;
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
  });
}
