import fs from 'fs';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const ORACLE_PROMPT = (diff: string, invariants: string) => `
You are a malicious senior security architect whose job is to find any way that the
following code change could cause a production incident, bypass a financial invariant,
introduce a backdoor, or quietly disable a safety check.

The system has these hard invariants:
${invariants}

Analyze the following diff with maximum adversarial scrutiny:
\`\`\`diff
${diff.slice(0, 8000)}
\`\`\`

Respond in JSON only (no markdown, no explanation outside the JSON):
{
  "safe": boolean,
  "confidence": number,
  "findings": string[],
  "reasoning": string
}
`;

interface OracleVerdict {
  model: string;
  safe: boolean;
  confidence: number;
  findings: string[];
  reasoning: string;
}

async function queryGPT4o(diff: string, invariants: string): Promise<OracleVerdict> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: ORACLE_PROMPT(diff, invariants) }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });
  const parsed = JSON.parse(resp.choices[0].message.content ?? '{}');
  return { model: 'gpt-4o', ...parsed };
}

async function queryGemini(diff: string, invariants: string): Promise<OracleVerdict> {
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
  const model = genai.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
  const result = await model.generateContent(ORACLE_PROMPT(diff, invariants));
  const text = result.response.text().replace(/```json\n?|\n?```/g, '').trim();
  const parsed = JSON.parse(text);
  return { model: 'gemini-2.0-flash', ...parsed };
}

async function queryClaude(diff: string, invariants: string): Promise<OracleVerdict> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: ORACLE_PROMPT(diff, invariants) }],
    }),
  });
  const data = await resp.json() as { content: { text: string }[] };
  const parsed = JSON.parse(data.content[0].text);
  return { model: 'claude-3.5-sonnet', ...parsed };
}

async function main() {
  const diff = process.env.PR_DIFF ?? '';
  const invariants = fs.existsSync('CLAUDE.md')
    ? fs.readFileSync('CLAUDE.md', 'utf-8')
        .split('\n')
        .filter(l => l.startsWith('- **INV') || l.startsWith('- **ARCH') || l.startsWith('- **SM'))
        .join('\n')
    : 'Financial invariants: amounts must be positive, ledger entries are append-only, escrow can only release once.';

  if (!diff) {
    console.log('No diff provided — oracle skipping.');
    process.exit(0);
  }

  console.log('Citadel Oracle: dispatching 3-model adversarial ensemble...');

  const [gpt, gemini, claude] = await Promise.allSettled([
    queryGPT4o(diff, invariants),
    queryGemini(diff, invariants),
    queryClaude(diff, invariants),
  ]);

  const verdicts: OracleVerdict[] = [gpt, gemini, claude]
    .filter(r => r.status === 'fulfilled')
    .map(r => (r as PromiseFulfilledResult<OracleVerdict>).value);

  if (verdicts.length < 2) {
    console.error('Oracle: fewer than 2 models responded — cannot form quorum');
    process.exit(1);
  }

  const totalWeight = verdicts.reduce((s, v) => s + v.confidence, 0);
  const safeWeight = verdicts.filter(v => v.safe).reduce((s, v) => s + v.confidence, 0);
  const weightedSafe = safeWeight / totalWeight;
  const overallSafe = weightedSafe >= 0.5;
  const findings = verdicts.flatMap(v => v.findings);

  const report = { safe: overallSafe, weightedConfidence: weightedSafe, verdicts, findings };
  fs.writeFileSync('citadel-oracle-report.json', JSON.stringify(report, null, 2));

  const md = [
    `## Oracle Ensemble Verdict: ${overallSafe ? 'SAFE' : 'UNSAFE'}`,
    `**Weighted confidence:** ${(weightedSafe * 100).toFixed(1)}%`,
    '',
    '| Model | Verdict | Confidence | Findings |',
    '|-------|---------|------------|---------|',
    ...verdicts.map(v =>
      `| ${v.model} | ${v.safe ? 'SAFE' : 'UNSAFE'} | ${(v.confidence * 100).toFixed(0)}% | ${v.findings.join('; ') || 'None'} |`
    ),
    findings.length > 0 ? `\n### Findings\n${findings.map(f => `- ${f}`).join('\n')}` : '',
  ].join('\n');

  fs.writeFileSync('citadel-oracle-report.md', md);

  if (!overallSafe) {
    console.error(`Oracle: ensemble voted UNSAFE (${(weightedSafe * 100).toFixed(1)}% safe weight)`);
    console.error('Findings:', findings);
    process.exit(1);
  }

  console.log(`Oracle: ensemble voted SAFE (${(weightedSafe * 100).toFixed(1)}% safe weight)`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `oracle_safe=${overallSafe}\noracle_confidence=${weightedSafe.toFixed(3)}\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
