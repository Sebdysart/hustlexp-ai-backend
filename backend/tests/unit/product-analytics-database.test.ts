import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { pool } = vi.hoisted(() => ({ pool: {
  options: { max: 20 }, totalCount: 0, idleCount: 0, waitingCount: 0, connect: vi.fn(),
} }));
vi.mock('../../src/db.js', () => ({ db: { getPool: () => pool } }));
import { analyticsQuery, AnalyticsCapacityError, ANALYTICS_ACQUIRE_MS } from '../../src/services/analytics/database.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const client = () => ({ query: vi.fn(async () => ({ rows: [{ ok: true }], rowCount: 1 })), release: vi.fn() });

describe('shared product analytics SQL admission', () => {
  beforeEach(() => {
    vi.useFakeTimers(); pool.options.max = 20; pool.totalCount = 0; pool.idleCount = 0; pool.waitingCount = 0;
    pool.connect.mockReset(); pool.connect.mockImplementation(async () => client());
  });
  afterEach(() => vi.useRealTimers());
  it('admits only three operations, drops the fourth without connecting, and returns slots', async () => {
    const blocked = deferred<ReturnType<typeof client>>();
    pool.connect.mockReturnValue(blocked.promise);
    const pending = [analyticsQuery('SELECT 1'), analyticsQuery('SELECT 1'), analyticsQuery('SELECT 1')];
    await expect(analyticsQuery('SELECT 1')).rejects.toBeInstanceOf(AnalyticsCapacityError);
    expect(pool.connect).toHaveBeenCalledTimes(3);
    // A real pool gives each borrower a separate connection; immediate mock
    // queries suffice to inspect slot accounting, without any actual SQL.
    blocked.resolve(client());
    await Promise.all(pending);
    await expect(analyticsQuery('SELECT 1')).resolves.toMatchObject({ rowCount: 1 });
  });
  it('never joins a busy pool queue and leaves spare business capacity', async () => {
    pool.waitingCount = 1;
    await expect(analyticsQuery('SELECT 1')).rejects.toBeInstanceOf(AnalyticsCapacityError);
    pool.waitingCount = 0; pool.totalCount = 18;
    await expect(analyticsQuery('SELECT 1')).rejects.toBeInstanceOf(AnalyticsCapacityError);
    pool.totalCount = 0; pool.options.max = 3;
    await expect(analyticsQuery('SELECT 1')).rejects.toBeInstanceOf(AnalyticsCapacityError);
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('scales admission down to one quarter of a smaller pool', async () => {
    pool.options.max = 8;
    const blocked = deferred<ReturnType<typeof client>>(); pool.connect.mockReturnValue(blocked.promise);
    const pending = [analyticsQuery('SELECT 1'), analyticsQuery('SELECT 1')];
    await expect(analyticsQuery('SELECT 1')).rejects.toBeInstanceOf(AnalyticsCapacityError);
    blocked.resolve(client()); await Promise.all(pending);
  });
  it('times out acquisition without releasing budget early or leaking a late client', async () => {
    const blocked = deferred<ReturnType<typeof client>>(); pool.connect.mockReturnValue(blocked.promise);
    const outcome = analyticsQuery('SELECT 1').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(ANALYTICS_ACQUIRE_MS);
    expect(await outcome).toBeInstanceOf(AnalyticsCapacityError);
    const late = client(); blocked.resolve(late);
    await Promise.resolve(); await Promise.resolve();
    expect(late.release).toHaveBeenCalledOnce();
    expect(late.query).not.toHaveBeenCalled();
  });
  it('uses transaction-local deadlines and destroys failed connections', async () => {
    const connection = client();
    connection.query.mockImplementation(async (config?: unknown) => {
      if ((config as { text?: string })?.text === 'SELECT broken') throw new Error('statement timeout');
      return { rows: [], rowCount: 0 };
    });
    pool.connect.mockResolvedValue(connection);
    await expect(analyticsQuery('SELECT broken')).rejects.toThrow('statement timeout');
    expect(connection.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("set_config('statement_timeout',$1,true)"), values: ['1000', '100'], query_timeout: 1500,
    }));
    expect(connection.release).toHaveBeenCalledWith(true);
  });
});
