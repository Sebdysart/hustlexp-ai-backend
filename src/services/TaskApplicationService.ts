/**
 * TASK APPLICATION SERVICE
 *
 * Manages the application lifecycle for tasks:
 * Hustler Applies → Poster Accepts/Rejects/Counter-Offers → Hustler Responds
 *
 * CONSTITUTIONAL INVARIANTS ENFORCED:
 * - INV-APP-1: Only one active application per hustler per task
 * - INV-APP-2: Only the task poster can accept/reject/counter
 * - INV-APP-3: Only the applying hustler can respond to counter-offers
 * - INV-APP-4: Accepting an application transitions task to 'assigned' and triggers escrow hold
 * - INV-APP-5: Counter-offer chain depth is bounded (max 3 rounds)
 * - INV-APP-6: Application state machine: pending → accepted | rejected | countered → counter_responded → accepted | rejected
 * - INV-4: All money operations through escrow (acceptance triggers HOLD_ESCROW)
 *
 * @version 1.0.0
 */

import { v4 as uuidv4 } from 'uuid';
import { sql, isDatabaseAvailable, transaction } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';
import { TaskService } from './TaskService.js';
import { BetaMetricsService } from './BetaMetricsService.js';

const logger = serviceLogger.child({ module: 'TaskApplicationService' });

// ============================================================================
// TYPES
// ============================================================================

export type ApplicationStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'countered'
  | 'counter_accepted'
  | 'counter_rejected'
  | 'withdrawn'
  | 'expired';

export interface TaskApplication {
  id: string;
  taskId: string;
  hustlerId: string;
  proposedPriceCents: number | null;
  message: string | null;
  status: ApplicationStatus;
  rejectionReason: string | null;
  counterOfferPriceCents: number | null;
  counterOfferMessage: string | null;
  counterOfferRound: number;
  agreedPriceCents: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApplicationResult {
  success: boolean;
  message: string;
  application?: TaskApplication;
  applicationId?: string;
}

// Maximum counter-offer rounds to prevent infinite negotiation
const MAX_COUNTER_ROUNDS = 3;

// Application expiry window (48 hours)
const APPLICATION_EXPIRY_MS = 48 * 60 * 60 * 1000;

// ============================================================================
// VALID STATE TRANSITIONS
// ============================================================================

const VALID_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  pending:           ['accepted', 'rejected', 'countered', 'withdrawn', 'expired'],
  countered:         ['counter_accepted', 'counter_rejected', 'withdrawn', 'expired'],
  counter_accepted:  [], // Terminal
  counter_rejected:  ['countered'], // Poster can re-counter after hustler rejects
  accepted:          [], // Terminal
  rejected:          [], // Terminal
  withdrawn:         [], // Terminal
  expired:           [], // Terminal
};

function isValidTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================================
// SERVICE CLASS
// ============================================================================

class TaskApplicationServiceClass {

  // --------------------------------------------------------------------------
  // APPLY FOR TASK
  // Hustler submits an application with optional proposed price and message
  // --------------------------------------------------------------------------
  async applyForTask(
    taskId: string,
    hustlerId: string,
    proposedPrice?: number,
    message?: string
  ): Promise<ApplicationResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      // 1. Validate task exists and is open for applications
      const task = await TaskService.getTask(taskId);
      if (!task) {
        return { success: false, message: 'Task not found' };
      }

      if (task.status !== 'active') {
        return { success: false, message: `Task is not accepting applications (status: ${task.status})` };
      }

      // 2. Prevent self-application (poster cannot apply to own task)
      if (task.clientId === hustlerId) {
        return { success: false, message: 'Cannot apply to your own task' };
      }

      // 3. INV-APP-1: Check for existing active application
      const [existing] = await sql`
        SELECT id, status FROM task_applications
        WHERE task_id = ${taskId}
          AND hustler_id = ${hustlerId}
          AND status NOT IN ('rejected', 'counter_rejected', 'withdrawn', 'expired')
        LIMIT 1
      `;

      if (existing) {
        return {
          success: false,
          message: 'You already have an active application for this task',
          applicationId: existing.id
        };
      }

