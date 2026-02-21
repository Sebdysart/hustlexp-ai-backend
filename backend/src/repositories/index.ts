/**
 * Repository Layer
 *
 * Provides data access abstractions that decouple services from raw SQL.
 * All repositories accept an optional RepositoryContext for transaction support.
 *
 * Usage:
 *   import { taskRepository, userRepository, escrowRepository } from './repositories';
 *
 *   // Simple query
 *   const task = await taskRepository.findById(taskId);
 *
 *   // Within a transaction
 *   await db.transaction(async (query) => {
 *     const task = await taskRepository.findById(taskId, { query });
 *     await escrowRepository.updateState(escrowId, 'RELEASED', { query });
 *   });
 */

export { BaseRepository, type RepositoryContext } from './BaseRepository';
export { TaskRepository, taskRepository } from './TaskRepository';
export { UserRepository, userRepository } from './UserRepository';
export { EscrowRepository, escrowRepository } from './EscrowRepository';
