import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyEmbeddedTask } from './embeddedClassifier.js';

interface PythonReference { input: string; expected: string; top_category: string; top_score: number; second_category: string; second_score: number; margin: number; }
interface ParityFailure { input: string; reason: string; pythonTop: string; nodeTop: string; pythonSecond: string; nodeSecond: string; pythonMargin: number; nodeMargin: number; marginDelta: number; }
const MARGIN_TOLERANCE = 0.05;

async function main(): Promise<void> {
  const referencePath = path.resolve(process.cwd(), 'ml', 'task_classifier', 'data', 'parity_reference.json');
  const references = JSON.parse(await readFile(referencePath, 'utf8')) as PythonReference[];
  let topMatchCount = 0, secondMatchCount = 0, marginWithinToleranceCount = 0, maxMarginDelta = 0;
  const failures: ParityFailure[] = [];
  for (const reference of references) {
    const node = await classifyEmbeddedTask(reference.input);
    const topMatches = node.category === reference.top_category;
    const secondMatches = node.secondCategory === reference.second_category;
    const marginDelta = Math.abs(node.margin - reference.margin);
    const marginWithinTolerance = marginDelta <= MARGIN_TOLERANCE;
    if (topMatches) topMatchCount += 1;
    if (secondMatches) secondMatchCount += 1;
    if (marginWithinTolerance) marginWithinToleranceCount += 1;
    maxMarginDelta = Math.max(maxMarginDelta, marginDelta);
    if (!topMatches || !secondMatches || !marginWithinTolerance) {
      const reasons: string[] = [];
      if (!topMatches) reasons.push('top-category mismatch');
      if (!secondMatches) reasons.push('second-category mismatch');
      if (!marginWithinTolerance) reasons.push('margin drift');
      failures.push({ input: reference.input, reason: reasons.join(', '), pythonTop: reference.top_category, nodeTop: node.category, pythonSecond: reference.second_category, nodeSecond: node.secondCategory, pythonMargin: reference.margin, nodeMargin: node.margin, marginDelta });
    }
  }
  const total = references.length;
  console.log('\n=== Python ↔ Node Parity ===');
  console.log(`Examples: ${total}`);
  console.log(`Top-1 match: ${topMatchCount}/${total} (${((topMatchCount / total) * 100).toFixed(2)}%)`);
  console.log(`Top-2 runner-up match: ${secondMatchCount}/${total} (${((secondMatchCount / total) * 100).toFixed(2)}%)`);
  console.log(`Margin within ${MARGIN_TOLERANCE}: ${marginWithinToleranceCount}/${total} (${((marginWithinToleranceCount / total) * 100).toFixed(2)}%)`);
  console.log(`Max margin delta: ${maxMarginDelta.toFixed(6)}`);
  if (failures.length) { console.log('\n=== Parity Differences ==='); console.table(failures); }
  if (topMatchCount !== total) throw new Error(`Top-1 parity failed: ${topMatchCount}/${total}`);
  if (marginWithinToleranceCount !== total) throw new Error(`Margin parity exceeded tolerance for ${total - marginWithinToleranceCount} examples.`);
  console.log('\nParity check passed.');
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
