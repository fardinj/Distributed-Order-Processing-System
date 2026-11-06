import { z } from 'zod';
import { irr } from '../../../../../packages/runtime/src/money.js';

const amount = z.string().refine((value) => {
  try {
    irr(value);
    return true;
  } catch {
    return false;
  }
}, 'Use a canonical whole-IRR decimal string');
const reason = z.string().trim().min(5).max(1000);
const version = z.number().int().min(1).max(2147483646);
export const idSchema = z.uuid();
export const createProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(['DIGITAL', 'SUBSCRIPTION', 'PHYSICAL']),
    priceMinor: amount,
    subscriptionDays: z.number().int().min(1).max(36500).optional(),
    digitalMetadata: z.record(z.string(), z.unknown()).optional(),
    reason,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.type === 'SUBSCRIPTION') !== (value.subscriptionDays !== undefined))
      context.addIssue({
        code: 'custom',
        message: 'Only subscriptions require subscriptionDays',
        path: ['subscriptionDays'],
      });
    if (value.type !== 'DIGITAL' && value.digitalMetadata !== undefined)
      context.addIssue({
        code: 'custom',
        message: 'digitalMetadata is digital-only',
        path: ['digitalMetadata'],
      });
  });
export const updateProductSchema = z
  .object({
    expectedVersion: version,
    reason,
    name: z.string().trim().min(1).max(200).optional(),
    priceMinor: amount.optional(),
    subscriptionDays: z.number().int().min(1).max(36500).optional(),
    digitalMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (value) =>
      ['name', 'priceMinor', 'subscriptionDays', 'digitalMetadata'].some((key) => key in value),
    'Supply a change',
  );
export const deactivateSchema = z.object({ expectedVersion: version, reason }).strict();
export const adjustSchema = z
  .object({
    expectedVersion: version,
    delta: z
      .number()
      .int()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .refine((value) => value !== 0),
    reason,
  })
  .strict();
export const reconcileSchema = z
  .object({
    expectedVersion: version,
    countedOnHand: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    reason,
  })
  .strict();
export const listSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(300).optional(),
  })
  .strict();
export type CreateProduct = z.infer<typeof createProductSchema>;
export type UpdateProduct = z.infer<typeof updateProductSchema>;
export type AdjustInventory = z.infer<typeof adjustSchema>;
export type ReconcileInventory = z.infer<typeof reconcileSchema>;
