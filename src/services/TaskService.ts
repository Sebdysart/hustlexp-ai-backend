import { v4 as uuidv4 } from 'uuid';
import type {
    Task,
    TaskDraft,
    TaskCategory,
    TaskFlag,
    HustlerCandidate,
    HustlerProfile
} from '../types/index.js';
import { serviceLogger } from '../utils/logger.js';
import { sql, isDatabaseAvailable } from '../db/index.js';

// In-memory store as fallback when database is not available
const tasksMemory: Map<string, Task> = new Map();

// Mock hustlers for fallback
const mockHustlers: HustlerProfile[] = [
    {
        userId: 'hustler-1',
        skills: ['delivery', 'errands', 'moving'],
        rating: 4.8,
        completedTasks: 47,
        completionRate: 0.94,
        xp: 2350,
        level: 8,
        streak: 5,
        latitude: 47.6062,
        longitude: -122.3321,
        isActive: true,
        bio: 'Quick and reliable, I have a truck!'
    },
    {
        userId: 'hustler-2',
        skills: ['cleaning', 'pet_care', 'yard_work'],
        rating: 4.9,
        completedTasks: 83,
        completionRate: 0.97,
        xp: 4120,
        level: 12,
        streak: 14,
        latitude: 47.6205,
        longitude: -122.3493,
        isActive: true,
        bio: 'Pet lover and cleaning expert'
    },
    {
        userId: 'hustler-3',
        skills: ['handyman', 'tech_help', 'moving'],
        rating: 4.7,
        completedTasks: 31,
        completionRate: 0.90,
        xp: 1550,
        level: 6,
        streak: 2,
        latitude: 47.6097,
        longitude: -122.3331,
        isActive: true,
        bio: 'Handy with tools and tech'
    }
];

export interface CreateTaskArgs {
    clientId: string;
    title: string;
    description: string;
    category: TaskCategory;
    minPrice?: number;
    recommendedPrice: number;
    maxPrice?: number;
    locationText?: string;
    latitude?: number;
    longitude?: number;
    timeWindow?: { start: Date; end: Date };
    flags?: TaskFlag[];
}

export interface SearchTasksArgs {
    category?: TaskCategory;
    maxDistance?: number;
    minPrice?: number;
    maxPrice?: number;
    limit?: number;
}

