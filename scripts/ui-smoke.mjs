import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { Client } from 'pg';
const origin = process.env.PUBLIC_URL ?? 'http://localhost:8080';
const flowsOnly = process.argv.includes('--flows-only');
const secret = async (name) => (await readFile(`/run/secrets/${name}_password`, 'utf8')).trim();
const results = [];
const pass = (message) => {
  results.push(message);
  console.log(`PASS ${message}`);
};
async function token(client, name) {
  const r = await fetch('http://identity:8080/identity/realms/tops/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client,
      client_secret: await secret(name),
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(r.status, 200);
  return (await r.json()).access_token;
}
const adminToken = await token('fixture-admin', 'fixture_admin');
const otherToken = await token('fixture-customer-b', 'fixture_customer_b');
async function api(path, method = 'GET', body, bearer = adminToken) {
  const r = await fetch(`http://gateway:3000/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, body: await r.json() };
}
const clients = new Map();
async function db(owner, sql, values = []) {
  if (!clients.has(owner)) {
    const c = new Client({
      host: 'postgres',
      database: owner,
      user: `${owner}_migrator`,
      password: await secret(`${owner}_migration`),
    });
    await c.connect();
    clients.set(owner, c);
  }
  return (await clients.get(owner).query(sql, values)).rows;
}
async function until(work, message, ms = 45000) {
  const end = Date.now() + ms;
  do {
    const result = await work();
    if (result) return result;
    await pause(250);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${message}`);
}
await mkdir('/verification', { recursive: true });
// Transparent loopback forwarding preserves the configured localhost origin inside the test container.
const sockets = new Set();
const forwarder = createServer((socket) => {
  sockets.add(socket);
  const upstream = connect(3000, 'gateway');
  socket.pipe(upstream).pipe(socket);
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => {
    upstream.destroy();
    sockets.delete(socket);
  });
});
await new Promise((resolve) =>
  forwarder.listen(Number(new URL(origin).port) || 80, '127.0.0.1', resolve),
);
const browser = await chromium.launch({ headless: true });
const customerContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const adminContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
// Test-only adapter interception supplies a real scoped fixture JWT to this browser context.
// Production assets have no fixture login, token persistence or API authorization bypass.
await adminContext.route('**/ui/auth.js', (route) =>
  route.fulfill({
    contentType: 'text/javascript',
    body: `export async function initialize(){return true;} export async function token(){return ${JSON.stringify(adminToken)};} export function username(){return 'مدیر آزمون';} export function login(){} export function logout(){}`,
  }),
);
const customer = await customerContext.newPage(),
  admin = await adminContext.newPage();
