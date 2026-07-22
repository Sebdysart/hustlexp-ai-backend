/**
 * Binding HX/OS notification architecture.
 *
 * This module is deliberately pure. It is the exhaustive policy vocabulary used
 * by notification creation, delivery workers, scheduled digests, and compliance
 * evidence. Adding a category without classifying it is a TypeScript error.
 */

export const NOTIFICATION_CLASSES = [
  'transaction_critical',
  'action_required',
  'status',
  'operational_digest',
  'growth',
] as const;

export type NotificationClass = (typeof NOTIFICATION_CLASSES)[number];

export const NOTIFICATION_CHANNELS = ['in_app', 'push', 'email', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CATEGORIES = [
  'task_accepted', 'task_completed', 'task_cancelled', 'task_expired',
  'provider_arrived',
  'proof_submitted', 'proof_approved', 'proof_rejected',
  'clarification_required', 'scope_change_required', 'recurring_budget_exception',
  'escrow_funded', 'payment_failed', 'payment_released', 'payment_due',
  'refund_issued', 'payout_failed',
  'dispute_opened', 'dispute_resolved',
  'trust_tier_upgraded', 'badge_earned',
  'message_received', 'unread_messages',
  'new_matching_task', 'live_mode_task', 'instant_task_available',
  'account_suspended', 'security_alert', 'password_changed',
  'welcome', 'weekly_recap', 'business_operational_digest', 'export_ready',
  'growth_rebook', 'maintenance_suggestion', 'provider_reactivation',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type QuietHoursPolicy = 'respect' | 'active_task_override' | 'security_override';
export type NotificationConsentPolicy = 'transactional' | 'explicit_opt_in';
export type FocusSuppressionPolicy = 'allow' | 'defer_during_active_execution';
export type NotificationContentIdentity = 'transactional' | 'operational' | 'optional_growth';

export interface NotificationCategoryPolicy {
  notificationClass: NotificationClass;
  consent: NotificationConsentPolicy;
  quietHours: QuietHoursPolicy;
  focusSuppression: FocusSuppressionPolicy;
  contentIdentity: NotificationContentIdentity;
  allowedChannels: readonly NotificationChannel[];
  defaultChannels: readonly NotificationChannel[];
  objectReferenceRequired: true;
  deepLinkRequired: true;
  dedupeRequired: true;
  aggregationRequired: boolean;
  supersedes: readonly NotificationCategory[];
  maxDeliveryAttempts: number;
  providerStatusRequired: true;
  terminalFailureVisibility: 'operator_exception';
}

const CLASS_CHANNEL_CONTRACT = {
  // Email remains permitted for security, account, and financial receipts. The
  // supplied class table defines the normal in-app/push path and consented SMS;
  // it does not justify suppressing a separately consented durable receipt.
  transaction_critical: {
    allowed: ['in_app', 'push', 'sms', 'email'],
    defaults: ['in_app', 'push'],
  },
  action_required: {
    allowed: ['in_app', 'push', 'sms', 'email'],
    defaults: ['in_app', 'push'],
  },
  status: {
    allowed: ['in_app', 'push'],
    defaults: ['in_app', 'push'],
  },
  operational_digest: {
    allowed: ['in_app', 'email'],
    defaults: ['in_app', 'email'],
  },
  growth: {
    allowed: ['push', 'email'],
    defaults: ['push'],
  },
} as const satisfies Record<NotificationClass, {
  allowed: readonly NotificationChannel[];
  defaults: readonly NotificationChannel[];
}>;

const base = (
  notificationClass: NotificationClass,
  options: {
    consent?: NotificationConsentPolicy;
    quietHours?: QuietHoursPolicy;
    focusSuppression?: FocusSuppressionPolicy;
    aggregationRequired?: boolean;
    supersedes?: readonly NotificationCategory[];
  } = {},
): NotificationCategoryPolicy => ({
  notificationClass,
  consent: options.consent ?? 'transactional',
  quietHours: options.quietHours ?? 'respect',
  focusSuppression: options.focusSuppression
    ?? (notificationClass === 'operational_digest' || notificationClass === 'growth'
      ? 'defer_during_active_execution'
      : 'allow'),
  contentIdentity: notificationClass === 'growth'
    ? 'optional_growth'
    : notificationClass === 'operational_digest'
      ? 'operational'
      : 'transactional',
  allowedChannels: CLASS_CHANNEL_CONTRACT[notificationClass].allowed,
  defaultChannels: CLASS_CHANNEL_CONTRACT[notificationClass].defaults,
  objectReferenceRequired: true,
  deepLinkRequired: true,
  dedupeRequired: true,
  aggregationRequired: options.aggregationRequired ?? false,
  supersedes: options.supersedes ?? [],
  maxDeliveryAttempts: 3,
  providerStatusRequired: true,
  terminalFailureVisibility: 'operator_exception',
});

export type NotificationChannelResolution =
  | { valid: true; channels: NotificationChannel[] }
  | { valid: false; reason: 'notification_channels_required' | 'notification_channel_forbidden' };

/** Resolve class-owned defaults and reject any channel the class does not permit. */
export function resolveNotificationChannels(
  policy: NotificationCategoryPolicy,
  requested?: readonly NotificationChannel[],
): NotificationChannelResolution {
  const selected = requested ?? policy.defaultChannels;
  if (selected.length === 0) {
    return { valid: false, reason: 'notification_channels_required' };
  }
  const channels = [...new Set(selected)];
  if (channels.some((channel) => !policy.allowedChannels.includes(channel))) {
    return { valid: false, reason: 'notification_channel_forbidden' };
  }
  return { valid: true, channels };
}

/**
 * Preserve a provider-visible identity boundary. Optional growth may never use
 * task-state-looking copy without an explicit label, and caller metadata cannot
 * overwrite the system-owned notification intent.
 */
export function applyNotificationPresentation(
  policy: NotificationCategoryPolicy,
  title: string,
  metadata: Record<string, unknown> = {},
): { title: string; metadata: Record<string, unknown> } {
  const trimmedTitle = title.trim();
  const visibleTitle = policy.contentIdentity === 'optional_growth'
    && !trimmedTitle.startsWith('Optional · ')
    ? `Optional · ${trimmedTitle}`
    : trimmedTitle;
  return {
    title: visibleTitle.slice(0, 200),
    metadata: { ...metadata, notificationIntent: policy.contentIdentity },
  };
}

const taskTerminalSupersedes = [
  'new_matching_task', 'live_mode_task', 'instant_task_available', 'task_accepted',
  'provider_arrived', 'proof_submitted', 'proof_rejected', 'clarification_required',
  'scope_change_required',
] as const satisfies readonly NotificationCategory[];

/** Every category is deliberately and exhaustively classified. */
export const NOTIFICATION_POLICY = {
  task_accepted: base('status', {
    quietHours: 'active_task_override',
    supersedes: ['new_matching_task', 'live_mode_task', 'instant_task_available'],
  }),
  task_completed: base('status', { supersedes: taskTerminalSupersedes }),
  task_cancelled: base('transaction_critical', { supersedes: taskTerminalSupersedes }),
  task_expired: base('status', { supersedes: taskTerminalSupersedes }),
  provider_arrived: base('transaction_critical', { quietHours: 'active_task_override' }),
  proof_submitted: base('action_required', {
    quietHours: 'active_task_override', supersedes: ['proof_rejected'],
  }),
  proof_approved: base('status', { supersedes: ['proof_submitted', 'proof_rejected'] }),
  proof_rejected: base('action_required', {
    quietHours: 'active_task_override', supersedes: ['proof_submitted'],
  }),
  clarification_required: base('action_required', { quietHours: 'active_task_override' }),
  scope_change_required: base('action_required', { quietHours: 'active_task_override' }),
  recurring_budget_exception: base('action_required'),
  escrow_funded: base('status'),
  payment_failed: base('transaction_critical', { quietHours: 'active_task_override' }),
  payment_released: base('status', { supersedes: ['payment_due', 'payment_failed'] }),
  payment_due: base('action_required'),
  refund_issued: base('transaction_critical', { supersedes: ['payment_due', 'payment_failed'] }),
  payout_failed: base('transaction_critical', { quietHours: 'active_task_override' }),
  dispute_opened: base('transaction_critical', { quietHours: 'active_task_override' }),
  dispute_resolved: base('transaction_critical', { supersedes: ['dispute_opened'] }),
  trust_tier_upgraded: base('growth', { consent: 'explicit_opt_in' }),
  badge_earned: base('growth', { consent: 'explicit_opt_in' }),
  message_received: base('action_required', { quietHours: 'active_task_override' }),
  unread_messages: base('operational_digest', { aggregationRequired: true }),
  new_matching_task: base('action_required', {
    focusSuppression: 'defer_during_active_execution',
  }),
  live_mode_task: base('action_required', {
    focusSuppression: 'defer_during_active_execution',
  }),
  instant_task_available: base('action_required', {
    quietHours: 'active_task_override',
    focusSuppression: 'defer_during_active_execution',
  }),
  account_suspended: base('transaction_critical', { quietHours: 'security_override' }),
  security_alert: base('transaction_critical', { quietHours: 'security_override' }),
  password_changed: base('transaction_critical', { quietHours: 'security_override' }),
  welcome: base('growth', { consent: 'explicit_opt_in' }),
  weekly_recap: base('operational_digest', { aggregationRequired: true }),
  business_operational_digest: base('operational_digest', { aggregationRequired: true }),
  export_ready: base('status'),
  growth_rebook: base('growth', { consent: 'explicit_opt_in' }),
  maintenance_suggestion: base('growth', { consent: 'explicit_opt_in' }),
  provider_reactivation: base('growth', { consent: 'explicit_opt_in' }),
} as const satisfies Record<NotificationCategory, NotificationCategoryPolicy>;

export type DeepLinkValidation = { valid: true } | { valid: false; reason: string };

/** Only app-owned routes are permitted. Provider-visible copy may never open an arbitrary URL. */
export function validateNotificationDeepLink(deepLink: string): DeepLinkValidation {
  const value = deepLink.trim();
  if (!value) return { valid: false, reason: 'deep_link_required' };
  if (value.length > 2048) return { valid: false, reason: 'deep_link_too_long' };
  if (/\s/.test(value)) return { valid: false, reason: 'deep_link_whitespace' };
  if (value.startsWith('/') && !value.startsWith('//')) return { valid: true };
  if (!/^(?:hustlexp|app):\/\//.test(value)) {
    return { valid: false, reason: 'deep_link_must_be_internal' };
  }
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      return { valid: false, reason: 'deep_link_credentials_forbidden' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'deep_link_invalid' };
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values as unknown as ZonedParts;
}

function parseClock(value: string): { hour: number; minute: number; second: number } | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

/** Convert a wall-clock time in an IANA zone to an instant, including DST boundaries. */
function zonedDateTimeToDate(parts: ZonedParts, timeZone: string): Date {
  const target = Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
  );
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = zonedParts(new Date(candidate), timeZone);
    const renderedUtc = Date.UTC(
      rendered.year, rendered.month - 1, rendered.day,
      rendered.hour, rendered.minute, rendered.second,
    );
    const delta = target - renderedUtc;
    candidate += delta;
    if (delta === 0) break;
  }
  return new Date(candidate);
}

