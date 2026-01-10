/**
 * @deprecated Use src/config/env.ts directly
 * This file remains for backward compatibility but delegates to the new enterprise loader.
 */
export declare function validateEnv(): {
    valid: boolean;
    missing: never[];
    warnings: never[];
    configured: {
        OPENAI_API_KEY: boolean;
        DEEPSEEK_API_KEY: boolean;
        GROQ_API_KEY: boolean;
        DATABASE_URL: boolean;
        UPSTASH_REDIS_REST_URL: boolean;
        FIREBASE_PROJECT_ID: boolean;
        FIREBASE_CONFIGURED: boolean;
    };
};
export declare function logEnvStatus(result?: any): void;
export declare function getEnvStatus(): {
    database: boolean;
    redis: boolean;
    openai: boolean;
    deepseek: boolean;
    groq: boolean;
    firebase: boolean;
};
//# sourceMappingURL=envValidator.d.ts.map