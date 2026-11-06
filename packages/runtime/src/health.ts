import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { CONFIG, Dependencies, readiness } from './dependencies.js';
import type { ServiceConfig } from './config.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(CONFIG) private readonly config: ServiceConfig,
    private readonly dependencies: Dependencies,
  ) {}

  @Get('live')
  live() {
    return { service: this.config.name, status: 'up' };
  }

  @Get('ready')
  async ready() {
    const dependencies = await this.dependencies.report();
    const state = readiness(dependencies);
    const body = {
      service: this.config.name,
      status: !state.ready ? 'not_ready' : state.degraded ? 'degraded' : 'ready',
      dependencies,
    };
    if (!state.ready) throw new ServiceUnavailableException(body);
    return body;
  }
}
