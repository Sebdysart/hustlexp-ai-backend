export class PrometheusMetrics {
    static counters = new Map();
    static gauges = new Map();
    static increment(name, labels = {}, value = 1) {
        const key = this.getKey(name, labels);
        const current = this.counters.get(key) || 0;
        this.counters.set(key, current + value);
    }
    static setGauge(name, labels = {}, value) {
        const key = this.getKey(name, labels);
        this.gauges.set(key, value);
    }
    static getKey(name, labels) {
        const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
        return labelStr ? `${name}{${labelStr}}` : name;
    }
    static getMetrics() {
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
//# sourceMappingURL=Prometheus.js.map