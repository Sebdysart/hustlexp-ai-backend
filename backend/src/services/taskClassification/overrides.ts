import type { RawTaskClassification, ServiceTaskCategory } from './types.js';
export interface ClassificationOverride { category: ServiceTaskCategory; secondaryIntents: ServiceTaskCategory[]; reason: string; }
function normalize(value: string): string { return value.toLowerCase().replace(/\s+/g, ' ').trim(); }
export function findClassificationOverride(raw: string, _classification: RawTaskClassification): ClassificationOverride | null {
  const text = normalize(raw);
  if (/\b(?:paint|painting|repaint|painter|painted)\b/.test(text) && /\b(?:wall|walls|ceiling|trim|baseboard|door|fence|deck|house|room)\b/.test(text)) return { category: 'painting', secondaryIntents: [], reason: 'explicit_painting_request' };
  if (/\b(?:sink|toilet|shower|bathtub|tub|faucet|tap|pipe|piping|water heater|drain|plumber|plumbing)\b/.test(text) && /\b(?:leak|leaking|clog|clogged|blocked|pressure|water|install|replace|repair|fix|drip)\b/.test(text)) return { category: 'plumbing', secondaryIntents: [], reason: 'explicit_plumbing_request' };
  if (/\b(?:electrical|light|lights|outlet|socket|receptacle|switch|ceiling fan|breaker|panel|doorbell|electrician)\b/.test(text) && /\b(?:install|replace|repair|fix|working|flicker|flickering|trip|tripping|power|wiring|broken|dead)\b/.test(text)) return { category: 'electrical', secondaryIntents: [], reason: 'explicit_electrical_request' };
  if (/\b(pet|dog|cat)\b/.test(text) && /\b(hair|waste|litter|stain|odor|mess)\b/.test(text) && /\b(clean|remove|vacuum|scrub)\b/.test(text)) return { category: 'cleaning', secondaryIntents: [], reason: 'pet_related_cleaning' };
  if (/\b(assemble|assembly|put\b(?:\s+\w+){0,3}\s+together|build)\b/.test(text) && !/\b(pick\s*up|pickup|deliver|delivery|transport|bring\s+(?:it|them|this|that)\s+(?:home|over|to))\b/.test(text)) return { category: 'assembly', secondaryIntents: [], reason: 'explicit_assembly_action' };
  if (/\b(pick\s*up|pickup|collect|deliver|transport)\b/.test(text) && /\b(bring|deliver|transport|to|home|house|property|venue|center)\b/.test(text)) { const secondary: ServiceTaskCategory[] = []; if (/\b(assemble|put\b(?:\s+\w+){0,3}\s+together)\b/.test(text)) secondary.push('assembly'); if (/\b(install|mount|attach)\b/.test(text)) secondary.push('handyman'); return { category: 'delivery', secondaryIntents: secondary, reason: 'explicit_pickup_delivery' }; }
  if (/\b(party|wedding|reception|event|baby shower|corporate event)\b/.test(text) && /\b(set\s*up|setup|tear\s*down|cleanup|clean\s*up|serve|decorate|bartend|buffet|guests)\b/.test(text)) return { category: 'events', secondaryIntents: [], reason: 'explicit_event_context' };
  if (/\b(dog|dogs|cat|cats|puppy|pet|pets|fish|parrot)\b/.test(text) && /\b(walk|feed|watch|sit|look after|check on|medication|vet)\b/.test(text)) return { category: 'pet_care', secondaryIntents: [], reason: 'explicit_pet_care_action' };
  return null;
}
