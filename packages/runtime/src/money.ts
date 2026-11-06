/** Whole IRR only. These strings never pass through JavaScript Number. */
export function irr(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Expected a canonical nonnegative whole-IRR decimal string');
  }
  return value;
}

export function sumIrr(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(irr(value)), 0n).toString();
}

export function multiplyIrr(value: string, quantity: number): string {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Invalid quantity');
  return (BigInt(irr(value)) * BigInt(quantity)).toString();
}
