import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type RootCause =
  | 'model boundary'
  | 'override false positive'
  | 'multi-intent ambiguity'
  | 'oracle ambiguity'
  | 'training coverage'
  | 'preprocessing';

interface Summary {
  total: number;
  concreteCases: number;
  vagueCases: number;
  correctEmitted: number;
  incorrectEmitted: number;
  unnecessaryAbstentions: number;
  correctAbstentions: number;
  falseConcreteOnVague: number;
  emittedCategoryPrecision: number | null;
  concreteTaskAccuracy: number | null;
  concreteCoverage: number | null;
  overallEmissionRate: number | null;
  overallAbstentionRate: number | null;
  wrongEmittedRateAmongConcrete: number | null;
  unnecessaryAbstentionRateAmongConcrete: number | null;
  falseVagueEmissionRate: number | null;
  emittedPrecisionWilson95?: [number, number] | null;
}

interface Diagnostic {
  id: string;
  group: string;
  raw: string;
  expectedCategory: string | null;
  emittedCategory: string | null;
  outcome: string;
  source: string;
  overrideReason: string | null;
  top1Category: string | null;
  top1Score: number | null;
  top2Category: string | null;
  top2Score: number | null;
  margin: number;
  threshold: number;
}

interface BlindReport {
  dataset: string;
  configuration: Record<string, unknown>;
  summary: Summary;
  perCategory: Record<string, Summary>;
  perGroup: Record<string, Summary>;
  overrideUsage: Record<string, { total: number; correct: number; incorrect: number }>;
  diagnostics: Diagnostic[];
}

const ORACLE_AMBIGUITY_IDS = new Set([
  'blind2_0209',
  'blind2_0229',
  'blind2_0243',
  'blind2_0557',
  'blind2_0559',
  'blind2_0561',
  'blind2_0611',
  'blind2_0612',
  'blind2_0613',
  'blind2_0614',
  'blind2_0615',
  'blind2_0616',
]);

const MULTI_INTENT_AMBIGUITY_IDS = new Set(['blind2_0348', 'blind2_0771']);
const TRAINING_COVERAGE_IDS = new Set([
  'blind2_0153',
  'blind2_0205',
  'blind2_0230',
  'blind2_0604',
]);
const CAUSAL_OVERRIDE_REASONS = new Set([
  'explicit_bring_task_object',
  'pet_related_cleaning',
  'explicit_automotive_component',
  'explicit_plumbing_request',
]);

function classifyRootCause(row: Diagnostic): RootCause {
  if (ORACLE_AMBIGUITY_IDS.has(row.id)) return 'oracle ambiguity';
  if (MULTI_INTENT_AMBIGUITY_IDS.has(row.id)) return 'multi-intent ambiguity';
  if (TRAINING_COVERAGE_IDS.has(row.id)) return 'training coverage';
  if (CAUSAL_OVERRIDE_REASONS.has(row.overrideReason ?? '') || row.id === 'blind2_0583')
    return 'override false positive';
  if (
    /plumbing is fine|do not touch the wiring|painting is not needed|faucet can be ignored|no event help is needed|outlet itself works|no plumbing work/i.test(
      row.raw
    )
  )
    return 'preprocessing';
  return 'model boundary';
}

