/**
 * API Documentation Generator - Phase F
 * 
 * Generates structured API documentation for mobile app integration
 */

// ============================================
// Types
// ============================================

export interface EndpointDoc {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    path: string;
    description: string;
    auth: 'public' | 'optionalAuth' | 'requireAuth' | 'requireRole';
    role?: string;
    requestSchema?: Record<string, unknown>;
    responseSchema?: Record<string, unknown>;
    tags: string[];
}

// ============================================
// API Documentation
// ============================================

const API_DOCS: EndpointDoc[] = [
    // AI Endpoints
    {
        method: 'POST',
        path: '/ai/orchestrate',
        description: 'Main AI orchestration endpoint - handles all AI-powered actions',
        auth: 'optionalAuth',
        requestSchema: {
            intent: 'string (e.g., "new_task", "find_task", "complete_task", "get_advice")',
            input: 'string - user message or query',
            context: '{ userId?: string, taskId?: string, location?: { lat, lng } }',
        },
        responseSchema: {
            intent: 'string',
            action: 'string',
            response: 'string',
            data: 'object | null',
            suggestedActions: 'string[]',
        },
        tags: ['ai', 'core'],
    },
    {
        method: 'POST',
        path: '/ai/confirm-task',
        description: 'Confirm task creation after AI orchestration',
        auth: 'requireAuth',
        requestSchema: {
            draftId: 'string',
            confirmed: 'boolean',
        },
        responseSchema: {
            success: 'boolean',
            task: 'Task object',
        },
        tags: ['ai', 'tasks'],
    },

    // Task Endpoints
    {
        method: 'GET',
        path: '/api/tasks',
        description: 'List tasks with optional filters',
        auth: 'optionalAuth',
        requestSchema: {
            query: '{ category?, status?, cityId?, limit? }',
        },
        responseSchema: {
            tasks: 'Task[]',
            count: 'number',
        },
        tags: ['tasks'],
    },
    {
        method: 'GET',
        path: '/api/tasks/:taskId',
        description: 'Get task details by ID',
        auth: 'optionalAuth',
        responseSchema: {
            id: 'string',
            title: 'string',
            description: 'string',
            price: 'number',
            category: 'string',
            status: 'string',
            location: '{ lat, lng, neighborhood }',
        },
        tags: ['tasks'],
    },
    {
        method: 'POST',
        path: '/api/tasks',
        description: 'Create a new task',
        auth: 'requireAuth',
        requestSchema: {
            title: 'string',
            description: 'string',
            price: 'number',
            category: 'string',
            location: '{ lat: number, lng: number }',
        },
        responseSchema: {
            task: 'Task object',
        },
        tags: ['tasks'],
    },
    {
        method: 'POST',
        path: '/api/tasks/:taskId/accept',
        description: 'Accept a task as hustler',
        auth: 'requireAuth',
        responseSchema: {
            success: 'boolean',
            task: 'Task object',
        },
        tags: ['tasks', 'hustler'],
    },

    // Coach & Growth
    {
        method: 'GET',
        path: '/api/coach/daily',
        description: 'Get daily coaching message and action plan',
        auth: 'requireAuth',
        responseSchema: {
            message: 'string',
            todayPlan: '{ tasks: Task[], earnings: number }',
            nextBestAction: 'string',
            motivationalTip: 'string',
        },
        tags: ['coach', 'ai'],
    },
    {
        method: 'GET',
        path: '/api/coach/growth-plan',
        description: 'Get personalized growth plan',
        auth: 'requireAuth',
        responseSchema: {
            plan: 'GrowthPlan object',
            milestones: 'Milestone[]',
            progress: 'number (0-100)',
        },
        tags: ['coach', 'ai'],
    },

    // Badges & Quests
    {
        method: 'GET',
        path: '/api/badges',
        description: 'Get all badges for user',
        auth: 'requireAuth',
        responseSchema: {
            badges: 'Badge[]',
            unlockedCount: 'number',
            totalCount: 'number',
        },
        tags: ['gamification'],
    },
    {
        method: 'GET',
        path: '/api/quests',
        description: 'Get active quests for user',
        auth: 'requireAuth',
        responseSchema: {
            quests: 'Quest[]',
            dailyQuests: 'Quest[]',
            weeklyQuests: 'Quest[]',
        },
        tags: ['gamification'],
    },

    // Tips
    {
        method: 'GET',
        path: '/api/tips/contextual',
        description: 'Get contextual tip based on current state',
        auth: 'requireAuth',
        requestSchema: {
            query: '{ screen?, action?, taskId? }',
        },
        responseSchema: {
            tip: 'string',
            priority: 'number',
            actionUrl: 'string | null',
        },
        tags: ['tips', 'ai'],
    },

    // Profile
    {
        method: 'GET',
        path: '/api/profile/:userId',
        description: 'Get user profile',
        auth: 'optionalAuth',
        responseSchema: {
            id: 'string',
            name: 'string',
            role: 'string',
            xp: 'number',
            level: 'number',
            badges: 'Badge[]',
            stats: '{ tasksCompleted, totalEarnings, avgRating }',
        },
        tags: ['profile'],
    },
    {
        method: 'PUT',
        path: '/api/profile',
        description: 'Update user profile',
        auth: 'requireAuth',
        requestSchema: {
            name: 'string?',
            bio: 'string?',
            skills: 'string[]?',
            availability: 'object?',
        },
        responseSchema: {
            success: 'boolean',
            profile: 'Profile object',
        },
        tags: ['profile'],
    },

    // Stripe Connect
    {
        method: 'POST',
        path: '/api/stripe/connect/create',
        description: 'Create Stripe Connect account for hustler',
        auth: 'requireAuth',
        responseSchema: {
            accountId: 'string',
            status: 'string',
        },
        tags: ['payments', 'hustler'],
    },
    {
        method: 'GET',
        path: '/api/stripe/connect/:userId/onboard',
        description: 'Get Stripe onboarding link',
        auth: 'requireAuth',
        responseSchema: {
            url: 'string',
            expiresAt: 'timestamp',
        },
        tags: ['payments', 'hustler'],
    },
    {
        method: 'GET',
        path: '/api/stripe/connect/:userId/status',
        description: 'Get Stripe Connect account status',
        auth: 'requireAuth',
        responseSchema: {
            status: 'string (none, pending, verified)',
            canReceivePayouts: 'boolean',
        },
        tags: ['payments', 'hustler'],
    },

    // Escrow
    {
        method: 'POST',
        path: '/api/escrow/create',
        description: 'Create escrow for task',
        auth: 'requireAuth',
        requestSchema: {
            taskId: 'string',
            amount: 'number',
        },
        responseSchema: {
            escrowId: 'string',
            status: 'string',
            paymentIntentId: 'string',
        },
        tags: ['payments', 'poster'],
    },
    {
        method: 'GET',
        path: '/api/escrow/:taskId',
        description: 'Get escrow status for task',
        auth: 'requireAuth',
        responseSchema: {
            status: 'string (pending, held, released, refunded)',
            amount: 'number',
            hustlerPayout: 'number',
        },
        tags: ['payments'],
    },

    // Proof
    {
        method: 'POST',
        path: '/api/proof/validated/submit',
        description: 'Submit proof with GPS and photos',
        auth: 'requireAuth',
        requestSchema: {
            taskId: 'string',
            lat: 'number',
            lng: 'number',
            accuracy: 'number',
            photoBase64: 'string',
            caption: 'string?',
        },
        responseSchema: {
            success: 'boolean',
            proofId: 'string',
            status: 'string',
        },
        tags: ['proof', 'hustler'],
    },
    {
        method: 'POST',
        path: '/api/proof/validated/:taskId/approve',
        description: 'Approve proof and release payout',
        auth: 'requireAuth',
        responseSchema: {
            success: 'boolean',
            payoutId: 'string',
            amount: 'number',
        },
        tags: ['proof', 'poster'],
    },
    {
        method: 'POST',
        path: '/api/proof/validated/:taskId/reject',
        description: 'Reject proof with reason',
        auth: 'requireAuth',
        requestSchema: {
            reason: 'string',
            action: '"refund" | "dispute"',
        },
        responseSchema: {
            success: 'boolean',
            disputeId: 'string?',
        },
        tags: ['proof', 'poster'],
    },

    // Location
    {
        method: 'POST',
        path: '/api/location/resolve',
        description: 'Resolve city and zone from coordinates',
        auth: 'public',
        requestSchema: {
            lat: 'number',
            lng: 'number',
        },
        responseSchema: {
            city: 'City | null',
            zone: 'Zone | null',
            inCoverage: 'boolean',
        },
        tags: ['location'],
    },

    // Feature Flags
    {
        method: 'GET',
        path: '/api/flags/:key',
        description: 'Check if feature flag is enabled',
        auth: 'public',
        requestSchema: {
            query: '{ cityId?, userId? }',
        },
        responseSchema: {
            enabled: 'boolean',
        },
        tags: ['config'],
    },

    // User Suspension Check
    {
        method: 'GET',
        path: '/api/user/:userId/suspension',
        description: 'Check if user is suspended',
        auth: 'public',
        responseSchema: {
            suspended: 'boolean',
            reason: 'string?',
            until: 'timestamp?',
        },
        tags: ['users'],
    },
];

// ============================================
// Generator Functions
// ============================================

/**
 * Get full API documentation
 */
export function getAPIDocs(): {
    version: string;
    baseUrl: string;
    endpoints: EndpointDoc[];
    tags: string[];
} {
    const allTags = [...new Set(API_DOCS.flatMap(e => e.tags))].sort();

    return {
        version: '1.0.0-beta',
        baseUrl: '/api',
        endpoints: API_DOCS,
        tags: allTags,
    };
}

/**
 * Get endpoints by tag
 */
export function getEndpointsByTag(tag: string): EndpointDoc[] {
    return API_DOCS.filter(e => e.tags.includes(tag));
}

/**
 * Get sample endpoint for documentation
 */
export function getSampleEndpoint(): EndpointDoc {
    return API_DOCS.find(e => e.path === '/ai/orchestrate')!;
}
