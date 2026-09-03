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
  total: number;
  preAuth?: boolean;
  meta?: Record<string, unknown>;
}

export interface StaxTransaction {
  id: string;
  success?: boolean;
  total?: number | string;
  status?: string;
  payment_method_id?: string;
  customer_id?: string;
  meta?: Record<string, unknown>;
}

export async function chargeStaxPaymentMethod(
  input: StaxChargeInput,
): Promise<StaxTransaction> {
  return staxRequest<StaxTransaction>('/charge', {
    method: 'POST',
    body: JSON.stringify({
      payment_method_id: input.paymentMethodId,
      total: input.total,
      pre_auth: input.preAuth ?? false,
      meta: input.meta ?? {},
    }),
  });
}