import { describe, expect, it } from 'vitest';
import { prettyLoggingEnabled } from '../../src/logger';

describe('logger transport selection', () => {
  it.each(['0', 'false', 'FALSE', 'no', 'off', ' off '])(
    'disables the development-only pretty transport for %s',
    (mode) => {
      expect(prettyLoggingEnabled({ LOG_PRETTY: mode }, true)).toBe(false);
    },
  );

  it('keeps developer-friendly output by default in a full development install', () => {
    expect(prettyLoggingEnabled({}, true)).toBe(true);
  });

  it('never enables the development-only transport in a production runtime', () => {
    expect(prettyLoggingEnabled({ LOG_PRETTY: 'true' }, false)).toBe(false);
  });
});
