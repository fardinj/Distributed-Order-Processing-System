import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ZodType } from 'zod';
import { createHash } from 'node:crypto';

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException({
      message: 'Invalid request',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  return result.data;
}

export function requestKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new BadRequestException('A valid Idempotency-Key is required');
  return value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
export const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export function versionMatches(actual: number, expected: number) {
  if (actual !== expected) throw new ConflictException('Version changed; reload before retrying');
}
