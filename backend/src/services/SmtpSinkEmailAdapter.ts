import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';

/**
 * Transport-local message shape. Keep the SMTP sink independent from the
 * higher-level outbound-port factory so the adapter can be imported by that
 * factory without creating a runtime/module cycle.
 */
interface SmtpSinkEmailMessage {
  idempotencyKey: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

interface SmtpResponse {
  code: number;
  message: string;
}

interface SmtpResponseWaiter {
  resolve: (response: SmtpResponse) => void;
  reject: (error: Error) => void;
}

class SmtpResponseReader {
  private buffer = '';
  private lines: string[] = [];
  private responses: SmtpResponse[] = [];
  private waiters: SmtpResponseWaiter[] = [];
  private failure: Error | null = null;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('SMTP sink closed the connection')));
  }

  next(): Promise<SmtpResponse> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.responses.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    const completeLines = this.buffer.split(/\r?\n/u);
    this.buffer = completeLines.pop() ?? '';
    for (const line of completeLines) this.onLine(line);
  }

  private onLine(line: string): void {
    this.lines.push(line);
    const terminal = line.match(/^(\d{3}) /u);
    if (!terminal) return;
    const response = { code: Number(terminal[1]), message: this.lines.join('\n') };
    this.lines = [];
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(response);
    else this.responses.push(response);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.responses = [];
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}

function stableMessageId(idempotencyKey: string): string {
  return createHash('sha256').update(`email:${idempotencyKey}`, 'utf8').digest('hex');
}

function openSmtpConnection(
  url: URL,
  timeoutMs: number
): { socket: Socket; connected: Promise<void> } {
  const port = Number(url.port || (url.protocol === 'smtps:' ? 465 : 25));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SMTP sink port is invalid');
  }
  if (url.protocol === 'smtps:') {
    const socket = connectTls({ host: url.hostname, port, servername: url.hostname });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP sink connection timed out')));
    const connected = new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    return { socket, connected };
  }
  const socket = new Socket();
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP sink connection timed out')));
  const connected = new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.connect(port, url.hostname);
  });
  return { socket, connected };
}

function safeHeader(value: string, name: string): string {
  if (/\r|\n/u.test(value)) throw new Error(`${name} may not contain line breaks`);
  return value;
}

function smtpMessage(message: SmtpSinkEmailMessage): string {
  const digest = stableMessageId(message.idempotencyKey);
  const boundary = `hustlexp-${digest.slice(0, 24)}`;
  const subject = Buffer.from(safeHeader(message.subject, 'subject'), 'utf8').toString('base64');
  const lines = [
    `From: ${safeHeader(message.from, 'from')}`,
    `To: ${safeHeader(message.to, 'to')}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    `Message-ID: <${digest}@sink.hustlexp.invalid>`,
    `X-HustleXP-Idempotency-Key: ${safeHeader(message.idempotencyKey, 'idempotency key')}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    message.text,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    message.html,
    `--${boundary}--`,
  ];
  return lines.join('\r\n').replace(/^\./gmu, '..');
}

async function expectSmtp(
  reader: SmtpResponseReader,
  expectedCode: number,
  socket?: Socket,
  command?: string
): Promise<void> {
  if (command && socket) socket.write(`${command}\r\n`);
  const response = await reader.next();
  if (response.code !== expectedCode) {
    throw new Error(`SMTP sink expected ${expectedCode}, received code ${response.code}`);
  }
}

export async function sendEmailToSmtpSink(
  url: URL,
  message: SmtpSinkEmailMessage,
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('SMTP sink timeout is invalid');
  }
  const { socket, connected } = openSmtpConnection(url, timeoutMs);
  const reader = new SmtpResponseReader(socket);
  let messageAccepted = false;
  try {
    await connected;
    await expectSmtp(reader, 220);
    await expectSmtp(reader, 250, socket, 'EHLO hustlexp-synthetic.local');
    await expectSmtp(reader, 250, socket, `MAIL FROM:<${safeHeader(message.from, 'from')}>`);
    await expectSmtp(reader, 250, socket, `RCPT TO:<${safeHeader(message.to, 'to')}>`);
    await expectSmtp(reader, 354, socket, 'DATA');
    await expectSmtp(reader, 250, socket, `${smtpMessage(message)}\r\n.`);
    messageAccepted = true;
    // The final DATA 250 is the provider acceptance boundary. QUIT is only a
    // best-effort session courtesy: a sink may close immediately after it has
    // durably accepted the message, and that close must not erase the known
    // deterministic receipt or invite a duplicate send.
    // Gracefully half-close after QUIT so the peer can deliver its final reply.
    // Destroying the socket immediately after writing QUIT resets loopback SMTP
    // peers on Windows and can surface an unrelated ECONNRESET after success.
    socket.end('QUIT\r\n');
  } finally {
    // Before the DATA acceptance boundary, fail fast and release the socket.
    // After acceptance, preserve the known result and let the graceful SMTP
    // shutdown above finish independently of the deterministic receipt.
    if (!messageAccepted) socket.destroy();
  }
  return `smtp-sink-${stableMessageId(message.idempotencyKey)}`;
}
