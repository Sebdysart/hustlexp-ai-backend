export declare class PrometheusMetrics {
    private static counters;
    private static gauges;
    static increment(name: string, labels?: Record<string, string>, value?: number): void;
    static setGauge(name: string, labels: Record<string, string> | undefined, value: number): void;
    private static getKey;
    static getMetrics(): string;
}
//# sourceMappingURL=Prometheus.d.ts.map