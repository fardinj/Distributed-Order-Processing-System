import { ServiceUnavailableException } from '@nestjs/common';
const httpTotals: Record<string, number> = {};
export function recordHttpStatus(status: number) {
  const group = Math.floor(status / 100);
  if (group >= 1 && group <= 5) {
    const name = `tops_http_responses_${group}xx_total`;
    httpTotals[name] = (httpTotals[name] ?? 0) + 1;
  }
}
export class MetricCache {
  private value?: Record<string, number>;
  private updatedAt = 0;
  private pending?: Promise<Record<string, number>>;
  constructor(private readonly collect: () => Promise<Record<string, number>>) {}
  async read() {
    if (this.value && Date.now() - this.updatedAt < 5000) return this.value;
    this.pending ??= this.collect()
      .then((value) => {
        this.updatedAt = Date.now();
        return (this.value = {
          ...value,
          tops_metrics_snapshot_timestamp_seconds: this.updatedAt / 1000,
        });
      })
      .catch(() => {
        throw new ServiceUnavailableException('Metrics temporarily unavailable');
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
export function prometheus(service: string, values: Record<string, number>) {
  const cpu = process.cpuUsage();
  const all = {
    ...httpTotals,
    ...values,
    tops_process_resident_memory_bytes: process.memoryUsage().rss,
    tops_process_uptime_seconds: process.uptime(),
    tops_process_cpu_seconds_total: (cpu.user + cpu.system) / 1e6,
  };
  return Object.entries(all)
    .map(([key, value]) => {
      if (!/^tops_[a-z0-9_]+$/.test(key) || !Number.isFinite(value))
        throw new Error('Invalid metric');
      return `# TYPE ${key} ${key.endsWith('_total') ? 'counter' : 'gauge'}\n${key}{service="${service}"} ${value}\n`;
    })
    .join('');
}
