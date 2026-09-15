import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { classifyTask } from './classifyTask.js';
import { getTaskClassifierModel } from './modelLoader.js';
import type { ServiceTaskCategory, TaskClassificationResult } from './types.js';

const CATEGORIES = new Set<ServiceTaskCategory>([
  'yard',
  'cleaning',
  'moving',
  'assembly',
  'delivery',
  'handyman',
  'home_services',
  'auto',
  'events',
  'pet_care',
  'painting',
  'plumbing',
  'electrical',
]);

interface BlindCase {
  id: string;
  raw: string;
  expectedCategory: ServiceTaskCategory | null;
  group: string;
}

type Outcome =
  | 'correct_emitted'
  | 'incorrect_emitted'
  | 'unnecessary_abstention'
  | 'correct_abstention'
  | 'false_concrete_on_vague';

interface Counts {
  total: number;
  concreteCases: number;
  vagueCases: number;
  correctEmitted: number;
  incorrectEmitted: number;
  unnecessaryAbstentions: number;
  correctAbstentions: number;
  falseConcreteOnVague: number;
}

interface DiagnosticRecord {
  id: string;
  group: string;
  raw: string;
  expectedCategory: ServiceTaskCategory | null;
  emittedCategory: ServiceTaskCategory | null;
  outcome: Outcome;
  source: TaskClassificationResult['source'];
  overrideReason: string | null;
  needsClarification: boolean;
  top1Category: ServiceTaskCategory | null;
  top1Score: number | null;
  top2Category: ServiceTaskCategory | null;
  top2Score: number | null;
  margin: number;
  threshold: number;
}

function emptyCounts(): Counts {
  return {
    total: 0,
    concreteCases: 0,
    vagueCases: 0,
    correctEmitted: 0,
    incorrectEmitted: 0,
    unnecessaryAbstentions: 0,
    correctAbstentions: 0,
    falseConcreteOnVague: 0,
  };
}

function outcomeFor(
  expected: ServiceTaskCategory | null,
  actual: ServiceTaskCategory | null
): Outcome {
  if (expected === null) return actual === null ? 'correct_abstention' : 'false_concrete_on_vague';
  if (actual === expected) return 'correct_emitted';
  return actual === null ? 'unnecessary_abstention' : 'incorrect_emitted';
}

function record(counts: Counts, testCase: BlindCase, outcome: Outcome): void {
  counts.total += 1;
  if (testCase.expectedCategory === null) counts.vagueCases += 1;
  else counts.concreteCases += 1;
  if (outcome === 'correct_emitted') counts.correctEmitted += 1;
  else if (outcome === 'incorrect_emitted') counts.incorrectEmitted += 1;
  else if (outcome === 'unnecessary_abstention') counts.unnecessaryAbstentions += 1;
  else if (outcome === 'correct_abstention') counts.correctAbstentions += 1;
  else counts.falseConcreteOnVague += 1;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function summarize(counts: Counts) {
  const emitted = counts.correctEmitted + counts.incorrectEmitted + counts.falseConcreteOnVague;
  const concreteEmitted = counts.correctEmitted + counts.incorrectEmitted;
  const abstained = counts.unnecessaryAbstentions + counts.correctAbstentions;
  return {
    ...counts,
    emittedCategoryPrecision: ratio(counts.correctEmitted, emitted),
    concreteTaskAccuracy: ratio(counts.correctEmitted, counts.concreteCases),
    concreteCoverage: ratio(concreteEmitted, counts.concreteCases),
    overallEmissionRate: ratio(emitted, counts.total),
    overallAbstentionRate: ratio(abstained, counts.total),
    wrongEmittedRateAmongConcrete: ratio(counts.incorrectEmitted, counts.concreteCases),
    unnecessaryAbstentionRateAmongConcrete: ratio(
      counts.unnecessaryAbstentions,
      counts.concreteCases
    ),
    falseVagueEmissionRate: ratio(counts.falseConcreteOnVague, counts.vagueCases),
  };
}

function wilson95(successes: number, trials: number): [number, number] | null {
  if (trials === 0) return null;
  const z = 1.959963984540054;
  const proportion = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (proportion + (z * z) / (2 * trials)) / denominator;
  const halfWidth =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / trials + (z * z) / (4 * trials * trials));
  return [center - halfWidth, center + halfWidth];
}

function percentage(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function parseCases(value: unknown, expectedCount: number): BlindCase[] {
  const candidate = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { cases?: unknown }).cases)
      ? (value as { cases: unknown[] }).cases
      : null;
  if (!candidate) throw new Error('Blind dataset must be an array or an object with a cases array.');
  if (candidate.length !== expectedCount)
    throw new Error(`Expected exactly ${expectedCount} blind cases; received ${candidate.length}.`);

  return candidate.map((item, index) => {
    if (typeof item !== 'object' || item === null) throw new Error(`Case ${index + 1} is invalid.`);
    const rawCase = item as Record<string, unknown>;
    const expected = rawCase.expectedCategory;
    if (
      typeof rawCase.id !== 'string' ||
      typeof rawCase.raw !== 'string' ||
      typeof rawCase.group !== 'string' ||
      !(expected === null || (typeof expected === 'string' && CATEGORIES.has(expected as ServiceTaskCategory)))
    )
      throw new Error(`Case ${index + 1} does not match the blind evaluation contract.`);
    return {
      id: rawCase.id,
      raw: rawCase.raw,
      group: rawCase.group,
      expectedCategory: expected as ServiceTaskCategory | null,
    };
  });
}

