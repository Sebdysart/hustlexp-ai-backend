import { classifyEmbeddedTask } from './embeddedClassifier.js';
import { findClassificationOverride } from './overrides.js';
import { getTaskClassifierModel } from './modelLoader.js';
import type { ServiceTaskCategory, TaskClassificationResult } from './types.js';
function inferSecondaryIntents(raw: string, primary: ServiceTaskCategory): ServiceTaskCategory[] { const text = raw.toLowerCase(); const secondary = new Set<ServiceTaskCategory>(); if (primary !== 'assembly' && /\\b(?:assemble|put\\b(?:\\s+\\w+){0,3}\\s+together)\\b/.test(text)) secondary.add('assembly'); if (primary !== 'assembly' && /\b(?:mount|anchor|attach)\b[^.!?]{0,40}\b(?:tv|television|mirror|shelf|shelves|cabinet)\b/i.test(text)) secondary.add('assembly'); if (primary !== 'handyman' && /\\b(mount|install|attach|repair|fix)\\b/.test(text)) secondary.add('handyman'); if (primary !== 'cleaning' && /\\b(clean|cleanup|clean up|wash|scrub|vacuum)\\b/.test(text)) secondary.add('cleaning'); if (primary !== 'moving' && /\\b(move|carry|load|unload)\\b/.test(text)) secondary.add('moving'); return [...secondary]; }
export const inferSecondaryIntentsForTest = inferSecondaryIntents;
export async function classifyTask(raw: string): Promise<TaskClassificationResult> { const text = raw.trim(); if (!text) return { category: null, primaryCategory: null, secondaryIntents: [], needsClarification: true, margin: 0, threshold: 0, source: 'ml', candidates: [] }; const [model, rawClassification] = await Promise.all([getTaskClassifierModel(), classifyEmbeddedTask(text)]); const override = findClassificationOverride(text, rawClassification); if (override) return { category: override.category, primaryCategory: override.category, secondaryIntents: [...new Set([...override.secondaryIntents, ...inferSecondaryIntents(text, override.category)])], needsClarification: false, margin: rawClassification.margin, threshold: model.ambiguity_threshold, source: 'override', candidates: rawClassification.candidates, overrideReason: override.reason }; const needsClarification = rawClassification.margin < model.ambiguity_threshold; if (needsClarification) return { category: null, primaryCategory: null, secondaryIntents: [], needsClarification: true, margin: rawClassification.margin, threshold: model.ambiguity_threshold, source: 'ml', candidates: rawClassification.candidates }; return { category: rawClassification.category, primaryCategory: rawClassification.category, secondaryIntents: inferSecondaryIntents(text, rawClassification.category), needsClarification: false, margin: rawClassification.margin, threshold: model.ambiguity_threshold, source: 'ml', candidates: rawClassification.candidates }; }














