import { v4 as uuidv4 } from 'uuid';
import { GamificationService } from './GamificationService.js';
import { serviceLogger } from '../utils/logger.js';
import type { TaskCategory } from '../types/index.js';

// ============================================
// Proof Types & Requirements
// ============================================

export type ProofType = 'before' | 'during' | 'after' | 'handoff' | 'result' | 'safety';
export type ProofStatus = 'pending' | 'submitted' | 'verified' | 'rejected';
export type AnimationType = 'confetti' | 'xp_burst' | 'badge_unlock' | 'progress_fill' | 'streak_fire' | 'level_up' | 'sparkle';

export interface ProofRequirement {
    id: string;
    type: ProofType;
    title: string;
    prompt: string;             // AI prompt to user
    xpReward: number;
    required: boolean;
    order: number;
    triggerAt: 'start' | 'middle' | 'end' | 'manual';
    triggerAfterMinutes?: number;
}

export interface SubmittedProof {
    id: string;
    requirementId: string;
    taskId: string;
    hustlerId: string;
    type: ProofType;
    photoUrl: string;
    caption?: string;
    status: ProofStatus;
    xpAwarded: number;
    submittedAt: Date;
    verifiedAt?: Date;
    // Gamification response
    animations: AnimationType[];
    trustPointsEarned: number;
    badgeProgress?: { badge: string; current: number; max: number };
}

export interface ProofSession {
    sessionId: string;
    taskId: string;
    hustlerId: string;
    category: TaskCategory;
    requirements: ProofRequirement[];
    proofs: SubmittedProof[];
    completedCount: number;
    totalRequired: number;
    progressPercent: number;
    totalXPEarned: number;
    trustScoreBonus: number;
    status: 'active' | 'complete' | 'expired';
    createdAt: Date;
    completedAt?: Date;
}

export interface TrustProfile {
    hustlerId: string;
    trustScore: number;           // 0-100
    verifiedProofCount: number;
    proofStreak: number;          // Consecutive tasks with all proofs
    badges: string[];
    recentProofs: { photoUrl: string; category: string; submittedAt: Date }[];
    categoryProofs: Record<string, number>; // category -> count
}

// ============================================
// Category-Based Proof Requirements
// ============================================

const CATEGORY_PROOFS: Record<TaskCategory, Omit<ProofRequirement, 'id'>[]> = {
    cleaning: [
        { type: 'before', title: 'Before Photo', prompt: "Quick pic of the space before you start - this helps show your amazing work!", xpReward: 15, required: true, order: 1, triggerAt: 'start' },
        { type: 'after', title: 'After Photo', prompt: "Take a final photo to show off that sparkle! 🌟 This completes your task and awards XP.", xpReward: 35, required: true, order: 2, triggerAt: 'end' },
    ],
    delivery: [
        { type: 'before', title: 'Package Photo', prompt: "Snap a pic of the package before pickup - keeps everyone protected!", xpReward: 15, required: true, order: 1, triggerAt: 'start' },
        { type: 'handoff', title: 'Delivery Confirmation', prompt: "Photo of successful handoff or doorstep! 📦 Client will love seeing this.", xpReward: 35, required: true, order: 2, triggerAt: 'end' },
    ],
    moving: [
        { type: 'before', title: 'Items Before Move', prompt: "Quick photo of items before moving - protects you and the client!", xpReward: 15, required: true, order: 1, triggerAt: 'start' },
        { type: 'during', title: 'Progress Check', prompt: "Show those muscles working! 💪 Mid-task photo for bonus XP.", xpReward: 20, required: false, order: 2, triggerAt: 'middle', triggerAfterMinutes: 30 },
        { type: 'after', title: 'Final Placement', prompt: "Everything in place? Final photo to complete the mission!", xpReward: 35, required: true, order: 3, triggerAt: 'end' },
    ],
    pet_care: [
        { type: 'before', title: 'Pet Check-in', prompt: "Say hi! 🐕 Photo with the pet when you arrive.", xpReward: 20, required: true, order: 1, triggerAt: 'start' },
        { type: 'during', title: 'Happy Pet', prompt: "Capture a cute moment! Pet parents love seeing their fur baby.", xpReward: 25, required: false, order: 2, triggerAt: 'middle', triggerAfterMinutes: 20 },
        { type: 'after', title: 'Safe Return', prompt: "Pet safely home! Final photo completes your task. 🎉", xpReward: 30, required: true, order: 3, triggerAt: 'end' },
    ],
    errands: [
        { type: 'result', title: 'Task Complete', prompt: "Show the completed errand - receipt, item, or result!", xpReward: 30, required: true, order: 1, triggerAt: 'end' },
    ],
    handyman: [
        { type: 'before', title: 'Before Work', prompt: "Photo of the problem/area before you fix it.", xpReward: 15, required: true, order: 1, triggerAt: 'start' },
        { type: 'during', title: 'Work in Progress', prompt: "Show your skills! Mid-repair photo.", xpReward: 20, required: false, order: 2, triggerAt: 'middle', triggerAfterMinutes: 20 },
        { type: 'after', title: 'Fixed & Done', prompt: "The masterpiece is complete! 🔧 Final photo for full XP.", xpReward: 40, required: true, order: 3, triggerAt: 'end' },
    ],
    tech_help: [
        { type: 'result', title: 'Problem Solved', prompt: "Screenshot or photo showing the issue is fixed!", xpReward: 35, required: true, order: 1, triggerAt: 'end' },
    ],
    yard_work: [
        { type: 'before', title: 'Before Photo', prompt: "Capture the yard before your magic begins! 🌿", xpReward: 15, required: true, order: 1, triggerAt: 'start' },
        { type: 'after', title: 'After Photo', prompt: "Show that beautiful yard! Before/after is 🔥", xpReward: 40, required: true, order: 2, triggerAt: 'end' },
    ],
    event_help: [
        { type: 'before', title: 'Setup Start', prompt: "Photo of venue/setup area when you arrive.", xpReward: 15, required: true, order: 1, triggerAt: 'start' },
        { type: 'after', title: 'Event Ready', prompt: "Everything set? Final photo shows your work! 🎉", xpReward: 35, required: true, order: 2, triggerAt: 'end' },
    ],
    general: [
        { type: 'result', title: 'Task Complete', prompt: "Photo proof of completed task!", xpReward: 30, required: true, order: 1, triggerAt: 'end' },
    ],
    other: [
        { type: 'result', title: 'Task Complete', prompt: "Photo proof of completed task!", xpReward: 30, required: true, order: 1, triggerAt: 'end' },
    ],
};

