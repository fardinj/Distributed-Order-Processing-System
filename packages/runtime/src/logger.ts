import type { LoggerService } from '@nestjs/common';

export function logRecord(service: string, level: string, message: unknown, details = {}) {
  process.stdout.write(
    JSON.stringify({ time: new Date().toISOString(), level, service, message, ...details }) + '\n',
  );
}

export class JsonLogger implements LoggerService {
  constructor(private readonly service: string) {}
  log(message: unknown) {
    logRecord(this.service, 'info', message);
  }
  error(message: unknown) {
    logRecord(this.service, 'error', message);
  }
  warn(message: unknown) {
    logRecord(this.service, 'warn', message);
  }
  debug(message: unknown) {
    logRecord(this.service, 'debug', message);
  }
  verbose(message: unknown) {
    logRecord(this.service, 'debug', message);
  }
  fatal(message: unknown) {
    logRecord(this.service, 'fatal', message);
  }
}
