import type { User, HustlerProfile } from '../types/index.js';
import { serviceLogger } from '../utils/logger.js';

// In-memory store - replace with database later
const users: Map<string, User> = new Map();
const hustlerProfiles: Map<string, HustlerProfile> = new Map();

// Add some mock users for development
users.set('test-client', {
    id: 'test-client',
    email: 'client@example.com',
    name: 'Test Client',
    role: 'client',
    createdAt: new Date(),
});

users.set('test-hustler', {
    id: 'test-hustler',
    email: 'hustler@example.com',
    name: 'Test Hustler',
    role: 'hustler',
    createdAt: new Date(),
});

hustlerProfiles.set('test-hustler', {
    userId: 'test-hustler',
    skills: ['delivery', 'errands', 'moving'],
    rating: 4.7,
    completedTasks: 23,
    completionRate: 0.91,
    xp: 1150,
    level: 5,
    streak: 3,
    latitude: 47.6062,
    longitude: -122.3321,
    isActive: true,
    bio: 'Ready to hustle!',
});

export interface UserStats {
    xp: number;
    level: number;
    streak: number;
    tasksCompleted: number;
    rating: number;
    totalEarnings: number;
}

class UserServiceClass {
    async getUser(userId: string): Promise<User | null> {
        return users.get(userId) || null;
    }

    async createUser(user: Omit<User, 'id' | 'createdAt'>): Promise<User> {
        const newUser: User = {
            ...user,
            id: `user-${Date.now()}`,
            createdAt: new Date(),
        };
        users.set(newUser.id, newUser);
        serviceLogger.info({ userId: newUser.id }, 'User created');
        return newUser;
    }

    async getHustlerProfile(userId: string): Promise<HustlerProfile | null> {
        return hustlerProfiles.get(userId) || null;
    }

    async getUserStats(userId: string): Promise<UserStats | null> {
        const profile = hustlerProfiles.get(userId);
        if (!profile) return null;

        return {
            xp: profile.xp,
            level: profile.level,
            streak: profile.streak,
            tasksCompleted: profile.completedTasks,
            rating: profile.rating,
            totalEarnings: profile.completedTasks * 35, // Mock estimate
        };
    }

    async updateHustlerLocation(userId: string, lat: number, lng: number): Promise<void> {
        const profile = hustlerProfiles.get(userId);
        if (profile) {
            profile.latitude = lat;
            profile.longitude = lng;
        }
    }

    async setHustlerActive(userId: string, isActive: boolean): Promise<void> {
        const profile = hustlerProfiles.get(userId);
        if (profile) {
            profile.isActive = isActive;
            serviceLogger.info({ userId, isActive }, 'Hustler active status updated');
        }
    }
}

export const UserService = new UserServiceClass();
