import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { bootstrap, RuntimeModule } from '../../../packages/runtime/src/bootstrap.js';
import { serviceConfig } from '../../../packages/runtime/src/config.js';
import { logRecord } from '../../../packages/runtime/src/logger.js';
import { identityPathAllowed } from './identity-policy.js';

const config = serviceConfig('gateway');
const publicUrl = new URL(process.env.PUBLIC_URL ?? 'http://localhost:8080');
if (publicUrl.pathname !== '/' || publicUrl.username || publicUrl.password) {
  throw new Error('PUBLIC_URL must be an origin, without credentials or path');
}

@Controller()
class GatewayController {
  @Get()
  index() {
    return {
      application: 'tops',
      milestone: 'service-skeleton',
      health: '/health/ready',
      identity: '/identity/realms/tops/.well-known/openid-configuration',
      message: 'Business APIs and the Persian UI are subsequent roadmap steps.',
    };
  }
}

@Module({ imports: [RuntimeModule.forRoot(config)], controllers: [GatewayController] })
class GatewayModule {}

bootstrap(GatewayModule, config, (app) => {
  app.use(
    createProxyMiddleware({
      target: 'http://identity:8080',
      changeOrigin: true,
      xfwd: false,
      pathFilter: identityPathAllowed,
      on: {
        proxyReq(proxyReq, req) {
          // Never forward caller-provided identity/proxy assertions as trusted metadata.
          for (const header of ['forwarded', 'x-forwarded-prefix', 'x-user-id', 'x-user-role'])
            proxyReq.removeHeader(header);
          proxyReq.setHeader('x-forwarded-host', publicUrl.host);
          proxyReq.setHeader('x-forwarded-proto', publicUrl.protocol.slice(0, -1));
          proxyReq.setHeader(
            'x-forwarded-port',
            publicUrl.port || (publicUrl.protocol === 'https:' ? '443' : '80'),
          );
          proxyReq.setHeader('x-forwarded-for', req.socket.remoteAddress ?? 'unknown');
        },
        error(_error, _req, res) {
          if ('writeHead' in res && !res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ statusCode: 502, message: 'Identity service unavailable' }));
          }
        },
      },
      proxyTimeout: 5000,
      timeout: 6000,
    }),
  );
}).catch(() => {
  logRecord(config.name, 'fatal', 'startup_failed');
  process.exitCode = 1;
});
