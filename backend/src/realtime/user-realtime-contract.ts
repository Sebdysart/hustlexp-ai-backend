const USER_CHANNEL_PREFIX = 'room:user:';
const REALTIME_EVENT_TYPE = /^[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*$/u;
const MAX_USER_ID_LENGTH = 128;
const MAX_EVENT_TYPE_LENGTH = 96;

export const USER_REALTIME_SCHEMA_VERSION = 1 as const;

export interface UserRealtimeEnvelope {
  schemaVersion: typeof USER_REALTIME_SCHEMA_VERSION;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
  room: string;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function assertUserId(userId: string): void {
  if (
    typeof userId !== 'string'
    || userId.length === 0
    || userId.length > MAX_USER_ID_LENGTH
    || userId !== userId.trim()
    || containsControlCharacter(userId)
  ) {
    throw new Error('SSE_USER_ID_INVALID');
  }
}

function assertEventType(type: string): void {
  if (
    typeof type !== 'string'
    || type.length > MAX_EVENT_TYPE_LENGTH
    || !REALTIME_EVENT_TYPE.test(type)
  ) {
    throw new Error('SSE_EVENT_TYPE_INVALID');
  }
}

function assertPayload(payload: Record<string, unknown>): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('SSE_EVENT_PAYLOAD_INVALID');
  }
  try {
    JSON.stringify(payload);
  } catch {
    throw new Error('SSE_EVENT_PAYLOAD_INVALID');
  }
}

function assertTimestamp(timestamp: string): void {
  const parsedTimestamp = Date.parse(timestamp);
  if (
    typeof timestamp !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)
    || Number.isNaN(parsedTimestamp)
    || new Date(parsedTimestamp).toISOString() !== timestamp
  ) {
    throw new Error('SSE_EVENT_TIMESTAMP_INVALID');
  }
}

/**
 * Return the only supported Redis channel for personal realtime delivery.
 * Encoding keeps Redis channel delimiters structural while preserving existing
 * Firebase-style identifiers byte-for-byte when they already use URL-safe text.
 */
export function getCanonicalUserRoomKey(userId: string): string {
  assertUserId(userId);
  return `${USER_CHANNEL_PREFIX}${encodeURIComponent(userId)}`;
}

export function isCanonicalUserRoomKey(room: string): boolean {
  if (typeof room !== 'string' || !room.startsWith(USER_CHANNEL_PREFIX)) return false;
  try {
    const encodedUserId = room.slice(USER_CHANNEL_PREFIX.length);
    const userId = decodeURIComponent(encodedUserId);
    return getCanonicalUserRoomKey(userId) === room;
  } catch {
    return false;
  }
}

export function getUserIdFromCanonicalRoomKey(room: string): string {
  if (!isCanonicalUserRoomKey(room)) throw new Error('SSE_CHANNEL_INVALID');
  return decodeURIComponent(room.slice(USER_CHANNEL_PREFIX.length));
}

export function createUserRealtimeEnvelope(
  userId: string,
  type: string,
  payload: Record<string, unknown>,
  timestamp = new Date().toISOString(),
): UserRealtimeEnvelope {
  const room = getCanonicalUserRoomKey(userId);
  assertEventType(type);
  assertPayload(payload);
  assertTimestamp(timestamp);
  return {
    schemaVersion: USER_REALTIME_SCHEMA_VERSION,
    type,
    payload,
    timestamp,
    room,
  };
}

export function parseUserRealtimeEnvelope(
  channel: string,
  rawMessage: string,
): UserRealtimeEnvelope {
  if (!isCanonicalUserRoomKey(channel)) throw new Error('SSE_CHANNEL_INVALID');

  const parsed: unknown = JSON.parse(rawMessage);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SSE_EVENT_ENVELOPE_INVALID');
  }

  const envelope = parsed as Partial<UserRealtimeEnvelope>;
  if (
    envelope.schemaVersion !== USER_REALTIME_SCHEMA_VERSION
    || envelope.room !== channel
    || typeof envelope.type !== 'string'
    || typeof envelope.timestamp !== 'string'
    || envelope.payload === null
    || typeof envelope.payload !== 'object'
    || Array.isArray(envelope.payload)
  ) {
    throw new Error('SSE_EVENT_ENVELOPE_INVALID');
  }

  assertEventType(envelope.type);
  assertPayload(envelope.payload as Record<string, unknown>);
  assertTimestamp(envelope.timestamp);
  return envelope as UserRealtimeEnvelope;
}
