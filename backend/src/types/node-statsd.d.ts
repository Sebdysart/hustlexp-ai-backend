declare module 'node-statsd' {
  export interface StatsDConfig {
    host?: string;
    port?: number;
    prefix?: string;
    suffix?: string;
    globalTags?: string[] | Record<string, string>;
  }

  export class StatsD {
    constructor(config?: StatsDConfig);
    
    increment(stat: string, value?: number, sampleRate?: number, tags?: string[], callback?: (error?: Error) => void): void;
    decrement(stat: string, value?: number, sampleRate?: number, tags?: string[], callback?: (error?: Error) => void): void;
    timing(stat: string, value: number, sampleRate?: number, tags?: string[], callback?: (error?: Error) => void): void;
    gauge(stat: string, value: number, sampleRate?: number, tags?: string[], callback?: (error?: Error) => void): void;
    histogram(stat: string, value: number, sampleRate?: number, tags?: string[], callback?: (error?: Error) => void): void;
    
    close(callback?: () => void): void;
    
    on(event: 'error', callback: (error: Error) => void): void;
  }

  export default StatsD;
}
