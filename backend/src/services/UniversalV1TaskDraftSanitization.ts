import crypto from 'node:crypto';

/** Remove contact PII and exact street addresses from the TaskDraft aggregate. */
export function sanitizeTaskDraftText(input: string): string {
  const withoutDirectIdentifiers = input
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/giu, '')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/gu, '')
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gu, '');
  const withoutPreciseCoordinates = withoutDirectIdentifiers
    .replace(
      /(?:^|\s)[+-]?\d{1,2}\.\d{4,}\s*[,/]\s*[+-]?\d{1,3}\.\d{4,}(?=$|\s|[.,;])/gu,
      ' ',
    )
    .replace(
      /\b(?:lat(?:itude)?|lon(?:gitude)?)\s*[:=]?\s*[+-]?\d{1,3}(?:\.\d+)?\b/giu,
      '',
    );
  const withoutPhones = withoutPreciseCoordinates
    .split(
      /(\b(?:\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b)/giu,
    )
    .map((segment, index) => index % 2 === 1
      ? segment
      : segment.replace(/\+?\d[\d\s()./_-]{6,}\d/gu, (candidate) => {
        const digitCount = candidate.replace(/\D/gu, '').length;
        return digitCount >= 10 && digitCount <= 15 ? '' : candidate;
      }))
    .join('');
  const withoutLocationAndAccessSecrets = withoutPhones
    .replace(
      /\b(?:p(?:ost(?:al)?)?\.?\s*o(?:ffice)?\.?\s*(?:box|drawer)|po\s*box)\s*[A-Za-z0-9-]+\b/giu,
      '',
    )
    .replace(
      /\b(?:door|gate|garage|entry|access)\s*(?:code|pin|passcode|combo)\s*(?:is|:|=|#)?\s*[A-Za-z0-9*-]{2,20}\b/giu,
      '[access detail redacted]',
    )
    .replace(
      /\b(?:code|pin|passcode|combo)\s+(?:for|to)\s+(?:the\s+)?(?:door|gate|garage|entry|access)\s*(?:is|:|=|#)?\s*[A-Za-z0-9*-]{2,20}\b/giu,
      '[access detail redacted]',
    )
    .replace(
      /\b(?:buzz|buzzer)\s*(?:is|:|=|#)?\s*[A-Za-z0-9*-]{2,20}\s+(?:at|for)\s+(?:the\s+)?(?:door|gate|garage|entry)\b/giu,
      '[access detail redacted]',
    )
    .replace(
      /\bsignal\s*(?:me\s*)?(?:(?:at|:|=)\s*)?@[A-Za-z0-9_.-]{2,64}(?![A-Za-z0-9_.-])/giu,
      '[contact detail redacted]',
    );
  return withoutLocationAndAccessSecrets
    .replace(
      /\b\d{1,6}\s+(?:(?:north|south|east|west|ne|nw|se|sw|n|s|e|w)\s+)?(?:[A-Za-z0-9.'-]+\s+){0,5}(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|way|pl|place|ter|terrace|cir|circle|pkwy|parkway|hwy|highway|route|rte|broadway)\b\.?(?:\s+(?:north|south|east|west|ne|nw|se|sw|n|s|e|w))?(?:\s+(?:apt|apartment|unit|suite|#)\s*[A-Za-z0-9-]+)?/giu,
      '',
    )
    .replace(
      /\b(?:(?:u\.?s\.?|state|county)\s+)?(?:highway|hwy|route|rte)\s+\d+[A-Za-z]?\b/giu,
      '',
    )
    .split('')
    .map((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint < 32 || codePoint === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

/** Reject obvious placeholders/repeated low-entropy capabilities at ingress. */
export function isPlausiblyRandomTaskDraftCardToken(token: string): boolean {
  if (!/^[0-9a-f]{64}$/iu.test(token)) return false;
  const normalized = token.toLowerCase();
  const bytes = normalized.match(/.{2}/gu) ?? [];
  if (new Set(bytes).size < 8 || new Set(normalized).size < 10) return false;
  for (let period = 1; period <= normalized.length / 2; period += 1) {
    if (normalized.length % period === 0
      && normalized.slice(0, period).repeat(normalized.length / period) === normalized) {
      return false;
    }
  }
  return true;
}

export function sanitizeTaskDraftAnswers(
  input: Record<string, unknown>,
): Record<string, string | string[] | boolean | number> {
  const output: Record<string, string | string[] | boolean | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (/address|street|email|phone|(?:^|_)name(?:$|_)|ssn|social_security|date_of_birth|(?:^|_)dob(?:$|_)/iu.test(key)) continue;
    if (typeof value === 'string') {
      output[key] = sanitizeTaskDraftText(value) || '[details redacted]';
    } else if (Array.isArray(value)) {
      output[key] = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => sanitizeTaskDraftText(item) || '[details redacted]');
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      output[key] = value;
    }
  }
  return output;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function universalTaskDraftRequestHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function taskDraftCardTokenHash(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function taskDraftMutationIdempotencyKey(
  submissionId: string,
  expectedVersion: number,
): string {
  return `taskdraft:${submissionId}:v${expectedVersion + 1}`;
}