function diagnosticFor(
  testCase: BlindCase,
  result: TaskClassificationResult,
  outcome: Outcome
): DiagnosticRecord {
  const top1 = result.candidates[0];
  const top2 = result.candidates[1];
  return {
    id: testCase.id,
    group: testCase.group,
    raw: testCase.raw,
    expectedCategory: testCase.expectedCategory,
    emittedCategory: result.category,
    outcome,
    source: result.source,
    overrideReason: result.overrideReason ?? null,
    needsClarification: result.needsClarification,
    top1Category: top1?.category ?? null,
    top1Score: top1?.score ?? null,
    top2Category: top2?.category ?? null,
    top2Score: top2?.score ?? null,
    margin: result.margin,
    threshold: result.threshold,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const datasetPath = path.resolve(
    process.cwd(),
    process.argv[2] ?? 'ml/task_classifier/eval/blind_holdout_v2_1000.json'
  );
  const reportPath = path.resolve(
    process.cwd(),
    process.argv[3] ?? 'ml/task_classifier/eval/blind_holdout_v2_1000.results.json'
  );
  const expectedCount = Number.parseInt(process.argv[4] ?? '1000', 10);
  if (!Number.isInteger(expectedCount) || expectedCount <= 0)
    throw new Error(`Expected case count must be a positive integer; received ${process.argv[4]}.`);
  if (await pathExists(reportPath))
    throw new Error(`Refusing to overwrite existing one-shot report: ${reportPath}`);

  const parsed = JSON.parse(await readFile(datasetPath, 'utf8')) as unknown;
  const cases = parseCases(parsed, expectedCount);
  const model = await getTaskClassifierModel();
  const overall = emptyCounts();
  const byCategory = new Map<string, Counts>();
  const byGroup = new Map<string, Counts>();
  const diagnostics: DiagnosticRecord[] = [];
  const overrideUsage = new Map<string, { total: number; correct: number; incorrect: number }>();

  for (const [index, testCase] of cases.entries()) {
    const result = await classifyTask(testCase.raw);
    const outcome = outcomeFor(testCase.expectedCategory, result.category);
    record(overall, testCase, outcome);

    const categoryKey = testCase.expectedCategory ?? 'vague';
    const categoryCounts = byCategory.get(categoryKey) ?? emptyCounts();
    record(categoryCounts, testCase, outcome);
    byCategory.set(categoryKey, categoryCounts);

    const groupCounts = byGroup.get(testCase.group) ?? emptyCounts();
    record(groupCounts, testCase, outcome);
    byGroup.set(testCase.group, groupCounts);

    if (result.overrideReason) {
      const usage = overrideUsage.get(result.overrideReason) ?? { total: 0, correct: 0, incorrect: 0 };
      usage.total += 1;
      if (outcome === 'correct_emitted') usage.correct += 1;
      else usage.incorrect += 1;
      overrideUsage.set(result.overrideReason, usage);
    }

    if (outcome !== 'correct_emitted' && outcome !== 'correct_abstention')
      diagnostics.push(diagnosticFor(testCase, result, outcome));

    if ((index + 1) % 100 === 0) console.log(`Evaluated ${index + 1}/${cases.length}`);
  }

  const summary = summarize(overall);
  const emitted =
    overall.correctEmitted + overall.incorrectEmitted + overall.falseConcreteOnVague;
  const report = {
    dataset: path.basename(datasetPath),
    evaluatedAt: new Date().toISOString(),
    configuration: {
      trainingExamples: model.training_examples,
      classifier: model.classifier,
      ambiguityThreshold: model.ambiguity_threshold,
      classes: model.classes,
    },
    summary: {
      ...summary,
      emittedPrecisionWilson95: wilson95(overall.correctEmitted, emitted),
    },
    perCategory: Object.fromEntries(
      [...byCategory.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
        ([key, counts]) => [key, summarize(counts)]
      )
    ),
    perGroup: Object.fromEntries(
      [...byGroup.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
        ([key, counts]) => [key, summarize(counts)]
      )
    ),
    overrideUsage: Object.fromEntries(
      [...overrideUsage.entries()].sort(([left], [right]) => left.localeCompare(right))
    ),
    diagnostics,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('\nClassifier evaluation complete.');
  console.log(`Total: ${summary.total}`);
  console.log(`Concrete cases: ${summary.concreteCases}`);
  console.log(`Vague cases: ${summary.vagueCases}`);
  console.log(`Correct emitted: ${summary.correctEmitted}`);
  console.log(`Incorrect emitted: ${summary.incorrectEmitted}`);
  console.log(`Unnecessary abstentions: ${summary.unnecessaryAbstentions}`);
  console.log(`Correct abstentions: ${summary.correctAbstentions}`);
  console.log(`False concrete on vague: ${summary.falseConcreteOnVague}`);
  console.log(`Emitted precision: ${percentage(summary.emittedCategoryPrecision)}`);
  console.log(`Concrete accuracy: ${percentage(summary.concreteTaskAccuracy)}`);
  console.log(`Concrete coverage: ${percentage(summary.concreteCoverage)}`);
  console.log(`Overall emission: ${percentage(summary.overallEmissionRate)}`);
  console.log(`Overall abstention: ${percentage(summary.overallAbstentionRate)}`);
  console.log(`False-vague emission: ${percentage(summary.falseVagueEmissionRate)}`);
  console.log(`Diagnostic records: ${diagnostics.length}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
