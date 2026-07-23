import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../src/cache/redis', () => ({ checkRateLimit: vi.fn() }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

afterEach(() => {
  delete process.env.R2_PUBLIC_URL;
  vi.resetModules();
});

it('falls back safely when the configured R2 URL is malformed', async () => {
  process.env.R2_PUBLIC_URL = 'not a valid URL';
  const { approvedProofMediaUrl } = await import('../../src/routers/task-router-common');
  expect(approvedProofMediaUrl.safeParse('https://pub-aabbccdd.r2.dev/proof.jpg').success).toBe(true);
  expect(approvedProofMediaUrl.safeParse('https://example.com/proof.jpg').success).toBe(false);
});

it('accepts the explicitly configured R2 public hostname', async () => {
  process.env.R2_PUBLIC_URL = 'https://assets.hustlexp.example';
  const { approvedProofMediaUrl } = await import('../../src/routers/task-router-common');
  expect(approvedProofMediaUrl.safeParse('https://assets.hustlexp.example/proof.jpg').success).toBe(true);
});
