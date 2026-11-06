import 'reflect-metadata';
import { Controller, Get, Module, Res } from '@nestjs/common';
import type { Response } from 'express';
import { fileURLToPath } from 'node:url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { bootstrap, RuntimeModule } from '../../../packages/runtime/src/bootstrap.js';
import { serviceConfig } from '../../../packages/runtime/src/config.js';
import { logRecord } from '../../../packages/runtime/src/logger.js';
import { identityPathAllowed } from './identity-policy.js';
import { Auxiliary } from '../../../packages/runtime/src/auxiliary.js';
import {
  CurrentUser,
  type Principal,
  Public,
  Roles,
  TokenVerifier,
  oidcSettings,
} from '../../../packages/runtime/src/security.js';

const config = serviceConfig('gateway');
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const publicUrl = new URL(process.env.PUBLIC_URL ?? 'http://localhost:8080');
if (publicUrl.pathname !== '/' || publicUrl.username || publicUrl.password) {
  throw new Error('PUBLIC_URL must be an origin, without credentials or path');
}

@Controller()
class GatewayController {
  @Public()
  @Get(['', 'auth/callback'])
  index(@Res() response: Response) {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    return response.sendFile('index.html', { root: webRoot });
  }
  @Public()
  @Get('status')
  status() {
    return {
      application: 'tops',
      milestone: 'persian-operations-ui',
      health: '/health/ready',
      identity: '/identity/realms/tops/.well-known/openid-configuration',
      message: 'Persian customer/admin UI is available at /. APIs remain authenticated under /api.',
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
  app.useStaticAssets(webRoot, {
    prefix: '/ui/',
    index: false,
    fallthrough: false,
    setHeaders(response) {
      response.setHeader('cache-control', 'no-cache');
      response.setHeader('x-content-type-options', 'nosniff');
    },
  });
  const verifier = app.get(TokenVerifier);
  const auxiliary = app.get(Auxiliary);
  const active = { ordinary: 0, recovery: 0 };
  const edgeActive = { ordinary: 0, recovery: 0 };
  app.use(
    async (
      request: import('express').Request,
      response: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      if (
        !request.path.startsWith('/api/') &&
        !request.path.startsWith('/identity/') &&
        !request.path.startsWith('/auth/')
      )
        return next();
      // Bound pending Redis/JWT work too, before any dependency wait or authentication.
      const edgeLane =
        request.method !== 'GET' && /^\/api\/orders\/.+/.test(request.path)
          ? 'recovery'
          : 'ordinary';
      if (edgeActive[edgeLane] >= (edgeLane === 'recovery' ? 16 : 48)) {
        response.setHeader('retry-after', '2');
        response.status(503).json({ message: 'Edge capacity busy; retry with the same key' });
        return;
      }
      edgeActive[edgeLane]++;
      let edgeReleased = false;
      const releaseEdge = () => {
        if (!edgeReleased) {
          edgeReleased = true;
          edgeActive[edgeLane]--;
        }
      };
      response.once('finish', releaseEdge);
      response.once('close', releaseEdge);
      const quota = await auxiliary.quota(request.socket.remoteAddress ?? 'unknown', 'edge', 6000);
      response.setHeader('x-rate-limit-mode', quota.mode);
      if (!quota.allowed) {
        response.setHeader('retry-after', quota.retryAfter);
        response.status(429).json({ message: 'Request quota exceeded' });
        return;
      }
      if (
        request.method === 'POST' &&
        /\/protocol\/openid-connect\/(token|auth)\/?$/.test(request.path)
      ) {
        const login = await auxiliary.quota(request.socket.remoteAddress ?? 'unknown', 'login', 5);
        response.setHeader('x-rate-limit-mode', login.mode);
        if (!login.allowed) {
          response.setHeader('retry-after', login.retryAfter);
          response.status(429).json({ message: 'Login quota exceeded' });
          return;
        }
      }
      next();
    },
  );
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
        const principal = await verifier.authenticate(request.headers.authorization);
        const lane =
          request.method === 'GET'
            ? 'read'
            : request.path.replace(/\/+$/, '') === '/api/orders'
              ? 'new'
              : request.path.startsWith('/api/admin/')
                ? 'admin'
                : 'recovery';
        const quota = await auxiliary.quota(
          principal.id,
          lane,
          { read: 1800, new: 120, admin: 180, recovery: 600 }[lane],
        );
        response.setHeader('x-rate-limit-mode', quota.mode);
        if (!quota.allowed) {
          response.setHeader('retry-after', quota.retryAfter);
          response.status(429).json({ message: 'Request quota exceeded', lane });
          return;
        }
        const execution = lane === 'recovery' ? 'recovery' : 'ordinary';
        if (active[execution] >= (execution === 'recovery' ? 8 : 24)) {
          response.setHeader('retry-after', '2');
          response.status(503).json({ message: 'Request capacity busy; retry with the same key' });
          return;
        }
        active[execution]++;
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            active[execution]--;
          }
        };
        response.once('finish', release);
        response.once('close', release);
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
      proxyTimeout: 15000,
      timeout: 16000,
    }),
  );
}).catch(() => {
  logRecord(config.name, 'fatal', 'startup_failed');
  process.exitCode = 1;
});