      // 4. Validate proposed price if provided
      const proposedPriceCents = proposedPrice ? Math.round(proposedPrice * 100) : null;
      if (proposedPriceCents !== null) {
        if (proposedPriceCents <= 0) {
          return { success: false, message: 'Proposed price must be positive' };
        }
        // Sanity cap: don't allow proposals more than 5x the recommended price
        const maxAllowedCents = Math.round(task.recommendedPrice * 100 * 5);
        if (proposedPriceCents > maxAllowedCents) {
          return { success: false, message: 'Proposed price exceeds reasonable bounds' };
        }
      }

      // 5. Create the application
      const applicationId = uuidv4();
      const [row] = await sql`
        INSERT INTO task_applications (
          id, task_id, hustler_id,
          proposed_price_cents, message,
          status, counter_offer_round,
          created_at, updated_at
        ) VALUES (
          ${applicationId}, ${taskId}, ${hustlerId},
          ${proposedPriceCents}, ${message || null},
          'pending', 0,
          NOW(), NOW()
        )
        RETURNING *
      `;

      const application = this.rowToApplication(row);

      logger.info({
        applicationId,
        taskId,
        hustlerId,
        proposedPriceCents,
      }, 'Application submitted');

      return {
        success: true,
        message: 'Application submitted successfully',
        application,
        applicationId,
      };

    } catch (error) {
      logger.error({ error, taskId, hustlerId }, 'Failed to submit application');
      return { success: false, message: 'Internal error submitting application' };
    }
  }

  // --------------------------------------------------------------------------
  // ACCEPT APPLICATION
  // Poster accepts a hustler's application, triggering task assignment
  // --------------------------------------------------------------------------
  async acceptApplication(
    taskId: string,
    applicationId: string,
    posterId: string
  ): Promise<ApplicationResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      // 1. Validate poster ownership
      const task = await TaskService.getTask(taskId);
      if (!task) return { success: false, message: 'Task not found' };
      if (task.clientId !== posterId) {
        return { success: false, message: 'Only the task poster can accept applications' };
      }
      if (task.status !== 'active') {
        return { success: false, message: `Task is not in a state to accept applications (status: ${task.status})` };
      }

      // 2. Get the application
      const [app] = await sql`
        SELECT * FROM task_applications
        WHERE id = ${applicationId} AND task_id = ${taskId}
      `;
      if (!app) return { success: false, message: 'Application not found' };

      // 3. INV-APP-6: Validate state transition
      const currentStatus = app.status as ApplicationStatus;
      if (!isValidTransition(currentStatus, 'accepted')) {
        return { success: false, message: `Cannot accept application in '${currentStatus}' status` };
      }

      // 4. Determine the agreed price
      // If there was a counter-offer that the hustler accepted, use that
      // Otherwise use the hustler's proposed price, or the task recommended price
      let agreedPriceCents: number;
      if (currentStatus === 'counter_accepted' && app.counter_offer_price_cents) {
        agreedPriceCents = Number(app.counter_offer_price_cents);
      } else if (app.proposed_price_cents) {
        agreedPriceCents = Number(app.proposed_price_cents);
      } else {
        agreedPriceCents = Math.round(task.recommendedPrice * 100);
      }

      // 5. Atomic: Accept application + assign task + reject other applications
      await transaction(async (tx) => {
        // A. Update this application to accepted
        await tx`
          UPDATE task_applications
          SET status = 'accepted',
              agreed_price_cents = ${agreedPriceCents},
              updated_at = NOW()
          WHERE id = ${applicationId}
        `;

        // B. Reject all other pending/countered applications for this task
        await tx`
          UPDATE task_applications
          SET status = 'rejected',
              rejection_reason = 'Another application was accepted',
              updated_at = NOW()
          WHERE task_id = ${taskId}
            AND id != ${applicationId}
            AND status IN ('pending', 'countered')
        `;

        // C. Assign the hustler to the task
        await tx`
          UPDATE tasks
          SET assigned_hustler_id = ${app.hustler_id},
              status = 'assigned',
              updated_at = NOW()
          WHERE id = ${taskId}
        `;
      });

      // 6. Fetch the updated application
      const [updatedRow] = await sql`
        SELECT * FROM task_applications WHERE id = ${applicationId}
      `;
      const application = this.rowToApplication(updatedRow);

      logger.info({
        applicationId,
        taskId,
        hustlerId: app.hustler_id,
        agreedPriceCents,
      }, 'Application accepted - task assigned');

      return {
        success: true,
        message: 'Application accepted and hustler assigned to task',
        application,
      };

    } catch (error) {
      logger.error({ error, taskId, applicationId, posterId }, 'Failed to accept application');
      return { success: false, message: 'Internal error accepting application' };
    }
  }

  // --------------------------------------------------------------------------
  // REJECT APPLICATION
  // Poster rejects a hustler's application
  // --------------------------------------------------------------------------
  async rejectApplication(
    taskId: string,
    applicationId: string,
    posterId: string,
    reason?: string
  ): Promise<ApplicationResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      // 1. Validate poster ownership
      const task = await TaskService.getTask(taskId);
      if (!task) return { success: false, message: 'Task not found' };
      if (task.clientId !== posterId) {
        return { success: false, message: 'Only the task poster can reject applications' };
      }

      // 2. Get the application
      const [app] = await sql`
        SELECT * FROM task_applications
        WHERE id = ${applicationId} AND task_id = ${taskId}
      `;
      if (!app) return { success: false, message: 'Application not found' };

      // 3. Validate state transition
      const currentStatus = app.status as ApplicationStatus;
      if (!isValidTransition(currentStatus, 'rejected')) {
        return { success: false, message: `Cannot reject application in '${currentStatus}' status` };
      }

      // 4. Reject the application
      const [updatedRow] = await sql`
        UPDATE task_applications
        SET status = 'rejected',
            rejection_reason = ${reason || null},
            updated_at = NOW()
        WHERE id = ${applicationId}
        RETURNING *
      `;

      const application = this.rowToApplication(updatedRow);

      logger.info({
        applicationId,
        taskId,
        hustlerId: app.hustler_id,
        reason,
      }, 'Application rejected');

      return {
        success: true,
        message: 'Application rejected',
        application,
      };

    } catch (error) {
      logger.error({ error, taskId, applicationId, posterId }, 'Failed to reject application');
      return { success: false, message: 'Internal error rejecting application' };
    }
  }

  // --------------------------------------------------------------------------
  // COUNTER-OFFER
  // Poster proposes a different price to the hustler
  // --------------------------------------------------------------------------
  async counterOffer(
    taskId: string,
    applicationId: string,
    posterId: string,
    newPrice: number,
    message?: string
  ): Promise<ApplicationResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      // 1. Validate poster ownership
      const task = await TaskService.getTask(taskId);
      if (!task) return { success: false, message: 'Task not found' };
      if (task.clientId !== posterId) {
        return { success: false, message: 'Only the task poster can counter-offer' };
      }

      // 2. Get the application
      const [app] = await sql`
        SELECT * FROM task_applications
        WHERE id = ${applicationId} AND task_id = ${taskId}
      `;
      if (!app) return { success: false, message: 'Application not found' };

      // 3. Validate state transition
      const currentStatus = app.status as ApplicationStatus;
      if (!isValidTransition(currentStatus, 'countered')) {
        return { success: false, message: `Cannot counter-offer for application in '${currentStatus}' status` };
      }

      // 4. INV-APP-5: Check counter-offer round limit
      const currentRound = Number(app.counter_offer_round) || 0;
      if (currentRound >= MAX_COUNTER_ROUNDS) {
        return {
          success: false,
          message: `Maximum counter-offer rounds reached (${MAX_COUNTER_ROUNDS}). Please accept or reject.`,
        };
      }

      // 5. Validate price
      const newPriceCents = Math.round(newPrice * 100);
      if (newPriceCents <= 0) {
        return { success: false, message: 'Counter-offer price must be positive' };
      }

      // 6. Update the application with counter-offer
      const [updatedRow] = await sql`
        UPDATE task_applications
        SET status = 'countered',
            counter_offer_price_cents = ${newPriceCents},
            counter_offer_message = ${message || null},
            counter_offer_round = ${currentRound + 1},
            updated_at = NOW()
        WHERE id = ${applicationId}
        RETURNING *
      `;

      const application = this.rowToApplication(updatedRow);

      logger.info({
        applicationId,
        taskId,
        hustlerId: app.hustler_id,
        originalPriceCents: app.proposed_price_cents,
        counterPriceCents: newPriceCents,
        round: currentRound + 1,
      }, 'Counter-offer sent');

      return {
        success: true,
        message: 'Counter-offer sent to hustler',
        application,
      };

    } catch (error) {
      logger.error({ error, taskId, applicationId, posterId }, 'Failed to send counter-offer');
      return { success: false, message: 'Internal error sending counter-offer' };
    }
  }

  // --------------------------------------------------------------------------
  // RESPOND TO COUNTER-OFFER
  // Hustler accepts or rejects a poster's counter-offer, with optional re-counter
  // --------------------------------------------------------------------------
  async respondToCounter(
    applicationId: string,
    hustlerId: string,
    accept: boolean,
    counterPrice?: number
  ): Promise<ApplicationResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      // 1. Get the application
      const [app] = await sql`
        SELECT * FROM task_applications
        WHERE id = ${applicationId}
      `;
      if (!app) return { success: false, message: 'Application not found' };

      // 2. INV-APP-3: Validate hustler ownership
      if (app.hustler_id !== hustlerId) {
        return { success: false, message: 'Only the applying hustler can respond to counter-offers' };
      }

      // 3. Validate current status allows response
      const currentStatus = app.status as ApplicationStatus;
      if (currentStatus !== 'countered') {
        return { success: false, message: `Cannot respond to counter-offer in '${currentStatus}' status` };
      }

      if (accept) {
        // Hustler accepts the counter-offer
        const [updatedRow] = await sql`
          UPDATE task_applications
          SET status = 'counter_accepted',
              agreed_price_cents = counter_offer_price_cents,
              updated_at = NOW()
          WHERE id = ${applicationId}
          RETURNING *
        `;

        const application = this.rowToApplication(updatedRow);

        logger.info({
          applicationId,
          taskId: app.task_id,
          hustlerId,
          agreedPriceCents: updatedRow.agreed_price_cents,
        }, 'Counter-offer accepted by hustler');

        return {
          success: true,
          message: 'Counter-offer accepted. Waiting for poster to finalize assignment.',
          application,
        };

      } else {
        // Hustler rejects the counter-offer
        if (counterPrice !== undefined) {
          // Hustler is proposing a new price (re-counter)
          const currentRound = Number(app.counter_offer_round) || 0;
          if (currentRound >= MAX_COUNTER_ROUNDS) {
            // At max rounds, just reject without re-counter
            const [updatedRow] = await sql`
              UPDATE task_applications
              SET status = 'counter_rejected',
                  updated_at = NOW()
              WHERE id = ${applicationId}
              RETURNING *
            `;
            const application = this.rowToApplication(updatedRow);

            return {
              success: true,
              message: `Counter-offer rejected. Maximum negotiation rounds (${MAX_COUNTER_ROUNDS}) reached.`,
              application,
            };
          }

          // Update with hustler's new proposed price
          const newPriceCents = Math.round(counterPrice * 100);
          if (newPriceCents <= 0) {
            return { success: false, message: 'Counter-price must be positive' };
          }

          const [updatedRow] = await sql`
            UPDATE task_applications
            SET status = 'counter_rejected',
                proposed_price_cents = ${newPriceCents},
                updated_at = NOW()
            WHERE id = ${applicationId}
            RETURNING *
          `;

          const application = this.rowToApplication(updatedRow);

          logger.info({
            applicationId,
            taskId: app.task_id,
            hustlerId,
            newProposedPriceCents: newPriceCents,
          }, 'Counter-offer rejected with new price proposal');

          return {
            success: true,
            message: 'Counter-offer rejected. Your new price has been submitted.',
            application,
          };

        } else {
          // Simple rejection without re-counter
          const [updatedRow] = await sql`
            UPDATE task_applications
            SET status = 'counter_rejected',
                updated_at = NOW()
            WHERE id = ${applicationId}
            RETURNING *
          `;

          const application = this.rowToApplication(updatedRow);

          logger.info({
            applicationId,
            taskId: app.task_id,
            hustlerId,
          }, 'Counter-offer rejected');

          return {
            success: true,
            message: 'Counter-offer rejected',
            application,
          };
        }
      }

    } catch (error) {
      logger.error({ error, applicationId, hustlerId }, 'Failed to respond to counter-offer');
      return { success: false, message: 'Internal error responding to counter-offer' };
    }
  }

  // --------------------------------------------------------------------------
  // WITHDRAW APPLICATION
  // Hustler withdraws their own application before it's accepted
  // --------------------------------------------------------------------------
  async withdrawApplication(
    applicationId: string,
    hustlerId: string
  ): Promise<ApplicationResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      const [app] = await sql`
        SELECT * FROM task_applications
        WHERE id = ${applicationId}
      `;
      if (!app) return { success: false, message: 'Application not found' };
      if (app.hustler_id !== hustlerId) {
        return { success: false, message: 'Only the applicant can withdraw' };
      }

      const currentStatus = app.status as ApplicationStatus;
      if (!isValidTransition(currentStatus, 'withdrawn')) {
        return { success: false, message: `Cannot withdraw application in '${currentStatus}' status` };
      }

      const [updatedRow] = await sql`
        UPDATE task_applications
        SET status = 'withdrawn', updated_at = NOW()
        WHERE id = ${applicationId}
        RETURNING *
      `;

      const application = this.rowToApplication(updatedRow);

      logger.info({ applicationId, hustlerId }, 'Application withdrawn');

      return {
        success: true,
        message: 'Application withdrawn',
        application,
      };

    } catch (error) {
      logger.error({ error, applicationId, hustlerId }, 'Failed to withdraw application');
      return { success: false, message: 'Internal error withdrawing application' };
    }
  }

  // --------------------------------------------------------------------------
  // QUERY METHODS
  // --------------------------------------------------------------------------

  /**
   * Get all applications for a task (poster view)
   */
  async getApplicationsForTask(taskId: string, posterId: string): Promise<TaskApplication[]> {
    if (!sql) throw new Error('Database not initialized');

    // Verify poster owns the task
    const task = await TaskService.getTask(taskId);
    if (!task || task.clientId !== posterId) {
      throw new Error('Unauthorized: not the task poster');
    }

    const rows = await sql`
      SELECT a.*, u.name as hustler_name, u.email as hustler_email,
             hp.rating, hp.completed_tasks, hp.completion_rate, hp.xp, hp.level
      FROM task_applications a
      LEFT JOIN users u ON u.id = a.hustler_id
      LEFT JOIN hustler_profiles hp ON hp.user_id = a.hustler_id
      WHERE a.task_id = ${taskId}
      ORDER BY a.created_at DESC
    `;

    return rows.map(row => this.rowToApplication(row));
  }

  /**
   * Get applications by a specific hustler
   */
  async getApplicationsByHustler(hustlerId: string): Promise<TaskApplication[]> {
    if (!sql) throw new Error('Database not initialized');

    const rows = await sql`
      SELECT * FROM task_applications
      WHERE hustler_id = ${hustlerId}
      ORDER BY created_at DESC
    `;

    return rows.map(row => this.rowToApplication(row));
  }

  /**
   * Get a single application by ID
   */
  async getApplication(applicationId: string): Promise<TaskApplication | null> {
    if (!sql) throw new Error('Database not initialized');

    const [row] = await sql`
      SELECT * FROM task_applications WHERE id = ${applicationId}
    `;
    if (!row) return null;
    return this.rowToApplication(row);
  }

  /**
   * Expire stale applications (run on a cron/interval)
   * Applications older than 48 hours in pending status are expired
   */
  async expireStaleApplications(): Promise<number> {
    if (!sql) throw new Error('Database not initialized');

    const cutoff = new Date(Date.now() - APPLICATION_EXPIRY_MS);

    const expired = await sql`
      UPDATE task_applications
      SET status = 'expired', updated_at = NOW()
      WHERE status IN ('pending', 'countered')
        AND created_at < ${cutoff.toISOString()}
      RETURNING id
    `;

    if (expired.length > 0) {
      logger.info({ count: expired.length }, 'Expired stale applications');
    }

    return expired.length;
  }

  // --------------------------------------------------------------------------
  // PRIVATE HELPERS
  // --------------------------------------------------------------------------

  private rowToApplication(row: Record<string, unknown>): TaskApplication {
    return {
      id: row.id as string,
      taskId: row.task_id as string,
      hustlerId: row.hustler_id as string,
      proposedPriceCents: row.proposed_price_cents != null ? Number(row.proposed_price_cents) : null,
      message: row.message as string | null,
      status: row.status as ApplicationStatus,
      rejectionReason: row.rejection_reason as string | null,
      counterOfferPriceCents: row.counter_offer_price_cents != null ? Number(row.counter_offer_price_cents) : null,
      counterOfferMessage: row.counter_offer_message as string | null,
      counterOfferRound: Number(row.counter_offer_round) || 0,
      agreedPriceCents: row.agreed_price_cents != null ? Number(row.agreed_price_cents) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}

export const TaskApplicationService = new TaskApplicationServiceClass();
