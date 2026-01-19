import type { ModerationResult } from '../types/index.js';
declare class ModerationServiceClass {
    /**
     * Fast check using Qwen/Groq for initial filtering
     */
    fastCheck(content: string): Promise<ModerationResult>;
    /**
     * Deep check using GPT-4o for suspicious content
     */
    deepCheck(content: string, context?: string): Promise<ModerationResult>;
    /**
     * Full moderation flow: fast check -> deep check if suspicious
     */
    check(content: string, context?: string): Promise<ModerationResult>;
}
export declare const ModerationService: ModerationServiceClass;
export {};
//# sourceMappingURL=ModerationService.d.ts.map