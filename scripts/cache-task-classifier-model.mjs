import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

const root = process.cwd();

const classifierPath = path.join(
  root,
  'backend',
  'models',
  'task-classifier.json',
);

const cacheDir = path.join(
  root,
  'backend',
  'models',
  'transformers-cache',
);

async function assertCacheNotEmpty(directory) {
  const entries = await readdir(directory, {
    recursive: true,
  });

  if (entries.length === 0) {
    throw new Error(
      `Transformer cache is empty after warmup: ${directory}`,
    );
  }
}

try {
  await access(classifierPath);

  const classifier = JSON.parse(
    await readFile(classifierPath, 'utf8'),
  );

  const modelId = classifier.runtime_embedding_model;
  const expectedDimensions = classifier.embedding_dimensions;

  if (!modelId || typeof modelId !== 'string') {
    throw new Error(
      'task-classifier.json is missing runtime_embedding_model',
    );
  }

  if (
    !Number.isInteger(expectedDimensions) ||
    expectedDimensions <= 0
  ) {
    throw new Error(
      'task-classifier.json has invalid embedding_dimensions',
    );
  }

  await mkdir(cacheDir, {
    recursive: true,
  });

  env.cacheDir = cacheDir;
  env.useFSCache = true;
  env.allowRemoteModels = true;

  console.log('[classifier-cache] downloading', {
    modelId,
    cacheDir,
    expectedDimensions,
  });

  const extractor = await pipeline(
    'feature-extraction',
    modelId,
  );

  const output = await extractor(
    'classifier cache warmup',
    {
      pooling: 'mean',
      normalize: true,
    },
  );

  const values = Float32Array.from(
    output.data,
  );

  if (values.length !== expectedDimensions) {
    throw new Error(
      `Classifier cache warmup produced ${values.length} dimensions; expected ${expectedDimensions}`,
    );
  }

  await assertCacheNotEmpty(cacheDir);

  console.log('[classifier-cache] ready', {
    modelId,
    cacheDir,
    dimensions: values.length,
  });
} catch (error) {
  console.error(
    '[classifier-cache] failed',
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : error,
  );

  process.exit(1);
}