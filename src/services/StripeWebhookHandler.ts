/**
 * STRIPE WEBHOOK HANDLER (BUILD_GUIDE FIX 2)
 * 
 * Handles Stripe webhooks with:
 * - Idempotent event processing (stripe_events table)
 * - Out-of-order event handling
 * - Error logging and retry support
 * 
 * INVARIANTS ENFORCED:
 * - INV-STRIPE-1: Every Stripe webhook processed exactly once
 * - INV-STRIPE-2: Stripe is authoritative for payment state
 * - INV-STRIPE-3: Out-of-order events don't corrupt state
 * 
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */

import Stripe from 'stripe';
import { getSql } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { EscrowStateMachine } from '../services/EscrowStateMachine.js';
import { JobQueue } from '../services/JobQueue.js';

const logger = createLogger('StripeWebhook');

// ============================================================================
// AUTHORITATIVE EVENTS (FROM BUILD_GUIDE)
// ============================================================================

const AUTHORITATIVE_EVENTS = [
  'payment_intent.succeeded',   // FUNDED escrow
  'payment_intent.canceled',    // REFUND escrow
  'payment_intent.payment_failed', // Log, notify
  'charge.dispute.created',     // LOCK escrow
  'charge.dispute.closed',      // Resolve dispute
  'transfer.created',           // Payout initiated
  'transfer.failed',            // Payout failed
  'payout.paid',                // Final payout confirmation
] as const;

type AuthoritativeEvent = typeof AUTHORITATIVE_EVENTS[number];

// ============================================================================
// WEBHOOK HANDLER CLASS
// ============================================================================

class StripeWebhookHandlerClass {
  
  /**
   * Process a Stripe webhook event
   * Returns true if processed, false if duplicate
   */
  async handleEvent(event: Stripe.Event): Promise<boolean> {
    const sql = getSql();
    
    // 1. Idempotency check - insert event record
    try {
      await sql`
        INSERT INTO stripe_events (
          stripe_event_id,
          event_type,
          payload,
          created_at
        ) VALUES (
          ${event.id},
          ${event.type},
          ${JSON.stringify(event.data)},
          NOW()
        )
      `;
    } catch (e: any) {
      // Unique constraint violation = duplicate event
      if (e.code === '23505' || e.message?.includes('unique') || e.message?.includes('duplicate')) {
        logger.info({ eventId: event.id, type: event.type }, 'Duplicate Stripe event - skipping');
        return false;
      }
      throw e;
    }
    
    // 2. Process based on event type
    try {
      await this.processEvent(event);
      
      // 3. Mark as processed
      await sql`
        UPDATE stripe_events
        SET processed_at = NOW()
        WHERE stripe_event_id = ${event.id}
      `;
      
      logger.info({ eventId: event.id, type: event.type }, 'Stripe event processed');
      return true;
      
    } catch (error: any) {
      // Log error but allow Stripe to retry
      await sql`
        UPDATE stripe_events
        SET processing_error = ${error.message}
        WHERE stripe_event_id = ${event.id}
      `;
      
      logger.error({ 
        eventId: event.id, 
        type: event.type, 
        error: error.message 
      }, 'Stripe event processing failed');
      
      throw error; // Re-throw for Stripe retry
    }
  }
  
  /**
   * Process event based on type
   */
  private async processEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;
        
      case 'payment_intent.canceled':
        await this.handlePaymentCanceled(event.data.object as Stripe.PaymentIntent);
        break;
        
      case 'payment_intent.payment_failed':
        await this.handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
        break;
        
      case 'charge.dispute.created':
        await this.handleDisputeCreated(event.data.object as Stripe.Dispute);
        break;
        
      case 'charge.dispute.closed':
        await this.handleDisputeClosed(event.data.object as Stripe.Dispute);
        break;
        
      case 'transfer.created':
        await this.handleTransferCreated(event.data.object as Stripe.Transfer);
        break;
        