// ============================================
// In-memory stores
// ============================================

const proofSessions = new Map<string, ProofSession>();
const trustProfiles = new Map<string, TrustProfile>();
const proofFeed = new Map<string, SubmittedProof[]>(); // hustlerId -> proofs

// ============================================
// AI Proof Service
// ============================================

class AIProofServiceClass {
    /**
     * Start a proof session for a task
     */
    startProofSession(
        taskId: string,
        hustlerId: string,
        category: TaskCategory
    ): ProofSession {
        const requirements = this.getProofRequirements(category);

        const session: ProofSession = {
            sessionId: uuidv4(),
            taskId,
            hustlerId,
            category,
            requirements,
            proofs: [],
            completedCount: 0,
            totalRequired: requirements.filter(r => r.required).length,
            progressPercent: 0,
            totalXPEarned: 0,
            trustScoreBonus: 0,
            status: 'active',
            createdAt: new Date(),
        };

        proofSessions.set(session.sessionId, session);
        serviceLogger.info({ sessionId: session.sessionId, taskId, category, requirements: requirements.length }, 'Proof session started');

        return session;
    }

    /**
     * Get proof requirements for a category
     */
    getProofRequirements(category: TaskCategory): ProofRequirement[] {
        const categoryProofs = CATEGORY_PROOFS[category] || CATEGORY_PROOFS.other;
        return categoryProofs.map(proof => ({
            ...proof,
            id: uuidv4(),
        }));
    }

    /**
     * Get AI prompt for next required proof
     */
    getNextProofPrompt(sessionId: string): {
        requirement: ProofRequirement | null;
        prompt: string;
        xpReward: number;
        isRequired: boolean;
        progress: { completed: number; total: number; percent: number };
    } | null {
        const session = proofSessions.get(sessionId);
        if (!session || session.status !== 'active') return null;

        const submittedIds = new Set(session.proofs.map(p => p.requirementId));
        const nextReq = session.requirements.find(r => !submittedIds.has(r.id));

        if (!nextReq) {
            return {
                requirement: null,
                prompt: "All proofs submitted! 🎉 You're crushing it!",
                xpReward: 0,
                isRequired: false,
                progress: {
                    completed: session.completedCount,
                    total: session.totalRequired,
                    percent: 100,
                },
            };
        }

        return {
            requirement: nextReq,
            prompt: nextReq.prompt,
            xpReward: nextReq.xpReward,
            isRequired: nextReq.required,
            progress: {
                completed: session.completedCount,
                total: session.totalRequired,
                percent: session.progressPercent,
            },
        };
    }

