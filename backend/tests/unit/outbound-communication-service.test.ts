import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createOutboundEmailPort,
  createOutboundSmsPort,
  sendEmailToSmtpSink,
  type OutboundEmailMessage,
  type OutboundSmsMessage,
} from '../../src/services/OutboundCommunicationService.js';

const emailMessage: OutboundEmailMessage = {
  idempotencyKey: 'email-idempotency-1',
  emailId: 'email-1',
  userId: 'user-1',
  to: 'synthetic-recipient@example.invalid',
  from: 'synthetic-sender@example.invalid',
  subject: 'Synthetic task update',
  text: 'The synthetic task changed.',
  html: '<p>The synthetic task changed.</p>',
};

const smsMessage: OutboundSmsMessage = {
  idempotencyKey: 'sms-idempotency-1',
  smsId: 'sms-1',
  notificationId: 'notification-1',
  to: '+15555550100',
  body: 'Synthetic task update.',
};

function sinkEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'development',
    HX_ENVIRONMENT: 'local',
    HX_OUTBOUND_COMMUNICATION_MODE: 'sink',
    HX_EMAIL_DELIVERY_MODE: 'sink',
    HX_SMS_DELIVERY_MODE: 'sink',
    HX_LIVE_DELIVERY: 'false',
    HX_LIVE_PROVIDER_ACCESS: 'false',
    HX_EXTERNAL_VALUE: 'false',
    SMTP_URL: 'smtp://mailpit:1025',
    HX_SMS_SINK_URL: 'http://synthetic-providers:8080/v1/messages/sms',
    ...overrides,
  };
}

function transportSpies() {
  return {
    smtpSend: vi.fn().mockResolvedValue('smtp-sink-accepted-1'),
    fetch: vi.fn(),
    liveEmail: vi.fn().mockResolvedValue('sendgrid-accepted-1'),
    liveSms: vi.fn().mockResolvedValue('twilio-accepted-1'),
  };
}

