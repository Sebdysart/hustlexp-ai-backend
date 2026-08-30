import { describe, expect, it } from 'vitest';
import {
  createUserRealtimeEnvelope,
  getCanonicalUserRoomKey,
  getUserIdFromCanonicalRoomKey,
  isCanonicalUserRoomKey,
  parseUserRealtimeEnvelope,
} from '../../src/realtime/user-realtime-contract';

describe('user realtime contract', () => {
  it('constructs and parses the canonical versioned user envelope', () => {
    const timestamp = '2026-08-28T12:34:56.789Z';
    const envelope = createUserRealtimeEnvelope(
      'user:one two',
      'message.new',
      { messageId: 'message-1' },
      timestamp,
    );

    expect(envelope).toEqual({
      schemaVersion: 1,
      type: 'message.new',
      payload: { messageId: 'message-1' },
      timestamp,
      room: 'room:user:user%3Aone%20two',
    });
    expect(getUserIdFromCanonicalRoomKey(envelope.room)).toBe('user:one two');
    expect(parseUserRealtimeEnvelope(envelope.room, JSON.stringify(envelope))).toEqual(envelope);
  });

  it('rejects invalid identifiers and non-canonical channels', () => {
    expect(() => getCanonicalUserRoomKey('')).toThrow('SSE_USER_ID_INVALID');
    expect(() => getCanonicalUserRoomKey(' user-1')).toThrow('SSE_USER_ID_INVALID');
    expect(isCanonicalUserRoomKey('room:user:user one')).toBe(false);
    expect(isCanonicalUserRoomKey('realtime:user:user-1')).toBe(false);
  });

  it('rejects mismatched rooms, legacy envelopes, and invalid payloads', () => {
    const envelope = createUserRealtimeEnvelope('user-1', 'message.new', {});

    expect(() => parseUserRealtimeEnvelope(
      getCanonicalUserRoomKey('user-2'),
      JSON.stringify(envelope),
    )).toThrow('SSE_EVENT_ENVELOPE_INVALID');
    expect(() => parseUserRealtimeEnvelope(
      envelope.room,
      JSON.stringify({ ...envelope, schemaVersion: undefined }),
    )).toThrow('SSE_EVENT_ENVELOPE_INVALID');
    expect(() => createUserRealtimeEnvelope('user-1', 'bad event type', {}))
      .toThrow('SSE_EVENT_TYPE_INVALID');
    expect(() => createUserRealtimeEnvelope('user-1', 'message.new', [] as unknown as Record<string, unknown>))
      .toThrow('SSE_EVENT_PAYLOAD_INVALID');
  });
});
