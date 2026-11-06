import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from './generated/prisma/client.js';

@Catch(Prisma.PrismaClientKnownRequestError)
export class DatabaseErrors implements ExceptionFilter {
  catch(error: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const sqlCode = String(error.meta?.code ?? '');
    let status = 500;
    let message = 'Database operation failed';
    if (error.code === 'P2002' || ['23505', '23514'].includes(sqlCode)) {
      status = 409;
      message = 'Request conflicts with current data constraints';
    }
    if (error.code === 'P2025') {
      status = 404;
      message = 'Resource not found';
    }
    if (
      ['P2028', 'P2024', 'P1001', 'P1002', 'P1017'].includes(error.code) ||
      ['40P01', '40001', '57014'].includes(sqlCode)
    ) {
      status = 503;
      message = 'Database temporarily busy; retry with the same idempotency key';
      response.setHeader('retry-after', '2');
    }
    if (['22003', '22P02'].includes(sqlCode)) {
      status = 400;
      message = 'Value exceeds a supported representation or has invalid syntax';
    }
    response.status(status).json({ statusCode: status, message });
  }
}
