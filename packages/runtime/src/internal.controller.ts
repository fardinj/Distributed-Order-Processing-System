import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type Principal, Roles } from './security.js';

@Controller('internal')
@Roles('service')
export class InternalIdentityController {
  @Get('identity') identity(@CurrentUser() principal: Principal) {
    return { subject: principal.id, clientId: principal.clientId, authenticated: true };
  }
}
