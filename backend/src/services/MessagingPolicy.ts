import { db } from '../db.js';
import type { ServiceResult, TaskState } from '../types.js';
import { ErrorCodes } from '../types.js';
import { expire, incr } from '../cache/redis.js';
import type {
  CreateMessageParams,
  MessagingContext,
  MessagingTask,
} from './MessagingTypes.js';

const ALLOWED_MESSAGING_STATES: TaskState[] = ['ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED'];
const QUOTE_MESSAGING_STATES: TaskState[] = ['OPEN', 'MATCHING'];
const READ_ONLY_STATES: TaskState[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

const AUTO_MESSAGE_TEMPLATES: Record<string, string> = {
  on_my_way: "I'm on my way to the task location. ETA: ~X minutes.",
  running_late: "I'm running about X minutes late. I'll arrive at [time].",
  completed: "I've completed the task. Submitting proof now.",
  need_clarification: 'I need clarification on [specific aspect].',
  photo_request: 'Could you take a photo of [specific thing]?',
};

function invalidStateMessage(state: TaskState, variant: 'text' | 'photo'): string {
  if (READ_ONLY_STATES.includes(state)) {
    return `Cannot send messages: task is in ${state} state (read-only)`;
  }
  if (variant === 'photo') return `Cannot send messages: task is in ${state} state`;
  return `Cannot send messages: task is in ${state} state. Messages allowed in: ${ALLOWED_MESSAGING_STATES.join(', ')}`;
}

async function loadMessagingTask(taskId: string): Promise<MessagingTask | null> {
  const taskResult = await db.query<MessagingTask>(
    `SELECT t.id,t.poster_id,t.worker_id,t.state,
            shortlist.worker_id AS quote_worker_id
       FROM tasks t
       LEFT JOIN LATERAL (
         SELECT worker_id FROM task_quote_shortlists
          WHERE task_id=t.id AND status='ACTIVE'
          LIMIT 1
       ) shortlist ON TRUE
      WHERE t.id=$1`,
    [taskId],
  );
  return taskResult.rows[0] ?? null;
}

export async function loadMessagingContext(
  taskId: string,
  senderId: string,
  variant: 'text' | 'photo',
): Promise<ServiceResult<MessagingContext>> {
  const task = await loadMessagingTask(taskId);
  if (!task) {
    return {
      success: false,
      error: { code: ErrorCodes.NOT_FOUND, message: `Task ${taskId} not found` },
    };
  }

  const assignedState = ALLOWED_MESSAGING_STATES.includes(task.state);
  const quoteState = QUOTE_MESSAGING_STATES.includes(task.state);
  if (!assignedState && !quoteState) {
    return {
      success: false,
      error: { code: ErrorCodes.INVALID_STATE, message: invalidStateMessage(task.state, variant) },
    };
  }
  const assignedWorker = assignedState ? task.worker_id : null;
  const quoteWorker = quoteState ? task.quote_worker_id ?? null : null;
  const authorizedWorker = assignedWorker ?? quoteWorker;
  if (!authorizedWorker) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_STATE,
        message: `Cannot send message: no recipient is active for this ${task.state} task`,
      },
    };
  }
  if (task.poster_id !== senderId && authorizedWorker !== senderId) {
    return {
      success: false,
      error: { code: ErrorCodes.FORBIDDEN, message: 'You are not a participant in this task' },
    };
  }

  const recipientId = task.poster_id === senderId ? authorizedWorker : task.poster_id;
  return { success: true, data: { task, recipientId } };
}

export async function loadMessagingReadContext(
  taskId: string,
  viewerId: string,
): Promise<ServiceResult<MessagingContext>> {
  const task = await loadMessagingTask(taskId);
  if (!task) {
    return {
      success: false,
      error: { code: ErrorCodes.NOT_FOUND, message: `Task ${taskId} not found` },
    };
  }
  const assignedReadable = [...ALLOWED_MESSAGING_STATES, ...READ_ONLY_STATES].includes(task.state)
    ? task.worker_id
    : null;
  const quoteReadable = QUOTE_MESSAGING_STATES.includes(task.state)
    ? task.quote_worker_id ?? null
    : null;
  const authorizedWorker = assignedReadable ?? quoteReadable;
  if (!authorizedWorker || (viewerId !== task.poster_id && viewerId !== authorizedWorker)) {
    return {
      success: false,
      error: { code: ErrorCodes.FORBIDDEN, message: 'You do not have permission to view messages for this task' },
    };
  }
  return {
    success: true,
    data: {
      task,
      recipientId: viewerId === task.poster_id ? authorizedWorker : task.poster_id,
    },
  };
}

