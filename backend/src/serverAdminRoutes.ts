import { TRPCError } from '@trpc/server';
import { createContext, type Context } from './trpc-context.js';
import {
  OperatorAuthorityService,
  type OperatorSession,
} from './services/OperatorAuthorityService.js';
import type { HustleApp } from './serverTypes.js';

interface AdminRouteDependencies {
  createContext: typeof createContext;
  getOperatorSession: (context: Context) => Promise<OperatorSession>;
}

const defaultDependencies: AdminRouteDependencies = {
  createContext,
  getOperatorSession: OperatorAuthorityService.getSession,
};

function statusFor(error: TRPCError): 401 | 403 | 409 | 412 | 500 {
  if (error.code === 'UNAUTHORIZED') return 401;
  if (error.code === 'FORBIDDEN') return 403;
  if (error.code === 'CONFLICT') return 409;
  if (error.code === 'PRECONDITION_FAILED') return 412;
  return 500;
}

/**
 * Canonical named-operator handshake consumed by the web Operations gate.
 * It returns no bearer token, shared secret, or persisted browser credential.
 */
export function registerAdminRoutes(
  app: HustleApp,
  dependencies: AdminRouteDependencies = defaultDependencies,
): void {
  app.get('/admin/session', async (honoContext) => {
    honoContext.header('Cache-Control', 'no-store');
    honoContext.header('Pragma', 'no-cache');
    try {
      const responseHeaders = new Headers();
      const authContext = await dependencies.createContext({
        req: honoContext.req.raw,
        resHeaders: responseHeaders,
      });
      const session = await dependencies.getOperatorSession(authContext);
      return honoContext.json(session, 200);
    } catch (cause) {
      if (cause instanceof TRPCError) {
        return honoContext.json({
          ok: false,
          code: cause.code,
          message: cause.message,
        }, statusFor(cause));
      }
      return honoContext.json({
        ok: false,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Operator verification failed.',
      }, 500);
    }
  });
}
