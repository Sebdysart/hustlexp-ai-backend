import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { classifierHardeningCases } from './classifierHardeningCases.js';
import {
  extractExplicitPrimaryTaskClause,
  getExplicitlyExcludedCategories,
  hasConcreteTaskPredicate,
  hasEventServiceSemantics,
  hasExplicitDeliveryTransportSemantics,
  isGenericAssistanceOnlyRequest,
} from './classificationContext.js';
import { classifyEmbeddedTask } from './embeddedClassifier.js';
import { findClassificationOverride } from './overrides.js';
import type { RawTaskClassification, ServiceTaskCategory } from './types.js';

type GenericPolicy = 'legacy' | 'current' | 'none' | 'margin_075' | 'strong_signal';
type OverridePolicy = 'current' | 'none' | 'authoritative' | 'agreement';

interface Experiment {
  number: number;
  name: string;
  hypothesis: string;
  threshold?: number;
  genericPolicy?: GenericPolicy;
  overridePolicy?: OverridePolicy;
  disabledOverrides?: readonly string[];
  primaryClause?: boolean;
}

interface ScoredCase {
  input: string;
  group: string;
  expectedCategory: ServiceTaskCategory | null;
  raw: RawTaskClassification;
  overrideCategory: ServiceTaskCategory | null;
  overrideReason: string | null;
}

const CATEGORY_CHANGING = new Set([
  'explicit_assembly_action',
  'explicit_bring_task_object',
  'explicit_ceiling_fan_service',
  'explicit_cleaning_request',
  'explicit_direct_electrical_work',
  'explicit_electrical_request',
  'explicit_event_context',
  'explicit_direct_electrical_work',
  'explicit_handyman_hardware_work',
  'explicit_internal_relocation',
  'explicit_patch_and_paint',
  'explicit_direct_plumbing_work',
  'explicit_pickup_delivery',
  'explicit_screen_door_repair',
  'explicit_pet_care_action',
  'explicit_wall_mounting_request',
]);
const AUTHORITATIVE = new Set([
  'explicit_ceiling_fan_service',
  'explicit_electrical_request',
  'explicit_internal_relocation',
  'explicit_patch_and_paint',
  'explicit_pickup_delivery',
  'explicit_pet_care_action',
  'explicit_wall_mounting_request',
]);
const LOW_MARGIN = new Set([
  'explicit_automotive_component',
  'explicit_automotive_context',
  'explicit_automotive_symptom',
  'explicit_cleaning_request',
  'explicit_home_damage_assessment',
  'explicit_home_services_domain',
  'explicit_handyman_repair',
  'explicit_handyman_surface_repair',
  'explicit_leading_household_move',
  'explicit_painting_request',
  'explicit_plumbing_request',
  'explicit_yard_maintenance',
]);
const EXCLUDED_FALLBACK = new Set([
  'explicit_cleaning_request',
  'explicit_handyman_surface_repair',
  'explicit_home_damage_assessment',
  'explicit_leading_household_move',
]);
const LEGACY_CONCRETE =
  /\b(?:assemble|bartend|bring|build|carry|clean|collect|coordinate|courier|decorate|deliver|drop off|feed|fetch|fix|install|inspect|lift|mend|mount|move|paint|patch|pick up|pickup|repaint|repair|replace|retrieve|scrub|serve|service|setup|shift|transport|vacuum|walk|wash|yard|lawn|dog|cat|sink|toilet|faucet|outlet|switch|breaker|ceiling fan|roof|chimney|car|vehicle|plumbing|electrical|party|wedding|event|reception|celebration|gala|banquet|gathering|guests?|attendees?)\b/i;
const GENERIC = /\b(?:someone|somebody|person|worker|help|assistance|something|task|job)\b/i;

