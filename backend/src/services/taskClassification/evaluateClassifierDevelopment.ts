import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { classifierDevelopmentCases } from './classifierDevelopmentCases.js';
import { classifyTask } from './classifyTask.js';
import {
  getExplicitlyExcludedCategories,
  hasExplicitDeliveryTransportSemantics,
  hasEventServiceSemantics,
} from './classificationContext.js';
import { classifyEmbeddedTask } from './embeddedClassifier.js';
import { getTaskClassifierModel } from './modelLoader.js';
import { findClassificationOverride } from './overrides.js';
import type { RawTaskClassification, ServiceTaskCategory } from './types.js';

const THRESHOLDS = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8] as const;
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
const HIGH_RISK_OVERRIDE_REASONS = new Set([
  'explicit_electrical_request',
  'explicit_household_moving_request',
  'explicit_painting_request',
  'explicit_plumbing_request',
  'explicit_yard_debris_work',
]);

interface ScoredCase {
  group: string;
  input: string;
  expectedCategory: ServiceTaskCategory | null;
  raw: RawTaskClassification;
  overrideCategory: ServiceTaskCategory | null;
  overrideReason: string | null;
}

interface Metrics {
  total: number;
  concreteTotal: number;
  vagueTotal: number;
  correctEmitted: number;
  incorrectEmitted: number;
  unnecessaryAbstentions: number;
  correctAbstentions: number;
  falseConcreteOnVague: number;
  concreteAccuracy: number;
  emittedPrecision: number;
  emissionRate: number;
  abstentionRate: number;
}

