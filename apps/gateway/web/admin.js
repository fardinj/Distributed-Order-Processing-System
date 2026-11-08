import { read, write } from './api.js';
import {
  h,
  heading,
  money,
  code,
  badge,
  button,
  field,
  select,
  ask,
  reasonField,
  notice,
  table,
  empty,
  details,
} from './view.js';
import { integer, count, fa, date, statusText } from './format.js';
import { requireId, appendPages, retryItem } from './orders.js';
const kinds = [
  ['PHYSICAL', 'کالای فیزیکی'],
  ['DIGITAL', 'دسترسی دیجیتال'],
  ['SUBSCRIPTION', 'اشتراک'],
];
const metadata = (value) => {
  const data = JSON.parse(value);
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('اطلاعات دیجیتال باید یک شیء JSON باشد.');
  return data;
};
export async function products(ctx) {
  let cursor;
  const rows = h('tbody'),
    more = button('کالاهای بیشتر', () => load());
  const search = h(
    'form',
    {
      class: 'inline-form',
      onsubmit: (event) => {
        event.preventDefault();
        try {
          location.hash = `#admin/product/${requireId(new FormData(search).get('id').trim())}`;
        } catch (error) {
          notice(error.message, 'error');
        }
      },
    },
    field('id', 'جست‌وجو با شناسه کالا', '', { dir: 'ltr', required: true }),
    h('button', { type: 'submit' }, 'باز کردن کالا'),
  );
  ctx.show(
    h(
      'div',
      {},
      heading(
        'مدیریت کالا',
        'قیمت، مشخصات و موجودی با دلیل و نسخه ثبت می‌شوند.',
        button(
          'کالای جدید',
          () =>
            ask(
              'ثبت کالای جدید',
              [
                field('name', 'نام کالا', '', { required: true, maxlength: 200 }),
                select('type', 'نوع کالا', kinds),
                field('price', 'قیمت به ریال', '', {
                  required: true,
                  inputmode: 'numeric',
                  dir: 'ltr',
                }),
                field('days', 'مدت اشتراک به روز (فقط اشتراک)', '30', { inputmode: 'numeric' }),
                field('metadata', 'اطلاعات دیجیتال JSON (اختیاری)', '', {
                  type: 'textarea',
                  dir: 'ltr',
                }),
                reasonField(),
              ],
              async (input) => {
                const body = {
                  name: input.name,
                  type: input.type,
                  priceMinor: integer(input.price),
                  reason: input.reason,
                };
                if (input.type === 'SUBSCRIPTION')
                  body.subscriptionDays = count(input.days, { min: 1, max: 36500 });
                if (input.type === 'DIGITAL' && input.metadata.trim())
                  body.digitalMetadata = metadata(input.metadata);
                const p = await write('/admin/products', body);
                notice('کالا ثبت شد.', 'success');
                location.hash = `#admin/product/${p.id}`;
              },
            ),
          'primary',
        ),
      ),
      h(
        'section',
        { class: 'panel' },
        search,
        h(
          'div',
          { class: 'section table-wrap' },
          h(
            'table',
            {},
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ['کالا', 'نوع', 'قیمت', 'وضعیت', ''].map((x) => h('th', { scope: 'col' }, x)),
              ),
            ),
            rows,
          ),
        ),
        h('div', { class: 'pager' }, more),
      ),
    ),
  );
  async function load() {
    const page = await read(
      `/admin/products?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (!ctx.valid()) return;
    for (const p of page.items)
      rows.append(
        h(
          'tr',
          {},
          h('td', { class: 'name' }, p.name, h('br'), code(p.id)),
          h('td', {}, statusText(p.type)),
          h('td', {}, money(p.priceMinor)),
          h('td', {}, p.active ? 'فعال' : 'غیرفعال'),
          h('td', {}, h('a', { href: `#admin/product/${p.id}` }, 'ویرایش و موجودی')),
        ),
      );
    if (!page.items.length && !cursor)
      rows.append(h('tr', {}, h('td', { colspan: 5 }, empty('کالایی ثبت نشده است.'))));
    cursor = page.nextCursor;
    more.hidden = !cursor;
  }
  await load();
}
export async function product(ctx, id) {
  requireId(id);
  const p = await read(`/admin/products/${id}`);
  if (!ctx.valid()) return;
  const history = h('section', { class: 'section stack' });
  const actions = [
    button(
      'ویرایش مشخصات',
      () =>
        ask(
          'تأیید ویرایش کالا',
          [
            h(
              'p',
              { class: 'muted' },
              `نسخه فعلی ${fa(p.version)}؛ تغییر هم‌زمان در سرور بررسی می‌شود.`,
            ),
            field('name', 'نام کالا', p.name, { required: true, maxlength: 200 }),
            field('price', 'قیمت به ریال', p.priceMinor, {
              required: true,
              dir: 'ltr',
              inputmode: 'numeric',
            }),
            p.type === 'SUBSCRIPTION'
              ? field('days', 'مدت اشتراک به روز', p.subscriptionDays, {
                  required: true,
                  inputmode: 'numeric',
                })
              : h('p', { class: 'muted' }, 'نوع کالا قابل تغییر نیست.'),
            p.type === 'DIGITAL'
              ? field('metadata', 'اطلاعات دیجیتال JSON', JSON.stringify(p.digitalMetadata ?? {}), {
                  type: 'textarea',
                  dir: 'ltr',
                })
              : h('span'),
            reasonField(),
          ],
          async (input) => {
            const body = {
              expectedVersion: p.version,
              name: input.name,
              priceMinor: integer(input.price),
              reason: input.reason,
            };
            if (p.type === 'SUBSCRIPTION')
              body.subscriptionDays = count(input.days, { min: 1, max: 36500 });
            if (p.type === 'DIGITAL') body.digitalMetadata = metadata(input.metadata);
            await write(`/admin/products/${id}`, body, 'PATCH');
            notice('تغییرات کالا ثبت شد.', 'success');
            await ctx.reload();
          },
        ),
      'primary',
    ),
  ];
  if (p.active)
    actions.push(
      button(
        'غیرفعال‌کردن',
        () =>
          ask(
            'تأیید غیرفعال‌کردن کالا',
            [
              h('p', {}, 'کالا از فروش جدید خارج می‌شود؛ سابقه سفارش‌ها حذف نمی‌شود.'),
              reasonField(),
            ],
            async (input) => {
              await write(`/admin/products/${id}/deactivate`, {
                expectedVersion: p.version,
                reason: input.reason,
              });
              notice('کالا غیرفعال شد.', 'success');
              await ctx.reload();
            },
          ),
        'quiet danger',
      ),
    );
  if (p.stock) {
    actions.push(
      button('افزایش یا کاهش موجودی', () =>
        ask(
          'تأیید اصلاح موجودی',
          [
            h(
              'p',
              {},
              `موجودی قابل فروش فعلی: ${fa(p.stock.available)}؛ تغییر به تعداد رزروهای قبلی دست نمی‌زند.`,
            ),
            field('delta', 'تغییر تعداد (منفی برای کاهش)', '', {
              required: true,
              inputmode: 'numeric',
              dir: 'ltr',
            }),
            reasonField(),
          ],
          async (input) => {
            const delta = count(input.delta, { min: -Number.MAX_SAFE_INTEGER });
            if (!delta) throw new Error('تغییر تعداد نباید صفر باشد.');
            await write(`/admin/inventory/${id}/adjustments`, {
              expectedVersion: p.stock.version,
              delta,
              reason: input.reason,
            });
            notice('اصلاح موجودی ثبت شد.', 'success');
            await ctx.reload();
          },
        ),
      ),
    );
    actions.push(
      button('ثبت شمارش واقعی', () =>
        ask(
          'تأیید شمارش واقعی انبار',
          [
            h(
              'p',
              {},
              'تعداد واقعی شامل کالاهای رزروشده است. کسری نسبت به رزروها، فروش جدید را متوقف و پرونده بررسی ایجاد می‌کند. مشتری متضرر را سامانه خودکار انتخاب نمی‌کند.',
            ),
            field('counted', 'تعداد واقعی در انبار', '', { required: true, inputmode: 'numeric' }),
            reasonField(),
          ],
          async (input) => {
            await write(`/admin/inventory/${id}/reconcile`, {
              expectedVersion: p.stock.version,
              countedOnHand: count(input.counted),
              reason: input.reason,
            });
            notice('شمارش انبار ثبت شد.', 'success');
            await ctx.reload();
          },
        ),
      ),
    );
    actions.push(
      button('سوابق اختلاف موجودی', async () => {
        const records = await read(`/admin/inventory/${id}/discrepancies`),
          section = h('div', { class: 'panel' }, h('h2', {}, 'اختلاف‌های ثبت‌شده'));
        if (!records.length) section.append(empty('اختلافی ثبت نشده است.'));
        for (const d of records)
          section.append(
            h(
              'div',
              { class: 'section' },
              badge(d.status),
              h(
                'p',
                {},
                `شمارش واقعی: ${fa(d.countedOnHand)}؛ رزروها: ${fa(d.heldQuantity)}؛ کسری: ${fa(d.shortage)}`,
              ),
              h('p', { class: 'muted' }, date(d.createdAt)),
              d.affectedReservations.map((r) =>
                h(
                  'div',
                  { class: 'row' },
                  code(r.itemId),
                  h('a', { href: `#admin/orders?query=${r.itemId}` }, 'یافتن سفارش این قلم'),
                ),
              ),
            ),
          );
        history.prepend(section);
      }),
    );
  }
  actions.push(
    button('تاریخچه تغییرات', async () => {
      const records = await read(`/admin/products/${id}/audit`);
      history.prepend(
        h(
          'div',
          { class: 'panel' },
          h('h2', {}, 'تاریخچه تغییرات'),
          records.length
            ? records.map((record) =>
                h(
                  'div',
                  { class: 'section' },
                  h('p', {}, record.reason),
                  h('small', {}, date(record.createdAt), ' · ', record.action),
                  details('جزئیات ثبت', record),
                ),
              )
            : empty('تغییری ثبت نشده است.'),
        ),
      );
    }),
  );
  ctx.show(
    h(
      'div',
      {},
      heading(
        p.name,
        code(id),
        button('تازه‌سازی', () => ctx.reload()),
      ),
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'actions' }, badge(p.type), h('span', {}, p.active ? 'فعال' : 'غیرفعال')),
        h(
          'dl',
          { class: 'summary' },
          h('div', {}, h('dt', {}, 'قیمت واحد'), h('dd', {}, money(p.priceMinor))),
          h('div', {}, h('dt', {}, 'نسخه کالا'), h('dd', {}, fa(p.version))),
          p.stock
            ? h('div', {}, h('dt', {}, 'موجودی قابل فروش'), h('dd', {}, fa(p.stock.available)))
            : h(
                'div',
                {},
                h('dt', {}, 'مدت اشتراک'),
                h('dd', {}, p.subscriptionDays ? `${fa(p.subscriptionDays)} روز` : '—'),
              ),
        ),
        p.stock?.requiresReview
          ? h(
              'p',
              { class: 'changes' },
              'موجودی نیازمند بررسی است. افزایش ساده موجودی، اختلاف ثبت‌شده را حل نمی‌کند.',
            )
          : null,
        h('div', { class: 'actions' }, actions),
      ),
      history,
    ),
  );
}
export async function reviews(ctx) {
  const list = h('section', { class: 'panel' });
  ctx.show(
    h(
      'div',
      {},
      heading(
        'بررسی دستی',
        'موارد نیازمند اقدام انسانی؛ موفقیت پرداخت یا بازپرداخت را نمی‌توان دستی جعل کرد.',
        button('تازه‌سازی', () => ctx.reload()),
      ),
      list,
    ),
  );
  await appendPages(list, '/admin/manual-review', (entry) =>
    h(
      'div',
      { class: 'row' },
      h(
        'div',
        {},
        h('strong', {}, statusText(entry.reason)),
        h('p', { class: 'muted' }, date(entry.createdAt)),
        code(entry.resourceId),
      ),
      h('a', { href: `#admin/review/${entry.id}` }, 'بررسی پرونده'),
    ),
  );
}
export async function review(ctx, id) {
  requireId(id);
  const record = await read(`/admin/manual-review/${id}`);
  if (!ctx.valid()) return;
  const reference = record.item?.orderId ?? record.refund?.orderId ?? record.metadata?.orderId;
  const actions = [];
  if (reference)
    actions.push(
      h('a', { href: `#order/${reference}`, class: 'button-link' }, 'مشاهده سفارش و گزارش‌ها'),
    );
  if (record.actions.includes('RETRY_CYCLE') && record.status === 'OPEN')
    actions.push(
      button(
        'آغاز چرخه پس از رفع علت',
        () => retryItem({ id: record.item.orderId }, record.item, ctx),
        'primary',
      ),
    );
  if (record.reason === 'STOCK_SHORTAGE')
    actions.push(
      h(
        'a',
        { href: `#admin/product/${record.resource_id}`, class: 'button-link' },
        'مشاهده اختلاف انبار و رزروهای متأثر',
      ),
    );
  ctx.show(
    h(
      'div',
      {},
      heading('پرونده بررسی', code(id)),
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'actions' }, badge(record.status), badge(record.reason)),
        h(
          'p',
          { class: 'message' },
          record.reason === 'RECOVERY_COST'
            ? 'پس از رفع علت، یک چرخه تازه با حفظ تاریخچه آغاز کنید.'
            : record.reason === 'REFUND_REQUIRES_REVIEW'
              ? 'بازپرداخت هنوز بدهی است. گزارش بانک را بررسی کنید؛ این صفحه بازپرداخت تأییدنشده را موفق نمی‌کند.'
              : 'موجودی و رزروهای متأثر را بررسی کنید. کسری پرداخت‌شده فقط از مسیر تعیین تکلیف قلم کامل رسیدگی می‌شود.',
        ),
        h('div', { class: 'actions' }, actions),
        record.item
          ? h(
              'p',
              { class: 'section' },
              `تعداد تلاش‌ها: ${fa(record.item.attemptCount)}؛ نسخه تلاش: ${fa(record.item.retryVersion)}`,
            )
          : null,
        details('اطلاعات پرونده', record),
      ),
    ),
  );
}
