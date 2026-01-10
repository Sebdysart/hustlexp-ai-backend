import type { ForensicsResult, ProofMetadata } from './types.js';
export declare class ImageForensicsService {
    /**
     * Analyze image for authenticity
     */
    static analyze(fileUrl: string, mimeType: string, metadata: ProofMetadata, taskTimeline?: {
        created: Date;
        assigned?: Date;
    }): Promise<ForensicsResult>;
    private static checkExif;
    private static checkResolution;
    private static checkMimeType;
    private static checkCameraModel;
    private static checkTimestamp;
    private static checkAIGeneration;
    private static calculateConfidence;
    /**
     * Quick check - is this likely a screenshot?
     */
    static isLikelyScreenshot(mimeType: string, metadata: ProofMetadata): boolean;
}
//# sourceMappingURL=ImageForensicsService.d.ts.map