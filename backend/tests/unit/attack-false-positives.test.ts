/**
 * attack-false-positives.test.ts
 *
 * Red-team test suite: false positive hunting for ComplianceGuardianService.
 *
 * For every case:
 *   - Mock DB returns no prior flagged phrases (first occurrence, no repeat).
 *   - Mock AIClient returns isConfigured()=false so we exercise only the heuristic path.
 *   - Assert score < 21 AND tier === 'clean'.
 *
 * Any assertion failure = FALSE POSITIVE = real bug in the detection patterns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ComplianceGuardianService,
} from '../../src/services/ComplianceGuardianService.js';
import {
  isCareContent,
  isContentReleaseRequired,
  CARE_KEYWORDS,
  CONTENT_RELEASE_KEYWORDS,
} from '../../src/services/TaskTemplateRegistry.js';

// ─── Mock DB: no prior phrases, no repeat ────────────────────────────────────
vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn().mockResolvedValue({ rows: [{ was_repeat: false }], rowCount: 1 }),
  },
}));

// ─── Mock AIClient: not configured → heuristic-only path ─────────────────────
vi.mock('../../src/services/AIClient.js', () => ({
  AIClient: {
    isConfigured: vi.fn().mockReturnValue(false),
    callJSON: vi.fn(),
  },
}));

// ─── Mock PII scrubber (passthrough) ─────────────────────────────────────────
vi.mock('../../src/lib/pii-scrubber.js', () => ({
  scrubPII: vi.fn((s: string) => s),
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────
vi.mock('../../src/logger.js', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  aiLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

// ─── Helper ───────────────────────────────────────────────────────────────────

async function evaluate(description: string, templateSlug = 'standard_physical') {
  return ComplianceGuardianService.evaluate({
    description,
    userId: 'test-user-fp',
    templateSlug,
  });
}

function assertClean(
  result: Awaited<ReturnType<typeof evaluate>>,
  description: string,
  label: string,
) {
  expect(result.score, `[${label}] score should be < 21 for: "${description}"`).toBeLessThan(21);
  expect(result.tier, `[${label}] tier should be 'clean' for: "${description}"`).toBe('clean');
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('False Positive Hunting — ComplianceGuardianService.evaluate()', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── CARE KEYWORD FALSE POSITIVES ────────────────────────────────────────────

  describe('Care keyword false positives', () => {
    it('Case 01 — bathtub cleaning: bathe root word with word boundary should NOT trigger', async () => {
      const desc = 'Help me deep clean my bathroom including the bathtub and shower';
      const result = await evaluate(desc, 'in_home');
      // isCareContent() check — bathtub does NOT contain \bbathe\b
      expect(isCareContent(desc)).toBe(false);
      assertClean(result, desc, 'C01');
    });

    it('Case 02 — wash my car: wash keyword, but no compliance score impact', async () => {
      const desc = 'I need someone to wash my car and clean the interior';
      const result = await evaluate(desc, 'standard_physical');
      // isCareContent() WILL match \bwash\b — this is a metadata false positive
      // but evaluate() score should still be 0 (wash is not in SOFT_FLAG_PATTERNS)
      assertClean(result, desc, 'C02');
    });

    it('Case 03 — elder sister: elder as age descriptor, not caregiving', async () => {
      const desc = "Move and assemble my elder sister's furniture in her new apartment";
      const result = await evaluate(desc, 'standard_physical');
      // isCareContent() matches \belder\b — metadata FP — but score stays 0
      assertClean(result, desc, 'C03');
    });

    it('Case 04 — dog walking: should NOT trigger pet-sit care flag', async () => {
      const desc = 'Dog walking service for my golden retriever — 1 hour per day';
      const result = await evaluate(desc, 'care');
      // "dog walking" / "dog walk" — CARE_KEYWORDS has "dog sit|dogsit" but NOT "dog walk"
      assertClean(result, desc, 'C04');
    });

    it('Case 05 — window washing: wash keyword, legitimate cleaning service', async () => {
      const desc = 'Wash my windows inside and out, 3-story house';
      const result = await evaluate(desc, 'in_home');
      // \bwash\b matches isCareContent() — metadata FP — score stays 0
      assertClean(result, desc, 'C05');
    });

    it('Case 06 — babysit objects: babysit applied to inanimate objects', async () => {
      const desc = "Babysit my collection of vintage baby dolls while I'm moving — they need careful packing";
      const result = await evaluate(desc, 'standard_physical');
      // \bbabysit\b matches isCareContent() — metadata FP — score stays 0
      // No SOFT_FLAG_PATTERNS match (no overnight, no isolation, etc.)
      assertClean(result, desc, 'C06');
    });

    it('Case 07 — bathe and groom my dog: pet grooming, not human care', async () => {
      const desc = 'Help me bathe and groom my dog before his vet visit';
      const result = await evaluate(desc, 'care');
      // \bbathe\b matches isCareContent() — expected, legitimate pet care
      // No SOFT_FLAG_PATTERNS for basic pet grooming
      assertClean(result, desc, 'C07');
    });

    it('Case 08 — wheelchair as object for garage sale: not patient transport', async () => {
      const desc = 'Move furniture including a wheelchair for my garage sale';
      const result = await evaluate(desc, 'standard_physical');
      // \bwheelchair\b matches isCareContent() — metadata FP — score stays 0
      assertClean(result, desc, 'C08');
    });

    it('Case 09 — elderly as descriptor: transcription task, not personal care', async () => {
      const desc = "Transcribe my elderly neighbor's life story interview";
      const result = await evaluate(desc, 'standard_physical');
      // \belderly\b matches isCareContent() — metadata FP — score stays 0
      assertClean(result, desc, 'C09');
    });

    it("Case 10 — grandfather's antique furniture: no care keywords", async () => {
      const desc = "Help me move my grandfather's antique furniture";
      const result = await evaluate(desc, 'standard_physical');
      expect(isCareContent(desc)).toBe(false);
      assertClean(result, desc, 'C10');
    });
  });

  // ── CONTENT RELEASE KEYWORD FALSE POSITIVES ─────────────────────────────────

  describe('Content release keyword false positives', () => {
    it('Case 11 — film my cat: filming an animal, operator not subject', async () => {
      const desc = "I need someone to film my cat doing tricks for a competition submission";
      const result = await evaluate(desc, 'standard_physical');
      // isContentReleaseRequired() will match \bfilm\b — metadata flag
      // No SOFT_FLAG_PATTERNS triggered → score stays 0
      assertClean(result, desc, 'C11');
    });

    it('Case 12 — podcast recording equipment operator: not appearing on camera', async () => {
      const desc = 'Help me record my podcast episode — you will run the recording equipment';
      const result = await evaluate(desc, 'standard_physical');
      // isContentReleaseRequired() matches \brecord\b and \brecording\b
      // score stays 0 — content release is metadata, not a compliance score
      assertClean(result, desc, 'C12');
    });

    it('Case 13 — real estate photography camera assistant: professional context', async () => {
      const desc = 'I need a camera assistant for my real estate photography shoot';
      const result = await evaluate(desc, 'creative_production');
      // isContentReleaseRequired() matches \bcamera\b
      assertClean(result, desc, 'C13');
    });

    it('Case 14 — move camera equipment to studio: camera as object being moved', async () => {
      const desc = 'Move my camera equipment to my studio';
      const result = await evaluate(desc, 'standard_physical');
      // isContentReleaseRequired() matches \bcamera\b — metadata FP
      assertClean(result, desc, 'C14');
    });

    it('Case 15 — edit YouTube video in post-production: editing only, not on camera', async () => {
      const desc = 'Help me edit my YouTube video in post-production';
      const result = await evaluate(desc, 'standard_physical');
      // isContentReleaseRequired() matches \bvideo\b and \byoutube\b
      assertClean(result, desc, 'C15');
    });

    it('Case 16 — OBS streaming setup test: technical work, no human appearance', async () => {
      const desc = 'I need someone to stream my gaming setup to test my OBS configuration';
      const result = await evaluate(desc, 'standard_physical');
      // isContentReleaseRequired() matches \bstream\b
      assertClean(result, desc, 'C16');
    });

    it('Case 17 — deliver camera bag to repair shop: camera in delivery context', async () => {
      const desc = 'Deliver my camera bag to the repair shop';
      const result = await evaluate(desc, 'standard_physical');
      // isContentReleaseRequired() matches \bcamera\b — metadata FP
      assertClean(result, desc, 'C17');
    });

    it('Case 18 — film dog obedience training for trainer records: filming animal', async () => {
      const desc = "Film my dog's obedience training for my trainer's records";
      const result = await evaluate(desc, 'standard_physical');
      // isContentReleaseRequired() matches \bfilm\b
      assertClean(result, desc, 'C18');
    });
  });

  // ── AUTHORITY/PROFESSIONAL IMPERSONATION FALSE POSITIVES ────────────────────

  describe('Authority and professional impersonation false positives', () => {
    it('Case 19 — zombie for haunted house: pretend without authority target', async () => {
      const desc = 'I need someone to pretend to be a zombie for my Halloween haunted house';
      const result = await evaluate(desc, 'event_appearance');
      // pretend + to be + zombie — zombie not in authority/professional list
      assertClean(result, desc, 'C19');
    });

    it('Case 20 — tour guide for office visitors: act as legitimate professional role', async () => {
      const desc = "Act as a tour guide for my company's office visitors today";
      const result = await evaluate(desc, 'event_appearance');
      // act + as + "tour guide" — tour guide not in authority list
      assertClean(result, desc, 'C20');
    });

    it('Case 21 — pretend to be surprised: mock emotional reaction, not impersonation', async () => {
      const desc = "Pretend to be surprised when I tell you my company news — I'm testing how to deliver it";
      const result = await evaluate(desc, 'wildcard_bizarre');
      // pretend + to be + surprised — "surprised" not in authority/professional list
      assertClean(result, desc, 'C21');
    });

    it('Case 22 — I am a police officer: police as self-descriptor of Poster, not impersonation request', async () => {
      const desc = "I'm a police officer and need help moving my personal furniture";
      const result = await evaluate(desc, 'standard_physical');
      // No pretend/pose/act + police pattern → no authority impersonation match
      assertClean(result, desc, 'C22');
    });

    it('Case 23 — letter to HOA about noise: HOA in legitimate admin context', async () => {
      const desc = 'Help me draft a letter to my HOA about noise complaints';
      const result = await evaluate(desc, 'standard_physical');
      // No pretend/pose/act + HOA → no authority impersonation
      assertClean(result, desc, 'C23');
    });

    it('Case 24 — play job interviewer for practice: consensual educational role-play', async () => {
      const desc = 'Play the role of a job interviewer to help me practice';
      const result = await evaluate(desc, 'wildcard_bizarre');
      // "play" is NOT in (pretend|pose|act|go as) → no professional_role_impersonation
      assertClean(result, desc, 'C24');
    });
  });

  // ── DRUG / LOCKPICK FALSE POSITIVES ─────────────────────────────────────────

  describe('Drug and lockpick false positives', () => {
    it('Case 25 — organize prescription medication cabinet: prescription ≠ controlled substance', async () => {
      const desc = 'Help me organize my prescription medication cabinet — I have many bottles';
      const result = await evaluate(desc, 'in_home');
      // "prescription" is not in HARD_BLOCK_PATTERNS drug regex
      // SOFT_FLAG: controlled_substances pattern only matches "controlled substances|pharmacolog|score some"
      assertClean(result, desc, 'C25');
    });

    it("Case 26 — move locksmith's tool kit: locksmith profession ≠ lockpicking", async () => {
      const desc = "Help me move my locksmith's tool kit to his new shop";
      const result = await evaluate(desc, 'standard_physical');
      // "locksmith" is not in HARD_BLOCK_PATTERNS (only lockpick|pick the lock|break in)
      assertClean(result, desc, 'C26');
    });

    it('Case 27 — hire locksmith to make duplicate keys: legitimate locksmith service', async () => {
      const desc = 'I need a locksmith to make duplicate keys for my apartment';
      const result = await evaluate(desc, 'specialized_licensed');
      assertClean(result, desc, 'C27');
    });

    it('Case 28 — pharmacy tech home study materials: pharmacy as educational context', async () => {
      const desc = 'Help me set up my pharmacy tech home study materials';
      const result = await evaluate(desc, 'in_home');
      // "pharmacy" alone does not match "pharmacolog\w*" (requires "pharmacolog" root)
      assertClean(result, desc, 'C28');
    });

    it('Case 29 — locked storage unit with combination: lock in legitimate context', async () => {
      const desc = "Pick up my locked storage unit items — you'll need the combination I'll provide";
      const result = await evaluate(desc, 'standard_physical');
      // "locked" ≠ "lockpick|pick the lock|break in"
      // "pick up" ≠ "pick the lock"
      assertClean(result, desc, 'C29');
    });

    it('Case 30 — drug counselor moving office furniture: drug as professional title', async () => {
      const desc = "I'm a drug counselor — help me move my office furniture to my new practice";
      const result = await evaluate(desc, 'standard_physical');
      // No buy/sell/score/source verb before "drug" — hard block pattern requires action verb
      assertClean(result, desc, 'C30');
    });
  });

  // ── SEX-WORK CODED LANGUAGE FALSE POSITIVES ──────────────────────────────────

  describe('Sex-work coded language false positives', () => {
    it('Case 31 — professional escort to business gala: escort to carveout in pattern', async () => {
      const desc = 'I need a professional escort to accompany me to a formal business gala';
      const result = await evaluate(desc, 'event_appearance');
      // escort(?!\s*(to|...)) — "escort to" triggers the negative lookahead carveout → no match
      assertClean(result, desc, 'C31');
    });

    it('Case 32 — full service car detailing: full service in automotive context', async () => {
      const desc = 'Full service car detailing — interior and exterior deep clean';
      const result = await evaluate(desc, 'standard_physical');
      // FIXED (v2.9.0): negative lookahead now excludes car|auto|vehicle|detailing|cleaning|...
      // "full service car" → lookahead sees "car" → no match → score=0, TRUE NEGATIVE
      assertClean(result, desc, 'C32');
    });

    it('Case 33 — full-service wardrobe consultation: full service in retail context', async () => {
      const desc = 'I need a personal shopper for a full-service wardrobe consultation';
      const result = await evaluate(desc, 'standard_physical');
      // FIXED (v2.9.0): "full-service" normalizes to "full service"; lookahead excludes "wardrobe"
      // → no match → score=0, TRUE NEGATIVE
      assertClean(result, desc, 'C33');
    });

    it('Case 34 — escort my elderly mother to the doctor: escort as accompaniment verb', async () => {
      const desc = "Escort my elderly mother to her doctor's appointment and back";
      const result = await evaluate(desc, 'standard_physical');
      // FIXED (v2.9.0): escort negative lookahead expanded to include "my" possessive
      // "Escort my" → lookahead sees "my" → no match → score=0, TRUE NEGATIVE
      assertClean(result, desc, 'C34');
    });

    it('Case 35 — massage therapist moving own massage table: professional logistics', async () => {
      const desc = "I'm a massage therapist looking for someone to help me move my massage table";
      const result = await evaluate(desc, 'standard_physical');
      // FIXED (v2.9.0): LICENSE_AFFIRMERS now includes /therapist/i
      // "massage" triggers physical_contact_ambiguous, but "therapist" fires LICENSE_AFFIRMERS suppression
      // → score=0, TRUE NEGATIVE
      assertClean(result, desc, 'C35');
    });
  });

  // ── OVERNIGHT / EXTENDED PRESENCE FALSE POSITIVES ───────────────────────────

  describe('Overnight and extended presence false positives', () => {
    it('Case 36 — live plant watering while away for one week: live = plant, not live-in person', async () => {
      const desc = "Live plant watering service while I'm away for one week";
      const result = await evaluate(desc, 'standard_physical');
      // extended_presence_livein: \b(live|stay|sleep).{0,20}(in|at).{0,20}(house|home|apartment|place|unit)
      // "Live plant watering service while I'm away" — live followed by "plant watering service"
      // No house/home/apartment/place/unit within 20 chars of any (in|at) that follows "live" in 20 chars
      // multi_night_arrangement: "for one week" but no companion|assistant|stay|live follows it
      assertClean(result, desc, 'C36');
    });

    it('Case 37 — water plants and collect mail for two weeks: duration without personal presence', async () => {
      const desc = 'I need someone to water my plants and collect mail for two weeks';
      const result = await evaluate(desc, 'standard_physical');
      // multi_night_arrangement: "for two weeks" but "weeks" not in night|nights list
      // Pattern: for (one|two...) (week|weeks|night|nights) then companion|stay|live within 30 chars
      // No companion/stay/live follows "two weeks"
      assertClean(result, desc, 'C37');
    });

    it('Case 38 — bathroom renovation for two days: duration in home, construction work', async () => {
      const desc = 'Help me renovate my bathroom for two days — tile work and grouting';
      const result = await evaluate(desc, 'in_home');
      // multi_night_arrangement: "for two days" — "days" is not in (week|weeks|night|nights)
      // extended_presence_livein: no live|stay|sleep in description
      assertClean(result, desc, 'C38');
    });

    it('Case 39 — wait for cable installer at apartment: short wait service, not live-in', async () => {
      const desc = 'Stay and wait for the cable installer at my apartment — they said between 12-6pm';
      const result = await evaluate(desc, 'standard_physical');
      // extended_presence_livein: \b(stay).{0,20}(in|at) — "Stay and wait for the cable installer at"
      // "stay" to "at" = 34+ chars, exceeds {0,20} limit → no match
      assertClean(result, desc, 'C39');
    });

    it('Case 40 — watch my house for a few hours: house-sitting, not companion care', async () => {
      const desc = 'Watch my house for a few hours while I am at the hospital with my family';
      const result = await evaluate(desc, 'standard_physical');
      // No live|stay|sleep → no extended_presence_livein
      // "alone.{0,20}(house|home|apartment)": no "alone" in description
      // No overnight, no companion, no multi_night
      assertClean(result, desc, 'C40');
    });
  });

  // ── ADDITIONAL EDGE CASE: isCareContent metadata false positives ─────────────
  // These verify the CARE_KEYWORDS regex correctly identifies metadata false positives
  // where the keyword appears but the task is not a care task. The evaluate() score
  // must still be clean because CARE_KEYWORDS only affects template metadata routing,
  // NOT the heuristic compliance score.

  describe('isCareContent() metadata false positives — score must still be clean', () => {
    it('wash, elder, babysit, wheelchair, elderly all trigger isCareContent but keep score clean', async () => {
      const cases: Array<[string, boolean]> = [
        ['wash my car doors', true],            // \bwash\b
        ['my elder brother', true],             // \belder\b
        ['babysit the plants', true],           // \bbabysit\b
        ['wheelchair in the garage', true],     // \bwheelchair\b
        ['elderly neighbor transcript', true],  // \belderly\b
        ['bathtub scrubbing task', false],      // \bbathe\b — bathtub does NOT contain \bbathe\b
      ];
      for (const [desc, expectedCare] of cases) {
        expect(isCareContent(desc), `isCareContent("${desc}")`).toBe(expectedCare);
        const result = await evaluate(desc, 'standard_physical');
        assertClean(result, desc, `meta-care:${desc.slice(0, 20)}`);
      }
    });
  });

  // ── ADDITIONAL EDGE CASE: isContentReleaseRequired metadata false positives ──

  describe('isContentReleaseRequired() metadata false positives — score must still be clean', () => {
    it('camera, film, record, stream trigger isContentReleaseRequired but keep score clean', async () => {
      const cases: Array<[string, boolean]> = [
        ['move my camera bag', true],            // \bcamera\b
        ['film my pet lizard', true],            // \bfilm\b
        ['record a voice memo', true],           // \brecord\b
        ['stream my gaming session test', true], // \bstream\b
        ['video game setup assembly', true],     // \bvideo\b
      ];
      for (const [desc, expectedContent] of cases) {
        expect(isContentReleaseRequired(desc), `isContentReleaseRequired("${desc}")`).toBe(expectedContent);
        const result = await evaluate(desc, 'standard_physical');
        assertClean(result, desc, `meta-content:${desc.slice(0, 20)}`);
      }
    });
  });
});
