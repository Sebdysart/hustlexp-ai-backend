import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

// noble/ed25519 v3 requires sha512 sync provider to be set for synchronous methods
ed.hashes.sha512 = sha512;

describe('citadel provenance signing', () => {
  it('signs and verifies a verdict payload', () => {
    const { secretKey, publicKey } = ed.keygen();

    const payload = JSON.stringify({ gate: 'mutation', score: 94.2, safe: true });
    const message = new TextEncoder().encode(payload);
    const signature = ed.sign(message, secretKey);

    const valid = ed.verify(signature, message, publicKey);
    expect(valid).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const { secretKey, publicKey } = ed.keygen();

    const payload = JSON.stringify({ gate: 'mutation', score: 94.2, safe: true });
    const message = new TextEncoder().encode(payload);
    const signature = ed.sign(message, secretKey);

    const tampered = new TextEncoder().encode(
      JSON.stringify({ gate: 'mutation', score: 94.2, safe: false }) // changed
    );
    const valid = ed.verify(signature, tampered, publicKey);
    expect(valid).toBe(false);
  });
});