function percentage(value: number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function numeric(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

function escapeCell(value: unknown): string {
  return String(value ?? '—')
    .replaceAll('|', '\\|')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ');
}

function table(headers: string[], rows: unknown[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ];
}

function categoryRows(report: BlindReport): unknown[][] {
  return Object.entries(report.perCategory).map(([category, value]) => [
    category,
    value.total,
    value.correctEmitted,
    value.incorrectEmitted + value.falseConcreteOnVague,
    value.unnecessaryAbstentions + value.correctAbstentions,
    percentage(value.concreteTaskAccuracy),
    percentage(value.concreteCoverage),
    percentage(value.emittedCategoryPrecision),
  ]);
}

function groupRows(report: BlindReport): unknown[][] {
  return Object.entries(report.perGroup).map(([group, value]) => [
    group,
    value.total,
    value.correctEmitted + value.correctAbstentions,
    value.incorrectEmitted + value.falseConcreteOnVague,
    value.unnecessaryAbstentions,
    percentage(value.emittedCategoryPrecision),
    percentage(value.concreteCoverage),
  ]);
}

async function main(): Promise<void> {
  const inputPath = path.resolve(
    process.cwd(),
    process.argv[2] ?? 'ml/task_classifier/eval/blind_holdout_v2_1000.results.json'
  );
  const outputPath = path.resolve(
    process.cwd(),
    process.argv[3] ?? 'ml/task_classifier/eval/blind_holdout_v2_1000.analysis.md'
  );
  const report = JSON.parse(await readFile(inputPath, 'utf8')) as BlindReport;
  const wrong = report.diagnostics.filter((row) => row.outcome === 'incorrect_emitted');
  const falseVague = report.diagnostics.filter((row) => row.outcome === 'false_concrete_on_vague');
  const abstentions = report.diagnostics.filter((row) => row.outcome === 'unnecessary_abstention');
  const rootCounts = new Map<RootCause, number>();
  for (const row of wrong) {
    const root = classifyRootCause(row);
    rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
  }

  const categoryAbstentions = new Map<string, number>();
  const groupAbstentions = new Map<string, number>();
  for (const row of abstentions) {
    const expected = row.expectedCategory ?? 'vague';
    categoryAbstentions.set(expected, (categoryAbstentions.get(expected) ?? 0) + 1);
    groupAbstentions.set(row.group, (groupAbstentions.get(row.group) ?? 0) + 1);
  }

  const lines: string[] = [
    '# Classifier evaluation post-run analysis',
    '',
    'This report was generated from a saved evaluation result. It does not invoke the classifier.',
    '',
    '## Global metrics',
    '',
    ...table(
      ['Metric', 'Value'],
      [
        ['Total', report.summary.total],
        ['Concrete', report.summary.concreteCases],
        ['Vague', report.summary.vagueCases],
        ['Correct emitted', report.summary.correctEmitted],
        ['Incorrect emitted', report.summary.incorrectEmitted],
        ['Unnecessary abstentions', report.summary.unnecessaryAbstentions],
        ['Correct abstentions', report.summary.correctAbstentions],
        ['False concrete on vague', report.summary.falseConcreteOnVague],
        ['Emitted precision', percentage(report.summary.emittedCategoryPrecision)],
        ['Concrete accuracy', percentage(report.summary.concreteTaskAccuracy)],
        ['Concrete coverage', percentage(report.summary.concreteCoverage)],
        [
          'Unnecessary-abstention rate',
          percentage(report.summary.unnecessaryAbstentionRateAmongConcrete),
        ],
        ['False-vague rate', percentage(report.summary.falseVagueEmissionRate)],
      ]
    ),
    '',
    '## Per-category results',
    '',
    ...table(
      ['Category', 'Total', 'Correct', 'Wrong', 'Abstained', 'Accuracy', 'Coverage', 'Precision'],
      categoryRows(report)
    ),
    '',
    '## Per-group results',
    '',
    ...table(
      ['Group', 'Total', 'Correct', 'Wrong', 'Unnecessary abstain', 'Precision', 'Coverage'],
      groupRows(report)
    ),
    '',
    '## Wrong-emission root causes',
    '',
    ...table(
      ['Root cause', 'Count'],
      [...rootCounts.entries()].sort((left, right) => right[1] - left[1])
    ),
    '',
    '## All incorrect concrete emissions',
    '',
    ...table(
      [
        'ID',
        'Group',
        'Raw input',
        'Expected',
        'Emitted',
        'Top 1 / score',
        'Top 2 / score',
        'Margin',
        'Source',
        'Override',
        'Root cause',
      ],
      wrong.map((row) => [
        row.id,
        row.group,
        row.raw,
        row.expectedCategory,
        row.emittedCategory,
        `${row.top1Category} / ${numeric(row.top1Score)}`,
        `${row.top2Category} / ${numeric(row.top2Score)}`,
        row.margin.toFixed(3),
        row.source,
        row.overrideReason,
        classifyRootCause(row),
      ])
    ),
    '',
    '## False concrete classifications on vague cases',
    '',
    ...table(
      ['ID', 'Raw input', 'Emitted', 'Margin', 'Source', 'Override'],
      falseVague.map((row) => [
        row.id,
        row.raw,
        row.emittedCategory,
        row.margin.toFixed(3),
        row.source,
        row.overrideReason,
      ])
    ),
    '',
    '## Abstention distribution',
    '',
    '### By expected category',
    '',
    ...table(
      ['Category', 'Count'],
      [...categoryAbstentions.entries()].sort((left, right) => right[1] - left[1])
    ),
    '',
    '### By evaluation group',
    '',
    ...table(
      ['Group', 'Count'],
      [...groupAbstentions.entries()].sort((left, right) => right[1] - left[1])
    ),
    '',
    '## Override usage',
    '',
    ...table(
      ['Reason', 'Emissions', 'Correct', 'Incorrect'],
      Object.entries(report.overrideUsage).map(([reason, value]) => [
        reason,
        value.total,
        value.correct,
        value.incorrect,
      ])
    ),
    '',
  ];

  await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Analyzed ${wrong.length} wrong concrete emissions.`);
  console.log(`Recorded ${falseVague.length} false concrete vague cases.`);
  console.log(`Recorded ${abstentions.length} unnecessary abstentions.`);
  console.log(`Wrote ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
