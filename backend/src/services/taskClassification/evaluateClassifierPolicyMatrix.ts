import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  getExplicitlyExcludedCategories,
  hasExplicitDeliveryTransportSemantics,
  hasEventServiceSemantics,
} from './classificationContext.js';
import { classifyEmbeddedTask } from './embeddedClassifier.js';
import { getTaskClassifierModel } from './modelLoader.js';
import { findClassificationOverride } from './overrides.js';
import type { RawTaskClassification, ServiceTaskCategory } from './types.js';

interface EvaluationCase {
  id: string;
  raw: string;
  expectedCategory: ServiceTaskCategory | null;
  group: string;
}

interface EvaluationDocument {
  cases: EvaluationCase[];
}

interface ScoredCase extends EvaluationCase {
  rawClassification: RawTaskClassification;
  overrideCategory: ServiceTaskCategory | null;
  overrideReason: string | null;
}

interface Policy {
  name: string;
  threshold: number;
  disabledOverrides?: ReadonlySet<string>;
  useOverrides?: boolean;
}

interface Metrics {
  total: number;
  concrete: number;
  vague: number;
  correctEmitted: number;
  incorrectEmitted: number;
  unnecessaryAbstentions: number;
  correctAbstentions: number;
  falseConcreteOnVague: number;
  emittedPrecision: number;
  concreteAccuracy: number;
  concreteCoverage: number;
  overrideCausedErrors: number;
}

const CATEGORY_CHANGING_OVERRIDE_REASONS = new Set([
  'explicit_assembly_action',
  'explicit_bring_task_object',
  'explicit_ceiling_fan_service',
  'explicit_electrical_request',
  'explicit_handyman_hardware_work',
  'explicit_internal_relocation',
  'explicit_patch_and_paint',
  'explicit_pickup_delivery',
  'explicit_screen_door_repair',
  'explicit_pet_care_action',
  'explicit_wall_mounting_request',
]);

const LOW_MARGIN_CONFIDENCE_OVERRIDE_REASONS = new Set([
  'explicit_automotive_component',
  'explicit_cleaning_request',
  'explicit_home_damage_assessment',
  'explicit_home_services_domain',
  'explicit_handyman_repair',
  'explicit_leading_household_move',
  'explicit_painting_request',
  'explicit_plumbing_request',
]);

const MINIMUM_CONFIDENCE_BOOST_MARGIN = 0.3;
const EXCLUDED_TOP_FALLBACK_REASONS = new Set([
  'explicit_cleaning_request',
  'explicit_handyman_surface_repair',
  'explicit_home_damage_assessment',
  'explicit_leading_household_move',
]);

function hasConcreteTaskSignal(text: string): boolean {
  return /\b(?:assemble|bartend|bring|build|carry|clean|collect|coordinate|courier|decorate|deliver|drop off|feed|fetch|fix|install|inspect|lift|mend|mount|move|paint|patch|pick up|pickup|repaint|repair|replace|retrieve|scrub|serve|service|setup|shift|transport|vacuum|walk|wash|yard|lawn|dog|cat|sink|toilet|faucet|outlet|switch|breaker|ceiling fan|roof|chimney|car|vehicle|plumbing|electrical|party|wedding|event|reception|celebration|gala|banquet|gathering|guests?|attendees?)\b/i.test(
    text
  );
}

function resolve(scored: ScoredCase, policy: Policy): ServiceTaskCategory | null {
  const text = scored.raw.trim();
  if (
    /\b(?:someone|somebody|person|worker|help|assistance|something|task|job)\b/i.test(text) &&
    !hasConcreteTaskSignal(text)
  )
    return null;

  const overrideEnabled =
    policy.useOverrides !== false &&
    scored.overrideCategory !== null &&
    scored.overrideReason !== null &&
    !policy.disabledOverrides?.has(scored.overrideReason);
  const agreesWithModel = scored.overrideCategory === scored.rawClassification.category;
  const excludedCategories = getExplicitlyExcludedCategories(text);
  const replacesExplicitlyExcludedTop =
    scored.overrideCategory !== null &&
    scored.overrideReason !== null &&
    excludedCategories.has(scored.rawClassification.category) &&
    !excludedCategories.has(scored.overrideCategory) &&
    EXCLUDED_TOP_FALLBACK_REASONS.has(scored.overrideReason);
  if (
    overrideEnabled &&
    scored.overrideReason &&
    scored.overrideCategory &&
    (CATEGORY_CHANGING_OVERRIDE_REASONS.has(scored.overrideReason) ||
      replacesExplicitlyExcludedTop ||
      (agreesWithModel &&
        (scored.rawClassification.margin >= MINIMUM_CONFIDENCE_BOOST_MARGIN ||
          LOW_MARGIN_CONFIDENCE_OVERRIDE_REASONS.has(scored.overrideReason))))
  )
    return scored.overrideCategory;

  if (scored.rawClassification.category === 'events' && !hasEventServiceSemantics(text)) return null;
  if (excludedCategories.has(scored.rawClassification.category)) return null;
  if (
    scored.rawClassification.category === 'delivery' &&
    !hasExplicitDeliveryTransportSemantics(text)
  )
    return null;
  return scored.rawClassification.margin >= policy.threshold
    ? scored.rawClassification.category
    : null;
}

