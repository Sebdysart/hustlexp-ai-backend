/**
 * Enhanced AI Proof Service
 *
 * Before/After photo workflow with AI verification.
 * - Defines proof requirements per category
 * - Validates photo submissions
 * - AI-powered caption generation
 * - Visual consistency checking
 */
import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { routedGenerate } from '../ai/router.js';
// ============================================
// Proof Requirements by Category
// ============================================
const CATEGORY_PROOF_REQUIREMENTS = {
    cleaning: [
        { phase: 'before', description: 'Photo of space before cleaning', required: true, exampleCaption: 'Kitchen before deep clean' },
        { phase: 'after', description: 'Photo of space after cleaning', required: true, exampleCaption: 'Kitchen spotless and organized' },
    ],
    moving: [
        { phase: 'before', description: 'Photo of items to be moved', required: true, exampleCaption: 'Furniture ready for moving' },
        { phase: 'during', description: 'Loading/transport photo', required: false, exampleCaption: 'Items safely loaded in truck' },
        { phase: 'after', description: 'Items at destination', required: true, exampleCaption: 'Furniture set up in new location' },
    ],
    delivery: [
        { phase: 'before', description: 'Photo of items for delivery', required: true, exampleCaption: 'Groceries picked up from store' },
        { phase: 'after', description: 'Delivered items photo', required: true, exampleCaption: 'Groceries delivered at doorstep' },
    ],
    handyman: [
        { phase: 'before', description: 'Photo of item/area before work', required: true, exampleCaption: 'IKEA box before assembly' },
        { phase: 'after', description: 'Completed work photo', required: true, exampleCaption: 'Fully assembled IKEA furniture' },
    ],
    pet_care: [
        { phase: 'during', description: 'Photo with pet during care', required: true, exampleCaption: 'Happy pup on walk in park' },
        { phase: 'after', description: 'Pet returned safely', required: false, exampleCaption: 'Dog back home and relaxed' },
    ],
    errands: [
        { phase: 'after', description: 'Proof of errand completion', required: true, exampleCaption: 'Package returned to store' },
    ],
    yard_work: [
        { phase: 'before', description: 'Yard before work', required: true, exampleCaption: 'Overgrown lawn before mowing' },
        { phase: 'after', description: 'Yard after completion', required: true, exampleCaption: 'Freshly mowed and edged lawn' },
    ],
    tech_help: [
        { phase: 'after', description: 'Working setup photo', required: true, exampleCaption: 'Smart home devices all connected' },
    ],
    event_help: [
        { phase: 'during', description: 'Event in progress', required: false, exampleCaption: 'Event setup complete' },
        { phase: 'after', description: 'Event completion/cleanup', required: true, exampleCaption: 'Venue cleaned after event' },
    ],
    general: [
        { phase: 'after', description: 'Proof of task completion', required: true, exampleCaption: 'Task completed as requested' },
    ],
    other: [
        { phase: 'after', description: 'Proof of task completion', required: true, exampleCaption: 'Task completed as requested' },
    ],
};
// ============================================
// In-Memory Store
// ============================================
const proofWorkflows = new Map();
const photoSubmissions = new Map();
// ============================================
// Enhanced AI Proof Service
// ============================================
class EnhancedAIProofServiceClass {
    /**
     * Initialize proof workflow for a task
     */
    initializeWorkflow(taskId, category) {
        const requirements = CATEGORY_PROOF_REQUIREMENTS[category] || CATEGORY_PROOF_REQUIREMENTS.other;
        const workflow = {
            taskId,
            category,
            requirements,
            submissions: [],
            isComplete: false,
            completionPercent: 0,
        };
        proofWorkflows.set(taskId, workflow);
        serviceLogger.debug({ taskId, category, requirementCount: requirements.length }, 'Proof workflow initialized');
        return workflow;
    }
    /**
     * Get workflow for a task
     */
    getWorkflow(taskId) {
        return proofWorkflows.get(taskId) || null;
    }
    /**
     * Get proof requirements for a category
     */
    getRequirements(category) {
        return CATEGORY_PROOF_REQUIREMENTS[category] || CATEGORY_PROOF_REQUIREMENTS.other;
    }
    /**
     * Submit a proof photo
     */
    async submitPhoto(taskId, userId, phase, photoUrl, userCaption) {
        const workflow = proofWorkflows.get(taskId);
        if (!workflow) {
            throw new Error(`No proof workflow found for task ${taskId}`);
        }
        // Generate AI caption if none provided
        let aiCaption;
        if (!userCaption) {
            aiCaption = await this.generateCaption(workflow.category, phase);
        }
        const submission = {
            id: uuidv4(),
            taskId,
            userId,
            phase,
            photoUrl,
            caption: userCaption,
            aiGeneratedCaption: aiCaption,
            submittedAt: new Date(),
            status: 'submitted',
        };
        photoSubmissions.set(submission.id, submission);
        workflow.submissions.push(submission);
        // Update completion percentage
        this.updateCompletionStatus(workflow);
        serviceLogger.info({ taskId, phase, submissionId: submission.id }, 'Proof photo submitted');
        return submission;
    }
    /**
     * Generate AI caption for a photo based on category and phase
     */
    async generateCaption(category, phase) {
        try {
            const result = await routedGenerate('small_aux', {
                system: `You generate short, professional captions for task completion photos.
Keep captions under 50 characters. Be descriptive but concise.
Category: ${category}, Phase: ${phase}`,
                messages: [{
                        role: 'user',
                        content: `Generate a caption for a ${phase} photo of a ${category} task.`,
                    }],
                maxTokens: 50,
            });
            return result.content.trim().replace(/^["']|["']$/g, '');
        }
        catch (error) {
            serviceLogger.error({ error, category, phase }, 'Failed to generate caption');
            // Fallback captions
            const fallbacks = {
                before: `${category} task - before`,
                during: `${category} task - in progress`,
                after: `${category} task - completed`,
            };
            return fallbacks[phase];
        }
    }
    /**
     * Verify before/after photo consistency
     */
    async verifyConsistency(taskId) {
        const workflow = proofWorkflows.get(taskId);
        if (!workflow) {
            return {
                isValid: false,
                confidence: 0,
                issues: ['Workflow not found'],
                suggestions: [],
                consistencyScore: 0,
            };
        }
        const beforePhotos = workflow.submissions.filter(s => s.phase === 'before');
        const afterPhotos = workflow.submissions.filter(s => s.phase === 'after');
        const issues = [];
        const suggestions = [];
        // Check required phases
        const requiredPhases = workflow.requirements.filter(r => r.required).map(r => r.phase);
        for (const phase of requiredPhases) {
            const hasPhoto = workflow.submissions.some(s => s.phase === phase);
            if (!hasPhoto) {
                issues.push(`Missing required ${phase} photo`);
            }
        }
        // Basic consistency checks
        if (beforePhotos.length > 0 && afterPhotos.length > 0) {
            // In a real implementation, this would use vision AI
            // For now, we check metadata consistency
            const timeDiff = afterPhotos[0].submittedAt.getTime() - beforePhotos[0].submittedAt.getTime();
            const minutesDiff = timeDiff / 1000 / 60;
            if (minutesDiff < 5) {
                suggestions.push('Photos submitted very quickly - ensure work was completed');
            }
            if (minutesDiff > 480) { // 8 hours
                suggestions.push('Long gap between photos - consider adding progress photos');
            }
        }
        // Calculate scores
        const requiredCount = workflow.requirements.filter(r => r.required).length;
        const submittedCount = new Set(workflow.submissions.map(s => s.phase)).size;
        const consistencyScore = Math.round((submittedCount / Math.max(requiredCount, 1)) * 100);
        const isValid = issues.length === 0 && consistencyScore >= 80;
        const confidence = issues.length === 0 ? 0.9 : 0.5;
        // Update submission statuses
        if (isValid) {
            for (const submission of workflow.submissions) {
                submission.status = 'verified';
            }
        }
        return {
            isValid,
            confidence,
            issues,
            suggestions,
            consistencyScore,
        };
    }
    /**
     * Get all submissions for a task
     */
    getSubmissions(taskId) {
        const workflow = proofWorkflows.get(taskId);
        return workflow?.submissions || [];
    }
    /**
     * Get submission by ID
     */
    getSubmission(submissionId) {
        return photoSubmissions.get(submissionId) || null;
    }
    /**
     * Update completion status of workflow
     */
    updateCompletionStatus(workflow) {
        const requiredPhases = workflow.requirements.filter(r => r.required).map(r => r.phase);
        const submittedPhases = new Set(workflow.submissions.map(s => s.phase));
        const completedRequired = requiredPhases.filter(p => submittedPhases.has(p)).length;
        workflow.completionPercent = Math.round((completedRequired / Math.max(requiredPhases.length, 1)) * 100);
        workflow.isComplete = workflow.completionPercent === 100;
    }
    /**
     * Get proof instructions for app UI
     */
    getProofInstructions(category) {
        const requirements = this.getRequirements(category);
        return {
            title: `Photo Proof for ${category.replace('_', ' ')} Task`,
            steps: requirements.map(r => ({
                phase: r.phase,
                instruction: r.description,
                required: r.required,
            })),
        };
    }
    /**
     * Attach verified proofs to user profile
     */
    attachToProfile(userId, taskId) {
        const workflow = proofWorkflows.get(taskId);
        if (!workflow || !workflow.isComplete) {
            return { proofCount: 0, categories: [] };
        }
        // In production, this would update the user's profile in DB
        serviceLogger.info({ userId, taskId, category: workflow.category }, 'Proof attached to profile');
        return {
            proofCount: workflow.submissions.length,
            categories: [workflow.category],
        };
    }
}
export const EnhancedAIProofService = new EnhancedAIProofServiceClass();
//# sourceMappingURL=EnhancedAIProofService.js.map