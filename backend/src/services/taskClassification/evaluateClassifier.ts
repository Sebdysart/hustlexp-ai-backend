import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { classifyTask } from './classifyTask.js';
import type { ServiceTaskCategory } from './types.js';

interface EvaluationCase {
  id?: string;
  raw: string;
  expectedCategory: ServiceTaskCategory | null;
}

interface EvaluationFile {
  name?: string;
  cases: EvaluationCase[];
}

interface CategoryMetrics {
  total: number;
  correct: number;
  incorrectEmitted: number;
  abstained: number;
}

function percentage(numerator: number, denominator: number): string {
  return denominator === 0 ? 'n/a' : `${((numerator / denominator) * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  const requestedPath =
    process.argv[2] ?? 'ml/task_classifier/eval/known_classifier_regressions.json';
  const datasetPath = path.resolve(process.cwd(), requestedPath);
  const dataset = JSON.parse(await readFile(datasetPath, 'utf8')) as EvaluationFile;

  if (!Array.isArray(dataset.cases)) throw new Error('Evaluation file must contain a cases array.');

  let correctEmitted = 0;
  let incorrectEmitted = 0;
  let unnecessaryAbstentions = 0;
  let correctAbstentions = 0;
  let falseConcreteOnVague = 0;
  const confusion = new Map<string, number>();
  const perCategory = new Map<ServiceTaskCategory, CategoryMetrics>();

  for (const testCase of dataset.cases) {
    const result = await classifyTask(testCase.raw);
    const expected = testCase.expectedCategory;
    const actual = result.category;

    if (expected === null) {
      if (actual === null) correctAbstentions += 1;
      else {
        falseConcreteOnVague += 1;
        const key = `abstain -> ${actual}`;
        confusion.set(key, (confusion.get(key) ?? 0) + 1);
      }
      continue;
    }

    const metrics = perCategory.get(expected) ?? {
      total: 0,
      correct: 0,
      incorrectEmitted: 0,
      abstained: 0,
    };
    metrics.total += 1;
    if (actual === expected) {
      correctEmitted += 1;
      metrics.correct += 1;
    } else if (actual === null) {
      unnecessaryAbstentions += 1;
      metrics.abstained += 1;
      const key = `${expected} -> abstain`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    } else {
      incorrectEmitted += 1;
      metrics.incorrectEmitted += 1;
      const key = `${expected} -> ${actual}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    }
    perCategory.set(expected, metrics);
  }

  const total = dataset.cases.length;
  const concreteTotal = [...perCategory.values()].reduce((sum, metrics) => sum + metrics.total, 0);
  const emittedTotal = correctEmitted + incorrectEmitted + falseConcreteOnVague;
  const abstentionTotal = unnecessaryAbstentions + correctAbstentions;

  console.log(`Dataset: ${dataset.name ?? path.basename(datasetPath)}`);
  console.log(`Total: ${total}`);
  console.log(`Correct emitted: ${correctEmitted}`);
  console.log(`Incorrect emitted: ${incorrectEmitted}`);
  console.log(`Unnecessary abstentions: ${unnecessaryAbstentions}`);
  console.log(`Correct abstentions: ${correctAbstentions}`);
  console.log(`False concrete on vague: ${falseConcreteOnVague}`);
  console.log(`Concrete accuracy: ${percentage(correctEmitted, concreteTotal)}`);
  console.log(`Emitted-category precision: ${percentage(correctEmitted, emittedTotal)}`);
  console.log(`Emission rate: ${percentage(emittedTotal, total)}`);
  console.log(`Abstention rate: ${percentage(abstentionTotal, total)}`);

  console.log('\nPer-category:');
  for (const [category, metrics] of [...perCategory.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    console.log(
      `${category}: ${metrics.correct}/${metrics.total} correct, ` +
        `${metrics.incorrectEmitted} wrong emitted, ${metrics.abstained} abstained ` +
        `(accuracy ${percentage(metrics.correct, metrics.total)}, abstention ${percentage(metrics.abstained, metrics.total)})`
    );
  }

  if (confusion.size > 0) {
    console.log('\nConfusions:');
    for (const [pair, count] of [...confusion.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
    )) {
      console.log(`${pair}: ${count}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
