import path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { getTaskClassifierModel } from './modelLoader.js';

const transformerCachePath = path.resolve(process.cwd(), 'backend', 'models', 'transformers-cache');
env.cacheDir = transformerCachePath;
env.useFSCache = true;
if (process.env.NODE_ENV === 'production') env.allowRemoteModels = false;
type FeatureExtractor = Awaited<ReturnType<typeof pipeline>>;
let extractorPromise: Promise<FeatureExtractor> | null = null;
async function getExtractor(): Promise<FeatureExtractor> { extractorPromise ??= getTaskClassifierModel().then((model) => pipeline('feature-extraction', model.runtime_embedding_model)); return extractorPromise; }
export async function embedTaskText(text: string): Promise<Float32Array> { const normalized = text.trim(); if (!normalized) throw new Error('Cannot embed empty task text.'); const [extractor, model] = await Promise.all([getExtractor(), getTaskClassifierModel()]); const output = await extractor(normalized, { pooling: 'mean', normalize: true }); const values = Float32Array.from((output as { data: ArrayLike<number> }).data); if (values.length !== model.embedding_dimensions) throw new Error(`Unexpected task embedding length: ${values.length}`); return values; }
