import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const sourceRoot = join(repositoryRoot, 'backend', 'src');

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? typescriptFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('portable Redis provider boundary', () => {
  it('keeps the generic TCP URL independent from explicit legacy REST credentials', () => {
    const source = readFileSync(join(sourceRoot, 'config.ts'), 'utf8');

    expect(source).toContain("restUrl: process.env.UPSTASH_REDIS_REST_URL || ''");
    expect(source).toContain("restToken: process.env.UPSTASH_REDIS_REST_TOKEN || ''");
    expect(source).toContain("url: process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || ''");
    expect(source).not.toMatch(/restUrl:[^\n]*REDIS_URL/u);
    expect(source).not.toMatch(/restToken:[^\n]*REDIS_TOKEN/u);
  });

  it('contains the legacy Upstash REST SDK to the reviewed compatibility inventory', () => {
    const consumers = typescriptFiles(sourceRoot)
      .filter((path) => readFileSync(path, 'utf8').includes('@upstash/redis'))
      .map((path) => relative(sourceRoot, path).replaceAll('\\', '/'))
      .sort();

    expect(consumers).toEqual(['redis/RedisCommandPort.ts']);
  });

  it('keeps the low-level port raw and disables REST automatic deserialization', () => {
    const commandPort = readFileSync(join(sourceRoot, 'redis', 'RedisCommandPort.ts'), 'utf8');

    expect(commandPort).toContain('get(key: string): Promise<string | null>');
    expect(commandPort).toContain('set(key: string, value: string');
    expect(commandPort).toContain('automaticDeserialization: false');
    expect(commandPort).not.toMatch(/\bget<T\b/u);
    expect(commandPort).not.toContain('value: unknown, options?: RedisSetOptions');
  });

  it('does not retain the vendor-specific rate-limit runtime in source or dependencies', () => {
    const packageManifest = readFileSync(join(repositoryRoot, 'package.json'), 'utf8');
    const consumers = typescriptFiles(sourceRoot)
      .filter((path) => readFileSync(path, 'utf8').includes('@upstash/ratelimit'));

    expect(consumers).toEqual([]);
    expect(packageManifest).not.toContain('@upstash/ratelimit');
  });

  it('derives TCP TLS only from an explicit rediss scheme, never a vendor hostname', () => {
    const commandPort = readFileSync(join(sourceRoot, 'redis', 'RedisCommandPort.ts'), 'utf8');
    const queues = readFileSync(join(sourceRoot, 'jobs', 'queues.ts'), 'utf8');

    expect(commandPort).toContain("redisUrl.startsWith('rediss://')");
    expect(queues).toContain("redisUrl.startsWith('rediss://')");
    expect(commandPort).not.toContain("includes('upstash.io')");
    expect(queues).not.toContain("includes('upstash.io')");
  });

  it('makes REDIS_URL the backend-only host TCP path and leaves vendor aliases opt-in', () => {
    const template = readFileSync(join(repositoryRoot, '.env.template'), 'utf8');
    const compose = readFileSync(join(repositoryRoot, 'docker-compose.yml'), 'utf8');

    expect(template).toContain('REDIS_URL=redis://localhost:6379');
    expect(template).toContain('UPSTASH_REDIS_URL=');
    expect(template).not.toContain('\nREDIS_TOKEN=');
    expect(template).toContain('repository-only host diagnostics');
    expect(compose).toContain('backend-compose-pointer');
    expect(compose).toContain('hustlexp-platform');
    expect(compose).toContain('network_mode: none');
    expect(compose).toContain('pull_policy: never');
    expect(compose).not.toMatch(/^\s{2}(app|worker|redis|postgres):\s*$/mu);
    expect(compose).not.toContain('DATABASE_URL');
    expect(compose).not.toContain('STRIPE_SECRET_KEY');
    expect(compose).not.toContain('ports:');
    expect(compose).not.toContain('build:');
  });
});
