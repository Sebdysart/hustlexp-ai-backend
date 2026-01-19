export declare enum EnvMode {
    TEST = "test",
    LOCAL = "local",
    STAGING = "staging",
    PRODUCTION = "production"
}
export declare const env: {
    mode: EnvMode;
    isLocal: boolean;
    isStaging: boolean;
    isProduction: boolean;
    isTest: boolean;
    PORT: number;
    DATABASE_URL: string;
    UPSTASH_REDIS_REST_URL: string;
    FIREBASE_PROJECT_ID: string;
    FIREBASE_PRIVATE_KEY: string | undefined;
    FIREBASE_CLIENT_EMAIL: string | undefined;
    OPENAI_API_KEY: string;
    DEEPSEEK_API_KEY: string;
    GROQ_API_KEY: string;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SECRET: string | undefined;
    STRIPE_MODE: "test" | "live";
    TWILIO_ACCOUNT_SID: string | undefined;
    TWILIO_AUTH_TOKEN: string | undefined;
    TWILIO_VERIFY_SERVICE_SID: string | undefined;
    SENDGRID_API_KEY: string | undefined;
    SENDGRID_FROM_EMAIL: string | undefined;
    isPayoutsEnabled: boolean;
    isEmailRealDelivery: boolean;
    isSmsRealDelivery: boolean;
    isIdentityStrictMode: boolean;
    aiCostLimitSoft: number;
    aiCostLimitHard: number;
};
//# sourceMappingURL=env.d.ts.map