    /**
     * Submit a proof photo
     */
    async submitProof(
        sessionId: string,
        requirementId: string,
        photoUrl: string,
        caption?: string
    ): Promise<{
        proof: SubmittedProof;
        session: ProofSession;
        animations: AnimationType[];
        xpAwarded: number;
        trustBonus: number;
        message: string;
        nextPrompt: string | null;
    }> {
        const session = proofSessions.get(sessionId);
        if (!session) throw new Error('Session not found');
        if (session.status !== 'active') throw new Error('Session is not active');

        const requirement = session.requirements.find(r => r.id === requirementId);
        if (!requirement) throw new Error('Requirement not found');

        // Create proof
        const proof: SubmittedProof = {
            id: uuidv4(),
            requirementId,
            taskId: session.taskId,
            hustlerId: session.hustlerId,
            type: requirement.type,
            photoUrl,
            caption,
            status: 'verified', // Auto-verify for now
            xpAwarded: requirement.xpReward,
            submittedAt: new Date(),
            verifiedAt: new Date(),
            animations: this.calculateAnimations(session, requirement),
            trustPointsEarned: this.calculateTrustPoints(requirement),
            badgeProgress: this.getBadgeProgress(session.hustlerId, session.category),
        };

        // Update session
        session.proofs.push(proof);
        session.completedCount = session.proofs.filter(p =>
            session.requirements.find(r => r.id === p.requirementId)?.required
        ).length;
        session.progressPercent = Math.round(
            (session.proofs.length / session.requirements.length) * 100
        );
        session.totalXPEarned += proof.xpAwarded;
        session.trustScoreBonus += proof.trustPointsEarned;

        // Check if all required proofs submitted
        const requiredCount = session.requirements.filter(r => r.required).length;
        const submittedRequiredCount = session.proofs.filter(p => {
            const req = session.requirements.find(r => r.id === p.requirementId);
            return req?.required;
        }).length;

        if (submittedRequiredCount >= requiredCount) {
            session.status = 'complete';
            session.completedAt = new Date();
        }

        proofSessions.set(sessionId, session);

        // Award XP
        await GamificationService.awardXP(session.hustlerId, proof.xpAwarded, `proof_${requirement.type}`);

        // Update trust profile
        this.updateTrustProfile(session.hustlerId, proof, session.category);

        // Add to proof feed
        this.addToProofFeed(session.hustlerId, proof);

        // Get next prompt
        const nextPromptData = this.getNextProofPrompt(sessionId);

        const messages = [
            "Awesome! 🔥 Proof submitted!",
            "Looking good! XP earned! 💪",
            "Perfect shot! Keep it up! 📸",
            "Verified! You're on fire! 🔥",
        ];

        return {
            proof,
            session,
            animations: proof.animations,
            xpAwarded: proof.xpAwarded,
            trustBonus: proof.trustPointsEarned,
            message: messages[Math.floor(Math.random() * messages.length)] + ` +${proof.xpAwarded} XP`,
            nextPrompt: nextPromptData?.requirement?.prompt || null,
        };
    }

    /**
     * Calculate animations based on context
     */
    private calculateAnimations(session: ProofSession, requirement: ProofRequirement): AnimationType[] {
        const animations: AnimationType[] = ['xp_burst', 'sparkle'];

        // First proof
        if (session.proofs.length === 0) {
            animations.push('confetti');
        }

        // All required complete
        const requiredCount = session.requirements.filter(r => r.required).length;
        if (session.proofs.length + 1 >= requiredCount) {
            animations.push('confetti', 'level_up');
        }

        // High XP reward
        if (requirement.xpReward >= 30) {
            animations.push('streak_fire');
        }

        // Progress milestone
        const newProgress = Math.round(((session.proofs.length + 1) / session.requirements.length) * 100);
        if (newProgress >= 50 && session.progressPercent < 50) {
            animations.push('progress_fill');
        }

        return [...new Set(animations)];
    }

    /**
     * Calculate trust points for proof
     */
    private calculateTrustPoints(requirement: ProofRequirement): number {
        let points = 5;
        if (requirement.required) points += 5;
        if (requirement.type === 'before') points += 3;
        if (requirement.type === 'after') points += 5;
        return points;
    }

