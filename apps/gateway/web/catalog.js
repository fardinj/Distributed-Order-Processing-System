import { read, write } from './api.js';
import { h, heading, money, button, empty, notice, badge } from './view.js';
import { count, fa, statusText } from './format.js';
const cart = new Map();
export async function catalog(ctx) {
  let cursor,
    loading = false;
  const products = h('div', { class: 'catalog', id: 'catalog-products' }),
    basket = h('aside', { class: 'panel cart', 'aria-label': 'سبد خرید' });
  const root = h(
    'div',
    {},
    heading(
      'فروشگاه',
      'کالای فیزیکی، دسترسی دیجیتال و اشتراک را در یک سفارش ثبت کنید.',
      button('تازه‌سازی کالاها', () => ctx.reload()),
    ),
    h(
      'div',
      { class: 'layout' },
      h(
        'section',
        {},
        products,
        button('کالاهای بیشتر', () => load(), 'quiet', { id: 'catalog-more' }),
      ),
      basket,
    ),
  );
  function drawBasket() {
    let total = 0n;
    for (const { product, quantity } of cart.values())
      total += BigInt(product.priceMinor) * BigInt(quantity);
    basket.replaceChildren(
      h('h2', {}, 'سبد خرید'),
      cart.size
        ? h(
            'div',
            {},
            [...cart.values()].map(({ product, quantity }) =>
              h(
                'div',
                { class: 'row' },
                h(
                  'div',
                  {},
                  h('strong', {}, product.name),
                  h('p', { class: 'muted' }, `${fa(quantity)} عدد`),
                ),
                button('حذف', () => {
                  cart.delete(product.id);
                  drawBasket();
                }),
              ),
            ),
          )
        : empty('هنوز کالایی اضافه نکرده‌اید.'),
      h('div', { class: 'total' }, h('span', {}, 'جمع تقریبی'), money(total.toString())),
      h('p', { class: 'muted' }, 'قیمت و موجودی هنگام ثبت، دوباره در سرور بررسی می‌شود.'),
      button(
        'ثبت و بررسی نهایی',
        async () => {
          if (!cart.size) return;
          const items = [...cart.values()].map(({ product, quantity }) => ({
            productId: product.id,
            quantity,
          }));
          items.sort((a, b) => a.productId.localeCompare(b.productId));
          const order = await write('/orders', { items });
          cart.clear();
          location.hash = `#order/${order.id}`;
        },
        'primary',
        { disabled: !cart.size, id: 'checkout-submit' },
      ),
    );
  }
  async function load() {
    if (loading) return;
    loading = true;
    try {
      const page = await read(
        `/products?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      if (!ctx.valid()) return;
      if (!cursor) products.replaceChildren();
      for (const product of page.items) {
        const quantity = h('input', {
          type: 'text',
          inputmode: 'numeric',
          value: '1',
          'aria-label': `تعداد ${product.name}`,
          disabled: product.type !== 'PHYSICAL',
        });
        const unavailable = product.stock?.requiresReview || product.stock?.available === '0';
        products.append(
          h(
            'article',
            { class: 'product' },
            h('span', { class: 'product-type' }, statusText(product.type)),
            h('h2', {}, product.name),
            product.subscriptionDays
              ? h('p', { class: 'muted' }, `${fa(product.subscriptionDays)} روز اعتبار`)
              : h(
                  'p',
                  { class: 'muted' },
                  product.type === 'PHYSICAL'
                    ? 'ارسال پس از تأیید پرداخت'
                    : 'فعال‌سازی پس از تأیید پرداخت',
                ),
            money(product.priceMinor),
            product.stock
              ? h(
                  'p',
                  { class: 'muted' },
                  product.stock.requiresReview
                    ? 'موجودی در حال بررسی است'
                    : `موجودی قابل فروش: ${fa(product.stock.available)}`,
                )
              : null,
            h(
              'div',
              { class: 'actions' },
              h('div', { class: 'quantity' }, quantity),
              button(
                unavailable ? 'فعلاً ناموجود' : 'افزودن به سبد',
                () => {
                  const amount =
                    product.type === 'PHYSICAL' ? count(quantity.value, { min: 1, max: 100 }) : 1;
                  const previous = cart.get(product.id)?.quantity ?? 0;
                  const combined = product.type === 'PHYSICAL' ? previous + amount : 1;
                  if (combined > 100) throw new Error('حداکثر تعداد هر قلم فیزیکی ۱۰۰ است.');
                  if (!cart.has(product.id) && cart.size >= 50)
                    throw new Error('هر سفارش حداکثر ۵۰ قلم دارد.');
                  cart.set(product.id, { product, quantity: combined });
                  drawBasket();
                  notice('کالا به سبد اضافه شد.', 'success');
                },
                'quiet',
                { disabled: unavailable, 'aria-label': `افزودن ${product.name}` },
              ),
            ),
          ),
        );
      }
      if (!page.items.length && !cursor) products.append(empty('کالایی برای فروش وجود ندارد.'));
      cursor = page.nextCursor;
      root.querySelector('#catalog-more').hidden = !cursor;
    } finally {
      loading = false;
    }
  }
  ctx.show(root);
  drawBasket();
  await load();
}
