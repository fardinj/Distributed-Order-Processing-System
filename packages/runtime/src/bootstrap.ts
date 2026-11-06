import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CONFIG, Dependencies } from './dependencies.js';
import { HealthController } from './health.js';
import { JsonLogger, logRecord } from './logger.js';
import type { ServiceConfig } from './config.js';

@Module({})
export class RuntimeModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: RuntimeModule,
      controllers: [HealthController],
      providers: [{ provide: CONFIG, useValue: config }, Dependencies],
    };
  }
}

export function correlationId(candidate: unknown): string {
  return typeof candidate === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(candidate)
    ? candidate
    : randomUUID();
}

export async function bootstrap(
  module: Parameters<typeof NestFactory.create>[0],
  config: ServiceConfig,
  configure?: (app: NestExpressApplication) => void,
) {
  const app = await NestFactory.create<NestExpressApplication>(module, {
    logger: new JsonLogger(config.name),
    bodyParser: false,
  });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.enableShutdownHooks();
  app.use(
    (
      req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      const requestId = correlationId(req.headers['x-request-id']);
      res.setHeader('x-request-id', requestId);
      const start = performance.now();
      res.on('finish', () => {
        if (!req.path.startsWith('/health/'))
          logRecord(config.name, 'info', 'request_completed', {
            requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - start),
          });
      });
      next();
    },
  );
  configure?.(app);
  await app.listen(config.port, '0.0.0.0');
  logRecord(config.name, 'info', 'service_listening', { port: config.port });
  return app;
}
