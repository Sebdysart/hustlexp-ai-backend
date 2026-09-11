import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClassifierModelArtifact } from './types.js';
let modelPromise: Promise<ClassifierModelArtifact> | null = null;
function validateModel(model: ClassifierModelArtifact): void { if (model.format_version !== 1 || model.classifier !== 'linear_svc') throw new Error('Unsupported task classifier model.'); if (model.embedding_dimensions !== 384) throw new Error(`Unexpected task embedding dimensions: ${model.embedding_dimensions}`); if (model.classes.length !== model.weights.length || model.classes.length !== model.bias.length) throw new Error('Task classifier model dimensions mismatch.'); for (const weights of model.weights) if (weights.length !== model.embedding_dimensions) throw new Error('Task classifier weight vector has invalid dimensions.'); }
async function loadModel(): Promise<ClassifierModelArtifact> { const modelPath = path.resolve(process.cwd(), 'backend', 'models', 'task-classifier.json'); const model = JSON.parse(await readFile(modelPath, 'utf8')) as ClassifierModelArtifact; validateModel(model); return model; }
export function getTaskClassifierModel(): Promise<ClassifierModelArtifact> { modelPromise ??= loadModel(); return modelPromise; }
