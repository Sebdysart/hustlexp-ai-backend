/**
 * Task-scoped coordination messaging facade.
 *
 * CONSTITUTIONAL: PRODUCT_SPEC section 10, MESSAGING_SPEC.md.
 */
import {
  getMessagesForTask,
  getUnreadCount,
  markAllAsRead,
  markAsRead,
} from './MessagingReadService.js';
import { sendPhotoMessage } from './MessagingPhotoService.js';
import { sendMessage } from './MessagingTextService.js';

export type {
  CreateMessageParams,
  CreatePhotoMessageParams,
  TaskMessage,
} from './MessagingTypes.js';

export const MessagingService = {
  getMessagesForTask,
  getUnreadCount,
  sendMessage,
  sendPhotoMessage,
  markAsRead,
  markAllAsRead,
};
