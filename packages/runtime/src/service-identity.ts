import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { secret } from './config.js';

@Injectable()
export class ServiceIdentity {
  private cached?: { token: string; expiresAt: number };
  private pending?: Promise<string>;
  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 30000) return this.cached.token;
    this.pending ??= this.acquire().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async acquire() {
    const id = process.env.OIDC_SERVICE_CLIENT_ID;
    if (!id) throw new ServiceUnavailableException('Service identity is not configured');
    try {
      const response = await fetch(
        'http://identity:8080/identity/realms/tops/protocol/openid-connect/token',
        {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: id,
            client_secret: secret('OIDC_CLIENT_SECRET'),
          }),
          signal: AbortSignal.timeout(2000),
        },
      );
      if (!response.ok) throw new Error('Provider rejected service identity');
      const body = (await response.json()) as { access_token: string; expires_in: number };
      this.cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
      return body.access_token;
    } catch {
      throw new ServiceUnavailableException('Service identity temporarily unavailable');
    }
  }
}
