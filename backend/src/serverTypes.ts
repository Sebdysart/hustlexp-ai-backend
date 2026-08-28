import type { Hono } from 'hono';

export type AppVariables = { requestId: string };
export type HustleApp = Hono<{ Variables: AppVariables }>;