export function resolveMessageContent(
  params: CreateMessageParams,
): ServiceResult<string> {
  if (params.messageType === 'TEXT') {
    if (!params.content || params.content.trim().length === 0) {
      return {
        success: false,
        error: { code: ErrorCodes.INVALID_INPUT, message: 'Text message content is required' },
      };
    }
    if (params.content.length > 500) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_INPUT,
          message: 'Message content exceeds maximum length of 500 characters',
        },
      };
    }
    return { success: true, data: params.content };
  }

  const template = params.autoMessageTemplate;
  if (!template || !AUTO_MESSAGE_TEMPLATES[template]) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_INPUT,
        message: `Invalid auto-message template: ${template}. Allowed templates: ${Object.keys(AUTO_MESSAGE_TEMPLATES).join(', ')}`,
      },
    };
  }
  return { success: true, data: AUTO_MESSAGE_TEMPLATES[template] };
}

export function validatePhotoCount(photoUrls: string[]): ServiceResult<true> {
  if (photoUrls && photoUrls.length > 0 && photoUrls.length <= 3) {
    return { success: true, data: true };
  }
  return {
    success: false,
    error: { code: ErrorCodes.INVALID_INPUT, message: 'Photo message must contain 1-3 photos' },
  };
}

export async function enforceMessageRateLimit(
  senderId: string,
  taskId: string,
): Promise<ServiceResult<true>> {
  const limit = 30;
  const windowSeconds = 60;
  const count = await incr(`msg_rate:${senderId}:${taskId}`);
  if (count === 1) await expire(`msg_rate:${senderId}:${taskId}`, windowSeconds);
  if (count <= limit) return { success: true, data: true };
  return {
    success: false,
    error: {
      code: ErrorCodes.RATE_LIMIT_EXCEEDED,
      message: `Message rate limit exceeded. You can send at most ${limit} messages per minute per conversation.`,
    },
  };
}

export function detectForbiddenPatterns(content: string): string[] {
  const patterns: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s]*)/i, 'link'],
    [/(\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/, 'phone'],
    [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, 'email'],
    [/\b(?:venmo|paypal|cash\s*app|cashapp|zelle)\b|(?:^|\s)\$[a-z][a-z0-9_]{1,30}\b/i, 'payment_handle'],
    [/\b\d{1,6}\s+(?:[a-z0-9.'-]+\s+){0,5}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|circle|cir|way|parkway|pkwy|highway|hwy|place|pl|terrace|ter)\b\.?/i, 'street_address'],
    [/<\s*\/?\s*(?:script|iframe|object|embed|svg|math)\b|\bon(?:error|load|click|focus|mouseover)\s*=/i, 'unsafe_markup'],
    [/\b(?:javascript|vbscript|data)\s*:/i, 'unsafe_scheme'],
    [/\b(?:while\s+you(?:'re|\s+are)?\b[^.!?]{0,80}\b(?:can|could|would)\s+you\s+also|(?:can|could|would)\s+you\s+also|one\s+more\s+(?:thing|task)|add(?:ing)?\s+(?:another|one\s+more)\s+(?:task|job|chore))\b/i, 'scope_change_request'],
    [/\b(?:(?:text|call|email|message)\s+me|off[ -]?platform|outside\s+(?:the\s+)?app|avoid\s+(?:the\s+)?fees?|pay\s+(?:me\s+)?(?:directly|in\s+cash))\b/i, 'off_platform_request'],
    [/\b(?:kill\s+yourself|i(?:'ll|\s+will)\s+(?:hurt|kill|attack|find)\s+you|(?:fuck|screw)\s+you|you(?:'re|\s+are)\s+(?:(?:a|an)\s+)?(?:worthless|stupid|idiot|moron))\b/i, 'harassment'],
    [/\b(?:send\s+nudes?|sexual\s+services?|(?:buy\s+or\s+sell|buy|sell|provide)\s+(?:illegal\s+)?(?:drugs?|weapons?)|unlicensed\s+(?:electrical|gas|structural)\s+work)\b/i, 'prohibited_content'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(content)) patterns.push(label);
  }
  return patterns;
}