/**
 * Return the first instant at which quiet hours end, or null when `now` is not
 * quiet. Invalid clocks/zones throw so callers cannot silently mis-schedule.
 */
export function nextQuietHoursEnd(
  now: Date,
  startTime: string,
  endTime: string,
  timeZone: string,
): Date | null {
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_NOTIFICATION_CLOCK');
  const start = parseClock(startTime);
  const end = parseClock(endTime);
  if (!start || !end) throw new Error('INVALID_QUIET_HOURS');

  const localNow = zonedParts(now, timeZone);
  const nowSeconds = localNow.hour * 3600 + localNow.minute * 60 + localNow.second;
  const startSeconds = start.hour * 3600 + start.minute * 60 + start.second;
  const endSeconds = end.hour * 3600 + end.minute * 60 + end.second;
  if (startSeconds === endSeconds) return null;

  const overnight = startSeconds > endSeconds;
  const quiet = overnight
    ? nowSeconds >= startSeconds || nowSeconds < endSeconds
    : nowSeconds >= startSeconds && nowSeconds < endSeconds;
  if (!quiet) return null;

  let endYear = localNow.year;
  let endMonth = localNow.month;
  let endDay = localNow.day;
  if (overnight && nowSeconds >= startSeconds) {
    const following = new Date(Date.UTC(endYear, endMonth - 1, endDay + 1));
    endYear = following.getUTCFullYear();
    endMonth = following.getUTCMonth() + 1;
    endDay = following.getUTCDate();
  }

  return zonedDateTimeToDate({
    year: endYear,
    month: endMonth,
    day: endDay,
    hour: end.hour,
    minute: end.minute,
    second: end.second,
  }, timeZone);
}
