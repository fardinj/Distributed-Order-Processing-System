import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Global,
  Injectable,
  Module,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { Request } from 'express';
import { ServiceIdentity } from './service-identity.js';

const PUBLIC = 'tops:public';
const ROLES = 'tops:roles';
export const Public = () => SetMetadata(PUBLIC, true);
export const Roles = (...roles: string[]) => SetMetadata(ROLES, roles);
export interface Principal {
  id: string;
  roles: string[];
  clientId: string;
}
export type AuthenticatedRequest = Request & { principal?: Principal };
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal,
);

export function oidcSettings() {
  return {
    issuer:
      process.env.OIDC_ISSUER ??
      `${process.env.PUBLIC_URL ?? 'http://localhost:8080'}/identity/realms/tops`,
    jwksUrl:
      process.env.OIDC_JWKS_URL ??
      'http://identity:8080/identity/realms/tops/protocol/openid-connect/certs',
    audience: 'tops-api',
  };
}

@Injectable()
export class TokenVerifier {
  private readonly settings = oidcSettings();
  private readonly keys = createRemoteJWKSet(new URL(this.settings.jwksUrl), {
    timeoutDuration: 2000,
    cooldownDuration: 30000,
    cacheMaxAge: 600000,
  });

  async authenticate(authorization: string | undefined): Promise<Principal> {
    if (!authorization || !/^Bearer [^\s]{1,16384}$/i.test(authorization)) {
      throw new UnauthorizedException('A bearer access token is required');
    }
    try {
      const { payload } = await jwtVerify(authorization.slice(7), this.keys, {
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'iat', 'exp'],
        clockTolerance: 5,
      });
      if (!payload.sub || payload.sub.length > 128 || typeof payload.azp !== 'string') {
        throw new UnauthorizedException('Invalid access token subject/client');
      }
      if (payload.typ !== 'Bearer') throw new UnauthorizedException('An access token is required');
      const realm = payload.realm_access as { roles?: unknown } | undefined;
      const roles = Array.isArray(realm?.roles)
        ? realm.roles.filter((role): role is string => typeof role === 'string')
        : [];
      return { id: payload.sub, roles, clientId: payload.azp };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      if (
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid ||
        (error instanceof errors.JOSEError && error.code === 'ERR_JOSE_GENERIC') ||
        (error instanceof TypeError && /fetch/i.test(error.message))
      ) {
        throw new ServiceUnavailableException('Identity verification temporarily unavailable');
      }
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}

@Injectable()
class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])
    )
      return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.principal = await this.verifier.authenticate(request.headers.authorization);
    const required = this.reflector.getAllAndOverride<string[]>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && !required.some((role) => request.principal!.roles.includes(role))) {
      throw new ForbiddenException('Insufficient permissions');
    }
    if (
      required?.includes('service') &&
      !['commerce-service', 'billing-service'].includes(request.principal.clientId)
    ) {
      throw new ForbiddenException('Unrecognized service identity');
    }
    return true;
  }
}

@Global()
@Module({
  providers: [
    TokenVerifier,
    ServiceIdentity,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
  ],
  exports: [TokenVerifier, ServiceIdentity],
})
export class SecurityModule {}
