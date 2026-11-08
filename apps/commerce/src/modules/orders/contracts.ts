import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';

export const createOrderSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            productId: z.uuid(),
            quantity: z.int().min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export const revisionSchema = z
  .object({ expectedRevision: z.int().positive().max(2147483646) })
  .strict();
export const orderPageFields = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
  status: z
    .enum([
      'CHECKOUT_RESERVED',
      'CHECKOUT_EXPIRED',
      'BASKET_CHANGED',
      'PENDING_PAYMENT',
      'PAYING',
      'PAYMENT_REVIEW',
      'PROCESSING',
      'ATTENTION_REQUIRED',
      'MANUAL_REVIEW',
      'CANCELLATION_PENDING',
      'PAYMENT_FAILED',
      'COMPLETED',
      'CANCELLED',
      'RESOLVED',
    ])
    .optional(),
  createdFrom: z.iso.datetime({ offset: true }).optional(),
  createdTo: z.iso.datetime({ offset: true }).optional(),
};
export const validOrderRange = (p: { createdFrom?: string; createdTo?: string }) =>
  !p.createdFrom || !p.createdTo || Date.parse(p.createdFrom) < Date.parse(p.createdTo);
export const orderListSchema = z
  .object(orderPageFields)
  .strict()
  .refine(validOrderRange, { message: 'createdFrom must precede createdTo' });
export const eventPageSchema = z
  .object({ limit: orderPageFields.limit, cursor: orderPageFields.cursor })
  .strict();
export interface Line {
  productId: string;
  quantity: number;
}
export function canonicalLines(lines: Line[]): Line[] {
  const quantities = new Map<string, number>();
  for (const line of lines) {
    const id = line.productId.toLowerCase();
    const quantity = (quantities.get(id) ?? 0) + line.quantity;
    if (quantity > 100) throw new BadRequestException('Merged quantity exceeds 100 per product');
    quantities.set(id, quantity);
  }
  return [...quantities]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productId, quantity]) => ({ productId, quantity }));
}
