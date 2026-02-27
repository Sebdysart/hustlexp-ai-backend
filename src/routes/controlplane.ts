import type { FastifyInstance } from 'fastify';
import { TaskService } from '../services/TaskService.js';
import { RiskScoreService } from '../services/RiskScoreService.js';
import { AdaptiveProofPolicy } from '../services/AdaptiveProofPolicy.js';
import { AnalysisSnapshotService } from '../control-plane/AnalysisSnapshotService.js';
import { AIRecommendationService, type IngestPayload } from '../control-plane/AIRecommendationService.js';
import { CounterfactualSimulator } from '../control-plane/CounterfactualSimulator.js';
import { MarketSignalEngine } from '../control-plane/MarketSignalEngine.js';
import { StrategicOutputEngine } from '../strategy/StrategicOutputEngine.js';
import { PricingFeedbackService } from '../feedback/PricingFeedbackService.js';
import { PerformanceFeedbackService } from '../feedback/PerformanceFeedbackService.js';
import { TrustFeedbackService } from '../feedback/TrustFeedbackService.js';
import { OperatorLearningService } from '../feedback/OperatorLearningService.js';
import { CityGridService } from '../city/CityGridService.js';
import { LiquidityHeatEngine } from '../city/LiquidityHeatEngine.js';
import { OpportunityBurstEngine } from '../city/OpportunityBurstEngine.js';
import { DefensibilityScoreService } from '../city/DefensibilityScoreService.js';
import { ExpansionDecisionEngine } from '../city/ExpansionDecisionEngine.js';
import { LiquidityLockInEngine } from '../dominance/LiquidityLockInEngine.js';
import { TaskChainingEngine } from '../dominance/TaskChainingEngine.js';
import { ReputationCompoundingService } from '../dominance/ReputationCompoundingService.js';
import { ExitFrictionAnalyzer } from '../dominance/ExitFrictionAnalyzer.js';
import { ZoneTakeoverEngine } from '../dominance/ZoneTakeoverEngine.js';

// ============================================
// Control Plane Route Module
// Covers: Risk, Shadow Policy, Snapshots, Recommendations,
//         Simulations, Market Signals, Strategy, Feedback Flywheel,
//         City Domination, Winner-Take-Most Dynamics
// ============================================

