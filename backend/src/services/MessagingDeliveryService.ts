import { db } from '../db.js';
import { logger } from '../logger.js';
import { ContentModerationService } from './ContentModerationService.js';
import { NotificationService } from './NotificationService.js';
import type { TaskMessage } from './MessagingTypes.js';

const log = logger.child({ service: 'MessagingService' });

export async function moderateTextMessage(
  message: TaskMessage,
  senderId: string,
  content: string,
  detectedPatterns: string[],
): Promise<void> {
  if (!content.trim()) return;
  if (detectedPatterns.length > 0) {
    await ContentModerationService.moderateContent({
      contentType: 'message',
      contentId: message.id,
      userId: senderId,
      contentText: content,
      flaggedBy: 'ai',
      aiConfidence: 0.95,
      aiRecommendation: 'flag',
    });
    return;
  }
  ContentModerationService.moderateContent({
    contentType: 'message',
    contentId: message.id,
    userId: senderId,
    contentText: content,
    flaggedBy: 'ai',
  }).catch((error) => {
    log.error(
      { err: error instanceof Error ? error.message : String(error), messageId: message.id },
      'Content moderation error (non-blocking)',
    );
  });
}

export function storePhotoEvidence(
  taskId: string,
  senderId: string,
  photoKeys: string[],
): void {
  for (const storageKey of photoKeys) {
    db.query(
      `INSERT INTO evidence (task_id, uploader_user_id, storage_key, content_type, access_scope)
       VALUES ($1, $2, $3, 'image', 'messaging')
       ON CONFLICT DO NOTHING`,
      [taskId, senderId, storageKey],
    ).catch((error) => {
      log.error(
        { err: error instanceof Error ? error.message : String(error), taskId, senderId },
        'Failed to store photo evidence (non-blocking)',
      );
    });
  }
}

export async function moderatePhotoMessage(
  message: TaskMessage,
  senderId: string,
  photoKeys: string[],
  caption: string | undefined,
  detectedPatterns: string[],
): Promise<void> {
  await Promise.all(photoKeys.map(async (photoKey) => {
    const result = await ContentModerationService.moderateContent({
      contentType: 'photo',
      contentId: message.id,
      userId: senderId,
      contentUrl: photoKey,
      flaggedBy: 'ai',
    }).catch((error) => {
      log.error(
        { err: error instanceof Error ? error.message : String(error), messageId: message.id },
        'Photo moderation error (non-blocking)',
      );
      return null;
    });
    if (result && !result.success) {
      log.error({ messageId: message.id, photoKey }, 'Photo moderation queue rejected an attachment');
    }
  }));
  if (!caption || detectedPatterns.length === 0) return;
  await ContentModerationService.moderateContent({
    contentType: 'message',
    contentId: message.id,
    userId: senderId,
    contentText: caption,
    flaggedBy: 'ai',
    aiConfidence: 0.95,
    aiRecommendation: 'flag',
  });
}

async function publishRealtime(
  message: TaskMessage,
  taskId: string,
  senderId: string,
  recipientId: string,
): Promise<void> {
  try {
    const { Redis } = await import('@upstash/redis');
    const { config } = await import('../config.js');
    if (!config.redis.restUrl || !config.redis.restToken) return;
    const redis = new Redis({ url: config.redis.restUrl, token: config.redis.restToken });
    await redis.publish(`realtime:user:${recipientId}`, JSON.stringify({
      event: 'message.new',
      data: {
        messageId: message.id,
        taskId,
        senderId,
        content: message.content,
        createdAt: message.created_at,
      },
    }));
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Failed to publish message to realtime',
    );
  }
}

interface DeliveryMessageParams {
  message: TaskMessage;
  taskId: string;
  senderId: string;
  recipientId: string;
  messageType: 'TEXT' | 'AUTO' | 'PHOTO';
  body: string;
}

export async function deliverMessage(params: DeliveryMessageParams): Promise<void> {
  const { message, taskId, senderId, recipientId, messageType, body } = params;
  await publishRealtime(message, taskId, senderId, recipientId);
  await NotificationService.createNotification({
    userId: recipientId,
    category: 'message_received',
    title: 'New Message',
    body,
    deepLink: `app://task/${taskId}/messages`,
    taskId,
    metadata: { messageId: message.id, messageType, senderId },
    channels: ['in_app', 'push'],
    priority: 'MEDIUM',
  }).catch((error) => {
    log.error(
      { err: error instanceof Error ? error.message : String(error), recipientId, taskId },
      messageType === 'PHOTO'
        ? 'Failed to send photo message notification'
        : 'Failed to send message notification',
    );
  });
}
