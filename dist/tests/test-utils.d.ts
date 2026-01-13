/**
 * TEST UTILITIES (BUILD_GUIDE Phase 5)
 *
 * Common utilities for test suites.
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
/**
 * Create a test user
 */
export declare function createTestUser(overrides?: {
    email?: string;
    type?: 'client' | 'hustler';
    trustTier?: number;
}): Promise<{
    id: string;
    email: string;
}>;
/**
 * Create a test task with escrow
 */
export declare function createTestTask(clientId: string, overrides?: {
    price?: number;
    status?: string;
    hustlerId?: string;
}): Promise<{
    id: string;
    price: number;
}>;
/**
 * Complete a task flow (for setup)
 */
export declare function completeTaskFlow(taskId: string, hustlerId: string): Promise<void>;
/**
 * Clean up all test data for a user
 */
export declare function cleanupTestUser(userId: string): Promise<void>;
/**
 * Assert XP was awarded exactly once
 */
export declare function assertXPAwardedOnce(taskId: string): Promise<number>;
/**
 * Assert state machine is in expected state
 */
export declare function assertTaskState(taskId: string, expected: string): Promise<void>;
export declare function assertEscrowState(taskId: string, expected: string): Promise<void>;
/**
 * Sleep for specified milliseconds
 */
export declare function sleep(ms: number): Promise<void>;
/**
 * Run with timeout
 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage?: string): Promise<T>;
//# sourceMappingURL=test-utils.d.ts.map