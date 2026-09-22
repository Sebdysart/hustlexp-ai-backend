import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(`backend/src/${path}`, 'utf8');
function sources(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(path, entry.name);
    return entry.isDirectory() ? sources(fullPath) : entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

describe('Stage 1 supported runtime payment surface', () => {
  it('has no retired SDK imports or payment adapters', () => {
    for (const path of sources('backend/src')) {
      expect(readFileSync(path, 'utf8')).not.toMatch(/(?:from\s+|import\s*\()["'][^"']*(?:Stripe|Stax|stripe|stax)/);
    }
    const dependencies = JSON.parse(readFileSync('package.json', 'utf8')).dependencies;
    expect(Object.keys(dependencies).filter((name) => /stripe|stax/i.test(name))).toEqual([]);
  });
  it('registers only supported webhook and financial routes', () => {
    expect(read('serverWebhookRoutes.ts')).toContain("app.post('/webhooks/tilled'");
    expect(read('serverWebhookRoutes.ts')).not.toMatch(/stripe|stax/i);
    expect(read('routers/index.ts')).not.toMatch(/stripeConnect|stax|subscriptionRouter|tippingRouter|xpTaxRouter|hustlerWalletRouter/i);
  });
  it('has no retired processor dispatch, completion, refund or startup branch', () => {
    for (const path of ['jobs/worker-registration.ts', 'jobs/worker-schedules.ts', 'jobs/completion-release-orchestrator.ts',
      'services/EscrowRefundProvider.ts', 'services/EscrowReleaseTransaction.ts',
      'services/payment/PaymentProviderResolver.ts', 'config.ts', 'lib/env-validator.ts']) {
      expect(read(path)).not.toMatch(/stripe|stax/i);
    }
  });
});
