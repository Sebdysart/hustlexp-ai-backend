import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

const root = process.cwd();

const classifierPath = path.join(root, 'backend', 'models', 'task-classifier.json');
const cacheDir = path.join(root, 'backend', 'models', 'transformers-cache');
const classifier = JSON.parse(await readFile(classifierPath, 'utf8'));
const modelId = classifier.runtime_embedding_model;

if (!modelId || typeof modelId !== 'string') {
  throw new Error('task-classifier.json is missing runtime_embedding_model');
}

await mkdir(cacheDir, { recursive: true });

env.cacheDir = cacheDir;
env.useFSCache = true;
env.allowRemoteModels = true;

console.log('[classifier-cache] downloading', { modelId, cacheDir });

const extractor = await pipeline('feature-extraction', modelId);
await extractor('classifier cache warmup', { pooling: 'mean', normalize: true });

console.log('[classifier-cache] ready', { modelId, cacheDir });
