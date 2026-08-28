import { db, getErrorMessage, isInvariantViolation } from '../db.js';
import type { ServiceResult } from '../types.js';
import type { CreateMessageParams, TaskMessage } from './MessagingTypes.js';
import {
  detectForbiddenPatterns,
  enforceMessageRateLimit,
  loadMessagingContext,
  resolveMessageContent,
} from './MessagingPolicy.js';
import { deliverMessage, moderateTextMessage } from './MessagingDeliveryService.js';

function notificationBody(params: CreateMessageParams, content: string): string {
  if (params.messageType !== 'TEXT') return 'You received a new message';
  return content.length > 50 ? `${content.substring(0, 50)}...` : content;
}

async function persistTextMessage(
  params: CreateMessageParams,
  recipientId: string,
  content: string,
  detectedPatterns: string[],
): Promise<TaskMessage> {
  const moderationStatus = detectedPatterns.length > 0 ? 'flagged' : 'pending';
  const result = await db.query<TaskMessage>(
    `INSERT INTO task_messages (
      task_id, sender_id, receiver_id, message_type, content, auto_message_template,
      read_at, moderation_status, moderation_flags
    )
    VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8::TEXT[])
    RETURNING
      id, task_id, sender_id, receiver_id, message_type, content,
      auto_message_template, photo_urls, photo_count,
      location_latitude, location_longitude, location_expires_at,
      read_at, moderation_status, moderation_flags, created_at, updated_at`,
    [
      params.taskId,
      params.senderId,
      recipientId,
      params.messageType,
      content,
      params.autoMessageTemplate || null,
      moderationStatus,
      detectedPatterns.length > 0 ? detectedPatterns : null,
    ],
  );
  const message = result.rows[0];
  message.moderation_status = moderationStatus;
  message.moderation_flags = detectedPatterns.length > 0 ? detectedPatterns : undefined;
  return message;
}

export async function sendMessage(
  params: CreateMessageParams,
): Promise<ServiceResult<TaskMessage>> {
  const { taskId, senderId, messageType } = params;
  try {
    const context = await loadMessagingContext(taskId, senderId, 'text');
    if (!context.success) return context;
    const resolvedContent = resolveMessageContent(params);
    if (!resolvedContent.success) return resolvedContent;
    const content = resolvedContent.data;
    const rateLimit = await enforceMessageRateLimit(senderId, taskId);
    if (!rateLimit.success) return rateLimit;

    const detectedPatterns = detectForbiddenPatterns(content);
    const message = await persistTextMessage(
      params,
      context.data.recipientId,
      content,
      detectedPatterns,
    );
    await moderateTextMessage(message, senderId, content, detectedPatterns);
    if (detectedPatterns.length === 0) {
      await deliverMessage({
        message,
        taskId,
        senderId,
        recipientId: context.data.recipientId,
        messageType,
        body: notificationBody(params, content),
      });
    }
    return { success: true, data: message };
  } catch (error) {
    if (isInvariantViolation(error)) {
      const code = error.code || 'INVARIANT_VIOLATION';
      return { success: false, error: { code, message: getErrorMessage(code) } };
    }
    return {
      success: false,
      error: {
        code: 'DB_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    };
  }
}
