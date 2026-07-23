import type { TaskState } from '../types.js';

export interface TaskMessage {
  id: string;
  task_id: string;
  sender_id: string;
  receiver_id: string;
  message_type: 'TEXT' | 'AUTO' | 'PHOTO' | 'LOCATION';
  content?: string;
  auto_message_template?: string;
  photo_urls?: string[];
  photo_count?: number;
  photo_delivery_status?: 'NONE' | 'READY' | 'PARTIAL' | 'UNAVAILABLE';
  photo_urls_expires_at?: string | null;
  location_latitude?: number;
  location_longitude?: number;
  location_expires_at?: Date;
  read_at?: Date | null;
  moderation_status?: 'pending' | 'approved' | 'flagged' | 'quarantined';
  moderation_flags?: string[];
  created_at: Date;
  updated_at: Date;
}

export interface CreateMessageParams {
  taskId: string;
  senderId: string;
  messageType: 'TEXT' | 'AUTO';
  content?: string;
  autoMessageTemplate?: string;
}

export interface CreatePhotoMessageParams {
  taskId: string;
  senderId: string;
  uploadReceiptIds: string[];
  caption?: string;
}

export interface MessagingTask {
  id: string;
  poster_id: string;
  worker_id: string | null;
  quote_worker_id?: string | null;
  state: TaskState;
}

export interface MessagingContext {
  task: MessagingTask;
  recipientId: string;
}
