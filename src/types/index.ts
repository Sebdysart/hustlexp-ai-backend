// Core types for HustleXP AI Infrastructure

// ============================================
// Task Types
// ============================================

export const TASK_CATEGORIES = [
    'delivery',
    'moving',
    'cleaning',
    'handyman',
    'errands',
    'pet_care',
    'yard_work',
    'tech_help',
    'event_help',
    'other'
] as const;

export type TaskCategory = typeof TASK_CATEGORIES[number];

export const TASK_FLAGS = [
    'needs_car',
    'heavy_lifting',
    'pet_friendly',
    'tools_required',
    'outdoor',
    'indoor',
    'flexible_time',
    'urgent'
] as const;

export type TaskFlag = typeof TASK_FLAGS[number];

export interface Task {
    id: string;
    clientId: string;
    title: string;
    description: string;
    category: TaskCategory;
    minPrice: number;
    recommendedPrice: number;
    maxPrice?: number;
    locationText?: string;
    latitude?: number;
    longitude?: number;
    timeWindow?: {
        start: Date;
        end: Date;
    };
    flags: TaskFlag[];
    status: 'draft' | 'open' | 'assigned' | 'in_progress' | 'completed' | 'cancelled';
    assignedHustlerId?: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface TaskDraft {
    title: string;
    description: string;
    category: TaskCategory;
    minPrice?: number;
    recommendedPrice: number;
    maxPrice?: number;
    locationText?: string;
    timeWindow?: {
        start: string;
        end: string;
    };
    flags: TaskFlag[];
    priceExplanation?: string;
}

// ============================================
// User Types
// ============================================

export interface User {
    id: string;
    email: string;
    name: string;
    role: 'client' | 'hustler' | 'both';
    createdAt: Date;
}

export interface HustlerProfile {
    userId: string;
    skills: TaskCategory[];
    rating: number;
    completedTasks: number;
    completionRate: number;
    xp: number;
    level: number;
    streak: number;
    latitude?: number;
    longitude?: number;
    isActive: boolean;
    bio?: string;
}

export interface HustlerCandidate extends HustlerProfile {
    score: number;
    distanceKm?: number;
    matchReasons?: string[];
}

// ============================================
// Gamification Types
// ============================================

export interface XPEvent {
    userId: string;
    amount: number;
    reason: string;
    taskId?: string;
    timestamp: Date;
}

export interface Quest {
    id: string;
    userId: string;
    title: string;
    description: string;
    goalCondition: string;
    xpReward: number;
    progress: number;
    target: number;
    isCompleted: boolean;
    expiresAt: Date;
    createdAt: Date;
}

// ============================================
// AI Types
// ============================================

export type Intent =
    | 'create_task'
    | 'edit_task'
    | 'search_tasks'
    | 'accept_task'
    | 'ask_pricing'
    | 'ask_support'
    | 'hustler_plan'
    | 'other';

export interface IntentClassification {
    intent: Intent;
    confidence: number;
    extractedEntities?: Record<string, unknown>;
}

export type OrchestrateMode = 'client_assistant' | 'hustler_assistant' | 'support';

// Screen context for always-aware AI
export type ScreenContext =
    | 'home'
    | 'feed'
    | 'task_create'
    | 'task_detail'
    | 'profile'
    | 'earnings'
    | 'quests'
    | 'badges'
    | 'settings'
    | 'onboarding'
    | 'wallet'
    | 'chat';

// Recent action for AI context
export interface RecentAction {
    type: string;
    category?: TaskCategory;
    timestamp?: Date;
}

// Profile snapshot for AI context
export interface ProfileSnapshot {
    role: 'hustler' | 'client' | 'both';
    level: number;
    xp: number;
    streakDays: number;
    topCategories: TaskCategory[];
    earningsLast7d: number;
    tasksCompletedTotal?: number;
    rating?: number;
}

// Full AI context block
export interface AIContextBlock {
    screen: ScreenContext;
    recentActions: RecentAction[];
    profileSnapshot: ProfileSnapshot;
    aiHistorySummary?: string;
}

export interface OrchestrateInput {
    userId: string;
    message: string;
    mode: OrchestrateMode;

    // NEW: Always-aware context (optional for backwards compatibility)
    context?: AIContextBlock;

    // Legacy field (deprecated, use context instead)
    legacyContext?: Record<string, unknown>;
}

export type OrchestrateResponseType =
    | 'TASK_DRAFT'
    | 'TASK_CREATED'
    | 'TASKS_FOUND'
    | 'PRICE_SUGGESTION'
    | 'HUSTLER_PLAN'
    | 'SUPPORT_RESPONSE'
    | 'CLARIFICATION_NEEDED'
    | 'ERROR';

export interface OrchestrateResponse {
    type: OrchestrateResponseType;
    data: unknown;
    message?: string;
    nextAction?: string;
}

// ============================================
// Model Router Types
// ============================================

export type ModelTaskType =
    | 'planning'
    | 'pricing'
    | 'matching_logic'
    | 'translate'
    | 'title_cleanup'
    | 'categorization'
    | 'intent'
    | 'small_aux'
    | 'safety'
    | 'dispute'
    | 'high_stakes_copy';

export type ModelProvider = 'deepseek' | 'qwen' | 'openai';

// ============================================
// AI Client Types
// ============================================

export interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface GenerateOptions {
    system: string;
    messages: Message[];
    json?: boolean;
    maxTokens?: number;
    temperature?: number;
}

export interface GenerateResult {
    content: string;
    tokensUsed?: {
        input: number;
        output: number;
    };
    latencyMs: number;
}

// ============================================
// Moderation Types
// ============================================

export type ModerationDecision = 'safe' | 'suspicious' | 'blocked';

export interface ModerationResult {
    decision: ModerationDecision;
    reason?: string;
    userMessage?: string;
}

// ============================================
// AI Event Logging Types
// ============================================

export interface AIEvent {
    id: string;
    userId?: string;
    intent?: Intent;
    modelUsed: ModelProvider;
    taskType: ModelTaskType;
    tokensIn: number;
    tokensOut: number;
    costEstimate: number;
    latencyMs: number;
    success: boolean;
    errorMessage?: string;
    timestamp: Date;
}
