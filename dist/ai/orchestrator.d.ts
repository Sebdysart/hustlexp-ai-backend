/**
 * AI Orchestrator - The central brain of HustleXP AI
 *
 * This is the main entry point for all AI interactions.
 * It classifies intent, routes to the appropriate handler,
 * and returns structured responses.
 *
 * UPGRADED: Now integrates UserBrainService for continuous learning.
 * Every interaction → learning → better next response.
 */
import type { OrchestrateInput, OrchestrateResponse } from '../types/index.js';
/**
 * Main orchestration entry point
 * Now includes learning loop from every interaction
 */
export declare function orchestrate(input: OrchestrateInput): Promise<OrchestrateResponse>;
export declare const orchestrator: {
    orchestrate: typeof orchestrate;
};
//# sourceMappingURL=orchestrator.d.ts.map