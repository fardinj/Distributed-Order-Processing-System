import { read, write } from './api.js';
import {
  h,
  replace,
  heading,
  money,
  code,
  badge,
  button,
  empty,
  ask,
  reasonField,
  notice,
  table,
  details,
  field,
} from './view.js';
import { date, fa, statusText, eventText } from './format.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requireId(id) {
  if (!uuid.test(id ?? '')) throw new Error('شناسه معتبر وارد کنید.');
  return id;
}
export async function orders(ctx, admin = false) {
  let cursor,
    query = ctx.query ? requireId(ctx.query) : '',
    loading = false;
  const rows = h('tbody'),
    more = button('سفارش‌های بیشتر', () => load());
  const search = h(
    'form',
    {
      class: 'inline-form',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const value = new FormData(search).get('query').trim();
          if (!admin) {
            location.hash = `#order/${requireId(value)}`;
            return;
          }
          query = value ? requireId(value) : '';
          cursor = null;
          await load();
        } catch (error) {
          notice(error.message, 'error');
        }
      },
    },
    field('query', admin ? 'شناسه سفارش، مشتری یا قلم' : 'شناسه سفارش', query, {
      placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      dir: 'ltr',
    }),
    h('button', { type: 'submit' }, 'جست‌وجو'),
  );
  const listing = h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ['سفارش', 'زمان ثبت', 'مبلغ', 'وضعیت', ''].map((label) =>
            h('th', { scope: 'col' }, label),
          ),
        ),
      ),
      rows,
    ),
  );
  ctx.show(
    h(
      'div',
      {},
      heading(
        admin ? 'مدیریت سفارش‌ها' : 'سفارش‌های من',
        'برای دیدن پرداخت، اقلام و بازپرداخت، سفارش را باز کنید.',
        button('تازه‌سازی', () => ctx.reload()),
      ),
      h(
        'section',
        { class: 'panel' },
        search,
        h('div', { class: 'section' }, listing),
        h('div', { class: 'pager' }, more),
      ),
    ),
  );
  async function load() {
    if (loading) return;
    loading = true;
    try {
      const page = await read(
        `${admin ? '/admin/orders' : '/orders'}?limit=25${cursor ? `&cursor=${cursor}` : ''}${query ? `&query=${query}` : ''}`,
      );
      if (!ctx.valid()) return;
      if (!cursor) rows.replaceChildren();
      for (const order of page.items)
        rows.append(
          h(
            'tr',
            {},
            h('td', {}, code(order.id)),
            h('td', {}, date(order.createdAt)),
            h('td', {}, money(order.totalMinor)),
            h('td', {}, badge(order.status)),
            h('td', {}, h('a', { href: `#order/${order.id}` }, 'مشاهده')),
          ),
        );
      if (!page.items.length && !cursor)
        rows.append(h('tr', {}, h('td', { colspan: 5 }, empty('سفارشی پیدا نشد.'))));
      cursor = page.nextCursor;
      more.hidden = !cursor;
    } finally {
      loading = false;
    }
  }
  await load();
}
export function retryItem(order, item, ctx) {
  ask(
    'آغاز یک چرخه تلاش دوباره',
    [
      h(
        'p',
        {},
        'قلم موفق یا واردشده به بازپرداخت دوباره اجرا نمی‌شود. وضعیت و نسخه در سرور بررسی خواهد شد.',
      ),
      reasonField(),
    ],
    async (input) => {
      await write(`/orders/${order.id}/items/${item.id}/retry`, {
        expectedGeneration: item.generation,
        expectedRetryVersion: item.retryVersion,
        reason: input.reason,
      });
      notice('چرخه تازه ثبت شد؛ نتیجه از سرور پیگیری می‌شود.', 'success');
      await ctx.reload();
    },
  );
}
export async function order(ctx, id, payment = false) {
  requireId(id);
  let current = await read(`/orders/${id}`);
  if (!ctx.valid()) return;
  const progress = h('section', { class: 'panel', id: 'order-progress' }),
    items = h('section', { class: 'section', id: 'order-items' }),
    support = h('section', { class: 'section stack' }),
    effects = h('div', { class: 'panel' }),
    stamp = h('span', { class: 'muted', 'aria-live': 'off' });
  const root = h(
    'div',
    {},
    heading(
      payment ? 'درگاه پرداخت شبیه‌سازی‌شده' : 'جزئیات سفارش',
      code(id),
      button('تازه‌سازی', () => ctx.reload()),
    ),
    progress,
    items,
    support,
    h('p', { class: 'muted section' }, stamp),
  );
  ctx.show(root);
  const own = () => current.customerId === ctx.user.id;
  function draw() {
    const o = current,
      f = o.financial,
      unpaid = !o.paymentOperationKey,
      editable = ['CHECKOUT_RESERVED', 'CHECKOUT_EXPIRED', 'BASKET_CHANGED'].includes(o.status);
    const actions = [];
    if (own() && editable) {
      actions.push(
        button('بررسی دوباره موجودی', async () => {
          await write(`/orders/${id}/checkout/refresh`, { expectedRevision: o.checkoutRevision });
          await ctx.reload();
        }),
      );
      if (o.checkout && !o.checkout.confirmed)
        actions.push(
          button(
            'تأیید سبد تغییر‌یافته',
            async () => {
              await write(`/orders/${id}/checkout/confirm`, {
                expectedRevision: o.checkoutRevision,
              });
              await ctx.reload();
            },
            'primary',
          ),
        );
      else if (payment)
        actions.push(
          button(
            'تأیید و آغاز پرداخت',
            async () => {
              const response = await write(`/orders/${id}/payment`, {
                expectedRevision: o.checkoutRevision,
              });
              if (response.status === 'BASKET_CHANGED')
                notice('سبد تغییر کرده است؛ اقلام و مبلغ جدید را بررسی و تأیید کنید.');
              location.hash = `#order/${id}`;
            },
            'primary',
            { id: 'payment-confirm' },
          ),
        );
      else
        actions.push(
          h('a', { href: `#payment/${id}`, class: 'button-link primary' }, 'رفتن به پرداخت'),
        );
    }
    if (
      own() &&
      !o.fulfillmentStartedAt &&
      !o.cancellationRequested &&
      !['COMPLETED', 'CANCELLED', 'RESOLVED'].includes(o.status)
    )
      actions.push(
        button(
          'لغو سفارش',
          () =>
            ask(
              'لغو کل سفارش',
              [
                h(
                  'p',
                  {},
                  unpaid
                    ? 'رزرو موقت آزاد می‌شود.'
                    : 'اگر مبلغی برداشت شده باشد، لغو تا تأیید بازپرداخت در انتظار می‌ماند. نتیجه نامشخص پرداخت به معنی شکست آن نیست.',
                ),
                reasonField(),
              ],
              async (input) => {
                await write(`/orders/${id}/cancel`, {
                  expectedVersion: o.workflowVersion,
                  reason: input.reason,
                });
                notice('درخواست لغو ثبت شد.', 'success');
                if (payment) location.hash = `#order/${id}`;
                else await ctx.reload();
              },
            ),
          'quiet danger',
        ),
      );
    const pendingPaid = ['PENDING', 'PROCESSING', 'UNKNOWN'].includes(f.status);
    const changes = o.checkout?.snapshot?.changes ?? [];
    replace(
      progress,
      h(
        'div',
        { class: 'actions' },
        badge(o.status),
        h('span', { class: 'muted' }, `نسخه سبد ${fa(o.checkoutRevision)}`),
      ),
      payment
        ? h(
            'p',
            { class: 'message' },
            'این درگاه فقط بانک محلی پروژه را اجرا می‌کند. تا تأیید پرداخت، مهلت رزرو موقت برقرار است.',
          )
        : null,
      unpaid && editable
        ? h(
            'p',
            { class: 'message' },
            'زمان باقی‌مانده رزرو: ',
            h('bdi', { class: 'timer', 'data-expires': o.expiresAt }, '—'),
            '؛ شمارش تقریبی است و سرور تصمیم نهایی را می‌گیرد.',
          )
        : null,
      pendingPaid
        ? h(
            'p',
            { class: 'message' },
            'پرداخت در حال تعیین تکلیف است. موجودی تا دریافت نتیجه قطعی محفوظ می‌ماند؛ پایان تایمر قبلی، آن را آزاد نمی‌کند.',
          )
        : null,
      o.cancellationRequested
        ? h(
            'p',
            { class: 'message' },
            'لغو درخواست شده است. مبلغ بازگشتی فقط پس از تأیید بانک در بخش «بازپرداخت تأییدشده» دیده می‌شود.',
          )
        : null,
      h(
        'dl',
        { class: 'summary' },
        h('div', {}, h('dt', {}, 'مبلغ سفارش'), h('dd', {}, money(o.totalMinor))),
        h('div', {}, h('dt', {}, 'وضعیت پرداخت'), h('dd', {}, badge(f.status))),
        h('div', {}, h('dt', {}, 'بازپرداخت تأییدشده'), h('dd', {}, money(f.refundedMinor))),
        h(
          'div',
          {},
          h('dt', {}, 'بازپرداخت در انتظار'),
          h('dd', {}, money(f.pendingRefundMinor ?? '0')),
        ),
        h('div', {}, h('dt', {}, 'خلاصه بازپرداخت'), h('dd', {}, badge(f.summary ?? 'NONE'))),
        h('div', {}, h('dt', {}, 'شناسه بانک'), h('dd', {}, code(f.bankReference))),
      ),
      changes.length
        ? h(
            'div',
            { class: 'changes' },
            h('h3', {}, 'تغییرات سبد'),
            changes.map((change) =>
              h(
                'div',
                { class: 'row' },
                h(
                  'div',
                  {},
                  code(change.productId),
                  h('p', {}, statusText(change.reason)),
                  h(
                    'p',
                    {},
                    `تعداد قبلی ${fa(change.previousQuantity)}؛ تعداد جدید ${fa(change.quantity)}`,
                  ),
                ),
                h(
                  'div',
                  {},
                  h('small', {}, 'قیمت واحد قبلی'),
                  money(change.previousUnitPriceMinor),
                  h('br'),
                  h('small', {}, 'قیمت واحد جدید'),
                  money(change.unitPriceMinor),
                ),
              ),
            ),
            !o.checkout.confirmed
              ? h('p', {}, 'پیش از پرداخت، نسخه تازه سبد را تأیید کنید.')
              : null,
          )
        : null,
      h('div', { class: 'actions' }, actions),
    );
    replace(
      items,
      h('h2', {}, 'اقلام سفارش'),
      h(
        'p',
        { class: 'mobile-table-hint muted' },
        'برای دیدن همه ستون‌ها، جدول را افقی جابه‌جا کنید.',
      ),
      table(
        ['کالا', 'تعداد و مبلغ', 'وضعیت و تلاش‌ها', 'عملیات'],
        o.items.map((item) =>
          h(
            'tr',
            {},
            h(
              'td',
              { class: 'name' },
              h('strong', {}, item.name),
              h('p', { class: 'muted' }, statusText(item.type)),
              code(item.id),
            ),
            h('td', {}, h('p', {}, `${fa(item.quantity)} عدد`), money(item.lineTotalMinor)),
            h(
              'td',
              {},
              badge(item.status),
              h('p', { class: 'muted' }, `${fa(item.attemptCount)} تلاش`),
              item.nextAttemptAt
                ? h('p', { class: 'muted' }, `تلاش بعدی: ${date(item.nextAttemptAt)}`)
                : null,
            ),
            h(
              'td',
              {},
              h(
                'div',
                { class: 'actions' },
                button('تاریخچه تلاش', () => showAttempts(item)),
                item.disposition === 'FULFILL' &&
                  item.status === 'RETRY_WAIT' &&
                  new Date(item.nextAttemptAt) <= new Date()
                  ? own() || ctx.admin
                    ? button('تلاش دوباره', () => retryItem(o, item, ctx))
                    : null
                  : null,
                ctx.admin &&
                  item.type === 'PHYSICAL' &&
                  item.disposition === 'FULFILL' &&
                  item.status !== 'SUCCEEDED' &&
                  f.status === 'SUCCEEDED'
                  ? button(
                      'ثبت کسری و بازپرداخت',
                      () =>
                        ask(
                          'تعیین تکلیف کسری موجودی',
                          [
                            h(
                              'p',
                              {},
                              'فقط قلم کامل پرداخت‌شده با کسری ثبت‌شده موجودی قابل بازپرداخت است؛ قلم موفق تغییر نمی‌کند.',
                            ),
                            reasonField(),
                          ],
                          async (input) => {
                            await write(`/admin/orders/${id}/items/${item.id}/shortage`, {
                              expectedGeneration: item.generation,
                              reason: input.reason,
                            });
                            notice('تعیین تکلیف ثبت شد.', 'success');
                            await ctx.reload();
                          },
                        ),
                      'quiet danger',
                    )
                  : null,
              ),
            ),
          ),
        ),
      ),
    );
    replace(
      effects,
      h('h2', {}, 'ثبت‌های انجام سفارش'),
      o.fulfillment.digitalGrants.map((g) =>
        h('p', {}, 'دسترسی دیجیتال فعال شد: ', code(g.itemId)),
      ),
      o.fulfillment.subscriptionExtensions.map((s) =>
        h('p', {}, `اشتراک ${fa(s.days)} روز تمدید شد؛ انقضا: ${date(s.expiresAt)}`),
      ),
      o.fulfillment.shipments.map((s) => h('p', {}, 'شناسه ارسال: ', code(s.reference))),
      !Object.values(o.fulfillment).some((array) => array.length)
        ? h('p', { class: 'muted' }, 'هنوز تحویل موفقی ثبت نشده است.')
        : null,
      h('h3', { class: 'section' }, 'رزروهای موجودی'),
      o.reservations.length
        ? o.reservations.map((r) => h('p', {}, badge(r.status), ' ', `${fa(r.quantity)} عدد`))
        : h('p', { class: 'muted' }, 'رزرو فعالی وجود ندارد.'),
    );
    stamp.textContent = `آخرین دریافت از سرور: ${date(new Date())} · پیگیری خودکار هر ۱۰ ثانیه در صفحه فعال`;
  }
  async function showAttempts(item) {
    const container = h('div', { class: 'panel' }, h('h2', {}, 'تاریخچه تلاش'), code(item.id));
    support.prepend(container);
    await appendPages(container, `/orders/${id}/items/${item.id}/attempts`, (entry) =>
      h(
        'div',
        { class: 'row' },
        h('span', {}, `تلاش ${fa(entry.attempt)}`, h('br'), badge(entry.result)),
        h('div', {}, date(entry.createdAt), h('p', { class: 'muted' }, statusText(entry.reason))),
      ),
    );
  }
  draw();
  support.append(effects);
  const returns = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'بازپرداخت‌ها و گزارش بانک'),
    button('دریافت بازپرداخت‌ها', async () => {
      returns.replaceChildren(h('h2', {}, 'بازپرداخت‌ها و گزارش بانک'));
      await appendPages(returns, `/orders/${id}/refunds`, (entry) =>
        h(
          'div',
          { class: 'row' },
          h(
            'div',
            {},
            money(entry.amountMinor),
            h('p', {}, badge(entry.status)),
            h('p', { class: 'muted' }, entry.reason),
            code(entry.id),
          ),
          button('گزارش بازپرداخت', async () => {
            const logs = h(
              'div',
              { class: 'panel' },
              h('h2', {}, 'گزارش بازپرداخت'),
              code(entry.id),
            );
            support.append(logs);
            await appendPages(logs, `/orders/${id}/refunds/${entry.id}/logs`, (log) =>
              details(`${date(log.createdAt)} · ${eventText(log.type)}`, {
                type: log.type,
                metadata: log.metadata,
              }),
            );
          }),
        ),
      );
    }),
  );
  support.append(
    returns,
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'رویدادهای اخیر سفارش'),
      h(
        'p',
        { class: 'muted' },
        'آخرین ۱۰۰ رویداد؛ برای دریافت رویدادهای تازه، سفارش را تازه‌سازی کنید.',
      ),
      current.events.map((event) =>
        details(`${date(event.createdAt)} · ${eventText(event.type)}`, {
          type: event.type,
          metadata: event.metadata,
        }),
      ),
    ),
  );
  ctx.poll = async () => {
    current = await read(`/orders/${id}`);
    if (ctx.valid()) {
      draw();
      if (['COMPLETED', 'CANCELLED', 'RESOLVED', 'PAYMENT_FAILED'].includes(current.status))
        ctx.poll = null;
    }
  };
  if (['COMPLETED', 'CANCELLED', 'RESOLVED', 'PAYMENT_FAILED'].includes(current.status))
    ctx.poll = null;
}
export async function appendPages(container, path, render) {
  let cursor = null;
  const body = h('div'),
    more = button('موارد بیشتر', () => load());
  container.append(body, more);
  async function load() {
    const page = await read(`${path}?limit=25${cursor ? `&cursor=${cursor}` : ''}`);
    for (const item of page.items) body.append(render(item));
    if (!page.items.length && !cursor) body.append(empty('موردی ثبت نشده است.'));
    cursor = page.nextCursor;
    more.hidden = !cursor;
  }
  await load();
}
