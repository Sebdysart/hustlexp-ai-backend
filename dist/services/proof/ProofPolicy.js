/**
 * PROOF POLICY
 *
 * Guardrails for AI proof requests.
 * AI cannot freestyle - must pass policy checks.
 */
import { ProofType, ProofReason } from './types.js';
// Categories that REQUIRE proof for completion
const PROOF_REQUIRED_CATEGORIES = [
    'cleaning',
    'moving',
    'repairs',
    'delivery',
    'assembly'
];
// Categories where proof is optional
const PROOF_OPTIONAL_CATEGORIES = [
    'errands',
    'shopping',
    'virtual'
];
// Max proof requests per task
const MAX_PROOFS_PER_TASK = 3;
// Trust tier threshold - require proof if below
const TRUST_THRESHOLD = 3;
// Price threshold - require proof if above
const PRICE_THRESHOLD_CENTS = 5000; // $50
export class ProofPolicy {
    /**
     * Check if AI can request proof for this task
     */
    static canRequestProof(task, user, proofType, reason, existingProofCount) {
        // 1. Task state check
        const eligibleStates = ['assigned', 'in_progress', 'pending_completion'];
        if (!eligibleStates.includes(task.status)) {
            return { allowed: false, reason: `Task status ${task.status} not eligible for proof request` };
        }
        // 2. Quota check
        if (existingProofCount >= MAX_PROOFS_PER_TASK) {
            return { allowed: false, reason: `Max ${MAX_PROOFS_PER_TASK} proofs per task exceeded` };
        }
        // 3. Category check
        const categoryAllowed = [...PROOF_REQUIRED_CATEGORIES, ...PROOF_OPTIONAL_CATEGORIES]
            .includes(task.category);
        if (!categoryAllowed) {
            return { allowed: false, reason: `Category ${task.category} does not support proof` };
        }
        // 4. Proof type + reason compatibility
        if (proofType === ProofType.VIDEO && reason === ProofReason.SCREEN_STATE) {
            return { allowed: false, reason: 'Video not allowed for screen state proof' };
        }
        return { allowed: true };
    }
    /**
     * Determine if proof should be auto-required for task
     */
    static isProofRequired(task, hustler) {
        // Required by category
        if (PROOF_REQUIRED_CATEGORIES.includes(task.category)) {
            return true;
        }
        // Required by price
        if (task.price > PRICE_THRESHOLD_CENTS) {
            return true;
        }
        // Required by low trust
        if (hustler.trustTier < TRUST_THRESHOLD) {
            return true;
        }
        // Required by high dispute rate
        if (hustler.disputeRate > 0.1) { // >10%
            return true;
        }
        // Required by task risk score
        if (task.riskScore && task.riskScore > 70) {
            return true;
        }
        return false;
    }
    /**
     * Get recommended proof type for task category
     */
    static getRecommendedProofType(category, reason) {
        if (reason === ProofReason.SCREEN_STATE) {
            return ProofType.SCREENSHOT;
        }
        if (['moving', 'cleaning', 'repairs'].includes(category)) {
            return ProofType.PHOTO; // Needs real camera
        }
        if (reason === ProofReason.BEFORE_AFTER) {
            return ProofType.PHOTO;
        }
        return ProofType.PHOTO; // Default
    }
    /**
     * Generate proof instructions based on context
     */
    static generateInstructions(category, reason, proofType) {
        const instructions = {
            cleaning: {
                [ProofReason.TASK_COMPLETION]: 'Take a photo showing the cleaned area. Include a wide shot showing the full space.',
                [ProofReason.BEFORE_AFTER]: 'Take photos before and after cleaning to show the transformation.',
                [ProofReason.DAMAGE_EVIDENCE]: 'Document any existing damage before starting work.',
                [ProofReason.LOCATION_CONFIRMATION]: 'Take a photo that shows you are at the correct location.',
                [ProofReason.SCREEN_STATE]: 'Take a screenshot of the relevant screen.',
                [ProofReason.IDENTITY_VERIFICATION]: 'Take a selfie for identity verification.'
            },
            moving: {
                [ProofReason.TASK_COMPLETION]: 'Take photos of items in their new location.',
                [ProofReason.BEFORE_AFTER]: 'Document items before and after moving.',
                [ProofReason.DAMAGE_EVIDENCE]: 'Document any damage to items or property.',
                [ProofReason.LOCATION_CONFIRMATION]: 'Take a photo at the pickup/dropoff location.',
                [ProofReason.SCREEN_STATE]: 'Take a screenshot if needed.',
                [ProofReason.IDENTITY_VERIFICATION]: 'Take a selfie for identity verification.'
            },
            default: {
                [ProofReason.TASK_COMPLETION]: 'Take a photo showing the completed task.',
                [ProofReason.BEFORE_AFTER]: 'Take photos showing before and after.',
                [ProofReason.DAMAGE_EVIDENCE]: 'Document any relevant damage.',
                [ProofReason.LOCATION_CONFIRMATION]: 'Take a photo at the task location.',
                [ProofReason.SCREEN_STATE]: 'Take a screenshot of the relevant screen.',
                [ProofReason.IDENTITY_VERIFICATION]: 'Take a selfie for identity verification.'
            }
        };
        const categoryInstructions = instructions[category] || instructions.default;
        return categoryInstructions[reason] || instructions.default[reason];
    }
}
//# sourceMappingURL=ProofPolicy.js.map