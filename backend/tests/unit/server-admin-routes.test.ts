import { TRPCError } from '@trpc/server';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerAdminRoutes } from '../../src/serverAdminRoutes';
import type { HustleApp } from '../../src/serverTypes';

describe('GET /admin/session', () => {
  it('returns the exact no-store named-operator session contract', async () => {
    const app = new Hono() as HustleApp;
    const createContext = vi.fn().mockResolvedValue({
      user: { id: 'operator-1' },
      firebaseUid: 'firebase-operator-1',
    });
    const getOperatorSession = vi.fn().mockResolvedValue({
      subject: 'firebase-operator-1',
      displayName: 'Named Operator',
      roles: ['operator_viewer', 'operator_responder'],
      expiresAt: '2033-05-18T03:33:20.000Z',
      stepUpVerified: true,
    });
    registerAdminRoutes(app, { createContext, getOperatorSession } as any);

    const response = await app.request('/admin/session', {
      headers: { Authorization: 'Bearer verified-firebase-token' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      subject: 'firebase-operator-1',
      displayName: 'Named Operator',
      roles: ['operator_viewer', 'operator_responder'],
      expiresAt: '2033-05-18T03:33:20.000Z',
      stepUpVerified: true,
    });
    expect(createContext).toHaveBeenCalledOnce();
    expect(getOperatorSession).toHaveBeenCalledWith(expect.objectContaining({
      firebaseUid: 'firebase-operator-1',
    }));
  });

  it('fails closed when fresh MFA step-up is absent', async () => {
    const app = new Hono() as HustleApp;
    registerAdminRoutes(app, {
      createContext: vi.fn().mockResolvedValue({
        user: { id: 'operator-1' }, firebaseUid: 'firebase-operator-1',
      }),
      getOperatorSession: vi.fn().mockRejectedValue(new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Fresh multi-factor step-up is required.',
      })),
    } as any);

    const response = await app.request('/admin/session', {
      headers: { Authorization: 'Bearer token-without-mfa' },
    });
    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'PRECONDITION_FAILED',
      message: 'Fresh multi-factor step-up is required.',
    });
  });
});
