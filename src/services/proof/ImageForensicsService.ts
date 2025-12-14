/**
 * IMAGE FORENSICS SERVICE
 * 
 * Detects screenshot vs camera, AI generation, and editing.
 * Results are ADVISORY - never auto-reject.
 */
import { createLogger } from '../../utils/logger.js';
import type { ForensicsResult, ForensicsSignal, ProofMetadata } from './types.js';

const logger = createLogger('ImageForensicsService');

// Known screenshot resolutions (common devices)
const SCREENSHOT_RESOLUTIONS = [
    { w: 1170, h: 2532 },  // iPhone 12/13/14 Pro
    { w: 1284, h: 2778 },  // iPhone 12/13/14 Pro Max
    { w: 1080, h: 2340 },  // Many Android phones
    { w: 1440, h: 3200 },  // Samsung Galaxy S
    { w: 1080, h: 1920 },  // Common Android
    { w: 750, h: 1334 },   // iPhone 8
    { w: 1242, h: 2688 },  // iPhone XS Max
    { w: 2560, h: 1440 },  // Desktop
    { w: 1920, h: 1080 },  // Desktop 1080p
];

// PNG is typically screenshots on mobile
const SCREENSHOT_MIME_TYPES = ['image/png'];

// JPEG with EXIF is typically camera
const CAMERA_MIME_TYPES = ['image/jpeg', 'image/heic', 'image/heif'];

// Known AI generation signatures (simplified)
const AI_GENERATION_SIGNATURES = [
    'DALL-E',
    'Midjourney',
    'Stable Diffusion',
    'Adobe Firefly',
    'Imagen'
];

export class ImageForensicsService {
    /**
     * Analyze image for authenticity
     */
    static async analyze(
        fileUrl: string,
        mimeType: string,
        metadata: ProofMetadata,
        taskTimeline?: { created: Date; assigned?: Date }
    ): Promise<ForensicsResult> {
        const signals: ForensicsSignal[] = [];
        const anomalies: string[] = [];

        // 1. EXIF presence check
        const exifSignal = this.checkExif(metadata);
        signals.push(exifSignal);
        if (exifSignal.suspicious) {
            anomalies.push('Missing or stripped EXIF data');
        }

        // 2. Screenshot resolution heuristic
        const resolutionSignal = this.checkResolution(metadata.resolution);
        signals.push(resolutionSignal);
        if (resolutionSignal.suspicious) {
            anomalies.push('Resolution matches known screenshot dimensions');
        }

        // 3. MIME type check
        const mimeSignal = this.checkMimeType(mimeType);
        signals.push(mimeSignal);
        if (mimeSignal.suspicious) {
            anomalies.push('PNG format commonly used for screenshots');
        }

        // 4. Camera model consistency
        if (metadata.cameraModel) {
            const cameraSignal = this.checkCameraModel(metadata.cameraModel);
            signals.push(cameraSignal);
            if (cameraSignal.suspicious) {
                anomalies.push('Suspicious camera model string');
            }
        }

        // 5. Timestamp vs task timeline
        if (metadata.captureTimestamp && taskTimeline) {
            const timeSignal = this.checkTimestamp(metadata.captureTimestamp, taskTimeline);
            signals.push(timeSignal);
            if (timeSignal.suspicious) {
                anomalies.push('Capture timestamp outside task window');
            }
        }

        // 6. AI generation check (from EXIF software field)
        const aiSignal = this.checkAIGeneration(metadata);
        signals.push(aiSignal);
        if (aiSignal.suspicious) {
            anomalies.push('Possible AI-generated image detected');
        }

        // Calculate confidence score
        const confidenceScore = this.calculateConfidence(signals);

        // Determine likelihoods
        const likelyScreenshot = signals.some(s =>
            s.name === 'resolution_check' && s.suspicious
        ) || (mimeType === 'image/png' && !metadata.exifPresent);

        const likelyAIGenerated = signals.some(s =>
            s.name === 'ai_generation' && s.suspicious
        );

        const likelyEdited = !metadata.exifPresent && mimeType === 'image/jpeg';

        const result: ForensicsResult = {
            confidenceScore,
            likelyScreenshot,
            likelyAIGenerated,
            likelyEdited,
            anomalies,
            signals,
            analyzedAt: new Date()
        };

        logger.info({
            confidenceScore,
            likelyScreenshot,
            anomalyCount: anomalies.length
        }, 'Forensics analysis complete');

        return result;
    }

