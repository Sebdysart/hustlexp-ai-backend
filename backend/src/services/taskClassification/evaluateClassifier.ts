import { TASK_CLASSIFIER_TRAINING_DATA } from './trainingData.js';
import { createTaskClassifier } from './createClassifier.js';
import type { TaskCategory, TrainingExample } from './types.js';

const FOLD_COUNT = 5;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildStratifiedFolds(examples: TrainingExample[]): TrainingExample[][] {
  const folds = Array.from({ length: FOLD_COUNT }, () => [] as TrainingExample[]);
  const grouped = new Map<TaskCategory, TrainingExample[]>();
  for (const example of examples) {
    const group = grouped.get(example.expected) ?? [];
    group.push(example);
    grouped.set(example.expected, group);
  }
  for (const group of grouped.values()) {
    [...group].sort((a, b) => stableHash(a.input) - stableHash(b.input)).forEach((example, index) => {
      folds[index % FOLD_COUNT].push(example);
    });
  }
  return folds;
}

function runEvaluation(): void {
  const folds = buildStratifiedFolds(TASK_CLASSIFIER_TRAINING_DATA);
  const results: Array<{ fold: number; correct: number; total: number; accuracy: number }> = [];
  const stats = new Map<TaskCategory, { correct: number; total: number }>();
  const failures: Array<{ input: string; expected: TaskCategory; actual: TaskCategory; fold: number }> = [];

  folds.forEach((test, foldIndex) => {
    const train = folds.flatMap((fold, index) => (index === foldIndex ? [] : fold));
    const classifier = createTaskClassifier(train);
    let correct = 0;
    for (const example of test) {
      const actual = classifier.classify(example.input) as TaskCategory;
      const category = stats.get(example.expected) ?? { correct: 0, total: 0 };
      category.total += 1;
      if (actual === example.expected) {
        correct += 1;
        category.correct += 1;
      } else {
        failures.push({ input: example.input, expected: example.expected, actual, fold: foldIndex + 1 });
      }
      stats.set(example.expected, category);
    }
    results.push({ fold: foldIndex + 1, correct, total: test.length, accuracy: test.length ? correct / test.length : 0 });
  });

  console.log('\n=== Fold results ===');
  console.table(results.map((result) => ({ ...result, accuracy: `${(result.accuracy * 100).toFixed(1)}%` })));
  console.log('\n=== Category accuracy ===');
  console.table([...stats.entries()].map(([category, value]) => ({ category, ...value, accuracy: `${((value.correct / value.total) * 100).toFixed(1)}%` })).sort((a, b) => a.category.localeCompare(b.category)));
  const correct = results.reduce((sum, result) => sum + result.correct, 0);
  const total = results.reduce((sum, result) => sum + result.total, 0);
  console.log('\n=== Overall ===');
  console.log(`${correct} / ${total} correct`);
  console.log(`${((correct / total) * 100).toFixed(2)}% cross-validation accuracy`);
  if (failures.length) {
    console.log('\n=== Misclassified ===');
    console.table(failures);
  }
}

runEvaluation();
