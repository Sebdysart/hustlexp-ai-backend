import fs from 'node:fs/promises';
import path from 'node:path';
import { TASK_CLASSIFIER_TRAINING_DATA } from './trainingData.js';
import { createTaskClassifier } from './createClassifier.js';

async function main(): Promise<void> {
  const classifier = createTaskClassifier(TASK_CLASSIFIER_TRAINING_DATA);
  const outputDirectory = path.resolve('models');
  const outputPath = path.join(outputDirectory, 'task-classifier.json');
  await fs.mkdir(outputDirectory, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    classifier.save(outputPath, (error: Error | null) => (error ? reject(error) : resolve()));
  });
  console.log(`Task classifier trained on ${TASK_CLASSIFIER_TRAINING_DATA.length} examples.`);
  console.log(`Saved model to ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
