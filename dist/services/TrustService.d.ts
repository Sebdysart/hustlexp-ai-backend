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
declare class TrustServiceClass {
    private getSqlClient;
    private buildHandle;
    private resolveCity;
    private getTaskStats;
    getPublicProfile(userId: string): Promise<PublicProfile>;
    getTaskHistory(userId: string, options?: {
        limit?: number;
        offset?: number;
    }): Promise<{
        total: number;
        items: TaskHistoryItem[];
    }>;
    getMutualTaskConnections(userA: string, userB: string): Promise<number>;
    private computeTrustScore;
    getTrustSummary(targetUserId: string, viewerUserId?: string): Promise<{
        profile: PublicProfile;
        task_stats: {
            completed_total: number;
            completed_as_worker: number;
            completed_as_poster: number;
            avg_rating: number | null;
            last_active_at: string | null;
        };
        mutual_task_connections: number | null;
        trust_score: {
            score: number;
            cap: number;
            breakdown: {
                task_points: number;
                five_star_points: number;
                mutual_points: number;
            };
        };
    }>;
}
export declare const TrustService: TrustServiceClass;
export {};
//# sourceMappingURL=TrustService.d.ts.map