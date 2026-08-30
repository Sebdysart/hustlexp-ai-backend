import { describe, expect, it } from 'vitest';
import { aiOperationId } from '../../src/ai/AIOperationIdentity.js';

describe('aiOperationId', () => {
  it('is stable across recursive object key insertion order', () => {
    const left = aiOperationId('scope', { z: 1, nested: { b: 2, a: 1 } });
    const right = aiOperationId('scope', { nested: { a: 1, b: 2 }, z: 1 });
    expect(left).toBe(right);
  });

  it('preserves array ordering', () => {
    expect(aiOperationId('scope', ['a', 'b'])).not.toBe(aiOperationId('scope', ['b', 'a']));
  });
});
