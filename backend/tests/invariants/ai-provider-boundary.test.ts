import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const scanRoots = [resolve(root, 'backend/src'), resolve(root, 'scripts')];
const allowedProviderFiles = new Set([
  'backend/src/ai/AIRouter.ts',
  'backend/src/services/AIClient.ts',
  'backend/src/services/KnowledgeGraphService.ts',
]);
const allowedProviderSelectorFiles = new Set([
  ...allowedProviderFiles,
  'backend/src/config.ts',
  'scripts/run-required-tests.mjs',
  'scripts/run-required-tests.test.mjs',
]);

const EXECUTABLE_EXTENSION = /\.(?:ts|mts|cts|js|mjs|cjs|sh|bash)$/u;

function executableFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) return executableFiles(path);
    return EXECUTABLE_EXTENSION.test(path) ? [path] : [];
  });
}

const providerBoundaryPatterns = [
  /(?:from\s+|import\s*\()['"](?:openai|groq-sdk|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai)['"]/u,
  /\bnew\s+(?:OpenAI|Groq|Anthropic|GoogleGenerativeAI|GoogleGenAI)\s*\(/u,
  /https:\/\/(?:api\.openai\.com|api\.groq\.com|api\.deepseek\.com|api\.anthropic\.com|api\.greptile\.com|generativelanguage\.googleapis\.com|[^/'"]*aiplatform\.googleapis\.com|dashscope[^/'"]*)/u,
  /\.(?:chat\.completions|embeddings)\.create\s*\(/u,
  /\.generateContent\s*\(/u,
];

describe('AI provider execution boundary', () => {
  it('allows provider SDKs and raw endpoints only in exact governed adapters', () => {
    const violations = scanRoots.flatMap(executableFiles).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const matched = providerBoundaryPatterns.some((pattern) => pattern.test(source));
      const repoPath = relative(root, file).replaceAll('\\', '/');
      return matched && !allowedProviderFiles.has(repoPath) ? [repoPath] : [];
    });
    expect(violations).toEqual([]);
    for (const file of allowedProviderFiles) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source).toContain('assertExternalAIProviderIOAuthorized');
    }
  });

  it('requires guards to dominate every governed adapter entry and construction path', () => {
    const aiClient = readFileSync(resolve(root, 'backend/src/services/AIClient.ts'), 'utf8');
    expect(aiClient).toMatch(/export async function call\([\s\S]{0,1200}?assertExternalAIProviderIOAuthorized\(`AIClient:\$\{options\.route\}`\);[\s\S]{0,300}?\/\/ 1\. Check cache/u);
    for (const provider of ['OpenAI', 'Groq', 'DeepSeek', 'Anthropic', 'Alibaba']) {
      expect(aiClient).toMatch(new RegExp(
        `function get${provider}Client\\(\\):[\\s\\S]{0,180}?assertExternalAIProviderIOAuthorized\\('AIClient:[^']+:construct'\\);[\\s\\S]{0,260}?new `,
        'u',
      ));
    }
    expect(aiClient).toMatch(/async function callProvider\([\s\S]{0,700}?assertExternalAIProviderIOAuthorized\(`AIClient:\$\{providerConfig\.name\}:io`\);[\s\S]{0,900}?\.chat\.completions\.create\(/u);

    const router = readFileSync(resolve(root, 'backend/src/ai/AIRouter.ts'), 'utf8');
    expect(router).toMatch(/export async function callAI\([\s\S]{0,700}?assertExternalAIProviderIOAuthorized\(`AIRouter:\$\{agent\}`\);[\s\S]{0,200}?const agentConfig/u);
    for (const provider of ['Groq', 'OpenAI', 'DeepSeek', 'Alibaba']) {
      expect(router).toMatch(new RegExp(
        `async function call${provider}\\([\\s\\S]{0,250}?assertExternalAIProviderIOAuthorized\\('AIRouter:[^']+'\\);[\\s\\S]{0,180}?(?:await import|new )`,
        'u',
      ));
    }

    const knowledge = readFileSync(resolve(root, 'backend/src/services/KnowledgeGraphService.ts'), 'utf8');
    expect(knowledge).toMatch(/function getOpenAI\(\): OpenAI \{\s*assertExternalAIProviderIOAuthorized\('KnowledgeGraph:openai:construct'\);[\s\S]{0,180}?new OpenAI/u);
    expect(knowledge).toMatch(/async function generateQueryEmbedding\([\s\S]{0,500}?assertExternalAIProviderIOAuthorized\('KnowledgeGraph:openai:embedding'\);\s*const openai = getOpenAI\(\)/u);
  });

  it('confines ambient provider selectors to inert config, governed adapters, and test-env scrubbing', () => {
    const selector = /\b(?:OPENAI|GROQ|DEEPSEEK|ANTHROPIC|ALIBABA|DASHSCOPE|GOOGLE|GEMINI|GOOGLE_(?:AI|GENAI))_(?:API_)?KEY\b/u;
    const violations = scanRoots.flatMap(executableFiles).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const repoPath = relative(root, file).replaceAll('\\', '/');
      return selector.test(source) && !allowedProviderSelectorFiles.has(repoPath) ? [repoPath] : [];
    });
    expect(violations).toEqual([]);
  });

  it('keeps the central runtime authority hard-dormant and configuration-independent', () => {
    const source = readFileSync(resolve(root, 'backend/src/ai/ExternalAIProviderAuthority.ts'), 'utf8');
    expect(source).toContain("EXTERNAL_AI_PROVIDER_POLICY_VERSION = 'external-ai-dormant-v1'");
    expect(source).toContain('return false;');
    expect(source).toContain('throw new ExternalAIProviderDormantError(surface);');
    expect(source).not.toMatch(/process\.env|config\.|apiKey/u);
  });

  it('keeps external-AI tooling as nonzero tombstones with no external-call path', () => {
    const packageSource = readFileSync(resolve(root, 'package.json'), 'utf8');
    for (const file of [
      'scripts/index-docs.ts',
      'scripts/greptile-pr-review.ts',
      'scripts/query-docs.ts',
      'scripts/query-docs-for-pr.ts',
    ]) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source).toContain('EXTERNAL_AI_DURABLE_SPEND_AUTHORITY_REQUIRED');
      expect(source).toContain('process.exitCode = 1');
      expect(source).not.toMatch(/\bfetch\s*\(|openai|groq|anthropic|greptile\.com|https?:\/\//iu);
      expect(source).not.toMatch(/process\.env|DATABASE_URL|GITHUB_OUTPUT|KnowledgeGraphService|\bPool\b|\bdb\.(?:query|readQuery)\b|appendFile/iu);
    }
    expect(packageSource).toContain("throw new Error('EXTERNAL_AI_DURABLE_SPEND_AUTHORITY_REQUIRED:index-docs')");
    expect(packageSource).toContain("throw new Error('EXTERNAL_AI_DURABLE_SPEND_AUTHORITY_REQUIRED:greptile-pr-review')");
    expect(packageSource).toContain("throw new Error('EXTERNAL_AI_DURABLE_SPEND_AUTHORITY_REQUIRED:query-docs')");
  });

  it('keeps the legacy admin incident diagnosis structurally dormant and free of fabricated evidence', () => {
    const source = readFileSync(resolve(root, 'backend/src/services/IncidentDiagnosisService.ts'), 'utf8');
    const objectStart = source.indexOf('export const IncidentDiagnosisService');
    const standaloneStart = source.indexOf('// Standalone exported diagnoseIncident function');
    expect(objectStart).toBeGreaterThan(-1);
    expect(standaloneStart).toBeGreaterThan(objectStart);
    const legacyObject = source.slice(objectStart, standaloneStart);
    expect(legacyObject).toContain('AI_INCIDENT_DIAGNOSIS_DORMANT');
    expect(legacyObject).not.toMatch(/\bdb\.(?:query|readQuery)\b|AIClient|aiOperationId|buildDiagnosisPrompt|parseAIDiagnosis|getRecentCommits|getRecentDeployments/u);
    expect(source).not.toMatch(/a1b2c3d|e4f5g6h|Deployment\s+#\d+/u);
    expect(source).not.toMatch(/import\s+\{?\s*AIClient|from ['"]\.\/AIClient/u);
  });

  it('permits direct Redis spend mutation only inside the durable ledger boundary', () => {
    const allowed = new Set([
      'backend/src/ai/UserAIBudget.ts',
      'backend/src/ai/AISpendAttemptLedger.ts',
    ]);
    const violations = executableFiles(resolve(root, 'backend/src')).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const repoPath = relative(root, file).replaceAll('\\', '/');
      const direct = /\b(?:reserveAIProviderSpend|settleAIProviderSpend|markAIProviderSpendUnknown|releaseAIProviderSpend|abortAIProviderSpendBeforeIO)\s*\(/u.test(source);
      return direct && !allowed.has(repoPath) ? [repoPath] : [];
    });
    expect(violations).toEqual([]);
  });

  it('keeps the dormant photo lane free of provider or spend authority code', () => {
    const source = readFileSync(resolve(root, 'backend/src/services/PhotoVerificationService.ts'), 'utf8');
    expect(source).not.toMatch(/openai|groq|anthropic|deepseek|dashscope|fetch\s*\(|AIProviderSpend|AIProviderAttempt/iu);
    expect(source).toContain('AI verification dormant — manual review required');
  });
});
