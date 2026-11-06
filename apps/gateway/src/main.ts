import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { bootstrap, RuntimeModule } from '../../../packages/runtime/src/bootstrap.js';
import { serviceConfig } from '../../../packages/runtime/src/config.js';
import { logRecord } from '../../../packages/runtime/src/logger.js';
import { identityPathAllowed } from './identity-policy.js';
import {
  CurrentUser,
  type Principal,
  Public,
  Roles,
  TokenVerifier,
  oidcSettings,
} from '../../../packages/runtime/src/security.js';

const config = serviceConfig('gateway');
const publicUrl = new URL(process.env.PUBLIC_URL ?? 'http://localhost:8080');
if (publicUrl.pathname !== '/' || publicUrl.username || publicUrl.password) {
  throw new Error('PUBLIC_URL must be an origin, without credentials or path');
}

@Controller()
class GatewayController {
  @Public()
  @Get()
  index() {
    return {
      application: 'tops',
      milestone: 'checkout-preparation',
      health: '/health/ready',
      identity: '/identity/realms/tops/.well-known/openid-configuration',
      message:
        'Authenticated catalog/admin, checkout reservations and reliable preparation are available under /api. Payment execution and the Persian UI are subsequent milestones.',
    };
  }
  @Public()
  @Get('auth/config')
  authConfig() {
    return {
      issuer: oidcSettings().issuer,
      clientId: 'tops-web',
      audience: 'tops-api',
      flow: 'authorization_code',
      pkce: 'S256',
    };
  }
  @Roles('customer', 'admin')
  @Get('auth/me')
  me(@CurrentUser() user: Principal) {
    return user;
  }
}

@Module({ imports: [RuntimeModule.forRoot(config)], controllers: [GatewayController] })
class GatewayModule {}

bootstrap(GatewayModule, config, (app) => {
  const verifier = app.get(TokenVerifier);
  const commerceProxy = createProxyMiddleware({
    target: 'http://commerce:3000',
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
    proxyTimeout: 5000,
    timeout: 6000,
    on: {
      proxyReq(proxyReq, request) {
        for (const header of ['forwarded', 'x-user-id', 'x-user-role', 'x-forwarded-user'])
          proxyReq.removeHeader(header);
        proxyReq.setHeader('x-forwarded-for', request.socket.remoteAddress ?? 'unknown');
        proxyReq.setHeader('x-forwarded-host', publicUrl.host);
        proxyReq.setHeader('x-forwarded-proto', publicUrl.protocol.slice(0, -1));
      },
      error(_error, _request, response) {
        if ('writeHead' in response && !response.headersSent) {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'Commerce temporarily unavailable' }));
        }
      },
    },
  });
  app.use(
    async (
      request: import('express').Request,
      response: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      if (!/^\/api\/(products(?:\/|$)|admin(?:\/|$)|orders(?:\/|$))/.test(request.path))
        return next();
      try {
        await verifier.authenticate(request.headers.authorization);
        commerceProxy(request, response, next);
      } catch (error) {
        const status =
          error && typeof error === 'object' && 'getStatus' in error
            ? (error as import('@nestjs/common').HttpException).getStatus()
            : 401;
        response.status(status).json({
          statusCode: status,
          message: status === 503 ? 'Identity temporarily unavailable' : 'Authentication required',
        });
      }
    },
  );
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
