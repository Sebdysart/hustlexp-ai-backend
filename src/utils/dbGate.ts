import { isDatabaseAvailable } from '../db/index.js';

const REQUIRE_DATABASE = process.env.REQUIRE_DATABASE === 'true';

export function isDatabaseRequired(): boolean {
    return REQUIRE_DATABASE;
}

export function shouldAllowFallback(): boolean {
    return process.env.NODE_ENV === 'development' && !REQUIRE_DATABASE;
}

export function createDatabaseUnavailableError(message = 'Database unavailable'): Error {
    const error = new Error(message);
    (error as { statusCode?: number; code?: string }).statusCode = 503;
    (error as { statusCode?: number; code?: string }).code = 'DB_REQUIRED';
    return error;
}

export function assertDatabaseAvailable(): void {
    if (REQUIRE_DATABASE && !isDatabaseAvailable()) {
        throw createDatabaseUnavailableError();
    }
}
