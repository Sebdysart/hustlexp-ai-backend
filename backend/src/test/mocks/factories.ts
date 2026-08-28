import { vi } from 'vitest';

export function createTestUser(overrides?: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    email: `test-${Date.now()}@example.com`,
    username: `user_${Date.now()}`,
    displayName: 'Test User',
    tier: 'free',
    role: 'user',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function createTestTask(overrides?: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    title: 'Test Task',
    description: 'A test task description',
    category: 'errands',
    status: 'open',
    budgetMin: 25.00,
    budgetMax: 100.00,
    posterId: crypto.randomUUID(),
    location: {
      lat: 40.7128,
      lng: -74.0060,
      address: '123 Test St',
      city: 'New York',
      state: 'NY',
      zip: '10001',
    },
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function createTestEscrow(overrides?: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    payerId: crypto.randomUUID(),
    payeeId: crypto.randomUUID(),
    amount: 50.00,
    status: 'held',
    stripePaymentIntentId: 'pi_test_' + Date.now(),
    createdAt: new Date(),
    ...overrides,
  };
}

export function createTestScenario(type: 'task-lifecycle' | 'escrow-flow' | 'dispute') {
  const poster = createTestUser({ role: 'user', displayName: 'Poster User' });
  const tasker = createTestUser({ role: 'user', displayName: 'Tasker User' });
  const admin = createTestUser({ role: 'admin', displayName: 'Admin User' });

  const task = createTestTask({
    posterId: poster.id,
    status: type === 'task-lifecycle' ? 'open' : type === 'escrow-flow' ? 'assigned' : 'disputed',
    assignedToId: type === 'escrow-flow' || type === 'dispute' ? tasker.id : undefined,
  });

  const escrow = type === 'escrow-flow' || type === 'dispute'
    ? createTestEscrow({
        taskId: task.id,
        payerId: poster.id,
        payeeId: tasker.id,
        status: type === 'dispute' ? 'disputed' : 'held',
      })
    : undefined;

  const dispute = type === 'dispute'
    ? {
        id: crypto.randomUUID(),
        escrowId: escrow!.id,
        taskId: task.id,
        initiatorId: poster.id,
        respondentId: tasker.id,
        reason: 'Service not as described',
        status: 'open',
        createdAt: new Date(),
      }
    : undefined;

  return {
    poster,
    tasker,
    admin,
    task,
    escrow,
    dispute,
  };
}

export function createMockDb() {
  const mockDb = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(mockDb)),
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    task: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    escrow: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    review: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    message: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  };
  return mockDb;
}

export function createMockRedis() {
  const store = new Map<string, string>();

  return {
    store,
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string, _opts?: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return Promise.resolve(existed ? 1 : 0);
    }),
    ping: vi.fn(() => Promise.resolve('PONG')),
    pipeline: vi.fn(() => ({
      exec: vi.fn(() => Promise.resolve([])),
    })),
  };
}

export function createMockStripe() {
  return {
    paymentIntents: {
      create: vi.fn(),
      retrieve: vi.fn(),
      cancel: vi.fn(),
    },
    transfers: {
      create: vi.fn(),
    },
    refunds: {
      create: vi.fn(),
    },
  };
}

export function createMockFirebaseAuth() {
  return {
    verifyIdToken: vi.fn(),
    getUser: vi.fn(),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
  };
}

export function createMockLogger() {
  const logger: Record<string, ReturnType<typeof vi.fn>> = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}