interface ResolutionOptions {
  useOverrides?: boolean;
  excludedOverrideReasons?: ReadonlySet<string>;
  categoryThresholds?: Partial<Record<ServiceTaskCategory, number>>;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function resolveCategory(
  scored: ScoredCase,
  threshold: number,
  options: ResolutionOptions = {}
): ServiceTaskCategory | null {
  const hasConcreteTaskSignal =
    /\b(?:assemble|bartend|bring|build|carry|clean|collect|coordinate|courier|decorate|deliver|drop off|feed|fetch|fix|install|inspect|lift|mend|mount|move|paint|patch|pick up|pickup|repaint|repair|replace|retrieve|scrub|serve|service|setup|shift|transport|vacuum|walk|wash|yard|lawn|dog|cat|sink|toilet|faucet|outlet|switch|breaker|ceiling fan|roof|chimney|car|vehicle|plumbing|electrical|party|wedding|event|reception|celebration|gala|banquet|gathering|guests?|attendees?)\b/i.test(
      scored.input
    );
  if (
    /\b(?:someone|somebody|person|worker|help|assistance|something|task|job)\b/i.test(
      scored.input
    ) &&
    !hasConcreteTaskSignal
  )
    return null;

  const useOverrides = options.useOverrides ?? true;
  const excludedCategories = getExplicitlyExcludedCategories(scored.input);
  const replacesExplicitlyExcludedTop =
    scored.overrideCategory !== null &&
    scored.overrideReason !== null &&
    excludedCategories.has(scored.raw.category) &&
    !excludedCategories.has(scored.overrideCategory) &&
    EXCLUDED_TOP_FALLBACK_REASONS.has(scored.overrideReason);
  if (
    useOverrides &&
    scored.overrideCategory &&
    scored.overrideReason &&
    (CATEGORY_CHANGING_OVERRIDE_REASONS.has(scored.overrideReason) ||
      replacesExplicitlyExcludedTop ||
      (scored.overrideCategory === scored.raw.category &&
        (scored.raw.margin >= MINIMUM_CONFIDENCE_BOOST_MARGIN ||
          LOW_MARGIN_CONFIDENCE_OVERRIDE_REASONS.has(scored.overrideReason)))) &&
    !options.excludedOverrideReasons?.has(scored.overrideReason)
  ) {
    return scored.overrideCategory;
  }

  if (scored.raw.category === 'events' && !hasEventServiceSemantics(scored.input)) return null;

  if (excludedCategories.has(scored.raw.category)) return null;
  if (
    scored.raw.category === 'delivery' &&
    !hasExplicitDeliveryTransportSemantics(scored.input)
  )
    return null;

  const effectiveThreshold = options.categoryThresholds?.[scored.raw.category] ?? threshold;
  return scored.raw.margin >= effectiveThreshold ? scored.raw.category : null;
}

function calculateMetrics(
  cases: readonly ScoredCase[],
  threshold: number,
  options: ResolutionOptions = {}
): Metrics {
  let correctEmitted = 0;
  let incorrectEmitted = 0;
  let unnecessaryAbstentions = 0;
  let correctAbstentions = 0;
  let falseConcreteOnVague = 0;

  for (const testCase of cases) {
    const actual = resolveCategory(testCase, threshold, options);
    if (testCase.expectedCategory === null) {
      if (actual === null) correctAbstentions += 1;
      else falseConcreteOnVague += 1;
    } else if (actual === testCase.expectedCategory) {
      correctEmitted += 1;
    } else if (actual === null) {
      unnecessaryAbstentions += 1;
    } else {
      incorrectEmitted += 1;
    }
  }

  const concreteTotal = cases.filter((testCase) => testCase.expectedCategory !== null).length;
  const vagueTotal = cases.length - concreteTotal;
  const emittedTotal = correctEmitted + incorrectEmitted + falseConcreteOnVague;
  const abstentionTotal = unnecessaryAbstentions + correctAbstentions;
  return {
    total: cases.length,
    concreteTotal,
    vagueTotal,
    correctEmitted,
    incorrectEmitted,
    unnecessaryAbstentions,
    correctAbstentions,
    falseConcreteOnVague,
    concreteAccuracy: concreteTotal === 0 ? 0 : correctEmitted / concreteTotal,
    emittedPrecision: emittedTotal === 0 ? 0 : correctEmitted / emittedTotal,
    emissionRate: emittedTotal / cases.length,
    abstentionRate: abstentionTotal / cases.length,
  };
}

function printMetrics(label: string, metrics: Metrics): void {
  console.log(
    [
      label.padEnd(24),
      percentage(metrics.emittedPrecision).padStart(9),
      percentage(metrics.emissionRate).padStart(9),
      percentage(metrics.concreteAccuracy).padStart(9),
      String(metrics.incorrectEmitted).padStart(7),
      String(metrics.unnecessaryAbstentions).padStart(8),
      String(metrics.falseConcreteOnVague).padStart(8),
    ].join(' ')
  );
}

function quantile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction));
  return sorted[index] ?? null;
}

