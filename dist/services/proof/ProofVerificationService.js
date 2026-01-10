/**
 * PROOF VERIFICATION SERVICE
 *
 * Decision engine for proof verification.
 * AI recommends - system/admin decides.
 */
import { ProofService } from './ProofService.js';
import { ImageForensicsService } from './ImageForensicsService.js';
import { neon } from '@neondatabase/serverless';
import { createLogger } from '../../utils/logger.js';
const logger = createLogger('ProofVerificationService');
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// Thresholds
const AUTO_VERIFY_THRESHOLD = 80; // Auto-verify if confidence >= 80
const AUTO_REJECT_THRESHOLD = 20; // Auto-reject if confidence <= 20
const ESCALATE_SCREENSHOT = true; // Escalate screenshots for review
export class ProofVerificationService {
    /**
     * Analyze and decide on proof submission
     */
    static async analyzeAndDecide(submissionId, fileUrl, mimeType, metadata) {
        const db = getDb();
        if (!db)
            return { success: false, error: 'Database not available' };
        try {
            // 1. Get submission and task info
            const [submission] = await db `
                SELECT ps.*, pr.proof_type, pr.reason, t.created_at as task_created, t.assigned_to
                FROM proof_submissions ps
                JOIN proof_requests pr ON pr.id = ps.request_id
                JOIN tasks t ON t.id = ps.task_id
                WHERE ps.id = ${submissionId}::uuid
            `;
            if (!submission) {
                return { success: false, error: 'Submission not found' };
            }
            // 2. Get task timeline
            const [taskAssignment] = await db `
                SELECT created_at FROM tasks WHERE id = ${submission.task_id}::uuid
            `;
            const timeline = {
                created: new Date(taskAssignment.created_at),
                assigned: submission.assigned_to ? new Date() : undefined
            };
            // 3. Run forensics
            const forensicsResult = await ImageForensicsService.analyze(fileUrl, mimeType, metadata, timeline);
            // 4. Record forensics result
            await ProofService.recordForensicsResult(submissionId, forensicsResult);
            // 5. Make decision
            const decision = this.makeDecision(forensicsResult, submission.proof_type, submission.reason);
            // 6. Execute decision
            if (decision.action === 'verify' && !decision.requiresReview) {
                await ProofService.finalizeProof(submissionId, 'verified', 'system', 'system', decision.reason);
            }
            else if (decision.action === 'reject' && !decision.requiresReview) {
                await ProofService.finalizeProof(submissionId, 'rejected', 'system', 'system', decision.reason);
            }
            else {
                // Escalate for human review
                await ProofService.finalizeProof(submissionId, 'escalated', 'system', 'system', decision.reason);
            }
            logger.info({
                submissionId,
                action: decision.action,
                confidence: decision.confidence
            }, 'Proof verification decision made');
            return { success: true, decision };
        }
        catch (err) {
            logger.error({ error: err.message }, 'Proof verification failed');
            return { success: false, error: err.message };
        }
    }
    /**
     * Make verification decision based on forensics
     */
    static makeDecision(forensics, proofType, reason) {
        const { confidenceScore, likelyScreenshot, likelyAIGenerated, anomalies } = forensics;
        // AI-generated = always reject
        if (likelyAIGenerated) {
            return {
                action: 'reject',
                reason: 'AI-generated image detected',
                confidence: confidenceScore,
                requiresReview: false
            };
        }
        // High confidence = auto-verify
        if (confidenceScore >= AUTO_VERIFY_THRESHOLD && !likelyScreenshot) {
            return {
                action: 'verify',
                reason: 'High confidence authentic image',
                confidence: confidenceScore,
                requiresReview: false
            };
        }
        // Low confidence = auto-reject
        if (confidenceScore <= AUTO_REJECT_THRESHOLD) {
            return {
                action: 'reject',
                reason: `Low confidence (${confidenceScore}%): ${anomalies.join(', ')}`,
                confidence: confidenceScore,
                requiresReview: false
            };
        }
        // Screenshot when photo expected = escalate
        if (likelyScreenshot && proofType === 'photo') {
            return {
                action: 'escalate',
                reason: 'Screenshot submitted when photo was requested',
                confidence: confidenceScore,
                requiresReview: true
            };
        }
        // Screenshot allowed for screen_state reason
        if (likelyScreenshot && reason === 'screen_state') {
            return {
                action: 'verify',
                reason: 'Screenshot appropriate for screen state proof',
                confidence: confidenceScore,
                requiresReview: false
            };
        }
        // Middle ground = escalate for review
        return {
            action: 'escalate',
            reason: `Uncertain (${confidenceScore}%): requires human review`,
            confidence: confidenceScore,
            requiresReview: true
        };
    }
    /**
     * Admin override verification decision
     */
    static async adminOverride(submissionId, adminId, decision, reason) {
        try {
            const result = await ProofService.finalizeProof(submissionId, decision === 'verify' ? 'verified' : 'rejected', adminId, 'admin', reason);
            if (result.success && decision === 'verify') {
                // Lock verified proof
                await ProofService.lockProof(submissionId);
            }
            return result;
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
    /**
     * Get submissions pending review
     */
    static async getPendingReviews() {
        const db = getDb();
        if (!db)
            return [];
        const submissions = await db `
            SELECT 
                ps.*,
                pr.proof_type,
                pr.reason,
                t.title as task_title,
                u.username as submitted_by_name
            FROM proof_submissions ps
            JOIN proof_requests pr ON pr.id = ps.request_id
            JOIN tasks t ON t.id = ps.task_id
            JOIN users u ON u.id = ps.submitted_by
            WHERE ps.state = 'escalated'
            ORDER BY ps.created_at ASC
        `;
        return submissions;
    }
}
//# sourceMappingURL=ProofVerificationService.js.map