export async function controlPlaneRoutes(fastify: FastifyInstance): Promise<void> {
    // ============================================
    // Risk Scoring Endpoints
    // ============================================

    // Score a user (poster or hustler)
    fastify.get<{
        Params: { userId: string };
        Querystring: { role?: 'poster' | 'hustler' };
    }>('/api/control-plane/risk/user/:userId', async (request) => {
        const { userId } = request.params;
        const role = request.query.role || 'hustler';

        const profile = await RiskScoreService.scoreUser(userId, role);

        return {
            success: true,
            profile
        };
    });

    // Score a task
    fastify.get<{
        Params: { taskId: string };
    }>('/api/control-plane/risk/task/:taskId', async (request, reply) => {
        const { taskId } = request.params;

        const task = await TaskService.getTask(taskId);
        if (!task) {
            reply.code(404);
            return { success: false, error: 'Task not found' };
        }

        const score = await RiskScoreService.scoreTask({
            taskId,
            category: task.category,
            price: task.recommendedPrice,
            posterId: task.clientId,
            hustlerId: task.assignedHustlerId || undefined
        });

        return {
            success: true,
            taskId,
            score
        };
    });

    // Full risk assessment (task + both parties)
    fastify.get<{
        Params: { taskId: string };
    }>('/api/control-plane/risk/assess/:taskId', async (request, reply) => {
        const { taskId } = request.params;

        const task = await TaskService.getTask(taskId);
        if (!task) {
            reply.code(404);
            return { success: false, error: 'Task not found' };
        }

        const assessment = await RiskScoreService.assessFullRisk({
            taskId,
            category: task.category,
            price: task.recommendedPrice,
            posterId: task.clientId,
            hustlerId: task.assignedHustlerId || undefined,
            isFirstTimeMatch: true
        });

        return {
            success: true,
            taskId,
            assessment
        };
    });

    // ============================================
    // Shadow Policy Endpoints (Phase 14D-2)
    // ============================================

    // Evaluate shadow policy for a task
    fastify.get<{
        Params: { taskId: string };
    }>('/api/control-plane/shadow/evaluate/:taskId', async (request, reply) => {
        const { taskId } = request.params;

        const task = await TaskService.getTask(taskId);
        if (!task) {
            reply.code(404);
            return { success: false, error: 'Task not found' };
        }

        const comparison = await AdaptiveProofPolicy.evaluateShadowPolicy(
            taskId,
            task.category,
            task.recommendedPrice,
            task.clientId,
            task.assignedHustlerId || undefined
        );

        return {
            success: true,
            taskId,
            comparison
        };
    });

    // Get shadow analysis report
    fastify.get<{
        Querystring: { days?: number };
    }>('/api/control-plane/shadow/analysis', async (request) => {
        const days = request.query.days || 7;

        const analysis = await AdaptiveProofPolicy.getShadowAnalysis(days);

        return {
            success: true,
            periodDays: days,
            analysis
        };
    });

    // ============================================
    // Control Plane Intelligence Layer Endpoints
    // ============================================

    // List snapshots
    fastify.get<{
        Querystring: { type?: 'hourly' | 'daily' | 'manual'; limit?: number };
    }>('/api/control-plane/snapshots', async (request) => {
        const { type, limit } = request.query;
        const snapshots = await AnalysisSnapshotService.listSnapshots(type, limit || 50);
        return { success: true, snapshots };
    });

    // Get snapshot by ID
    fastify.get<{
        Params: { id: string };
    }>('/api/control-plane/snapshots/:id', async (request, reply) => {
        const snapshot = await AnalysisSnapshotService.getSnapshot(request.params.id);
        if (!snapshot) {
            reply.code(404);
            return { success: false, error: 'Snapshot not found' };
        }
        return { success: true, snapshot };
    });

    // Export snapshot for AI
    fastify.get<{
        Params: { id: string };
    }>('/api/control-plane/snapshots/:id/export', async (request, reply) => {
        const exported = await AnalysisSnapshotService.exportForAI(request.params.id);
        if (!exported) {
            reply.code(404);
            return { success: false, error: 'Snapshot not found' };
        }
        return { success: true, export: exported };
    });

    // Manually generate snapshot (admin only)
    fastify.post<{
        Body: { type?: 'hourly' | 'daily' | 'manual' };
    }>('/api/control-plane/snapshots/generate', async (request) => {
        const type = request.body.type || 'manual';
        const snapshot = await AnalysisSnapshotService.generateSnapshot(type);
        return { success: true, snapshot };
    });

    // Get latest snapshot
    fastify.get<{
        Querystring: { type?: 'hourly' | 'daily' | 'manual' };
    }>('/api/control-plane/snapshots/latest', async (request) => {
        const snapshot = await AnalysisSnapshotService.getLatest(request.query.type);
        return { success: true, snapshot };
    });

    // List recommendations
    fastify.get<{
        Querystring: { status?: 'received' | 'reviewed' | 'accepted' | 'rejected' | 'archived'; limit?: number };
    }>('/api/control-plane/recommendations', async (request) => {
        const { status, limit } = request.query;
        const recommendations = await AIRecommendationService.list(status, limit || 50);
        const pending = await AIRecommendationService.getPendingCount();
        return { success: true, recommendations, pending };
    });

    // Get recommendation by ID
    fastify.get<{
        Params: { id: string };
    }>('/api/control-plane/recommendations/:id', async (request, reply) => {
        const recommendation = await AIRecommendationService.get(request.params.id);
        if (!recommendation) {
            reply.code(404);
            return { success: false, error: 'Recommendation not found' };
        }
        return { success: true, recommendation };
    });

    // Ingest AI recommendations (admin only)
    fastify.post<{
        Body: IngestPayload & { adminId: string };
    }>('/api/control-plane/recommendations/ingest', async (request) => {
        const { adminId, ...payload } = request.body;
        const result = await AIRecommendationService.ingest(payload, adminId);
        return { success: true, ...result };
    });

    // Review recommendation (admin only)
    fastify.post<{
        Params: { id: string };
        Body: { action: 'review' | 'accept' | 'reject'; adminId: string; notes?: string };
    }>('/api/control-plane/recommendations/:id/action', async (request, reply) => {
        const { id } = request.params;
        const { action, adminId, notes } = request.body;

        let success = false;

        switch (action) {
            case 'review':
                success = await AIRecommendationService.markReviewed(id, adminId);
                break;
            case 'accept':
                success = await AIRecommendationService.accept(id, adminId, notes);
                break;
            case 'reject':
                success = await AIRecommendationService.reject(id, adminId, notes);
                break;
        }

        if (!success) {
            reply.code(400);
            return { success: false, error: 'Action failed - check recommendation status' };
        }

        return { success: true, action, recommendationId: id };
    });

    // ============================================
    // Counterfactual Simulator Endpoints (Phase 14E)
    // ============================================

    // Run simulation for a recommendation
    fastify.post<{
        Params: { recommendationId: string };
        Body: { daysBack?: number };
    }>('/api/control-plane/simulate/:recommendationId', async (request, reply) => {
        const { recommendationId } = request.params;
        const daysBack = request.body.daysBack || 7;

        const recommendation = await AIRecommendationService.get(recommendationId);
        if (!recommendation) {
            reply.code(404);
            return { success: false, error: 'Recommendation not found' };
        }

        const result = await CounterfactualSimulator.simulate(recommendation, daysBack);

        return {
            success: true,
            simulation: result
        };
    });

    // Get simulation result
    fastify.get<{
        Params: { id: string };
    }>('/api/control-plane/simulations/:id', async (request, reply) => {
        const result = await CounterfactualSimulator.getResult(request.params.id);
        if (!result) {
            reply.code(404);
            return { success: false, error: 'Simulation not found' };
        }
        return { success: true, simulation: result };
    });

    // Get simulations for a recommendation
    fastify.get<{
        Params: { recommendationId: string };
    }>('/api/control-plane/recommendations/:recommendationId/simulations', async (request) => {
        const simulations = await CounterfactualSimulator.getForRecommendation(request.params.recommendationId);
        return { success: true, simulations };
    });

    // Check if recommendation should be accepted (based on simulation)
    fastify.get<{
        Params: { recommendationId: string };
    }>('/api/control-plane/recommendations/:recommendationId/should-accept', async (request) => {
        const result = await CounterfactualSimulator.shouldAccept(request.params.recommendationId);
        return { success: true, ...result };
    });

    // ============================================
    // Market Signal Engine Endpoints (Phase 15A)
    // ============================================

    // Generate full market snapshot
    fastify.post('/api/market/snapshot', async () => {
        const snapshot = await MarketSignalEngine.generateSnapshot();
        return { success: true, snapshot };
    });

    // Get latest market snapshot
    fastify.get('/api/market/snapshot/latest', async () => {
        const snapshot = await MarketSignalEngine.getLatest();
        return { success: true, snapshot };
    });

    // Get category health
    fastify.get<{
        Params: { category: string };
    }>('/api/market/categories/:category', async (request, reply) => {
        const health = await MarketSignalEngine.getCategoryHealth(request.params.category);
        if (!health) {
            reply.code(404);
            return { success: false, error: 'Category not found' };
        }
        return { success: true, health };
    });

    // Get zone health
    fastify.get<{
        Params: { zone: string };
    }>('/api/market/zones/:zone', async (request, reply) => {
        const health = await MarketSignalEngine.getZoneHealth(decodeURIComponent(request.params.zone));
        if (!health) {
            reply.code(404);
            return { success: false, error: 'Zone not found' };
        }
        return { success: true, health };
    });

    // Get pricing guidance
    fastify.get<{
        Params: { category: string };
        Querystring: { zone?: string };
    }>('/api/market/pricing/:category', async (request) => {
        const guidance = await MarketSignalEngine.getPricingGuidance(
            request.params.category,
            request.query.zone
        );
        return { success: true, guidance };
    });

    // Detect churn risk
    fastify.get<{
        Querystring: { minDays?: number };
    }>('/api/market/churn-risk', async (request) => {
        const minDays = request.query.minDays || 14;
        const atRisk = await MarketSignalEngine.detectChurnRisk(minDays);
        return { success: true, count: atRisk.length, atRisk };
    });

    // Get expansion readiness
    fastify.get('/api/market/expansion-readiness', async () => {
        const readiness = await MarketSignalEngine.getExpansionReadiness();
        return { success: true, zones: readiness };
    });

    // ============================================
    // Strategic Output Engine Endpoints (Phase 15B)
    // ============================================

    // 1. Pricing Guidance for Posters
    fastify.get<{
        Params: { category: string };
        Querystring: { zone?: string };
    }>('/api/strategy/pricing-guidance/:category', async (request) => {
        const guidance = await StrategicOutputEngine.getPricingGuidance(
            request.params.category,
            request.query.zone
        );
        return { success: true, guidance };
    });

    // 2. Hustler Opportunity Routing
    fastify.get<{
        Params: { userId: string };
        Querystring: { zone: string };
    }>('/api/strategy/hustler-opportunities/:userId', async (request) => {
        const opportunities = await StrategicOutputEngine.getHustlerOpportunities(
            request.params.userId,
            request.query.zone || 'Capitol Hill'
        );
        return { success: true, opportunities };
    });

    // 3. Trust Friction Recommendations (UX-only, cannot block payouts)
    fastify.post<{
        Body: {
            taskId: string;
            category: string;
            price: number;
            posterId: string;
            hustlerId?: string;
        };
    }>('/api/strategy/trust-friction', async (request) => {
        const { taskId, category, price, posterId, hustlerId } = request.body;
        const friction = await StrategicOutputEngine.getTrustFriction(
            taskId, category, price, posterId, hustlerId
        );
        return { success: true, friction };
    });

    // 4. Growth & Expansion Targeting (Ops-facing)
    fastify.get('/api/strategy/growth-targets', async () => {
        const targets = await StrategicOutputEngine.getGrowthTargets();
        return { success: true, targets };
    });

    // ============================================
    // Feedback Flywheel Endpoints (Phase 15C-1)
    // ============================================

    // Flywheel 1: Pricing Feedback (Posters)
    fastify.get<{
        Params: { taskId: string };
    }>('/api/feedback/pricing/:taskId', async (request) => {
        const feedback = await PricingFeedbackService.getFeedback(request.params.taskId);
        return { success: true, feedback };
    });

    fastify.get<{
        Params: { posterId: string };
    }>('/api/feedback/pricing/poster/:posterId', async (request) => {
        const analytics = await PricingFeedbackService.getPosterAnalytics(request.params.posterId);
        return { success: true, analytics };
    });

    // Flywheel 2: Performance Feedback (Hustlers)
    fastify.get<{
        Params: { userId: string };
        Querystring: { days?: number };
    }>('/api/feedback/performance/:userId', async (request) => {
        const days = request.query.days || 30;
        const summary = await PerformanceFeedbackService.getSummary(request.params.userId, days);
        return { success: true, summary };
    });

    fastify.get<{
        Params: { userId: string };
        Querystring: { limit?: number };
    }>('/api/feedback/performance/:userId/recent', async (request) => {
        const limit = request.query.limit || 10;
        const feedback = await PerformanceFeedbackService.getRecentFeedback(request.params.userId, limit);
        return { success: true, feedback };
    });

    // Flywheel 3: Trust Feedback (All Users)
    fastify.get<{
        Params: { taskId: string };
    }>('/api/feedback/trust/:taskId', async (request) => {
        const feedback = await TrustFeedbackService.getFeedback(request.params.taskId);
        return { success: true, feedback };
    });

    fastify.get<{
        Params: { userId: string };
    }>('/api/feedback/trust/profile/:userId', async (request) => {
        const profile = await TrustFeedbackService.getUserTrustProfile(request.params.userId);
        return { success: true, profile };
    });

    // Flywheel 4: Operator Learning
    fastify.get<{
        Querystring: { days?: number };
    }>('/api/control-plane/operator-learning/summary', async (request) => {
        const days = request.query.days || 30;
        const summary = await OperatorLearningService.getSummary(days);
        return { success: true, summary };
    });

    fastify.get('/api/control-plane/operator-learning/recommendations', async () => {
        const recommendations = await OperatorLearningService.getImprovementRecommendations();
        return { success: true, recommendations };
    });

    // ============================================
    // City Domination Engine Endpoints (Phase 16)
    // ============================================

    // 1. City Grid - Micro-zone model
    fastify.get<{
        Params: { city: string };
    }>('/api/city/grid/:city', async (request) => {
        const grid = await CityGridService.getGrid(request.params.city);
        return { success: true, grid };
    });

    fastify.get<{
        Params: { city: string; zone: string };
    }>('/api/city/grid/:city/:zone', async (request) => {
        const cells = await CityGridService.getZoneDetail(request.params.city, request.params.zone);
        return { success: true, cells };
    });

    // 2. Liquidity Heat - Where tasks pile up
    fastify.get<{
        Params: { city: string };
    }>('/api/city/heat/:city', async (request) => {
        const snapshot = await LiquidityHeatEngine.generateSnapshot(request.params.city);
        return { success: true, snapshot };
    });

    fastify.get<{
        Params: { city: string };
    }>('/api/city/heat/:city/critical', async (request) => {
        const critical = await LiquidityHeatEngine.getCriticalZones(request.params.city);
        return { success: true, critical };
    });

    // 3. Opportunity Bursts - Non-monetary nudges
    fastify.get<{
        Params: { userId: string };
        Querystring: { zone?: string };
    }>('/api/city/opportunities/:userId', async (request) => {
        const zone = request.query.zone || 'Capitol Hill';
        const opportunities = await OpportunityBurstEngine.getOpportunities(request.params.userId, zone);
        return { success: true, opportunities };
    });

    fastify.post<{
        Params: { city: string };
    }>('/api/city/opportunities/:city/generate', async (request) => {
        const bursts = await OpportunityBurstEngine.generateCityBursts(request.params.city);
        return { success: true, bursts };
    });

    // 4. Defensibility Score - How hard to displace
    fastify.get<{
        Params: { city: string };
    }>('/api/city/defensibility/:city', async (request) => {
        const defensibility = await DefensibilityScoreService.getCityDefensibility(request.params.city);
        return { success: true, defensibility };
    });

    fastify.get<{
        Params: { city: string };
    }>('/api/city/defensibility/:city/threats', async (request) => {
        const threats = await DefensibilityScoreService.getCompetitiveThreats(request.params.city);
        return { success: true, threats };
    });

    // 5. Expansion Decisions - Where to push/hold/retreat
    fastify.get<{
        Params: { city: string };
    }>('/api/city/expansion/:city', async (request) => {
        const plan = await ExpansionDecisionEngine.getExpansionPlan(request.params.city);
        return { success: true, plan };
    });

    fastify.get<{
        Params: { city: string };
    }>('/api/city/expansion/:city/priorities', async (request) => {
        const priorities = await ExpansionDecisionEngine.getPriorityActions(request.params.city);
        return { success: true, priorities };
    });

    // ============================================
    // Winner-Take-Most Dynamics Endpoints (Phase 17)
    // ============================================

    // 1. Liquidity Lock-In - Zone stickiness
    fastify.get<{
        Params: { zone: string };
    }>('/api/dominance/liquidity-lockin/:zone', async (request) => {
        const lockIn = await LiquidityLockInEngine.calculateLockIn(request.params.zone);
        return { success: true, lockIn };
    });

    fastify.get<{
        Params: { city: string };
    }>('/api/dominance/liquidity-lockin/city/:city', async (request) => {
        const overview = await LiquidityLockInEngine.getCityOverview(request.params.city);
        return { success: true, overview };
    });

    // 2. Task Chaining - Multi-task sequences
    fastify.get<{
        Params: { zone: string };
    }>('/api/dominance/task-chains/:zone', async (request) => {
        const metrics = await TaskChainingEngine.getZoneChainingMetrics(request.params.zone);
        return { success: true, metrics };
    });

    fastify.get<{
        Params: { hustlerId: string };
    }>('/api/dominance/task-chains/hustler/:hustlerId', async (request) => {
        const chains = await TaskChainingEngine.getHustlerChains(request.params.hustlerId);
        return { success: true, chains };
    });

    // 3. Reputation Compounding - Trust velocity
    fastify.get<{
        Params: { zone: string };
    }>('/api/dominance/reputation/:zone', async (request) => {
        const metrics = await ReputationCompoundingService.getZoneMetrics(request.params.zone);
        return { success: true, metrics };
    });

    fastify.get<{
        Params: { userId: string };
    }>('/api/dominance/reputation/user/:userId', async (request) => {
        const profile = await ReputationCompoundingService.getUserProfile(request.params.userId);
        return { success: true, profile };
    });

    // 4. Exit Friction - Natural switching costs (non-coercive)
    fastify.get<{
        Params: { zone: string };
    }>('/api/dominance/exit-friction/:zone', async (request) => {
        const analysis = await ExitFrictionAnalyzer.analyzeZone(request.params.zone);
        return { success: true, analysis };
    });

    fastify.get<{
        Params: { userId: string };
    }>('/api/dominance/exit-friction/user/:userId', async (request) => {
        const profile = await ExitFrictionAnalyzer.analyzeUserExitCost(request.params.userId);
        return { success: true, profile };
    });

    // 5. Zone Takeover - Winner-take-most threshold
    fastify.get<{
        Params: { zone: string };
    }>('/api/dominance/takeover/:zone', async (request) => {
        const state = await ZoneTakeoverEngine.getZoneState(request.params.zone);
        return { success: true, state };
    });

    fastify.get<{
        Params: { city: string };
    }>('/api/dominance/takeover/city/:city', async (request) => {
        const summary = await ZoneTakeoverEngine.getCityTakeoverSummary(request.params.city);
        return { success: true, summary };
    });
}