function formatMargin(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

async function scoreCases(): Promise<ScoredCase[]> {
  const scored: ScoredCase[] = [];
  for (const [index, testCase] of classifierDevelopmentCases.entries()) {
    const raw = await classifyEmbeddedTask(testCase.input);
    const override = findClassificationOverride(testCase.input, raw);
    scored.push({
      ...testCase,
      raw,
      overrideCategory: override?.category ?? null,
      overrideReason: override?.reason ?? null,
    });
    if ((index + 1) % 25 === 0 || index + 1 === classifierDevelopmentCases.length) {
      console.log(`Scored ${index + 1}/${classifierDevelopmentCases.length}`);
    }
  }
  return scored;
}

function printThresholdSweep(scored: readonly ScoredCase[]): void {
  console.log('\n=== Global threshold sweep (production overrides enabled) ===');
  console.log('threshold'.padEnd(24) + ' precision emission  accuracy   wrong abstain false-vague');
  for (const threshold of THRESHOLDS) {
    printMetrics(threshold.toFixed(2), calculateMetrics(scored, threshold));
  }

  console.log('\n=== Global threshold sweep (statistical model only) ===');
  console.log('threshold'.padEnd(24) + ' precision emission  accuracy   wrong abstain false-vague');
  for (const threshold of THRESHOLDS) {
    printMetrics(
      threshold.toFixed(2),
      calculateMetrics(scored, threshold, { useOverrides: false })
    );
  }
}

function printGroupMetrics(scored: readonly ScoredCase[], threshold: number): void {
  console.log(`\n=== Development groups at ${threshold.toFixed(2)} ===`);
  console.log('group'.padEnd(24) + ' precision emission  accuracy   wrong abstain false-vague');
  const groups = [...new Set(scored.map((testCase) => testCase.group))].sort();
  for (const group of groups) {
    printMetrics(
      group,
      calculateMetrics(
        scored.filter((testCase) => testCase.group === group),
        threshold
      )
    );
  }
}

function printPerCategoryMargins(scored: readonly ScoredCase[]): void {
  console.log('\n=== Raw model margin distributions by expected category ===');
  console.log('category'.padEnd(18) + ' n correct p10   p50   p90 wrong-p50 raw-recall');
  const categories = [
    ...new Set(
      scored
        .map((testCase) => testCase.expectedCategory)
        .filter((category): category is ServiceTaskCategory => category !== null)
    ),
  ].sort();
  for (const category of categories) {
    const cases = scored.filter((testCase) => testCase.expectedCategory === category);
    const correct = cases.filter((testCase) => testCase.raw.category === category);
    const wrong = cases.filter((testCase) => testCase.raw.category !== category);
    const correctMargins = correct.map((testCase) => testCase.raw.margin);
    const wrongMargins = wrong.map((testCase) => testCase.raw.margin);
    console.log(
      category.padEnd(18) +
        `${String(cases.length).padStart(2)} ${String(correct.length).padStart(7)} ` +
        `${formatMargin(quantile(correctMargins, 0.1)).padStart(5)} ` +
        `${formatMargin(quantile(correctMargins, 0.5)).padStart(5)} ` +
        `${formatMargin(quantile(correctMargins, 0.9)).padStart(5)} ` +
        `${formatMargin(quantile(wrongMargins, 0.5)).padStart(9)} ` +
        percentage(correct.length / cases.length).padStart(10)
    );
  }
}

function printOverrideAudit(scored: readonly ScoredCase[], threshold: number): void {
  console.log(`\n=== Override audit at ${threshold.toFixed(2)} ===`);
  const reasons = [
    ...new Set(
      scored
        .map((testCase) => testCase.overrideReason)
        .filter((reason): reason is string => reason !== null)
    ),
  ].sort();
  console.log('reason'.padEnd(40) + ' hits correct wrong rescued harmed redundant');
  for (const reason of reasons) {
    const cases = scored.filter((testCase) => testCase.overrideReason === reason);
    let correct = 0;
    let wrong = 0;
    let rescued = 0;
    let harmed = 0;
    let redundant = 0;
    for (const testCase of cases) {
      const withOverride = resolveCategory(testCase, threshold);
      const withoutOverride = resolveCategory(testCase, threshold, {
        excludedOverrideReasons: new Set([reason]),
      });
      if (withOverride === testCase.expectedCategory) correct += 1;
      else wrong += 1;
      if (
        withOverride === testCase.expectedCategory &&
        withoutOverride !== testCase.expectedCategory
      )
        rescued += 1;
      else if (
        withOverride !== testCase.expectedCategory &&
        withoutOverride === testCase.expectedCategory
      )
        harmed += 1;
      else if (
        withOverride === testCase.expectedCategory &&
        withoutOverride === testCase.expectedCategory
      )
        redundant += 1;
    }
    console.log(
      reason.padEnd(40) +
        `${String(cases.length).padStart(4)} ${String(correct).padStart(7)} ${String(wrong).padStart(5)} ` +
        `${String(rescued).padStart(7)} ${String(harmed).padStart(6)} ${String(redundant).padStart(9)}`
    );
  }

  console.log('\nOverride-removal simulations:');
  console.log('variant'.padEnd(24) + ' precision emission  accuracy   wrong abstain false-vague');
  printMetrics('all overrides', calculateMetrics(scored, threshold));
  printMetrics(
    'no overrides',
    calculateMetrics(scored, threshold, {
      useOverrides: false,
    })
  );
  for (const reason of reasons) {
    printMetrics(
      `without ${reason}`,
      calculateMetrics(scored, threshold, {
        excludedOverrideReasons: new Set([reason]),
      })
    );
  }

  console.log('\nHigh-risk override removal threshold sweep:');
  console.log('threshold'.padEnd(24) + ' precision emission  accuracy   wrong abstain false-vague');
  for (const candidateThreshold of THRESHOLDS) {
    printMetrics(
      candidateThreshold.toFixed(2),
      calculateMetrics(scored, candidateThreshold, {
        excludedOverrideReasons: HIGH_RISK_OVERRIDE_REASONS,
      })
    );
  }
}

function printCategoryThresholdSearch(scored: readonly ScoredCase[], baseThreshold: number): void {
  console.log(`\n=== Single-category threshold simulations (base ${baseThreshold.toFixed(2)}) ===`);
  console.log('variant'.padEnd(24) + ' precision emission  accuracy   wrong abstain false-vague');
  printMetrics('global baseline', calculateMetrics(scored, baseThreshold));
  const categories = [...new Set(scored.map((testCase) => testCase.raw.category))].sort();
  for (const category of categories) {
    for (const threshold of [0.45, 0.55, 0.6, 0.65, 0.7]) {
      printMetrics(
        `${category}@${threshold.toFixed(2)}`,
        calculateMetrics(scored, baseThreshold, {
          categoryThresholds: { [category]: threshold },
        })
      );
    }
  }
}

function printFailures(scored: readonly ScoredCase[], threshold: number): void {
  console.log(`\n=== Remaining cases at ${threshold.toFixed(2)} ===`);
  for (const testCase of scored) {
    const actual = resolveCategory(testCase, threshold);
    if (actual === testCase.expectedCategory) continue;
    console.log(
      `${testCase.group}: ${JSON.stringify(testCase.input)} expected=${testCase.expectedCategory ?? 'abstain'} ` +
        `actual=${actual ?? 'abstain'} raw=${testCase.raw.category}/${testCase.raw.secondCategory} ` +
        `margin=${testCase.raw.margin.toFixed(4)} override=${testCase.overrideReason ?? 'none'}`
    );
  }
}

async function main(): Promise<void> {
  console.log(`Development cases: ${classifierDevelopmentCases.length}`);
  const model = await getTaskClassifierModel();
  const scored = await scoreCases();
  let productionCorrect = 0;
  let productionWrong = 0;
  let productionAbstained = 0;
  let productionVagueCorrect = 0;
  let productionVagueWrong = 0;
  for (const testCase of classifierDevelopmentCases) {
    const actual = (await classifyTask(testCase.input)).category;
    if (testCase.expectedCategory === null) {
      if (actual === null) productionVagueCorrect += 1;
      else productionVagueWrong += 1;
    } else if (actual === testCase.expectedCategory) productionCorrect += 1;
    else if (actual === null) productionAbstained += 1;
    else productionWrong += 1;
  }
  console.log('\n=== Real production path ===');
  console.log(
    JSON.stringify({
      correct: productionCorrect,
      wrong: productionWrong,
      abstained: productionAbstained,
      vagueCorrect: productionVagueCorrect,
      vagueWrong: productionVagueWrong,
    })
  );
  printThresholdSweep(scored);
  printGroupMetrics(scored, model.ambiguity_threshold);
  printPerCategoryMargins(scored);
  printOverrideAudit(scored, model.ambiguity_threshold);
  printCategoryThresholdSearch(scored, model.ambiguity_threshold);
  printFailures(scored, model.ambiguity_threshold);

  const outputArgument = process.argv.find((argument) => argument.startsWith('--write='));
  if (outputArgument) {
    const outputPath = path.resolve(process.cwd(), outputArgument.slice('--write='.length));
    await writeFile(outputPath, `${JSON.stringify(scored, null, 2)}\n`, 'utf8');
    console.log(`\nWrote scored development cases to ${outputPath}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
