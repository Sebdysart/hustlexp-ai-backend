import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import {
  moderatePhotoMessage,
  storePhotoEvidence,
} from './MessagingDeliveryService.js';
import {
  detectForbiddenPatterns,
  enforceMessageRateLimit,
  loadMessagingContext,
  validatePhotoCount,
} from './MessagingPolicy.js';
import type { CreatePhotoMessageParams, TaskMessage } from './MessagingTypes.js';
import { randomUUID } from 'node:crypto';
import { consumeFinalizedMediaReceiptById } from './MediaUploadReceiptService.js';
import type { QueryFn } from '../db.js';
import { TRPCError } from '@trpc/server';
import { projectTaskMessagesForViewer } from './PrivateMediaDeliveryService.js';

function captionPatterns(caption: string | undefined): string[] {
  if (!caption?.trim()) return [];
  return detectForbiddenPatterns(caption);
}

async function persistPhotoMessage(
  query: QueryFn,
  params: CreatePhotoMessageParams,
  recipientId: string,
  detectedPatterns: string[],
  messageId: string,
  photoKeys: string[],
): Promise<TaskMessage> {
  const moderationStatus = 'quarantined';
  const moderationFlags = ['pixel_review_required', ...detectedPatterns];
  const result = await query<TaskMessage>(
    `INSERT INTO task_messages (
      id, task_id, sender_id, receiver_id, message_type, content, photo_urls,
      photo_count, read_at, moderation_status, moderation_flags
    )
    VALUES ($1, $2, $3, $4, 'PHOTO', $5, $6::TEXT[], $7, NULL, $8, $9::TEXT[])
    RETURNING
      id, task_id, sender_id, receiver_id, message_type, content,
      auto_message_template, photo_urls, photo_count,
      location_latitude, location_longitude, location_expires_at,
      read_at, moderation_status, moderation_flags, created_at, updated_at`,
    [
      messageId,
      params.taskId,
      params.senderId,
      recipientId,
      params.caption || null,
      photoKeys,
      photoKeys.length,
      moderationStatus,
      moderationFlags,
    ],
  );
  const message = result.rows[0];
  message.moderation_status = moderationStatus;
  message.moderation_flags = moderationFlags;
  return message;
}

export async function sendPhotoMessage(
  params: CreatePhotoMessageParams,
): Promise<ServiceResult<TaskMessage>> {
  const { taskId, senderId, uploadReceiptIds, caption } = params;
  try {
    const photoCount = validatePhotoCount(uploadReceiptIds);
    if (!photoCount.success) return photoCount;
    const context = await loadMessagingContext(taskId, senderId, 'photo');
    if (!context.success) return context;
    const rateLimit = await enforceMessageRateLimit(senderId, taskId);
    if (!rateLimit.success) return rateLimit;

    const detectedPatterns = captionPatterns(caption);
    const messageId = randomUUID();
    const { message, photoKeys } = await db.transaction(async (query) => {
      const photoKeys: string[] = [];
      for (const uploadReceiptId of uploadReceiptIds) {
        const finalized = await consumeFinalizedMediaReceiptById(query, {
          uploadReceiptId,
          taskId,
          uploaderId: senderId,
          purpose: 'MESSAGE',
          consumerId: messageId,
        });
        photoKeys.push(finalized.storageKey);
      }
      return {
        message: await persistPhotoMessage(
          query,
          params,
          context.data.recipientId,
          detectedPatterns,
          messageId,
          photoKeys,
        ),
        photoKeys,
      };
    });
    storePhotoEvidence(taskId, senderId, photoKeys);
    await moderatePhotoMessage(message, senderId, photoKeys, caption, detectedPatterns);
    const [deliveredMessage] = await projectTaskMessagesForViewer({
      taskId,
      viewerId: senderId,
      messages: [message],
    });
    return { success: true, data: deliveredMessage };
  } catch (error) {
    if (error instanceof TRPCError) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: error.message },
      };
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
