import { getSql } from '../db/index.js';
import { CityService } from './CityService.js';
import { createLogger } from '../utils/logger.js';

const trustLogger = createLogger('TrustService');

export interface PublicProfile {
    user_id: string;
    name: string;
    handle: string;
    city: string | null;
    xp: number;
    level: number;
    tasks_completed: number;
    categories_worked_in: string[];
    avg_rating: number | null;
    last_active_at: string | null;
    verification: {
        email: boolean;
        phone: boolean;
    };
}

export interface TaskHistoryItem {
    task_id: string;
    category: string;
    price: number;
    completed_at: string;
    role: 'worker' | 'poster';
    approved_by_poster: boolean;
}

interface TaskStats {
    totalCompleted: number;
    completedAsWorker: number;
    completedAsPoster: number;
    avgRating: number | null;
    lastActiveAt: string | null;
    fiveStarCount: number;
    categories: string[];
}

class TrustServiceClass {
    private getSqlClient() {
        return getSql();
    }

    private buildHandle(name: string | null, userId: string): string {
        const base = (name || 'hustler')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 18) || 'hustler';
        return `${base}-${userId.slice(0, 6)}`;
    }

    private resolveCity(latitude?: number | null, longitude?: number | null): string | null {
        if (latitude == null || longitude == null) {
            return null;
        }
        const result = CityService.resolveCityFromLatLng(Number(latitude), Number(longitude));
        return result.city?.name || null;
    }

    private async getTaskStats(userId: string): Promise<TaskStats> {
        const sql = this.getSqlClient();

        const statsRows = await sql`
            SELECT
                COUNT(*)::int AS total_completed,
                COUNT(*) FILTER (WHERE hustler_id = ${userId})::int AS completed_as_worker,
                COUNT(*) FILTER (WHERE client_id = ${userId})::int AS completed_as_poster,
                AVG(rating)::numeric AS avg_rating,
                MAX(completed_at) AS last_active_at,
                COUNT(*) FILTER (WHERE rating = 5)::int AS five_star_count
            FROM completions
            WHERE hustler_id = ${userId} OR client_id = ${userId}
        `;

        const categoriesRows = await sql`
            SELECT category, COUNT(*)::int AS count
            FROM completions
            WHERE hustler_id = ${userId} OR client_id = ${userId}
            GROUP BY category
            ORDER BY count DESC
            LIMIT 10
        `;

        const statsRow = statsRows[0] || {};

        return {
            totalCompleted: Number(statsRow.total_completed || 0),
            completedAsWorker: Number(statsRow.completed_as_worker || 0),
            completedAsPoster: Number(statsRow.completed_as_poster || 0),
            avgRating: statsRow.avg_rating !== null && statsRow.avg_rating !== undefined ? Number(statsRow.avg_rating) : null,
            lastActiveAt: statsRow.last_active_at ? new Date(statsRow.last_active_at).toISOString() : null,
            fiveStarCount: Number(statsRow.five_star_count || 0),
            categories: categoriesRows.map((row: any) => row.category as string),
        };
    }

    async getPublicProfile(userId: string): Promise<PublicProfile> {
        const sql = this.getSqlClient();

        const userRows = await sql`
            SELECT id, name
            FROM users
            WHERE id = ${userId}
            LIMIT 1
        `;
        const user = userRows[0];
        if (!user) {
            const error = new Error('USER_NOT_FOUND');
            (error as any).code = 'USER_NOT_FOUND';
            throw error;
        }

        const profileRows = await sql`
            SELECT xp, level, streak, rating, completed_tasks, latitude, longitude
            FROM hustler_profiles
            WHERE user_id = ${userId}
            LIMIT 1
        `;
        const profile = profileRows[0] || {};

        const verificationRows = await sql`
            SELECT email_verified, phone_verified
            FROM identity_verification
            WHERE user_id = ${userId}
            LIMIT 1
        `;
        const verification = verificationRows[0] || {};

        const stats = await this.getTaskStats(userId);

        return {
            user_id: user.id,
            name: user.name,
            handle: this.buildHandle(user.name, user.id),
            city: this.resolveCity(profile.latitude, profile.longitude),
            xp: Number(profile.xp || 0),
            level: Number(profile.level || 1),
            tasks_completed: stats.totalCompleted,
            categories_worked_in: stats.categories,
            avg_rating: stats.avgRating,
            last_active_at: stats.lastActiveAt,
            verification: {
                email: verification.email_verified === true,
                phone: verification.phone_verified === true,
            },
        };
    }

    async getTaskHistory(userId: string, options?: { limit?: number; offset?: number }): Promise<{
        total: number;
        items: TaskHistoryItem[];
    }> {
        const sql = this.getSqlClient();
        const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
        const offset = Math.max(options?.offset ?? 0, 0);

        const rows = await sql`
            SELECT
                c.task_id,
                c.category,
                c.earnings AS price,
                c.completed_at,
                CASE WHEN c.hustler_id = ${userId} THEN 'worker' ELSE 'poster' END AS role,
                COALESCE(t.status = 'completed', true) AS approved_by_poster
            FROM completions c
            LEFT JOIN tasks t ON t.id = c.task_id
            WHERE c.hustler_id = ${userId} OR c.client_id = ${userId}
            ORDER BY c.completed_at DESC
            LIMIT ${limit}
            OFFSET ${offset}
        `;

        const totalRows = await sql`
            SELECT COUNT(*)::int AS total
            FROM completions
            WHERE hustler_id = ${userId} OR client_id = ${userId}
        `;

        return {
            total: Number(totalRows[0]?.total || 0),
            items: rows.map((row: any) => ({
                task_id: row.task_id,
                category: row.category,
                price: Number(row.price),
                completed_at: new Date(row.completed_at).toISOString(),
                role: row.role as 'worker' | 'poster',
                approved_by_poster: row.approved_by_poster === true,
            })),
        };
    }

    async getMutualTaskConnections(userA: string, userB: string): Promise<number> {
        const sql = this.getSqlClient();

        const rows = await sql`
            WITH poster_shared AS (
                SELECT client_id AS partner_id
                FROM completions
                WHERE hustler_id = ${userA}
                INTERSECT
                SELECT client_id AS partner_id
                FROM completions
                WHERE hustler_id = ${userB}
            ),
            hustler_shared AS (
                SELECT hustler_id AS partner_id
                FROM completions
                WHERE client_id = ${userA}
                INTERSECT
                SELECT hustler_id AS partner_id
                FROM completions
                WHERE client_id = ${userB}
            ),
            combined AS (
                SELECT partner_id FROM poster_shared
                UNION
                SELECT partner_id FROM hustler_shared
            )
            SELECT COUNT(*)::int AS mutual_count FROM combined
        `;

        return Number(rows[0]?.mutual_count || 0);
    }

    private computeTrustScore(stats: TaskStats, mutualConnections: number) {
        const taskPoints = stats.totalCompleted * 5;
        const ratingPoints = stats.fiveStarCount * 10;
        const mutualPoints = mutualConnections * 5;
        const cap = 500;
        const score = Math.min(taskPoints + ratingPoints + mutualPoints, cap);

        return {
            score,
            cap,
            breakdown: {
                task_points: taskPoints,
                five_star_points: ratingPoints,
                mutual_points: mutualPoints,
            },
        };
    }

    async getTrustSummary(targetUserId: string, viewerUserId?: string) {
        const sql = this.getSqlClient();

        const profile = await this.getPublicProfile(targetUserId);
        const stats = await this.getTaskStats(targetUserId);

        let mutualConnections: number | null = null;
        if (viewerUserId) {
            mutualConnections = await this.getMutualTaskConnections(targetUserId, viewerUserId);
        }

        const trustScore = this.computeTrustScore(stats, mutualConnections || 0);

        const summary = {
            profile,
            task_stats: {
                completed_total: stats.totalCompleted,
                completed_as_worker: stats.completedAsWorker,
                completed_as_poster: stats.completedAsPoster,
                avg_rating: stats.avgRating,
                last_active_at: stats.lastActiveAt,
            },
            mutual_task_connections: mutualConnections,
            trust_score: trustScore,
        };

        trustLogger.debug({
            targetUserId,
            viewerUserId,
            mutualConnections,
            trustScore: trustScore.score,
        }, 'Computed trust summary');

        return summary;
    }
}

export const TrustService = new TrustServiceClass();
