import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/deploy.yml'), 'utf8');

describe('production release hold workflow contract', () => {
  it('contains no Railway mutation or deploy credential', () => {
    expect(workflow).not.toMatch(/railway\s+(?:up|deploy|variable|service)/iu);
    expect(workflow).not.toContain('RAILWAY_TOKEN');
    expect(workflow).not.toMatch(/^\s*environment:\s*production\s*$/mu);
    expect(workflow).toContain('Production deployment is deliberately unavailable');
  });

  it('verifies one exact immutable revision without persisting checkout credentials', () => {
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toContain('HX_BUILD_REVISION: ${{ github.sha }}');
    expect(workflow).not.toContain("HX_BUILD_SOURCE_CLEAN: 'true'");
    expect(workflow).toContain('identity.revision !== process.env.GITHUB_SHA');
    expect(workflow).toContain("identity.source !== 'GITHUB_SHA'");
    expect(workflow).toContain('isTrustedBuildIdentity(identity)');
  });

  it('proves the held artifact cannot create new customer money', () => {
    expect(workflow).toContain('HX_PAYMENT_CREATION_MODE: frozen');
    expect(workflow).toContain('newPaymentCreationMode(process.env)');
    expect(workflow).toContain("!== 'frozen'");
    expect(workflow).toContain('no Railway credential, command, or deployment job');
  });
});
