// Logger stubs for src/ layer (test/development environment).
// These match the pino-style logger interface used throughout src/.
// The first argument can be either a context object OR a message string.

/* eslint-disable @typescript-eslint/no-explicit-any */
type LogFn = (...args: any[]) => void;

interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  debug: LogFn;
  child: (bindings: Record<string, unknown>) => Logger;
}

const noop: LogFn = (..._args: any[]) => {};
const noopLogger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  debug: noop,
  child: () => noopLogger,
};

export const createLogger = (_name?: string): Logger => noopLogger;
export const logger: Logger = noopLogger;
export const serviceLogger: Logger = noopLogger;
export const aiLogger: Logger = noopLogger;