const experiments: Experiment[] = [
  { number: 1, name: 'legacy-baseline', hypothesis: 'Reproduce the former broad generic guard without priority-clause routing.', genericPolicy: 'legacy', primaryClause: false },
  { number: 2, name: 'current-concrete-predicate', hypothesis: 'Concrete predicates and explicit task priority should bypass generic wrapper wording.', primaryClause: true },
  { number: 3, name: 'generic-guard-disabled', hypothesis: 'Measure the full safety value of the generic guard.', genericPolicy: 'none' },
  { number: 4, name: 'generic-margin-bypass', hypothesis: 'A 0.75 raw margin may safely bypass generic guarding.', genericPolicy: 'margin_075' },
  { number: 5, name: 'generic-strong-signal', hypothesis: 'Category-specific strong signals may safely bypass generic guarding.', genericPolicy: 'strong_signal' },
  { number: 6, name: 'no-handyman-hardware', hypothesis: 'Removing hardware override prevents target hijacking.', disabledOverrides: ['explicit_handyman_hardware_work'] },
  { number: 7, name: 'no-electrical-override', hypothesis: 'Measure dependence on electrical boundary rules.', disabledOverrides: ['explicit_electrical_request'] },
  { number: 8, name: 'no-plumbing-override', hypothesis: 'Measure dependence on plumbing boundary rules.', disabledOverrides: ['explicit_plumbing_request'] },
  { number: 9, name: 'no-wall-mount-override', hypothesis: 'Measure wall-mount assembly dependence.', disabledOverrides: ['explicit_wall_mounting_request'] },
  { number: 10, name: 'no-paint-override', hypothesis: 'Measure explicit painting rule value.', disabledOverrides: ['explicit_painting_request', 'explicit_patch_and_paint'] },
  { number: 11, name: 'all-overrides-disabled', hypothesis: 'Measure raw-model safety and coverage.', overridePolicy: 'none' },
  { number: 12, name: 'authoritative-only', hypothesis: 'A smaller authoritative rule set may preserve safety.', overridePolicy: 'authoritative' },
  { number: 13, name: 'agreement-only', hypothesis: 'Model agreement gating may eliminate rule-caused errors.', overridePolicy: 'agreement' },
  { number: 14, name: 'no-internal-relocation', hypothesis: 'Measure moving boundary rule dependence.', disabledOverrides: ['explicit_internal_relocation'] },
  { number: 15, name: 'no-delivery-boundary', hypothesis: 'Measure delivery transport override dependence.', disabledOverrides: ['explicit_pickup_delivery', 'explicit_bring_task_object'] },
  { number: 16, name: 'no-pet-care-override', hypothesis: 'Measure pet primary-intent override dependence.', disabledOverrides: ['explicit_pet_care_action'] },
  { number: 17, name: 'no-pet-cleaning-override', hypothesis: 'Measure incidental-pet cleaning rule dependence.', disabledOverrides: ['pet_related_cleaning'] },
  { number: 18, name: 'no-home-damage-override', hypothesis: 'Measure home damage assessment rescue value.', disabledOverrides: ['explicit_home_damage_assessment'] },
  { number: 19, name: 'no-home-domain-override', hypothesis: 'Measure home-services domain rescue value.', disabledOverrides: ['explicit_home_services_domain'] },
  { number: 20, name: 'without-primary-clause', hypothesis: 'Ablate first/main task routing to measure secondary-task hijacking.', primaryClause: false },
  { number: 21, name: 'threshold-040', hypothesis: 'Lower threshold may recover safe coverage after semantic guards.', threshold: 0.4 },
  { number: 22, name: 'threshold-045', hypothesis: 'A modest threshold reduction may improve accepted recall.', threshold: 0.45 },
  { number: 23, name: 'threshold-050', hypothesis: 'Production threshold reference.', threshold: 0.5 },
  { number: 24, name: 'threshold-055', hypothesis: 'A higher threshold should trade coverage for precision.', threshold: 0.55 },
  { number: 25, name: 'threshold-060', hypothesis: 'A conservative threshold tests the upper safety bound.', threshold: 0.6 },
  { number: 26, name: 'primary-clause-plus-045', hypothesis: 'Primary intent handling may permit a lower threshold safely.', primaryClause: true, threshold: 0.45 },
  { number: 27, name: 'agreement-plus-045', hypothesis: 'Agreement-only overrides may permit a lower threshold.', overridePolicy: 'agreement', threshold: 0.45 },
  { number: 28, name: 'authoritative-plus-045', hypothesis: 'Authoritative rules plus lower threshold may simplify policy.', overridePolicy: 'authoritative', threshold: 0.45 },
];

function genericBlocked(scored: ScoredCase, experiment: Experiment): boolean {
  const policy = experiment.genericPolicy ?? 'current';
  const text = scored.input;
  if (!GENERIC.test(text)) return false;
  if (policy === 'none') return false;
  if (policy === 'legacy') return !LEGACY_CONCRETE.test(text);
  if (!isGenericAssistanceOnlyRequest(text)) return false;
  if (policy === 'margin_075') return scored.raw.margin < 0.75;
  if (policy === 'strong_signal') {
    const strong =
      hasConcreteTaskPredicate(text) ||
      /\b(?:lawn|yard|outlet|pipe|faucet|ceiling|roof|wall|party|guests?|dog|cat|car|engine)\b/i.test(text);
    return !strong;
  }
  return true;
}

function primaryClauseOverride(scored: ScoredCase) {
  const clause = extractExplicitPrimaryTaskClause(scored.input);
  if (!clause) return null;
  return findClassificationOverride(clause, scored.raw);
}