    /**
     * Get badge progress for category
     */
    private getBadgeProgress(hustlerId: string, category: TaskCategory): { badge: string; current: number; max: number } {
        const profile = trustProfiles.get(hustlerId);
        const count = profile?.categoryProofs[category] || 0;

        const badgeNames: Record<string, string> = {
            cleaning: 'Cleaning Champion',
            delivery: 'Delivery Pro',
            moving: 'Moving Master',
            pet_care: 'Pet Whisperer',
            handyman: 'Handyman Hero',
            errands: 'Errand Elite',
            tech_help: 'Tech Guru',
            yard_work: 'Green Thumb',
            event_help: 'Event Star',
            other: 'All-Rounder',
        };

        return {
            badge: badgeNames[category] || 'Versatile Hustler',
            current: (count + 1) % 10,
            max: 10,
        };
    }

    /**
     * Update trust profile with new proof
     */
    private updateTrustProfile(hustlerId: string, proof: SubmittedProof, category: TaskCategory): void {
        let profile = trustProfiles.get(hustlerId);

        if (!profile) {
            profile = {
                hustlerId,
                trustScore: 50, // Start at 50
                verifiedProofCount: 0,
                proofStreak: 0,
                badges: [],
                recentProofs: [],
                categoryProofs: {},
            };
        }

        // Update counts
        profile.verifiedProofCount += 1;
        profile.categoryProofs[category] = (profile.categoryProofs[category] || 0) + 1;

        // Update trust score (max 100)
        profile.trustScore = Math.min(100, profile.trustScore + proof.trustPointsEarned * 0.5);

        // Add to recent proofs
        profile.recentProofs.unshift({
            photoUrl: proof.photoUrl,
            category,
            submittedAt: proof.submittedAt,
        });
        profile.recentProofs = profile.recentProofs.slice(0, 10); // Keep last 10

        // Check for new badges
        const categoryCount = profile.categoryProofs[category];
        if (categoryCount === 10 && !profile.badges.includes(`${category}_pro`)) {
            profile.badges.push(`${category}_pro`);
        }
        if (profile.verifiedProofCount === 50 && !profile.badges.includes('proof_master')) {
            profile.badges.push('proof_master');
        }

        trustProfiles.set(hustlerId, profile);
    }

    /**
     * Add proof to feed
     */
    private addToProofFeed(hustlerId: string, proof: SubmittedProof): void {
        const feed = proofFeed.get(hustlerId) || [];
        feed.unshift(proof);
        proofFeed.set(hustlerId, feed.slice(0, 50)); // Keep last 50
    }

    /**
     * Get trust profile
     */
    getTrustProfile(hustlerId: string): TrustProfile | null {
        return trustProfiles.get(hustlerId) || null;
    }

    /**
     * Get proof feed for hustler
     */
    getProofFeed(hustlerId: string, limit: number = 20): SubmittedProof[] {
        const feed = proofFeed.get(hustlerId) || [];
        return feed.slice(0, limit);
    }

    /**
     * Get proof session
     */
    getSession(sessionId: string): ProofSession | null {
        return proofSessions.get(sessionId) || null;
    }

    /**
     * Get proof session by taskId
     */
    getSessionByTaskId(taskId: string): ProofSession | null {
        return Array.from(proofSessions.values()).find(s => s.taskId === taskId) || null;
    }

    /**
     * Get live task card update (for client view)
     */
    getLiveTaskUpdate(taskId: string): {
        proofs: { type: ProofType; photoUrl: string; submittedAt: Date; verified: boolean }[];
        progressPercent: number;
        status: string;
        lastUpdate: Date | null;
        isVerified: boolean;
    } | null {
        // Find session by taskId
        const session = Array.from(proofSessions.values()).find(s => s.taskId === taskId);
        if (!session) return null;

        return {
            proofs: session.proofs.map(p => ({
                type: p.type,
                photoUrl: p.photoUrl,
                submittedAt: p.submittedAt,
                verified: p.status === 'verified',
            })),
            progressPercent: session.progressPercent,
            status: session.status === 'complete' ? 'Proof Verified ✓' : 'In Progress',
            lastUpdate: session.proofs.length > 0 ? session.proofs[session.proofs.length - 1].submittedAt : null,
            isVerified: session.status === 'complete',
        };
    }
}

export const AIProofService = new AIProofServiceClass();
