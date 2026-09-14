import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  classifierHardeningCases,
  type ClassifierHardeningCase,
} from './classifierHardeningCases.js';
import { classifyTask } from './classifyTask.js';

type Outcome =
  | 'correct_emitted'
  | 'incorrect_emitted'
  | 'unnecessary_abstention'
  | 'correct_abstention'
  | 'false_concrete_on_vague';

interface ResultRow extends ClassifierHardeningCase {
  actualCategory: string | null;
  outcome: Outcome;
  source: string;
  overrideReason: string | null;
  margin: number;
  threshold: number;
  top1Category: string | null;
  top1Score: number | null;
  top2Category: string | null;
  top2Score: number | null;
}

function outcomeFor(expected: string | null, actual: string | null): Outcome {
  if (expected === null) return actual === null ? 'correct_abstention' : 'false_concrete_on_vague';
  if (actual === expected) return 'correct_emitted';
  return actual === null ? 'unnecessary_abstention' : 'incorrect_emitted';
}

async function main(): Promise<void> {
  const outputPath = path.resolve(
    process.cwd(),
    process.argv[2] ?? 'ml/task_classifier/eval/classifier_hardening.results.json'
  );
  const rows: ResultRow[] = [];
  for (const [index, testCase] of classifierHardeningCases.entries()) {
    const result = await classifyTask(testCase.input);
    rows.push({
      ...testCase,
      actualCategory: result.category,
      outcome: outcomeFor(testCase.expectedCategory, result.category),
      source: result.source,
      overrideReason: result.overrideReason ?? null,
      margin: result.margin,
      threshold: result.threshold,
      top1Category: result.candidates[0]?.category ?? null,
      top1Score: result.candidates[0]?.score ?? null,
      top2Category: result.candidates[1]?.category ?? null,
      top2Score: result.candidates[1]?.score ?? null,
    });
    if ((index + 1) % 200 === 0) console.log(`Evaluated ${index + 1}/${classifierHardeningCases.length}`);
  }

  const count = (outcome: Outcome): number => rows.filter((row) => row.outcome === outcome).length;
  const concrete = rows.filter((row) => row.expectedCategory !== null).length;
  const correct = count('correct_emitted');
  const wrong = count('incorrect_emitted');
  const abstained = count('unnecessary_abstention');
  const vagueCorrect = count('correct_abstention');
  const vagueWrong = count('false_concrete_on_vague');
  const emitted = correct + wrong + vagueWrong;
  const summary = {
    total: rows.length,
    concrete,
    vague: rows.length - concrete,
    correct,
    wrong,
    abstained,
    vagueCorrect,
    vagueWrong,
    precision: emitted === 0 ? 0 : correct / emitted,
    concreteAccuracy: correct / concrete,
    coverage: (correct + wrong) / concrete,
  };
  const groupCounts = Object.fromEntries(
    [...new Set(rows.map((row) => row.group))].sort().map((group) => {
      const selected = rows.filter((row) => row.group === group);
      return [
        group,
        {
          total: selected.length,
          correct: selected.filter((row) => row.outcome === 'correct_emitted').length,
          wrong: selected.filter((row) => row.outcome === 'incorrect_emitted').length,
          abstained: selected.filter((row) => row.outcome === 'unnecessary_abstention').length,
          vagueCorrect: selected.filter((row) => row.outcome === 'correct_abstention').length,
          vagueWrong: selected.filter((row) => row.outcome === 'false_concrete_on_vague').length,
        },
      ];
    })
  );
  await writeFile(outputPath, `${JSON.stringify({ summary, groups: groupCounts, rows }, null, 2)}\n`);
  console.log(JSON.stringify({ summary, groups: groupCounts }, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
