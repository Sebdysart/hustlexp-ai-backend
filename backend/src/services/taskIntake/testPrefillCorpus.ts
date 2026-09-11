import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { extractIntakePrefill } from './extractPrefill.js';
import { getQuestionsForIntake } from './definitions.js';
import type { IntakeAnswer, TaskCategory } from './types.js';

interface CorpusRow { input: string; expected: TaskCategory; }
interface ExpectedPrefill { input: string; category: TaskCategory; secondaryIntents?: TaskCategory[]; expectedAnswers: Record<string, IntakeAnswer>; }

const CORPUS_PATH = path.resolve(process.cwd(), 'ml', 'task_classifier', 'data', 'tasks.json');

const EXACT_CASES: ExpectedPrefill[] = [
  { input: 'Walk two large dogs twice today.', category: 'pet_care', expectedAnswers: { pet_type: 'dog', pet_count: 2, care_type: ['walking'] } },
  { input: 'Move 20 boxes down two flights of stairs.', category: 'moving', expectedAnswers: { item_count: 20, stairs: true, stair_flights: 2, access_restrictions: '2 flights of stairs are involved.' } },
  { input: 'Put together four dining chairs and a table.', category: 'assembly', expectedAnswers: { assembly_count: 5, assembly_type: 'dining chairs and table' } },
  { input: 'I need my apartment cleaned, three rooms total.', category: 'cleaning', expectedAnswers: { property_type: 'apartment', room_count: 3 } },
  { input: 'Pick up my new bed, bring it upstairs and assemble it.', category: 'delivery', secondaryIntents: ['assembly'], expectedAnswers: { delivery_item: 'bed', assembly_type: 'bed', assembly_count: 1, access_restrictions: 'The task involves carrying or accessing items upstairs.' } },
  { input: 'Move two couches and six boxes up three flights of stairs.', category: 'moving', expectedAnswers: { item_count: 8, stairs: true, stair_flights: 3, access_restrictions: '3 flights of stairs are involved.' } },
  { input: 'Assemble one desk, two shelves, and four chairs.', category: 'assembly', expectedAnswers: { assembly_count: 7, assembly_type: 'desk and shelves and chairs' } },
  { input: 'Deliver 30 folding chairs to an event venue.', category: 'delivery', expectedAnswers: { delivery_item: 'folding chairs' } },
  { input: 'Walk two dogs for three hours.', category: 'pet_care', expectedAnswers: { pet_type: 'dog', pet_count: 2, care_type: ['walking'] } },
  { input: 'Need someone ASAP.', category: 'other', expectedAnswers: {} },
];

const VAGUE_INPUT_PATTERNS = [/^need someone\b/i, /^need help\b/i, /^help me\b/i, /^can someone help\b/i, /^looking for help\b/i];

function equalAnswer(a: IntakeAnswer | undefined, b: IntakeAnswer): boolean { return Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b; }
function getAllowedKeys(category: TaskCategory, secondary: readonly TaskCategory[] = []): Set<string> { return new Set(getQuestionsForIntake(category, secondary).map((q) => q.key)); }

function runExactAssertions(): void {
  let passed = 0;
  for (const testCase of EXACT_CASES) {
    const result = extractIntakePrefill(testCase.input, testCase.category, testCase.secondaryIntents ?? []);
    assert.deepEqual(Object.keys(result.answers).sort(), Object.keys(testCase.expectedAnswers).sort(), testCase.input);
    for (const [key, expected] of Object.entries(testCase.expectedAnswers)) assert.ok(equalAnswer(result.answers[key], expected), `${testCase.input}: ${key}`);
    passed += 1;
  }
  console.log(`Exact cases passed: ${passed}/${EXACT_CASES.length}`);
}

async function main(): Promise<void> {
  runExactAssertions();
  const corpus = JSON.parse(await readFile(CORPUS_PATH, 'utf8')) as CorpusRow[];
  let tasksWithPrefill = 0, totalFields = 0, invalidKeys = 0, vaguePrefills = 0;
  const fieldCounts = new Map<string, number>();
  for (const row of corpus) {
    const result = extractIntakePrefill(row.input, row.expected, []);
    const keys = Object.keys(result.answers);
    if (keys.length) tasksWithPrefill += 1;
    totalFields += keys.length;
    for (const key of keys) fieldCounts.set(key, (fieldCounts.get(key) ?? 0) + 1);
    const allowed = getAllowedKeys(row.expected);
    invalidKeys += keys.filter((key) => !allowed.has(key)).length;
    if (keys.length && VAGUE_INPUT_PATTERNS.some((p) => p.test(row.input.trim()))) vaguePrefills += 1;
  }
  console.log(`Tasks checked: ${corpus.length}`);
  console.log(`Tasks with >= 1 prefill: ${tasksWithPrefill}/${corpus.length}`);
  console.log(`Average prefill fields/task: ${(totalFields / corpus.length).toFixed(2)}`);
  console.log(`Invalid-key prefills: ${invalidKeys}`);
  console.log(`Vague tasks with prefills: ${vaguePrefills}`);
  console.table([...fieldCounts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count })));
  assert.equal(invalidKeys, 0, 'Extractor emitted answer keys outside the active intake schema.');
  console.log('Corpus prefill validation passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