    private static checkExif(metadata: ProofMetadata): ForensicsSignal {
        const hasExif = metadata.exifPresent && Object.keys(metadata.exifData || {}).length > 0;
        return {
            name: 'exif_presence',
            value: hasExif,
            weight: 3,
            suspicious: !hasExif
        };
    }

    private static checkResolution(resolution: { width: number; height: number }): ForensicsSignal {
        const isScreenshotRes = SCREENSHOT_RESOLUTIONS.some(sr =>
            (sr.w === resolution.width && sr.h === resolution.height) ||
            (sr.h === resolution.width && sr.w === resolution.height)
        );

        return {
            name: 'resolution_check',
            value: `${resolution.width}x${resolution.height}`,
            weight: 2,
            suspicious: isScreenshotRes
        };
    }

    private static checkMimeType(mimeType: string): ForensicsSignal {
        const isScreenshotType = SCREENSHOT_MIME_TYPES.includes(mimeType);
        return {
            name: 'mime_type',
            value: mimeType,
            weight: 2,
            suspicious: isScreenshotType
        };
    }

    private static checkCameraModel(model: string): ForensicsSignal {
        const suspicious = !model ||
            model.toLowerCase().includes('unknown') ||
            model.toLowerCase().includes('screenshot');

        return {
            name: 'camera_model',
            value: model,
            weight: 2,
            suspicious
        };
    }

    private static checkTimestamp(
        captureTime: Date,
        timeline: { created: Date; assigned?: Date }
    ): ForensicsSignal {
        const captureMs = captureTime.getTime();
        const assignedMs = timeline.assigned?.getTime() || timeline.created.getTime();

        // Photo taken before task assignment is suspicious
        const suspicious = captureMs < assignedMs;

        return {
            name: 'timestamp_check',
            value: { capture: captureTime, assigned: timeline.assigned || timeline.created },
            weight: 3,
            suspicious
        };
    }

    private static checkAIGeneration(metadata: ProofMetadata): ForensicsSignal {
        const exifSoftware = metadata.exifData?.Software || metadata.exifData?.software || '';
        const suspicious = AI_GENERATION_SIGNATURES.some(sig =>
            exifSoftware.toLowerCase().includes(sig.toLowerCase())
        );

        return {
            name: 'ai_generation',
            value: exifSoftware,
            weight: 5,
            suspicious
        };
    }

    private static calculateConfidence(signals: ForensicsSignal[]): number {
        // Higher score = more authentic
        // Lower score = more suspicious
        const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
        const suspiciousWeight = signals
            .filter(s => s.suspicious)
            .reduce((sum, s) => sum + s.weight, 0);

        const suspicionRatio = suspiciousWeight / totalWeight;
        const confidence = Math.round((1 - suspicionRatio) * 100);

        return Math.max(0, Math.min(100, confidence));
    }

    /**
     * Quick check - is this likely a screenshot?
     */
    static isLikelyScreenshot(mimeType: string, metadata: ProofMetadata): boolean {
        // PNG without EXIF is almost certainly a screenshot
        if (mimeType === 'image/png' && !metadata.exifPresent) {
            return true;
        }

        // Known screenshot resolution
        const isScreenshotRes = SCREENSHOT_RESOLUTIONS.some(sr =>
            (sr.w === metadata.resolution.width && sr.h === metadata.resolution.height) ||
            (sr.h === metadata.resolution.width && sr.w === metadata.resolution.height)
        );

        return isScreenshotRes && !metadata.exifPresent;
    }
}
