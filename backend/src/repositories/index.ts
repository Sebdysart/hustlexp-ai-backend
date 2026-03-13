/**
 * Repository Layer
 *
 * Provides data access abstractions that decouple services from raw SQL.
 * All repositories accept an optional RepositoryContext for transaction support.
 *
 * Usage:
 *   import { taskRepository, userRepository, escrowRepository } from './repositories.js';
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

export { BaseRepository, type RepositoryContext } from './BaseRepository.js';
export { TaskRepository, taskRepository } from './TaskRepository.js';
export { UserRepository, userRepository } from './UserRepository.js';
export { EscrowRepository, escrowRepository } from './EscrowRepository.js';
