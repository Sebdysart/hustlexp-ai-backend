export class PrometheusMetrics {
    private static counters: Map<string, number> = new Map();
    private static gauges: Map<string, number> = new Map();

    static increment(name: string, labels: Record<string, string> = {}, value: number = 1) {
        const key = this.getKey(name, labels);
        const current = this.counters.get(key) || 0;
        this.counters.set(key, current + value);
    }

    static setGauge(name: string, labels: Record<string, string> = {}, value: number) {
        const key = this.getKey(name, labels);
        this.gauges.set(key, value);
    }

    private static getKey(name: string, labels: Record<string, string>) {
        const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
        return labelStr ? `${name}{${labelStr}}` : name;
    }

    static getMetrics(): string {
        let output = '';

        // Counters
        for (const [key, value] of this.counters) {
            output += `# TYPE ${key.split('{')[0]} counter\n`;
            output += `${key} ${value}\n`;
        }

        // Gauges
        for (const [key, value] of this.gauges) {
            output += `# TYPE ${key.split('{')[0]} gauge\n`;
            output += `${key} ${value}\n`;
        }

        return output;
    }
}
