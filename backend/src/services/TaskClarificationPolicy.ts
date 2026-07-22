import { createHash } from 'node:crypto';
import { scrubPII } from '../lib/pii-scrubber.js';

const PUBLIC_STREET_ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:st(?:reet)?|ave(?:nue)?|rd|road|blvd|boulevard|dr(?:ive)?|ln|lane|ct|court|way|pl(?:ace)?|pkwy|parkway)\b/giu;
const PUBLIC_GPS_PAIR = /\b-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\b/gu;

function redactPrivateLocation(text: string): string {
  return text.replace(PUBLIC_GPS_PAIR, '[location protected]').replace(PUBLIC_STREET_ADDRESS, '[location protected]');
}

export interface MaterialClarificationRevision {
  summary: string;
  checklist: string[];
  customerTotalCents: number;
  hustlerPayoutCents: number;
  platformMarginCents: number;
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

export function preparePublicClarification(raw: string): { text: string; hash: string } {
  const normalized = normalizedText(raw);
  if (!normalized || normalized.length > 500) {
    throw new Error('A task-specific question between 1 and 500 characters is required.');
  }
  const locationSafe = redactPrivateLocation(normalized);
  const text = normalizedText(scrubPII(locationSafe, { names: false, userIds: false }));
  if (!text) throw new Error('The question had no public-safe task detail.');
  return { text, hash: createHash('sha256').update(text).digest('hex') };
}

function validatedChecklist(items: string[]): string[] {
  const checklist = items.map(normalizedText).filter(Boolean);
  if (checklist.length < 1 || checklist.length > 12 || checklist.some((item) => item.length > 200)) {
    throw new Error('A material revision requires 1 to 12 bounded checklist items.');
  }
  if (new Set(checklist.map((item) => item.toLocaleLowerCase())).size !== checklist.length) {
    throw new Error('Material revision checklist items must be unique.');
  }
  return checklist;
}

function assertRevisionEconomics(input: MaterialClarificationRevision): void {
  const { customerTotalCents, hustlerPayoutCents, platformMarginCents } = input;
  const amounts = [customerTotalCents, hustlerPayoutCents, platformMarginCents];
  if (!amounts.every(Number.isInteger)
      || customerTotalCents <= 0 || hustlerPayoutCents <= 0 || platformMarginCents < 0) {
    throw new Error('Material revision economics must be positive integer cents.');
  }
  if (hustlerPayoutCents + platformMarginCents !== customerTotalCents) {
    throw new Error('Material revision economics must reconcile exactly.');
  }
}

export function buildMaterialClarificationRevision(
  input: MaterialClarificationRevision,
): MaterialClarificationRevision {
  const summary = normalizedText(input.summary);
  if (!summary || summary.length > 1000) throw new Error('A material scope summary is required.');
  const checklist = validatedChecklist(input.checklist);
  assertRevisionEconomics(input);
  const { customerTotalCents, hustlerPayoutCents, platformMarginCents } = input;
  return {
    summary: redactPrivateLocation(summary),
    checklist: checklist.map(redactPrivateLocation),
    customerTotalCents,
    hustlerPayoutCents,
    platformMarginCents,
  };
}