      case 'transfer.failed':
        await this.handleTransferFailed(event.data.object as Stripe.Transfer);
        break;
        
      case 'payout.paid':
        await this.handlePayoutPaid(event.data.object as Stripe.Payout);
        break;
        
      default:
        logger.debug({ type: event.type }, 'Ignoring non-authoritative event');
    }
  }
  
  // ==========================================================================
  // EVENT HANDLERS
  // ==========================================================================
  
  /**
   * Payment succeeded → Fund escrow
   */
  private async handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const sql = getSql();
    const taskId = paymentIntent.metadata?.task_id;
    
    if (!taskId) {
      logger.warn({ paymentIntentId: paymentIntent.id }, 'No task_id in payment intent metadata');
      return;
    }
    
    // Get current escrow state
    const state = await EscrowStateMachine.getState(taskId);
    
    // Only transition from pending (out-of-order handling)
    if (state !== 'pending') {
      logger.info({ 
        taskId, 
        currentState: state,
      }, 'Escrow not in pending state, ignoring payment_intent.succeeded');
      return;
    }
    
    // Transition to funded
    const result = await EscrowStateMachine.transition(taskId, 'funded', {
      stripePaymentIntentId: paymentIntent.id,
    });
    
    if (!result.success) {
      throw new Error(`Failed to fund escrow: ${result.error}`);
    }
    
    // Queue notification
    const [task] = await sql`SELECT client_id FROM tasks WHERE id = ${taskId}`;
    if (task) {
      await JobQueue.add('send_notification', {
        recipientId: task.client_id,
        notificationType: 'payment_received',
        title: 'Payment Received',
        body: 'Your payment has been received and is held in escrow.',
        data: { taskId },
      });
    }
  }
  
  /**
   * Payment canceled → Refund escrow
   */
  private async handlePaymentCanceled(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const taskId = paymentIntent.metadata?.task_id;
    
    if (!taskId) return;
    
    const state = await EscrowStateMachine.getState(taskId);
    
    if (state === 'pending') {
      await EscrowStateMachine.transition(taskId, 'refunded', {
        reason: 'Payment canceled',
      });
    }
  }
  
  /**
   * Payment failed → Log and notify
   */
  private async handlePaymentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const sql = getSql();
    const taskId = paymentIntent.metadata?.task_id;
    
    if (!taskId) return;
    
    const [task] = await sql`SELECT client_id FROM tasks WHERE id = ${taskId}`;
    
    if (task) {
      await JobQueue.add('send_notification', {
        recipientId: task.client_id,
        notificationType: 'payment_failed',
        title: 'Payment Failed',
        body: 'Your payment could not be processed. Please try again.',
        data: { 
          taskId,
          error: paymentIntent.last_payment_error?.message,
        },
      });
    }
    
    logger.warn({ 
      taskId, 
      error: paymentIntent.last_payment_error?.message,
    }, 'Payment failed');
  }
  
  /**
   * Dispute created → Lock escrow
   */
  private async handleDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
    const sql = getSql();
    
    // Find escrow by payment intent
    const [escrow] = await sql`
      SELECT task_id FROM money_state_lock
      WHERE stripe_payment_intent_id = ${dispute.payment_intent}
    `;
    
    if (!escrow) {
      logger.warn({ disputeId: dispute.id }, 'No escrow found for dispute');
      return;
    }
    
    const state = await EscrowStateMachine.getState(escrow.task_id);
    
    if (state === 'funded') {
      await EscrowStateMachine.transition(escrow.task_id, 'locked_dispute', {
        disputeId: dispute.id,
        reason: dispute.reason || 'Customer dispute',
      });
      
      // Notify relevant parties
      const [task] = await sql`
        SELECT client_id, assigned_to FROM tasks WHERE id = ${escrow.task_id}
      `;
      
      if (task) {
        await JobQueue.add('send_notification', {
          recipientId: task.client_id,
          notificationType: 'dispute_opened',
          title: 'Dispute Opened',
          body: 'A dispute has been opened on this task. Funds are on hold.',
          data: { taskId: escrow.task_id, disputeId: dispute.id },
        });
        
        if (task.assigned_to) {
          await JobQueue.add('send_notification', {
            recipientId: task.assigned_to,
            notificationType: 'dispute_opened',
            title: 'Dispute Opened',
            body: 'A dispute has been opened on this task. Payout is on hold.',
            data: { taskId: escrow.task_id, disputeId: dispute.id },
          });
        }
      }
    }
  }
  
  /**
   * Dispute closed → Apply outcome
   */
  private async handleDisputeClosed(dispute: Stripe.Dispute): Promise<void> {
    const sql = getSql();
    
    const [escrow] = await sql`
      SELECT task_id FROM money_state_lock
      WHERE stripe_payment_intent_id = ${dispute.payment_intent}
    `;
    
    if (!escrow) return;
    
    const state = await EscrowStateMachine.getState(escrow.task_id);
    
    if (state !== 'locked_dispute') {
      logger.info({ taskId: escrow.task_id, state }, 'Escrow not locked, ignoring dispute close');
      return;
    }
    
    // Apply outcome based on dispute status
    if (dispute.status === 'won') {
      // Merchant won → release to hustler
      await EscrowStateMachine.transition(escrow.task_id, 'released');
      
      // Queue XP award
      const [task] = await sql`SELECT assigned_to FROM tasks WHERE id = ${escrow.task_id}`;
      if (task?.assigned_to) {
        await JobQueue.add('award_xp', {
          taskId: escrow.task_id,
          hustlerId: task.assigned_to,
        }, { jobId: `xp-${escrow.task_id}` });
      }
      
    } else if (dispute.status === 'lost') {
      // Merchant lost → refund to client
      await EscrowStateMachine.transition(escrow.task_id, 'refunded', {
        reason: 'Dispute lost',
      });
      
      // Queue trust downgrade
      const [task] = await sql`SELECT assigned_to FROM tasks WHERE id = ${escrow.task_id}`;
      if (task?.assigned_to) {
        await JobQueue.add('trust_downgrade', {
          userId: task.assigned_to,
          trigger: 'dispute_lost',
        });
      }
    }
  }
  
  /**
   * Transfer created → Log
   */
  private async handleTransferCreated(transfer: Stripe.Transfer): Promise<void> {
    const sql = getSql();
    const taskId = transfer.metadata?.task_id;
    
    if (!taskId) return;
    
    await sql`
      UPDATE money_state_lock
      SET stripe_transfer_id = ${transfer.id}
      WHERE task_id = ${taskId}
    `;
    
    logger.info({ taskId, transferId: transfer.id }, 'Transfer created');
  }
  
  /**
   * Transfer failed → Alert
   */
  private async handleTransferFailed(transfer: Stripe.Transfer): Promise<void> {
    const taskId = transfer.metadata?.task_id;
    
    if (!taskId) return;
    
    // This is a critical error - alert immediately
    logger.error({ 
      taskId, 
      transferId: transfer.id,
    }, 'CRITICAL: Transfer failed');
    
    // Queue for manual review
    await JobQueue.add('send_notification', {
      recipientId: 'admin', // Special case for admin alerts
      notificationType: 'transfer_failed',
      title: 'CRITICAL: Transfer Failed',
      body: `Transfer ${transfer.id} for task ${taskId} failed.`,
      data: { taskId, transferId: transfer.id },
    });
  }
  
  /**
   * Payout paid → Final confirmation
   */
  private async handlePayoutPaid(payout: Stripe.Payout): Promise<void> {
    const taskId = payout.metadata?.task_id;
    
    if (!taskId) return;
    
    logger.info({ taskId, payoutId: payout.id }, 'Payout completed');
  }
}

export const StripeWebhookHandler = new StripeWebhookHandlerClass();
