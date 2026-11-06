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
export const orderListSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.uuid().optional(),
  })
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