class TaskServiceClass {
    async createTask(args: CreateTaskArgs): Promise<Task> {
        const task: Task = {
            id: uuidv4(),
            clientId: args.clientId,
            title: args.title,
            description: args.description,
            category: args.category,
            minPrice: args.minPrice || args.recommendedPrice * 0.8,
            recommendedPrice: args.recommendedPrice,
            maxPrice: args.maxPrice,
            locationText: args.locationText,
            latitude: args.latitude,
            longitude: args.longitude,
            timeWindow: args.timeWindow,
            flags: args.flags || [],
            status: 'open',
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        if (isDatabaseAvailable() && sql) {
            try {
                await sql`
          INSERT INTO tasks (
            id, client_id, title, description, category, 
            min_price, recommended_price, max_price,
            location_text, latitude, longitude,
            time_window_start, time_window_end, flags, status
          ) VALUES (
            ${task.id}, ${task.clientId}, ${task.title}, ${task.description}, ${task.category},
            ${task.minPrice}, ${task.recommendedPrice}, ${task.maxPrice || null},
            ${task.locationText || null}, ${task.latitude || null}, ${task.longitude || null},
            ${task.timeWindow?.start || null}, ${task.timeWindow?.end || null},
            ${task.flags}, ${task.status}
          )
        `;
                serviceLogger.info({ taskId: task.id, category: task.category, db: true }, 'Task created in database');
            } catch (error) {
                serviceLogger.error({ error }, 'Failed to create task in database, using memory');
                tasksMemory.set(task.id, task);
            }
        } else {
            tasksMemory.set(task.id, task);
            serviceLogger.info({ taskId: task.id, category: task.category, db: false }, 'Task created in memory');
        }

        return task;
    }

    async createTaskFromDraft(clientId: string, draft: TaskDraft): Promise<Task> {
        return this.createTask({
            clientId,
            title: draft.title,
            description: draft.description,
            category: draft.category,
            minPrice: draft.minPrice,
            recommendedPrice: draft.recommendedPrice,
            maxPrice: draft.maxPrice,
            locationText: draft.locationText,
            timeWindow: draft.timeWindow
                ? { start: new Date(draft.timeWindow.start), end: new Date(draft.timeWindow.end) }
                : undefined,
            flags: draft.flags,
        });
    }

    async getTask(taskId: string): Promise<Task | null> {
        if (isDatabaseAvailable() && sql) {
            try {
                const rows = await sql`SELECT * FROM tasks WHERE id = ${taskId}`;
                if (rows.length === 0) return null;
                return this.rowToTask(rows[0]);
            } catch (error) {
                serviceLogger.error({ error }, 'Failed to get task from database');
            }
        }
        return tasksMemory.get(taskId) || null;
    }

    async searchTasks(args: SearchTasksArgs): Promise<Task[]> {
        if (isDatabaseAvailable() && sql) {
            try {
                let query = `SELECT * FROM tasks WHERE status = 'open'`;
                const params: unknown[] = [];

                if (args.category) {
                    params.push(args.category);
                    query += ` AND category = $${params.length}`;
                }
                if (args.minPrice !== undefined) {
                    params.push(args.minPrice);
                    query += ` AND recommended_price >= $${params.length}`;
                }
                if (args.maxPrice !== undefined) {
                    params.push(args.maxPrice);
                    query += ` AND recommended_price <= $${params.length}`;
                }

                query += ` ORDER BY created_at DESC`;

                if (args.limit) {
                    params.push(args.limit);
                    query += ` LIMIT $${params.length}`;
                }

                const rows = await sql(query, params);
                return rows.map(row => this.rowToTask(row));
            } catch (error) {
                serviceLogger.error({ error }, 'Failed to search tasks from database');
            }
        }

        // Fallback to memory
        let results = Array.from(tasksMemory.values());

        if (args.category) {
            results = results.filter(t => t.category === args.category);
        }
        if (args.minPrice !== undefined) {
            results = results.filter(t => t.recommendedPrice >= args.minPrice!);
        }
        if (args.maxPrice !== undefined) {
            results = results.filter(t => t.recommendedPrice <= args.maxPrice!);
        }
        results = results.filter(t => t.status === 'open');
        if (args.limit) {
            results = results.slice(0, args.limit);
        }

        return results;
    }

    async getOpenTasksForHustler(hustlerId: string, limit = 20): Promise<Task[]> {
        if (isDatabaseAvailable() && sql) {
            try {
                const rows = await sql`
          SELECT * FROM tasks 
          WHERE status = 'open' 
          ORDER BY created_at DESC 
          LIMIT ${limit}
        `;
                return rows.map(row => this.rowToTask(row));
            } catch (error) {
                serviceLogger.error({ error }, 'Failed to get tasks from database');
            }
        }

        return Array.from(tasksMemory.values())
            .filter(t => t.status === 'open')
            .slice(0, limit);
    }

    async getCandidateHustlers(task: Task, limit = 20): Promise<HustlerCandidate[]> {
        let hustlers: HustlerProfile[] = [];

        if (isDatabaseAvailable() && sql) {
            try {
                const rows = await sql`
          SELECT * FROM hustler_profiles 
          WHERE is_active = true 
          AND ${task.category} = ANY(skills)
          ORDER BY rating DESC
          LIMIT ${limit * 2}
        `;
                hustlers = rows.map(row => this.rowToHustlerProfile(row));
            } catch (error) {
                serviceLogger.error({ error }, 'Failed to get hustlers from database');
                hustlers = mockHustlers.filter(h => h.isActive && h.skills.includes(task.category));
            }
        } else {
            hustlers = mockHustlers.filter(h => h.isActive && h.skills.includes(task.category));
        }

        // Score and rank candidates
        const candidates: HustlerCandidate[] = hustlers.map(hustler => {
            let distanceKm: number | undefined;
            if (task.latitude && task.longitude && hustler.latitude && hustler.longitude) {
                distanceKm = this.calculateDistance(
                    task.latitude, task.longitude,
                    hustler.latitude, hustler.longitude
                );
            }

            const ratingScore = hustler.rating * 20;
            const completionScore = hustler.completionRate * 30;
            const xpScore = Math.min(hustler.xp / 100, 25);
            const distanceScore = distanceKm ? Math.max(25 - distanceKm * 2, 0) : 10;

            const score = ratingScore + completionScore + xpScore + distanceScore;

            return {
                ...hustler,
                score,
                distanceKm,
                matchReasons: this.getMatchReasons(hustler, task),
            };
        })
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        return candidates;
    }

    async assignHustler(taskId: string, hustlerId: string): Promise<Task | null> {
        if (isDatabaseAvailable() && sql) {
            try {
                await sql`
          UPDATE tasks 
          SET assigned_hustler_id = ${hustlerId}, status = 'assigned', updated_at = NOW()
          WHERE id = ${taskId}
        `;
                return this.getTask(taskId);
            } catch (error) {
                serviceLogger.error({ error }, 'Failed to assign hustler in database');
            }
        }

        const task = tasksMemory.get(taskId);
        if (!task) return null;

        task.assignedHustlerId = hustlerId;
        task.status = 'assigned';
        task.updatedAt = new Date();

        serviceLogger.info({ taskId, hustlerId }, 'Hustler assigned to task');
        return task;
    }

    async completeTask(taskId: string): Promise<Task | null> {
        if (isDatabaseAvailable() && sql) {
            try {
                await sql`
          UPDATE tasks 
          SET status = 'completed', updated_at = NOW()
          WHERE id = ${taskId}
        `;
                return this.getTask(taskId);
            } catch (error) {
                serviceLogger.error({ error }, 'Failed to complete task in database');
            }
        }

        const task = tasksMemory.get(taskId);
        if (!task) return null;

        task.status = 'completed';
        task.updatedAt = new Date();

        serviceLogger.info({ taskId }, 'Task completed');
        return task;
    }

    private rowToTask(row: Record<string, unknown>): Task {
        return {
            id: row.id as string,
            clientId: row.client_id as string,
            title: row.title as string,
            description: row.description as string,
            category: row.category as TaskCategory,
            minPrice: Number(row.min_price),
            recommendedPrice: Number(row.recommended_price),
            maxPrice: row.max_price ? Number(row.max_price) : undefined,
            locationText: row.location_text as string | undefined,
            latitude: row.latitude ? Number(row.latitude) : undefined,
            longitude: row.longitude ? Number(row.longitude) : undefined,
            timeWindow: row.time_window_start ? {
                start: new Date(row.time_window_start as string),
                end: new Date(row.time_window_end as string),
            } : undefined,
            flags: (row.flags as TaskFlag[]) || [],
            status: row.status as Task['status'],
            assignedHustlerId: row.assigned_hustler_id as string | undefined,
            createdAt: new Date(row.created_at as string),
            updatedAt: new Date(row.updated_at as string),
        };
    }

    private rowToHustlerProfile(row: Record<string, unknown>): HustlerProfile {
        return {
            userId: row.user_id as string,
            skills: (row.skills as TaskCategory[]) || [],
            rating: Number(row.rating),
            completedTasks: Number(row.completed_tasks),
            completionRate: Number(row.completion_rate),
            xp: Number(row.xp),
            level: Number(row.level),
            streak: Number(row.streak),
            latitude: row.latitude ? Number(row.latitude) : undefined,
            longitude: row.longitude ? Number(row.longitude) : undefined,
            isActive: row.is_active as boolean,
            bio: row.bio as string | undefined,
        };
    }

    private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371;
        const dLat = this.toRad(lat2 - lat1);
        const dLon = this.toRad(lon2 - lon1);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    private toRad(deg: number): number {
        return deg * (Math.PI / 180);
    }

    private getMatchReasons(hustler: HustlerProfile, task: Task): string[] {
        const reasons: string[] = [];

        if (hustler.skills.includes(task.category)) {
            reasons.push(`Skilled in ${task.category}`);
        }
        if (hustler.rating >= 4.8) {
            reasons.push('Top-rated hustler');
        }
        if (hustler.completionRate >= 0.95) {
            reasons.push('Highly reliable');
        }
        if (hustler.streak >= 7) {
            reasons.push('Active streak - motivated');
        }

        return reasons;
    }

    async getTaskWithEscrow(taskId: string): Promise<Task & { hustlerPayout: number; posterId: string }> {
        // For Beta, we assume recommendedPrice is the agreed price.
        // In full prod, we might have an 'agreed_price' column or separate 'escrow' table entry.
        // But money_state_lock is now the source of state truth.
        const task = await this.getTask(taskId);
        if (!task) throw new Error(`Task ${taskId} not found`);

        // We assume posterId is clientId (mapped in rowToTask)
        return {
            ...task,
            posterId: task.clientId,
            hustlerPayout: task.recommendedPrice
        };
    }
}

export const TaskService = new TaskServiceClass();

