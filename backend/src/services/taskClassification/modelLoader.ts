import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClassifierModelArtifact } from './types.js';
let modelPromise: Promise<ClassifierModelArtifact> | null = null;
function validateModel(model: ClassifierModelArtifact): void { if (model.format_version !== 1 || model.classifier !== 'linear_svc') throw new Error('Unsupported task classifier model.'); if (model.embedding_dimensions !== 384) throw new Error(`Unexpected task embedding dimensions: ${model.embedding_dimensions}`); if (model.classes.length !== model.weights.length || model.classes.length !== model.bias.length) throw new Error('Task classifier model dimensions mismatch.'); for (const weights of model.weights) if (weights.length !== model.embedding_dimensions) throw new Error('Task classifier weight vector has invalid dimensions.'); }
async function loadModel(): Promise<ClassifierModelArtifact> {
  const modelPath = path.resolve(process.cwd(), 'backend', 'models', 'task-classifier.json');

  try {
    console.info('[task-classifier:model] loading', {
      modelPath,
      cwd: process.cwd(),
    });

    const model = JSON.parse(
      await readFile(modelPath, 'utf8'),
    ) as ClassifierModelArtifact;

    validateModel(model);

    console.info('[task-classifier:model] loaded', {
      embeddingModel: model.runtime_embedding_model,
      dimensions: model.embedding_dimensions,
      classes: model.classes.length,
    });

    return model;
  } catch (error) {
    console.error('[task-classifier:model] failed', {
      modelPath,
      cwd: process.cwd(),
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    throw error;
  }
}
export function getTaskClassifierModel(): Promise<ClassifierModelArtifact> { modelPromise ??= loadModel(); return modelPromise; }