function calculate(scoredCases: readonly ScoredCase[], policy: Policy): Metrics {
  let correctEmitted = 0;
  let incorrectEmitted = 0;
  let unnecessaryAbstentions = 0;
  let correctAbstentions = 0;
  let falseConcreteOnVague = 0;
  let overrideCausedErrors = 0;

  for (const scored of scoredCases) {
    const emitted = resolve(scored, policy);
    if (scored.expectedCategory === null) {
      if (emitted === null) correctAbstentions += 1;
      else falseConcreteOnVague += 1;
    } else if (emitted === scored.expectedCategory) correctEmitted += 1;
    else if (emitted === null) unnecessaryAbstentions += 1;
    else incorrectEmitted += 1;

    if (
      emitted !== null &&
      emitted !== scored.expectedCategory &&
      scored.overrideReason !== null &&
      emitted === scored.overrideCategory &&
      (scored.rawClassification.category !== emitted ||
        scored.rawClassification.margin < policy.threshold)
    )
      overrideCausedErrors += 1;
  }

  const concrete = scoredCases.filter(({ expectedCategory }) => expectedCategory !== null).length;
  const vague = scoredCases.length - concrete;
  const emitted = correctEmitted + incorrectEmitted + falseConcreteOnVague;
  return {
    total: scoredCases.length,
    concrete,
    vague,
    correctEmitted,
    incorrectEmitted,
    unnecessaryAbstentions,
    correctAbstentions,
    falseConcreteOnVague,
    emittedPrecision: emitted === 0 ? 0 : correctEmitted / emitted,
    concreteAccuracy: correctEmitted / concrete,
    concreteCoverage: (correctEmitted + incorrectEmitted) / concrete,
    overrideCausedErrors,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function print(name: string, metrics: Metrics): void {
  console.log(
    `${name.padEnd(30)} correct=${String(metrics.correctEmitted).padStart(3)} ` +
      `wrong=${String(metrics.incorrectEmitted).padStart(3)} abstain=${String(metrics.unnecessaryAbstentions).padStart(3)} ` +
      `vague-ok=${String(metrics.correctAbstentions).padStart(2)} vague-fp=${metrics.falseConcreteOnVague} ` +
      `precision=${percent(metrics.emittedPrecision)} accuracy=${percent(metrics.concreteAccuracy)} ` +
      `coverage=${percent(metrics.concreteCoverage)} override-errors=${metrics.overrideCausedErrors}`
  );
}

async function main(): Promise<void> {
  const datasetPath = path.resolve(
    process.cwd(),
    process.argv[2] ?? 'ml/task_classifier/eval/blind_holdout_v2_1000.curated.json'
  );
  const outputPath = path.resolve(
    process.cwd(),
    process.argv[3] ?? 'ml/task_classifier/eval/policy_matrix.results.json'
  );
  const document = JSON.parse(await readFile(datasetPath, 'utf8')) as EvaluationDocument;
  const model = await getTaskClassifierModel();
  const scoredCases: ScoredCase[] = [];
  for (const [index, testCase] of document.cases.entries()) {
    const rawClassification = await classifyEmbeddedTask(testCase.raw);
    const override = findClassificationOverride(testCase.raw, rawClassification);
    scoredCases.push({
      ...testCase,
      rawClassification,
      overrideCategory: override?.category ?? null,
      overrideReason: override?.reason ?? null,
    });
    if ((index + 1) % 100 === 0) console.log(`Scored ${index + 1}/${document.cases.length}`);
  }

  const policies: Policy[] = [
    { name: 'production-0.50', threshold: 0.5 },
    {
      name: 'without-bring-override',
      threshold: 0.5,
      disabledOverrides: new Set(['explicit_bring_task_object']),
    },
    {
      name: 'without-pet-cleaning',
      threshold: 0.5,
      disabledOverrides: new Set(['pet_related_cleaning']),
    },
    {
      name: 'without-bring-or-pet-cleaning',
      threshold: 0.5,
      disabledOverrides: new Set(['explicit_bring_task_object', 'pet_related_cleaning']),
    },
    { name: 'model-only-0.50', threshold: 0.5, useOverrides: false },
    ...[0.3, 0.35, 0.4, 0.45, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8].map((threshold) => ({
      name: `production-${threshold.toFixed(2)}`,
      threshold,
    })),
  ];
  const results = policies.map((policy) => ({ policy: policy.name, metrics: calculate(scoredCases, policy) }));
  console.log('\nPolicy matrix');
  for (const result of results) print(result.policy, result.metrics);
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        dataset: datasetPath,
        configuration: {
          trainingExamples: model.training_examples,
          classifier: model.classifier,
          threshold: model.ambiguity_threshold,
        },
        results,
      },
      null,
      2
    )
  );
  console.log(`\nWrote ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
