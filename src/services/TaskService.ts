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

// In-memory store - replace with database later
const tasks: Map<string, Task> = new Map();

// Mock hustlers for development
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

        tasks.set(task.id, task);
        serviceLogger.info({ taskId: task.id, category: task.category }, 'Task created');

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
        return tasks.get(taskId) || null;
    }

    async searchTasks(args: SearchTasksArgs): Promise<Task[]> {
        let results = Array.from(tasks.values());

        // Filter by category
        if (args.category) {
            results = results.filter(t => t.category === args.category);
        }

        // Filter by price range
        if (args.minPrice !== undefined) {
            results = results.filter(t => t.recommendedPrice >= args.minPrice!);
        }
        if (args.maxPrice !== undefined) {
            results = results.filter(t => t.recommendedPrice <= args.maxPrice!);
        }

        // Filter by status (only open tasks)
        results = results.filter(t => t.status === 'open');

        // Limit results
        if (args.limit) {
            results = results.slice(0, args.limit);
        }

        return results;
    }

    async getOpenTasksForHustler(hustlerId: string, limit = 20): Promise<Task[]> {
        // In a real implementation, this would filter by hustler's skills and location
        return Array.from(tasks.values())
            .filter(t => t.status === 'open')
            .slice(0, limit);
    }

    async getCandidateHustlers(task: Task, limit = 20): Promise<HustlerCandidate[]> {
        // Basic candidate ranking algorithm
        const candidates: HustlerCandidate[] = mockHustlers
            .filter(h => h.isActive)
            .filter(h => h.skills.includes(task.category))
            .map(hustler => {
                // Calculate distance if both have coordinates
                let distanceKm: number | undefined;
                if (task.latitude && task.longitude && hustler.latitude && hustler.longitude) {
                    distanceKm = this.calculateDistance(
                        task.latitude, task.longitude,
                        hustler.latitude, hustler.longitude
                    );
                }

                // Calculate basic score
                const ratingScore = hustler.rating * 20; // 0-100
                const completionScore = hustler.completionRate * 30; // 0-30
                const xpScore = Math.min(hustler.xp / 100, 25); // 0-25
                const distanceScore = distanceKm ? Math.max(25 - distanceKm * 2, 0) : 10; // 0-25

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
        const task = tasks.get(taskId);
        if (!task) return null;

        task.assignedHustlerId = hustlerId;
        task.status = 'assigned';
        task.updatedAt = new Date();

        serviceLogger.info({ taskId, hustlerId }, 'Hustler assigned to task');
        return task;
    }

    async completeTask(taskId: string): Promise<Task | null> {
        const task = tasks.get(taskId);
        if (!task) return null;

        task.status = 'completed';
        task.updatedAt = new Date();

        serviceLogger.info({ taskId }, 'Task completed');
        return task;
    }

    private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        // Haversine formula
        const R = 6371; // Earth's radius in km
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
}

export const TaskService = new TaskServiceClass();
