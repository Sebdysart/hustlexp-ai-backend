import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/deploy.yml'), 'utf8');

describe('production deploy workflow contract', () => {
  it('uses the application upload command and the only real Railway environment', () => {
    expect(workflow).toContain('railway up --ci');
    expect(workflow).not.toMatch(/railway deploy\b/u);
    expect(workflow).toContain('RAILWAY_ENVIRONMENT: production');
    expect(workflow).not.toMatch(/--environment[= ]staging/u);
  });

  it('deploys web and worker from one exact revision', () => {
    expect(workflow).toContain('RAILWAY_WEB_SERVICE: hustlexp-ai-backend-staging');
    expect(workflow).toContain('RAILWAY_WORKER_SERVICE: hustlexp-automation-worker');
    expect(workflow).toContain('HX_BUILD_REVISION=${GITHUB_SHA}');
    expect(workflow).toContain('HX_BUILD_SOURCE_CLEAN=true');
    expect(workflow.match(/railway up --ci/gu)).toHaveLength(2);
  });

  it('fails unless public health and worker state match the release contract', () => {
    expect(workflow).toContain('.build.revision == $sha');
    expect(workflow).toContain('.build.clean_source == true');
    expect(workflow).toContain('.build.service == "hustlexp-engine"');
    expect(workflow).toContain('railway service status');
    expect(workflow).toContain('.replicas.running >= 1');
  });
});
