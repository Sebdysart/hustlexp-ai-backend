export declare class DLQProcessor {
    /**
     * PROCESS QUEUE
     * Should be called by Cron / Worker periodically (e.g. every 1 min).
     */
    static processQueue(): Promise<void>;
    private static processItem;
    private static routeHandler;
}
//# sourceMappingURL=DLQProcessor.d.ts.map