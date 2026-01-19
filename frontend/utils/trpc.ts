/**
 * tRPC Client Setup
 * 
 * Minimal tRPC client for frontend-backend communication.
 * Replace with your actual tRPC setup.
 */

import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '../../../backend/src/routers/index';

// This should match your backend AppRouter type
// For now, using a placeholder - replace with actual import
export const trpc = createTRPCReact<AppRouter>();

// Example usage:
// const { data } = trpc.instant.listAvailable.useQuery();
// const mutation = trpc.instant.accept.useMutation();
