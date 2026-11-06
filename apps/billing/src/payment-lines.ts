import { InvalidMessage, type Sql } from '../../../packages/runtime/src/outbox.js';
export interface PaidLine {
  itemId: string;
  amountMinor: string;
}
export async function ensurePaymentLines(
  sql: Sql,
  payment: { id: string; order_id: string; checkout_revision: number; amount: string },
  provided?: PaidLine[],
) {
  let lines = provided;
  if (!lines) {
    const prepared = (
      await sql.query<{ snapshot: { id: string; lineTotalMinor: string }[] }>(
        `SELECT snapshot FROM prepared_checkouts WHERE order_id=$1 AND revision=$2`,
        [payment.order_id, payment.checkout_revision],
      )
    )[0];
    if (!prepared) return;
    lines = prepared.snapshot.map((i) => ({ itemId: i.id, amountMinor: i.lineTotalMinor }));
  }
  if (
    !lines.length ||
    new Set(lines.map((i) => i.itemId)).size !== lines.length ||
    lines.reduce((sum, i) => sum + BigInt(i.amountMinor), 0n) !== BigInt(payment.amount)
  )
    throw new InvalidMessage('CAPTURED_LINE_TOTAL_MISMATCH');
  const existing = await sql.query<{ item_id: string; amount: string }>(
    'SELECT item_id,amount_minor::text AS amount FROM payment_lines WHERE payment_id=$1',
    [payment.id],
  );
  if (existing.length) {
    if (
      existing.length !== lines.length ||
      lines.some(
        (line) =>
          !existing.some((old) => old.item_id === line.itemId && old.amount === line.amountMinor),
      )
    )
      throw new InvalidMessage('CAPTURED_LINE_SET_MISMATCH');
    return;
  }
  for (const line of lines) {
    await sql.query(
      'INSERT INTO payment_lines(payment_id,item_id,amount_minor) VALUES($1,$2,$3::numeric) ON CONFLICT DO NOTHING RETURNING item_id',
      [payment.id, line.itemId, line.amountMinor],
    );
    if (
      !(
        await sql.query(
          'SELECT 1 FROM payment_lines WHERE payment_id=$1 AND item_id=$2 AND amount_minor=$3::numeric',
          [payment.id, line.itemId, line.amountMinor],
        )
      ).length
    )
      throw new InvalidMessage('CAPTURED_LINE_IDENTITY_MISMATCH');
  }
}
