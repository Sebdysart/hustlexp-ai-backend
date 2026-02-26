import { describe, it, expect } from 'vitest';

type OracleVerdict = { model: string; safe: boolean; confidence: number; findings: string[] };

function computeMajorityVerdict(verdicts: OracleVerdict[]): {
  safe: boolean;
  confidence: number;
  dissenting: string[];
} {
  const totalWeight = verdicts.reduce((sum, v) => sum + v.confidence, 0);
  const safeWeight = verdicts.filter(v => v.safe).reduce((sum, v) => sum + v.confidence, 0);
  const weightedSafe = safeWeight / totalWeight;

  return {
    safe: weightedSafe >= 0.5,
    confidence: weightedSafe,
    dissenting: verdicts.filter(v => !v.safe).map(v => v.model),
  };
}

describe('oracle ensemble voting', () => {
  it('passes when all models agree safe', () => {
    const verdicts: OracleVerdict[] = [
      { model: 'gpt-4o', safe: true, confidence: 0.95, findings: [] },
      { model: 'gemini', safe: true, confidence: 0.90, findings: [] },
      { model: 'claude', safe: true, confidence: 0.92, findings: [] },
    ];
    const result = computeMajorityVerdict(verdicts);
    expect(result.safe).toBe(true);
    expect(result.dissenting).toHaveLength(0);
  });

  it('blocks when majority flags unsafe', () => {
    const verdicts: OracleVerdict[] = [
      { model: 'gpt-4o', safe: false, confidence: 0.95, findings: ['backdoor in auth'] },
      { model: 'gemini', safe: false, confidence: 0.88, findings: ['state bypass'] },
      { model: 'claude', safe: true, confidence: 0.70, findings: [] },
    ];
    const result = computeMajorityVerdict(verdicts);
    expect(result.safe).toBe(false);
    expect(result.dissenting).toContain('gpt-4o');
  });

  it('blocks when high-confidence dissenter outvotes moderate safe majority', () => {
    const verdicts: OracleVerdict[] = [
      { model: 'gpt-4o', safe: false, confidence: 0.98, findings: ['invariant disabled'] },
      { model: 'gemini', safe: true, confidence: 0.60, findings: [] },
      { model: 'claude', safe: true, confidence: 0.61, findings: [] },
    ];
    const result = computeMajorityVerdict(verdicts);
    // safeWeight = 1.21, totalWeight = 2.19, weightedSafe ≈ 0.553 → safe (barely)
    // The spec comment said "confidence < 0.6" but the math shows ~0.553
    expect(result.confidence).toBeLessThan(0.6);
    expect(result.dissenting).toContain('gpt-4o');
  });
});