function acceptsOverride(scored: ScoredCase, experiment: Experiment): boolean {
  if (!scored.overrideCategory || !scored.overrideReason) return false;
  if (experiment.disabledOverrides?.includes(scored.overrideReason)) return false;
  const policy = experiment.overridePolicy ?? 'current';
  if (policy === 'none') return false;
  const agrees = scored.overrideCategory === scored.raw.category;
  if (policy === 'agreement') return agrees && scored.raw.margin >= 0.3;
  if (policy === 'authoritative' && !AUTHORITATIVE.has(scored.overrideReason)) return false;
  const excluded = getExplicitlyExcludedCategories(scored.input);
  const replacement =
    excluded.has(scored.raw.category) &&
    !excluded.has(scored.overrideCategory) &&
    EXCLUDED_FALLBACK.has(scored.overrideReason);
  return (
    CATEGORY_CHANGING.has(scored.overrideReason) ||
    replacement ||
    (agrees && (scored.raw.margin >= 0.3 || LOW_MARGIN.has(scored.overrideReason)))
  );
}

function resolve(scored: ScoredCase, experiment: Experiment): ServiceTaskCategory | null {
  if (genericBlocked(scored, experiment)) return null;
  if (experiment.primaryClause !== false && experiment.overridePolicy !== 'none') {
    const primary = primaryClauseOverride(scored);
    if (
      primary &&
      !experiment.disabledOverrides?.includes(primary.reason) &&
      (experiment.overridePolicy !== 'authoritative' || AUTHORITATIVE.has(primary.reason)) &&
      (experiment.overridePolicy !== 'agreement' || primary.category === scored.raw.category)
    )
      return primary.category;
  }
  if (acceptsOverride(scored, experiment)) return scored.overrideCategory;
  const excluded = getExplicitlyExcludedCategories(scored.input);
  if (scored.raw.category === 'events' && !hasEventServiceSemantics(scored.input)) return null;
  if (excluded.has(scored.raw.category)) return null;
  if (scored.raw.category === 'delivery' && !hasExplicitDeliveryTransportSemantics(scored.input)) return null;
  return scored.raw.margin >= (experiment.threshold ?? 0.5) ? scored.raw.category : null;
}

function metrics(scored: readonly ScoredCase[], experiment: Experiment) {
  let correct = 0;
  let wrong = 0;
  let abstained = 0;
  let vagueCorrect = 0;
  let vagueWrong = 0;
  for (const row of scored) {
    const actual = resolve(row, experiment);
    if (row.expectedCategory === null) {
      if (actual === null) vagueCorrect += 1;
      else vagueWrong += 1;
    } else if (actual === row.expectedCategory) correct += 1;
    else if (actual === null) abstained += 1;
    else wrong += 1;
  }
  const concrete = scored.filter((row) => row.expectedCategory !== null).length;
  const emitted = correct + wrong + vagueWrong;
  return {
    correct,
    wrong,
    abstained,
    vagueCorrect,
    vagueWrong,
    precision: emitted ? correct / emitted : 0,
    coverage: (correct + wrong) / concrete,
    accuracy: correct / concrete,
  };
}

async function main(): Promise<void> {
  const outputPath = path.resolve(
    process.cwd(),
    process.argv[2] ?? 'ml/task_classifier/eval/classifier_hardening.experiments.json'
  );
  const scored: ScoredCase[] = [];
  for (const [index, testCase] of classifierHardeningCases.entries()) {
    const raw = await classifyEmbeddedTask(testCase.input);
    const override = findClassificationOverride(testCase.input, raw);
    scored.push({
      ...testCase,
      raw,
      overrideCategory: override?.category ?? null,
      overrideReason: override?.reason ?? null,
    });
    if ((index + 1) % 250 === 0) console.log(`Scored ${index + 1}/${classifierHardeningCases.length}`);
  }
  const results = experiments.map((experiment) => ({
    experiment,
    metrics: metrics(scored, experiment),
    groups: Object.fromEntries(
      [...new Set(scored.map((row) => row.group))].sort().map((group) => [
        group,
        metrics(scored.filter((row) => row.group === group), experiment),
      ])
    ),
  }));
  await writeFile(outputPath, `${JSON.stringify({ caseCount: scored.length, results }, null, 2)}\n`);
  for (const result of results) {
    const m = result.metrics;
    console.log(
      `${String(result.experiment.number).padStart(2)} ${result.experiment.name.padEnd(29)} ` +
        `correct=${m.correct} wrong=${m.wrong} abstain=${m.abstained} vague-fp=${m.vagueWrong} ` +
        `precision=${(m.precision * 100).toFixed(2)}% coverage=${(m.coverage * 100).toFixed(2)}%`
    );
  }
  console.log(`Wrote ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