const errors = [];
for (const page of [customer, admin]) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/ui/') && response.status() >= 400)
      errors.push(`Asset ${response.status()}: ${path}`);
  });
}
const created = [];
const tag = randomUUID().slice(0, 5);
async function navigate(page, hash) {
  if (
    page === customer &&
    page.url().startsWith(origin) &&
    (await page.getByRole('button', { name: 'خروج', exact: true }).isVisible())
  ) {
    const path =
      hash === '#catalog'
        ? '/api/products'
        : hash.startsWith('#order/')
          ? `/api/orders/${hash.slice(7)}`
          : null;
    const response = path
      ? page.waitForResponse(
          (r) => new URL(r.url()).pathname === path && r.request().method() === 'GET',
        )
      : Promise.resolve();
    if (new URL(page.url()).hash === hash)
      await page
        .getByRole('button', {
          name: hash === '#catalog' ? 'تازه‌سازی کالاها' : 'تازه‌سازی',
          exact: true,
        })
        .click();
    else
      await page.evaluate((value) => {
        location.hash = value;
      }, hash);
    await response;
  } else await page.goto(`${origin}/${hash}`);
  await page.locator('#main h1').waitFor();
  await page.waitForFunction(() => !document.querySelector('#session').disabled);
}
async function dialog(page, fields) {
  const modal = page.locator('#action-dialog');
  await modal.waitFor({ state: 'visible' });
  for (const [name, value] of Object.entries(fields))
    await modal.locator(`[name="${name}"]`).fill(String(value));
  await modal.getByRole('button', { name: 'تأیید و ثبت', exact: true }).click();
  await modal.waitFor({ state: 'hidden', timeout: 15000 });
}
async function product(name, type, price = '50') {
  await navigate(admin, '#admin/products');
  await admin.getByRole('button', { name: 'کالای جدید', exact: true }).click();
  await admin.locator('#action-dialog [name=type]').selectOption(type);
  await dialog(admin, { name, price, reason: 'نمونه مستقل برای بررسی رابط فارسی' });
  await admin.waitForURL(/#admin\/product\//);
  const id = admin.url().split('#admin/product/')[1];
  created.push(id);
  if (type === 'PHYSICAL') {
    await admin.getByRole('button', { name: 'افزایش یا کاهش موجودی', exact: true }).click();
    await dialog(admin, { delta: '۱۰', reason: 'موجودی اولیه نمونه رابط کاربری' });
  }
  return { id, name, type };
}
async function makeOrder(products, { lostResponse = false } = {}) {
  await navigate(customer, '#catalog');
  for (const p of products) {
    const card = customer
      .locator('.product')
      .filter({ has: customer.getByRole('heading', { name: p.name, exact: true }) });
    if (!(await card.count())) {
      await pause(2100);
      await customer.getByRole('button', { name: 'تازه‌سازی کالاها', exact: true }).click();
    }
    await card.waitFor();
    await card.getByRole('button', { name: `افزودن ${p.name}`, exact: true }).click();
  }
  let accepted;
  if (lostResponse)
    await customer.route('**/api/orders', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      accepted = (await response.json()).id;
      await route.abort('failed');
      await customer.unroute('**/api/orders');
    });
  await customer.getByRole('button', { name: 'ثبت و بررسی نهایی', exact: true }).click();
  if (lostResponse) {
    await customer
      .locator('#notice')
      .filter({ hasText: 'ممکن است درخواست ثبت شده باشد' })
      .waitFor();
    await customer.getByRole('button', { name: 'ثبت و بررسی نهایی', exact: true }).click();
  }
  await customer.waitForURL(/#order\//);
  await customer.locator('#order-progress').waitFor();
  const id = customer.url().split('#order/')[1];
  if (accepted) assert.equal(id, accepted);
  return (await api(`/orders/${id}`)).body;
}
async function control(item, outcome = 'SUCCESS', delay = 3600, failUntil = 1) {
  await db(
    'commerce',
    `INSERT INTO fulfillment_simulation_rules(item_id,outcome,not_before,fail_until_attempt) VALUES($1,$2,clock_timestamp()+$3*interval '1 second',$4) ON CONFLICT(item_id) DO UPDATE SET outcome=EXCLUDED.outcome,not_before=EXCLUDED.not_before,fail_until_attempt=EXCLUDED.fail_until_attempt`,
    [item.id, outcome, delay, failUntil],
  );
}
async function due(item) {
  await db(
    'commerce',
    "UPDATE fulfillment_jobs SET available_at=clock_timestamp() WHERE item_id=$1 AND status='DEFERRED'",
    [item.id],
  );
  await db(
    'commerce',
    "UPDATE order_items SET next_attempt_at=clock_timestamp() WHERE id=$1 AND status='RETRY_WAIT'",
    [item.id],
  );
}
async function pay(order) {
  await customer.getByRole('link', { name: 'رفتن به پرداخت', exact: true }).click();
  await customer.getByRole('button', { name: 'تأیید و آغاز پرداخت', exact: true }).click();
  await customer.waitForURL(new RegExp(`#order/${order.id}`));
}
async function state(order, status) {
  return until(async () => {
    const r = await api(`/orders/${order.id}`);
    return r.body.status === status ? r.body : null;
  }, status);
}
async function cancel(page) {
  await page.getByRole('button', { name: 'لغو سفارش', exact: true }).click();
  await dialog(page, { reason: 'درخواست لغو نمونه رابط کاربری' });
}
async function screenshot(page, name, width, height) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => scrollTo(0, 0));
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    `body overflow: ${name}`,
  );
  if (flowsOnly) return;
  await page.screenshot({
    path: `/verification/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}
try {
  await customer.goto(origin);
  await customer
    .getByRole('button', { name: 'ورود به سامانه', exact: true })
    .waitFor({ timeout: 30000 });
  await customer.getByRole('button', { name: 'ورود به سامانه', exact: true }).click();
  await customer.locator('#username').fill('demo-customer-a');
  await customer.locator('#password').fill(await secret('user_customer_a'));
  await customer.locator('#kc-login').click();
  await customer.getByRole('button', { name: 'خروج', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await customer.locator('html').getAttribute('dir'), 'rtl');
  assert.equal(await customer.locator('html').getAttribute('lang'), 'fa');
  assert.equal(await customer.locator('[href="#admin/products"]').isVisible(), false);
  const localValues = await customer.evaluate(() =>
    Object.keys(localStorage).filter((key) => /token|secret/i.test(key)),
  );
  assert.deepEqual(localValues, []);
  pass(
    'real human Authorization Code/S256 PKCE login succeeds; Persian RTL customer view hides admin and persists no token',
  );
  if (process.argv.includes('--session-only')) {
    await customer.getByRole('button', { name: 'خروج', exact: true }).click();
    await customer
      .getByRole('button', { name: 'ورود به سامانه', exact: true })
      .waitFor({ timeout: 30000 });
    pass('real provider logout returns to the signed-out Persian view without persisting tokens');
  } else if (process.argv.includes('--capture-only')) {
    const prior = JSON.parse(await readFile('/verification/results.json', 'utf8'));
    const large = (
      await db(
        'commerce',
        'SELECT id FROM products WHERE price_minor=$1::numeric ORDER BY created_at DESC LIMIT 1',
        ['9'.repeat(120)],
      )
    )[0];
    await navigate(admin, `#admin/product/${large.id}`);
    await screenshot(admin, 'admin-desktop', 1360, 900);
    await screenshot(admin, 'admin-mobile', 390, 844);
    await navigate(customer, '#catalog');
    await screenshot(customer, 'catalog-desktop', 1360, 900);
    await screenshot(customer, 'catalog-mobile', 390, 844);
    await navigate(customer, `#order/${prior.orders.partial}`);
    assert.equal(
      await customer
        .locator('details summary')
        .filter({ hasText: /RefundSUCCEEDED|CheckoutReserved|PaymentPROCESSING/ })
        .count(),
      0,
    );
    await screenshot(customer, 'order-desktop', 1360, 900);
    await screenshot(customer, 'order-mobile', 390, 844);
    const minimum = await customer
      .locator('#order-items table')
      .evaluate((node) => getComputedStyle(node).minWidth);
    assert.equal(minimum, '700px');
    assert.equal(
      await customer
        .locator('#order-items .badge')
        .first()
        .evaluate((node) => getComputedStyle(node).whiteSpace),
      'nowrap',
    );
    pass(
      'review corrections confirmed: mobile item table retains readable labels in a scroll region and customer event summaries are Persian',
    );
  } else {
    const digital = await product(`دسترسی دیجیتال ${tag}`, 'DIGITAL');
    const subscription = await product(`اشتراک سی‌روزه ${tag}`, 'SUBSCRIPTION');
    const physical = await product(`بسته لوازم اداری ${tag}`, 'PHYSICAL');
    pass(
      'admin forms create all three product types and apply reasoned versioned stock adjustments',
    );
    const success = await makeOrder([digital, subscription, physical], { lostResponse: true });
    assert.equal((await api(`/orders/${success.id}`, 'GET', undefined, otherToken)).status, 404);
    assert.equal((await api('/admin/orders', 'GET', undefined, otherToken)).status, 403);
    assert.equal((await api('/admin/orders?limit=101')).status, 400);
    assert.equal(
      (await api(`/admin/orders?query=${success.items[0].id}`)).body.items[0].id,
      success.id,
    );
    await pay(success);
    await state(success, 'COMPLETED');
    await customer
      .locator('#order-progress')
      .getByText('تکمیل شده', { exact: true })
      .waitFor({ timeout: 20000 });
    assert.equal(await customer.getByText('شناسه ارسال:', { exact: false }).isVisible(), true);
    pass(
      'lost create response replays one order; real payment fulfills all types; active UI polling updates status and effect evidence',
    );
    const changed = await makeOrder([digital]);
    await navigate(admin, `#admin/product/${digital.id}`);
    await admin.getByRole('button', { name: 'ویرایش مشخصات', exact: true }).click();
    await dialog(admin, { price: '۶۰', reason: 'تغییر قیمت برای بررسی نسخه تازه سبد' });
    await db(
      'commerce',
      "UPDATE orders SET checkout_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [changed.id],
    );
    await customer.getByRole('button', { name: 'بررسی دوباره موجودی', exact: true }).click();
    await customer.getByRole('button', { name: 'تأیید سبد تغییر‌یافته', exact: true }).waitFor();
    assert.equal(
      await customer.getByRole('heading', { name: 'تغییرات سبد', exact: true }).isVisible(),
      true,
    );
    await customer.getByRole('button', { name: 'تأیید سبد تغییر‌یافته', exact: true }).click();
    await cancel(customer);
    await state(changed, 'CANCELLED');
    pass(
      'expired checkout displays old/new price, requires explicit revision confirmation and permits unpaid cancellation',
    );
    const unknown = await makeOrder([physical]);
    await db(
      'bank',
      'INSERT INTO bank_simulation_assignments(operation_key,reference) VALUES($1,$2)',
      [`payment:${unknown.id}`, 'TIMEOUT_BEFORE'],
    );
    await pay(unknown);
    await state(unknown, 'PAYMENT_REVIEW');
    await customer
      .locator('#order-progress')
      .getByText('نتیجه پرداخت نامشخص', { exact: true })
      .waitFor({ timeout: 20000 });
    assert.equal(
      (await api(`/orders/${unknown.id}`)).body.reservations[0].status,
      'PAYMENT_PENDING',
    );
    await cancel(customer);
    await state(unknown, 'CANCELLED');
    pass(
      'unknown Bank result is visible and retains payment-owned stock; public UI cancellation waits for authoritative no-charge fencing',
    );
    const paid = await makeOrder([digital]);
    await control(paid.items[0]);
    await pay(paid);
    await until(
      async () => (await api(`/orders/${paid.id}`)).body.financial.status === 'SUCCEEDED',
      'captured cancellation',
    );
    await customer.getByRole('button', { name: 'تازه‌سازی', exact: true }).click();
    await cancel(customer);
    const stopped = await state(paid, 'CANCELLED');
    assert.equal(stopped.financial.refundedMinor, '60');
    pass(
      'paid cancellation UI suppresses fulfillment and keeps confirmed refunded money separate from cancellation intent',
    );
    const partial = await makeOrder([digital, physical]);
    for (const item of partial.items) await control(item);
    await pay(partial);
    await until(
      async () => (await api(`/orders/${partial.id}`)).body.financial.status === 'SUCCEEDED',
      'partial capture',
    );
    const digitalItem = partial.items.find((i) => i.type === 'DIGITAL'),
      physicalItem = partial.items.find((i) => i.type === 'PHYSICAL');
    await control(digitalItem, 'SUCCESS', 0);
    await due(digitalItem);
    await until(
      async () =>
        (await db('commerce', 'SELECT status FROM order_items WHERE id=$1', [digitalItem.id]))[0]
          .status === 'SUCCEEDED',
      'digital retained',
    );
    await navigate(admin, `#admin/product/${physical.id}`);
    await admin.getByRole('button', { name: 'ثبت شمارش واقعی', exact: true }).click();
    await dialog(admin, { counted: '۰', reason: 'شمارش واقعی نشان داد موجودی ثبت‌شده اشتباه است' });
    await admin.getByRole('button', { name: 'سوابق اختلاف موجودی', exact: true }).click();
    await admin.getByRole('link', { name: 'یافتن سفارش این قلم', exact: true }).click();
    await admin.getByRole('link', { name: 'مشاهده', exact: true }).click();
    await admin.getByRole('button', { name: 'ثبت کسری و بازپرداخت', exact: true }).click();
    await dialog(admin, { reason: 'تعیین تکلیف قلم کامل پس از تأیید کسری واقعی' });
    const resolved = await state(partial, 'RESOLVED');
    assert.equal(resolved.financial.refundedMinor, '50');
    assert.equal(resolved.fulfillment.digitalGrants.length, 1);
    await navigate(customer, `#order/${partial.id}`);
    await customer.getByRole('button', { name: 'دریافت بازپرداخت‌ها', exact: true }).click();
    await customer.getByRole('button', { name: 'گزارش بازپرداخت', exact: true }).click();
    await customer.getByRole('heading', { name: 'گزارش بازپرداخت', exact: true }).waitFor();
    pass(
      'admin discrepancy links to paid order; whole-line shortage returns 50 while retaining successful digital access and exposes refund logs',
    );
    const review = await makeOrder([digital]);
    await control(review.items[0], 'TRANSIENT', 3600, 12);
    await pay(review);
    await until(
      async () => (await api(`/orders/${review.id}`)).body.financial.status === 'SUCCEEDED',
      'review capture',
    );
    await control(review.items[0], 'TRANSIENT', 0, 12);
    await due(review.items[0]);
    for (let n = 1; n <= 12; n++) {
      await until(
        async () =>
          (
            await db('commerce', 'SELECT attempt_count FROM order_items WHERE id=$1', [
              review.items[0].id,
            ])
          )[0].attempt_count >= n,
        `review attempt ${n}`,
      );
      if (n < 12) await due(review.items[0]);
    }
    await db(
      'commerce',
      "UPDATE order_items SET recovery_started_at=clock_timestamp()-interval '31 minutes' WHERE id=$1",
      [review.items[0].id],
    );
    await due(review.items[0]);
    await state(review, 'MANUAL_REVIEW');
    const caseId = (
      await db(
        'commerce',
        "SELECT id FROM review_cases WHERE resource_id=$1 AND reason='RECOVERY_COST' AND status='OPEN'",
        [review.items[0].id],
      )
    )[0].id;
    await navigate(admin, `#admin/review/${caseId}`);
    await control(review.items[0], 'SUCCESS', 0);
    await admin.getByRole('button', { name: 'آغاز چرخه پس از رفع علت', exact: true }).click();
    await dialog(admin, { reason: 'علت موقت رفع شد؛ یک چرخه با حفظ تاریخچه آغاز شود' });
    const fixed = await state(review, 'COMPLETED');
    assert.equal(fixed.items[0].attemptCount, 13);
    pass(
      'manual review UI opens an audited guarded cycle after repair; successful item has one effect and retains 13 attempts',
    );
    const large = await product(`مبلغ بزرگ آزمایشی ${tag}`, 'DIGITAL', '9'.repeat(120));
    await navigate(admin, `#admin/product/${large.id}`);
    assert.equal(
      (await admin.locator('.summary .money').innerText())
        .replace(/[٬\sریال]/g, '')
        .replaceAll('۹', '9'),
      '9'.repeat(120),
    );
    await screenshot(admin, 'admin-desktop', 1360, 900);
    await screenshot(admin, 'admin-mobile', 390, 844);
    await navigate(customer, '#catalog');
    await screenshot(customer, 'catalog-desktop', 1360, 900);
    await screenshot(customer, 'catalog-mobile', 390, 844);
    await navigate(customer, `#order/${partial.id}`);
    await screenshot(customer, 'order-desktop', 1360, 900);
    await screenshot(customer, 'order-mobile', 390, 844);
    pass(
      flowsOnly
        ? 'desktop/mobile DOM checks preserve exact large IRR without document overflow'
        : 'desktop/mobile screenshots contain Persian font, exact large IRR and no document overflow',
    );
    assert.deepEqual(errors, [], 'browser page errors');
    await writeFile(
      flowsOnly ? '/verification/flow-results.json' : '/verification/results.json',
      JSON.stringify(
        {
          results,
          orders: {
            success: success.id,
            changed: changed.id,
            unknown: unknown.id,
            paid: paid.id,
            partial: partial.id,
            review: review.id,
          },
          products: { digital, subscription, physical, large },
          screenshots: flowsOnly
            ? []
            : [
                'admin-desktop',
                'admin-mobile',
                'catalog-desktop',
                'catalog-mobile',
                'order-desktop',
                'order-mobile',
              ],
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  const claims = await customer
    .evaluate(async () => {
      try {
        const a = await import('/ui/auth.js');
        const t = await a.token();
        const p = JSON.parse(atob(t.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
        return {
          iss: p.iss,
          aud: p.aud,
          typ: p.typ,
          azp: p.azp,
          hasSubject: !!p.sub,
          hasIssuedAt: !!p.iat,
        };
      } catch {
        return null;
      }
    })
    .catch(() => null);
  console.log(
    JSON.stringify({
      page: new URL(customer.url()).pathname,
      main: await customer
        .locator('body')
        .innerText()
        .catch(() => ''),
      errors,
      claims,
    }),
  );
  throw error;
} finally {
  for (const id of created) {
    const p = await api(`/admin/products/${id}`);
    if (p.status === 200 && p.body.active)
      await api(`/admin/products/${id}/deactivate`, 'POST', {
        expectedVersion: p.body.version,
        reason: 'بررسی رابط تمام شد؛ تاریخچه نمونه حفظ می‌شود',
      });
  }
  await browser.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => forwarder.close(resolve));
  await Promise.all([...clients.values()].map((c) => c.end()));
}
