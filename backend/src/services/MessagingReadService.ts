import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import type { TaskMessage } from './MessagingTypes.js';
import { loadMessagingReadContext } from './MessagingPolicy.js';
import { projectTaskMessagesForViewer } from './PrivateMediaDeliveryService.js';

function databaseError(error: unknown): ServiceResult<never> {
  return {
    success: false,
    error: {
      code: 'DB_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    },
  };
}

export async function getMessagesForTask(
  taskId: string,
  userId: string,
  offset = 0,
): Promise<ServiceResult<{ messages: TaskMessage[]; hasMore: boolean }>> {
  const pageSize = 100;
  try {
    const context = await loadMessagingReadContext(taskId, userId);
    if (!context.success) return context;
    const result = await db.query<TaskMessage>(
      `SELECT
        id, task_id, sender_id, receiver_id, message_type, content,
        auto_message_template, photo_urls, photo_count,
        location_latitude, location_longitude, location_expires_at,
        read_at, moderation_status, moderation_flags, created_at, updated_at
      FROM task_messages
      WHERE task_id = $1
        AND ((sender_id=$2 AND receiver_id=$3) OR (sender_id=$3 AND receiver_id=$2))
        AND (moderation_status IS NULL OR moderation_status NOT IN ('quarantined', 'flagged') OR sender_id=$2)
      ORDER BY created_at ASC
      LIMIT $4 OFFSET $5`,
      [taskId, userId, context.data.recipientId, pageSize, offset],
    );
    const messages = await projectTaskMessagesForViewer({
      taskId,
      viewerId: userId,
      messages: result.rows,
    });
    return {
      success: true,
      data: { messages, hasMore: result.rows.length === pageSize },
    };
  } catch (error) {
    return databaseError(error);
  }
}

export async function getUnreadCount(userId: string): Promise<ServiceResult<number>> {
  try {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM task_messages
       WHERE receiver_id = $1 AND read_at IS NULL
         AND (moderation_status IS NULL OR moderation_status NOT IN ('quarantined', 'flagged'))`,
      [userId],
    );
    return { success: true, data: parseInt(result.rows[0]?.count || '0', 10) };
  } catch (error) {
    return databaseError(error);
  }
}

export async function markAsRead(
  messageId: string,
  userId: string,
): Promise<ServiceResult<TaskMessage>> {
  try {
    const verifyResult = await db.query<{ receiver_id: string }>(
      `SELECT receiver_id FROM task_messages
       WHERE id = $1
         AND (moderation_status IS NULL OR moderation_status NOT IN ('quarantined', 'flagged'))`,
      [messageId],
    );
    if (verifyResult.rows.length === 0) {
      return {
        success: false,
        error: { code: ErrorCodes.NOT_FOUND, message: `Message ${messageId} not found` },
      };
    }
    if (verifyResult.rows[0].receiver_id !== userId) {
      return {
        success: false,
        error: { code: ErrorCodes.FORBIDDEN, message: 'You are not the receiver of this message' },
      };
    }
    const result = await db.query<TaskMessage>(
      `UPDATE task_messages
       SET read_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND receiver_id = $2 AND read_at IS NULL
         AND (moderation_status IS NULL OR moderation_status NOT IN ('quarantined', 'flagged'))
       RETURNING
         id, task_id, sender_id, receiver_id, message_type, content,
         auto_message_template, photo_urls, photo_count,
         location_latitude, location_longitude, location_expires_at,
         read_at, moderation_status, moderation_flags, created_at, updated_at`,
      [messageId, userId],
    );
    if (result.rows.length === 0) {
      return {
        success: false,
        error: {
          code: ErrorCodes.NOT_FOUND,
          message: `Message ${messageId} not found or already read`,
        },
      };
    }
    const [message] = await projectTaskMessagesForViewer({
      taskId: result.rows[0].task_id,
      viewerId: userId,
      messages: [result.rows[0]],
    });
    return { success: true, data: message };
  } catch (error) {
    return databaseError(error);
  }
}

export async function markAllAsRead(
  taskId: string,
  userId: string,
): Promise<ServiceResult<{ marked: number }>> {
  try {
    const context = await loadMessagingReadContext(taskId, userId);
    if (!context.success) return context;
    const result = await db.query(
      `UPDATE task_messages
       SET read_at = NOW(), updated_at = NOW()
       WHERE task_id = $1 AND receiver_id = $2 AND read_at IS NULL
         AND sender_id = $3
         AND (moderation_status IS NULL OR moderation_status NOT IN ('quarantined', 'flagged'))`,
      [taskId, userId, context.data.recipientId],
    );
    return { success: true, data: { marked: result.rowCount ?? 0 } };
  } catch (error) {
    return databaseError(error);
  }
}
