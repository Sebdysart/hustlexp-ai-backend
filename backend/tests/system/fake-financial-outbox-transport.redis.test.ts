import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createFakeFinancialOutboxTransport } from '../../src/jobs/queues.js';
import type { FakeFinancialOutboxClaim } from '../../src/jobs/fake-financial-outbox-publisher.js';

describe('fake-financial producer socket lifecycle', () => {
  it.each(['deadline', 'abort'] as const)(
    'settles pending Redis work and closes its socket on %s',
    async (mode) => {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', () => undefined);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('LOOPBACK_TEST_SERVER_REQUIRED');
      const controller = new AbortController();
      const commandId = randomUUID();
      const outboxId = randomUUID();
      const row: FakeFinancialOutboxClaim = {
        publish_claim_id: randomUUID(),
        outbox_request_id: outboxId,
        command_id: commandId,
        bullmq_job_id: `hx-fake-fin-${commandId.replaceAll('-', '')}-${'a'.repeat(64)}`,
        queue_name: 'synthetic_finance',
        job_name: 'synthetic_finance.command.v13',
        job_payload: {
          version: 1,
          kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND',
          outboxRequestId: outboxId,
          commandId,
          jobAuthoritySha256: 'a'.repeat(64),
        },
        job_authority_sha256: 'a'.repeat(64),
        claim_number: 1,
        lease_expires_at: new Date(Date.now() + 60000),
      };
      const transport = createFakeFinancialOutboxTransport({
        redisUrl: `redis://127.0.0.1:${address.port}`,
        prefix: `hx-ci-socket-${randomUUID()}`,
        deadlineMs: 200,
      });
      const startedAt = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        const published = transport.publish(row, controller.signal);
        if (mode === 'abort') timer = setTimeout(() => controller.abort(), 50);
        await expect(published).rejects.toThrow();
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        // Let the peer observe EOF; the operation itself has already settled.
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(sockets.size).toBe(0);
      } finally {
        if (timer) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );
});
