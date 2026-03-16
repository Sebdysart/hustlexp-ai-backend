import { describe, it, expect } from 'vitest';

// A simple pure function we'll use to verify Stryker works
function add(a: number, b: number): number {
  return a + b;
}

describe('citadel mutation verification', () => {
  it('catches arithmetic mutation', () => {
    expect(add(2, 3)).toBe(5);
    expect(add(0, 0)).toBe(0);
    expect(add(-1, 1)).toBe(0);
  });
});
