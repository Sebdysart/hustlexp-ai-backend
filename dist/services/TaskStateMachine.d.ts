/**
 * TASK STATE MACHINE (BUILD_GUIDE Phase 2)
 *
 * Implements the task lifecycle state machine from BUILD_GUIDE.
 *
 * STATES:
 * - OPEN: Task posted, awaiting hustler
 * - ACCEPTED: Hustler assigned, escrow funded
 * - PROOF_SUBMITTED: Hustler submitted completion proof
 * - DISPUTED: Proof rejected, under review
 * - COMPLETED: Task finished, XP awarded (terminal)
 * - CANCELLED: Task cancelled (terminal)
 * - EXPIRED: Task deadline passed (terminal)
 *
 * INVARIANTS ENFORCED:
 * - INV-2: COMPLETED requires RELEASED escrow
 * - INV-3: COMPLETED requires ACCEPTED proof
 * - Terminal states immutable
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
export type TaskState = 'OPEN' | 'ACCEPTED' | 'PROOF_SUBMITTED' | 'DISPUTED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
export declare const TERMINAL_STATES: TaskState[];
export interface TransitionContext {
    hustlerId?: string;
    proofId?: string;
    proofState?: string;
    escrowState?: string;
    reason?: string;
    adminId?: string;
}
export interface TransitionResult {
    success: boolean;
    previousState: TaskState;
    newState: TaskState;
    error?: string;
}
export declare const TASK_TRANSITIONS: Record<TaskState, TaskState[]>;
declare class TaskStateMachineClass {
    /**
     * Check if a transition is valid
     */
    canTransition(from: TaskState, to: TaskState): boolean;
    /**
     * Execute a state transition
     */
    transition(taskId: string, targetState: TaskState, context?: TransitionContext): Promise<TransitionResult>;
    /**
     * Get current task state
     */
    getState(taskId: string): Promise<TaskState | null>;
    /**
     * Get state history for a task
     */
    getHistory(taskId: string): Promise<Array<{
        fromState: TaskState;
        toState: TaskState;
        context: TransitionContext;
        createdAt: Date;
    }>>;
}
export declare const TaskStateMachine: TaskStateMachineClass;
export {};
//# sourceMappingURL=TaskStateMachine.d.ts.map