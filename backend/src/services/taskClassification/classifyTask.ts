import { classifyEmbeddedTask } from './embeddedClassifier.js';
import {
  extractExplicitPrimaryTaskClause,
  getExplicitlyExcludedCategories,
  hasExplicitDeliveryTransportSemantics,
  hasEventServiceSemantics,
  isGenericAssistanceOnlyRequest,
} from './classificationContext.js';
import { findClassificationOverride } from './overrides.js';
import { getTaskClassifierModel } from './modelLoader.js';
import type { ServiceTaskCategory, TaskClassificationResult } from './types.js';
const CATEGORY_CHANGING_OVERRIDE_REASONS = new Set([
  'explicit_assembly_action',
  'explicit_bring_task_object',
  'explicit_ceiling_fan_service',
  'explicit_cleaning_request',
  'explicit_electrical_request',
  'explicit_direct_electrical_work',
  'explicit_handyman_hardware_work',
  'explicit_internal_relocation',
  'explicit_patch_and_paint',
  'explicit_direct_plumbing_work',
  'explicit_event_context',
  'explicit_pickup_delivery',
  'explicit_screen_door_repair',
  'explicit_pet_care_action',
  'explicit_wall_mounting_request',
]);
const LOW_MARGIN_CONFIDENCE_OVERRIDE_REASONS = new Set([
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
const MINIMUM_CONFIDENCE_BOOST_MARGIN = 0.3;
const EXCLUDED_TOP_FALLBACK_REASONS = new Set([
  'explicit_cleaning_request',
  'explicit_handyman_surface_repair',
  'explicit_home_damage_assessment',
  'explicit_leading_household_move',
]);
function inferSecondaryIntents(raw: string, primary: ServiceTaskCategory): ServiceTaskCategory[] {
  const text = raw.toLowerCase();
  const secondary = new Set<ServiceTaskCategory>();
  if (primary !== 'assembly' && /\\b(?:assemble|put\\b(?:\\s+\\w+){0,3}\\s+together)\\b/.test(text))
    secondary.add('assembly');
  if (
    primary !== 'assembly' &&
    /\b(?:mount|anchor|attach)\b[^.!?]{0,40}\b(?:tv|television|mirror|shelf|shelves|cabinet)\b/i.test(
      text
    )
  )
    secondary.add('assembly');
  if (primary !== 'handyman' && /\\b(mount|install|attach|repair|fix)\\b/.test(text))
    secondary.add('handyman');
  if (primary !== 'cleaning' && /\\b(clean|cleanup|clean up|wash|scrub|vacuum)\\b/.test(text))
    secondary.add('cleaning');
  if (primary !== 'moving' && /\\b(move|carry|load|unload)\\b/.test(text)) secondary.add('moving');
  return [...secondary];
}
export const inferSecondaryIntentsForTest = inferSecondaryIntents;
export async function classifyTask(raw: string): Promise<TaskClassificationResult> {
  const text = raw.trim();
  if (!text)
    return {
      category: null,
      primaryCategory: null,
      secondaryIntents: [],
      needsClarification: true,
      margin: 0,
      threshold: 0,
      source: 'ml',
      candidates: [],
    };
  const [model, rawClassification] = await Promise.all([
    getTaskClassifierModel(),
    classifyEmbeddedTask(text),
  ]);
  if (isGenericAssistanceOnlyRequest(text))
    return {
      category: null,
      primaryCategory: null,
      secondaryIntents: [],
      needsClarification: true,
      margin: rawClassification.margin,
      threshold: model.ambiguity_threshold,
      source: 'ml',
      candidates: rawClassification.candidates,
    };
  const primaryClause = extractExplicitPrimaryTaskClause(text);
  const primaryOverride = primaryClause
    ? findClassificationOverride(primaryClause, rawClassification)
    : null;
  const override =
    primaryOverride ?? findClassificationOverride(text, rawClassification);
  const isExplicitPrimaryOverride = primaryOverride !== null;
  const excludedCategories = getExplicitlyExcludedCategories(text);
  const agreesWithModel = override?.category === rawClassification.category;
  const replacesExplicitlyExcludedTop =
    override !== null &&
    excludedCategories.has(rawClassification.category) &&
    !excludedCategories.has(override.category) &&
    EXCLUDED_TOP_FALLBACK_REASONS.has(override.reason);
  if (
    override &&
    (isExplicitPrimaryOverride ||
      CATEGORY_CHANGING_OVERRIDE_REASONS.has(override.reason) ||
      replacesExplicitlyExcludedTop ||
      (agreesWithModel &&
        (rawClassification.margin >= MINIMUM_CONFIDENCE_BOOST_MARGIN ||
          LOW_MARGIN_CONFIDENCE_OVERRIDE_REASONS.has(override.reason))))
  )
    return {
      category: override.category,
      primaryCategory: override.category,
      secondaryIntents: [
        ...new Set([
          ...override.secondaryIntents,
          ...inferSecondaryIntents(text, override.category),
        ]),
      ],
      needsClarification: false,
      margin: rawClassification.margin,
      threshold: model.ambiguity_threshold,
      source: 'override',
      candidates: rawClassification.candidates,
      overrideReason: override.reason,
    };
  const hasEventSemantics = hasEventServiceSemantics(text);
  if (rawClassification.category === 'events' && !hasEventSemantics)
    return {
      category: null,
      primaryCategory: null,
      secondaryIntents: [],
      needsClarification: true,
      margin: rawClassification.margin,
      threshold: model.ambiguity_threshold,
      source: 'ml',
      candidates: rawClassification.candidates,
    };
  if (excludedCategories.has(rawClassification.category))
    return {
      category: null,
      primaryCategory: null,
      secondaryIntents: [],
      needsClarification: true,
      margin: rawClassification.margin,
      threshold: model.ambiguity_threshold,
      source: 'ml',
      candidates: rawClassification.candidates,
    };
  if (
    rawClassification.category === 'delivery' &&
    !hasExplicitDeliveryTransportSemantics(text)
  )
    return {
      category: null,
      primaryCategory: null,
      secondaryIntents: [],
      needsClarification: true,
      margin: rawClassification.margin,
      threshold: model.ambiguity_threshold,
      source: 'ml',
      candidates: rawClassification.candidates,
    };
  const needsClarification = rawClassification.margin < model.ambiguity_threshold;
  if (needsClarification)
    return {
      category: null,
      primaryCategory: null,
      secondaryIntents: [],
      needsClarification: true,
      margin: rawClassification.margin,
      threshold: model.ambiguity_threshold,
      source: 'ml',
      candidates: rawClassification.candidates,
    };
  return {
    category: rawClassification.category,
    primaryCategory: rawClassification.category,
    secondaryIntents: inferSecondaryIntents(text, rawClassification.category),
    needsClarification: false,
    margin: rawClassification.margin,
    threshold: model.ambiguity_threshold,
    source: 'ml',
    candidates: rawClassification.candidates,
  };
}
