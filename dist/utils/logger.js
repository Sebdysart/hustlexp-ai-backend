import pino from 'pino';
const isDev = process.env.NODE_ENV !== 'production';
export const logger = pino({
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    transport: isDev
        ? {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname',
            },
        }
        : undefined,
});
export const aiLogger = logger.child({ module: 'ai' });
export const serviceLogger = logger.child({ module: 'service' });
// Helper function for creating module-specific loggers
export function createLogger(moduleName) {
    return logger.child({ module: moduleName });
}
//# sourceMappingURL=logger.js.map