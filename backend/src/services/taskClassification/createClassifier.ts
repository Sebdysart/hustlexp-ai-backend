import natural from 'natural';

import type { TrainingExample } from './types.js';

export function createTaskClassifier(trainingData: TrainingExample[]) {
  const classifier = new natural.LogisticRegressionClassifier();
  for (const example of trainingData) {
    classifier.addDocument(example.input, example.expected);
  }
  classifier.train();
  return classifier;
}
