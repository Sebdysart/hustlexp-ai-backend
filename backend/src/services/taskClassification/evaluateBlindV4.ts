import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { classifyTask } from './classifyTask.js';
import { getTaskClassifierModel } from './modelLoader.js';
import type { ServiceTaskCategory, TaskClassificationResult } from './types.js';

interface BlindV4Case {
  id: string;
  input: string;
  expectedCategory: ServiceTaskCategory | null;
  kind: 'concrete' | 'vague';
}

type Outcome = 'correct' | 'wrong' | 'abstained' | 'vague_safe' | 'vague_false_emission';

interface EvaluatedCase extends BlindV4Case {
  actualCategory: ServiceTaskCategory | null;
  needsClarification: boolean;
  outcome: Outcome;
  margin: number;
  threshold: number;
  source: TaskClassificationResult['source'];
  overrideReason: string | null;
  candidates: TaskClassificationResult['candidates'];
}

const categories: ServiceTaskCategory[] = [
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
];

function outcomeFor(testCase: BlindV4Case, actual: ServiceTaskCategory | null): Outcome {
  if (testCase.expectedCategory === null)
    return actual === null ? 'vague_safe' : 'vague_false_emission';
  if (actual === testCase.expectedCategory) return 'correct';
  return actual === null ? 'abstained' : 'wrong';
}

function parseCases(parsed: unknown): BlindV4Case[] {
  const value = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cases?: unknown }).cases)
      ? (parsed as { cases: unknown[] }).cases
      : null;
  if (!value) throw new Error('Blind v4 must be an array or an object with a cases array.');
  const allowed = new Set(categories);
  const cases = value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Invalid case at index ${index}.`);
    const candidate = item as Partial<BlindV4Case>;
    if (typeof candidate.id !== 'string' || typeof candidate.input !== 'string')
      throw new Error(`Invalid id/input at index ${index}.`);
    if (candidate.expectedCategory !== null && !allowed.has(candidate.expectedCategory as ServiceTaskCategory))
      throw new Error(`Invalid expected category at index ${index}.`);
    if (candidate.kind !== 'concrete' && candidate.kind !== 'vague')
      throw new Error(`Invalid kind at index ${index}.`);
    if ((candidate.kind === 'vague') !== (candidate.expectedCategory === null))
      throw new Error(`Kind/category disagreement at index ${index}.`);
    return candidate as BlindV4Case;
  });
  if (cases.length !== 600) throw new Error(`Expected 600 cases, received ${cases.length}.`);
  if (new Set(cases.map(({ id }) => id)).size !== cases.length) throw new Error('Duplicate case IDs.');
  const concrete = cases.filter(({ kind }) => kind === 'concrete').length;
  const vague = cases.length - concrete;
  if (concrete !== 520 || vague !== 80)
    throw new Error(`Expected 520 concrete and 80 vague cases, received ${concrete}/${vague}.`);
  return cases;
}

async function main(): Promise<void> {
  const datasetPath = path.resolve(
    process.cwd(),
    process.argv[2] ?? 'ml/task_classifier/eval/hustlexp_classifier_blind_v4_600.json'
  );
  const resultPath = path.resolve(
    process.cwd(),
    process.argv[3] ?? 'ml/task_classifier/eval/hustlexp_classifier_blind_v4_600.results.json'
  );
  const datasetBytes = await readFile(datasetPath);
  const cases = parseCases(JSON.parse(datasetBytes.toString('utf8')) as unknown);
  const model = await getTaskClassifierModel();
  const rows: EvaluatedCase[] = [];

  for (const [index, testCase] of cases.entries()) {
    const result = await classifyTask(testCase.input);
    rows.push({
      ...testCase,
      actualCategory: result.category,
      needsClarification: result.needsClarification,
      outcome: outcomeFor(testCase, result.category),
      margin: result.margin,
      threshold: result.threshold,
      source: result.source,
      overrideReason: result.overrideReason ?? null,
      candidates: result.candidates.slice(0, 3),
    });
    if ((index + 1) % 100 === 0) console.log(`Evaluated ${index + 1}/${cases.length}`);
  }

  const count = (outcome: Outcome): number => rows.filter((row) => row.outcome === outcome).length;
  const correct = count('correct');
  const wrong = count('wrong');
  const abstained = count('abstained');
  const vagueSafe = count('vague_safe');
  const vagueFalse = count('vague_false_emission');
  const categoryBreakdown = Object.fromEntries(
    categories.map((category) => {
      const selected = rows.filter((row) => row.expectedCategory === category);
      const selectedCorrect = selected.filter((row) => row.outcome === 'correct').length;
      const selectedWrong = selected.filter((row) => row.outcome === 'wrong').length;
      const selectedAbstained = selected.filter((row) => row.outcome === 'abstained').length;
      const emitted = selectedCorrect + selectedWrong;
      return [category, {
        total: selected.length,
        correct: selectedCorrect,
        wrong: selectedWrong,
        abstained: selectedAbstained,
        coverage: emitted / selected.length,
        emittedPrecision: emitted === 0 ? null : selectedCorrect / emitted,
      }];
    })
  );
  const report = {
    dataset: path.basename(datasetPath),
    datasetSha256: createHash('sha256').update(datasetBytes).digest('hex'),
    evaluatedAt: new Date().toISOString(),
    configuration: {
      trainingExamples: model.training_examples,
      classifier: model.classifier,
      threshold: model.ambiguity_threshold,
      categories: model.classes,
    },
    summary: {
      total: cases.length,
      concrete: 520,
      vague: 80,
      correct,
      wrong,
      abstained,
      concreteCoverage: (correct + wrong) / 520,
      emittedConcretePrecision: correct / (correct + wrong),
      acceptedRecall: correct / 520,
      vagueSafe,
      vagueFalse,
      vagueSafetyRate: vagueSafe / 80,
    },
    categoryBreakdown,
    rows,
  };
  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${resultPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