describe('provider-neutral outbound communication ports', () => {
  it('routes local email to the configured SMTP sink without any provider secret', async () => {
    const transports = transportSpies();
    const env = sinkEnvironment();
    expect(env.SENDGRID_API_KEY).toBeUndefined();

    const receipt = await createOutboundEmailPort({ env, transports }).deliver(emailMessage);

    expect(transports.smtpSend).toHaveBeenCalledWith(new URL('smtp://mailpit:1025'), emailMessage);
    expect(transports.liveEmail).not.toHaveBeenCalled();
    expect(receipt).toEqual({
      providerKind: 'smtp_sink',
      providerMessageId: 'smtp-sink-accepted-1',
      liveDelivery: false,
    });
  });

  it('writes a deterministic RFC message to an SMTP sink over loopback', async () => {
    let transcript = '';
    const server = createServer((socket) => {
      let buffer = '';
      let readingData = false;
      socket.write('220 synthetic-mail-sink ready\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\r\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          transcript += `${line}\n`;
          if (readingData) {
            if (line === '.') {
              readingData = false;
              socket.write('250 accepted\r\n');
            }
          } else if (line.startsWith('EHLO ')) {
            socket.write('250-synthetic-mail-sink\r\n250 8BITMIME\r\n');
          } else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) {
            socket.write('250 accepted\r\n');
          } else if (line === 'DATA') {
            readingData = true;
            socket.write('354 end with dot\r\n');
          } else if (line === 'QUIT') {
            socket.write('221 goodbye\r\n');
          }
        }
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('SMTP test server did not bind TCP');

    try {
      const providerMessageId = await sendEmailToSmtpSink(
        new URL(`smtp://127.0.0.1:${address.port}`),
        emailMessage
      );
      const digest = createHash('sha256')
        .update(`email:${emailMessage.idempotencyKey}`, 'utf8')
        .digest('hex');
      expect(providerMessageId).toBe(`smtp-sink-${digest}`);
      expect(transcript).toContain('RCPT TO:<synthetic-recipient@example.invalid>');
      expect(transcript).toContain('X-HustleXP-Idempotency-Key: email-idempotency-1');
      expect(transcript).toContain(`Message-ID: <${digest}@sink.hustlexp.invalid>`);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        })
      );
    }
  });

  it('routes staging SMS to the private HTTP sink and requires a non-live attestation', async () => {
    const transports = transportSpies();
    transports.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          providerKind: 'sink',
          messageId: 'sms-sink-accepted-1',
          liveDelivery: false,
        }),
        { status: 202, headers: { 'content-type': 'application/json' } }
      )
    );
    const env = sinkEnvironment({
      NODE_ENV: 'production',
      HX_ENVIRONMENT: 'staging',
      HX_SMS_SINK_URL: 'http://synthetic-providers.railway.internal:8080/v1/messages/sms',
      SMTP_URL: 'smtp://message-sink.railway.internal:1025',
    });
    expect(env.TWILIO_AUTH_TOKEN).toBeUndefined();

    const receipt = await createOutboundSmsPort({ env, transports }).deliver(smsMessage);

    expect(transports.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = transports.fetch.mock.calls[0];
    expect(String(url)).toBe('http://synthetic-providers.railway.internal:8080/v1/messages/sms');
    expect(request.headers).toMatchObject({
      'content-type': 'application/json',
      'x-hustlexp-idempotency-key': 'sms-idempotency-1',
    });
    expect(JSON.parse(String(request.body))).toMatchObject({
      smsId: 'sms-1',
      notificationId: 'notification-1',
      idempotencyKey: 'sms-idempotency-1',
    });
    expect(transports.liveSms).not.toHaveBeenCalled();
    expect(receipt).toEqual({
      providerKind: 'http_sink',
      providerMessageId: 'sms-sink-accepted-1',
      liveDelivery: false,
    });
  });

  it('fails closed in production when only legacy provider credentials exist', () => {
    const transports = transportSpies();
    const env = {
      NODE_ENV: 'production',
      HX_ENVIRONMENT: 'production',
      SENDGRID_API_KEY: 'configured-but-not-authority',
      TWILIO_ACCOUNT_SID: 'configured-but-not-authority',
      TWILIO_AUTH_TOKEN: 'configured-but-not-authority',
    };

    expect(() => createOutboundEmailPort({ env, transports })).toThrow(
      /OUTBOUND_DELIVERY_DENIED|Outbound delivery denied/u
    );
    expect(() => createOutboundSmsPort({ env, transports })).toThrow(
      /OUTBOUND_DELIVERY_DENIED|Outbound delivery denied/u
    );
    expect(transports.smtpSend).not.toHaveBeenCalled();
    expect(transports.fetch).not.toHaveBeenCalled();
    expect(transports.liveEmail).not.toHaveBeenCalled();
    expect(transports.liveSms).not.toHaveBeenCalled();
  });

  it('requires the complete explicit authority tuple before selecting approved live adapters', async () => {
    const transports = transportSpies();
    const env = {
      NODE_ENV: 'production',
      HX_ENVIRONMENT: 'production',
      HX_OUTBOUND_COMMUNICATION_MODE: 'live_provider',
      HX_EMAIL_DELIVERY_MODE: 'sendgrid',
      HX_SMS_DELIVERY_MODE: 'twilio',
      HX_LIVE_DELIVERY: 'true',
      HX_LIVE_PROVIDER_ACCESS: 'true',
      HX_EXTERNAL_VALUE: 'true',
      SENDGRID_API_KEY: 'test-approved-sendgrid-reference',
      SENDGRID_FROM_EMAIL: 'approved-sender@example.invalid',
      TWILIO_ACCOUNT_SID: 'test-approved-twilio-account',
      TWILIO_AUTH_TOKEN: 'test-approved-twilio-reference',
      TWILIO_FROM_PHONE: '+15555550199',
    };

    await expect(
      createOutboundEmailPort({ env, transports }).deliver(emailMessage)
    ).resolves.toEqual({
      providerKind: 'sendgrid',
      providerMessageId: 'sendgrid-accepted-1',
      liveDelivery: true,
    });
    await expect(createOutboundSmsPort({ env, transports }).deliver(smsMessage)).resolves.toEqual({
      providerKind: 'twilio',
      providerMessageId: 'twilio-accepted-1',
      liveDelivery: true,
    });
    expect(transports.liveEmail).toHaveBeenCalledTimes(1);
    expect(transports.liveSms).toHaveBeenCalledTimes(1);
  });

  it('rejects public sink endpoints in preview and staging', () => {
    const transports = transportSpies();
    expect(() =>
      createOutboundSmsPort({
        env: sinkEnvironment({
          HX_ENVIRONMENT: 'preview',
          HX_SMS_SINK_URL: 'https://example.com/sms',
        }),
        transports,
      })
    ).toThrow(/private networking/u);
  });

  it('rejects public sink endpoints even when a caller labels them local', () => {
    const transports = transportSpies();
    expect(() =>
      createOutboundSmsPort({
        env: sinkEnvironment({ HX_SMS_SINK_URL: 'https://example.com/sms' }),
        transports,
      })
    ).toThrow(/local container networking/u);
  });
});

describe('provider-neutral outbound migration', () => {
  it('adds provider identity and generic SMS receipt fields without dropping compatibility data', () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        'backend/database/migrations/20260831_provider_neutral_outbound_communication.sql'
      ),
      'utf8'
    );
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS provider_name TEXT');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS provider_message_id TEXT');
    expect(migration).toContain('provider_message_id = COALESCE(provider_message_id, twilio_sid)');
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/iu);
  });
});
