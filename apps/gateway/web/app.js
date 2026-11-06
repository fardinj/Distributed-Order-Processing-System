import * as auth from './auth.js';
import { read, setOwner, cooldownUntil } from './api.js';
import { h, heading, button, notice, empty } from './view.js';
import { fa } from './format.js';
import { catalog } from './catalog.js';
import { orders, order } from './orders.js';
import * as admin from './admin.js';
let user,
  activeContext,
  epoch = 0,
  polling = false,
  failures = 0;
const main = document.querySelector('#main'),
  session = document.querySelector('#session');
document.querySelector('.skip').onclick = (event) => {
  event.preventDefault();
  main.focus();
};
function welcome() {
  main.replaceChildren(
    h(
      'section',
      { class: 'welcome' },
      h('h1', {}, 'از ثبت سفارش تا آخرین نتیجه، روشن و قابل پیگیری.'),
      h(
        'p',
        {},
        'کالاهای فیزیکی، دیجیتال و اشتراک را سفارش دهید؛ پرداخت، انجام هر قلم و مبلغ بازگشتی را در یک جا ببینید.',
      ),
      button('ورود به سامانه', () => auth.login(), 'primary'),
      h(
        'ul',
        {},
        h('li', {}, 'مشتری: فروشگاه، سبد خرید و پیگیری سفارش'),
        h('li', {}, 'مدیر: کالا، موجودی و پرونده‌های بررسی'),
      ),
      h(
        'p',
        { class: 'muted' },
        'برای ورود از حساب تعریف‌شده در محیط پروژه استفاده کنید. دسترسی مدیر به نقش حساب شما بستگی دارد.',
      ),
    ),
  );
}
async function route() {
  const generation = ++epoch;
  if (!user) {
    welcome();
    return;
  }
  const [path, search = ''] = location.hash.slice(1).split('?');
  const parts = (path || 'catalog').split('/');
  const ctx = {
    user,
    admin: user.roles.includes('admin'),
    poll: null,
    valid: () => generation === epoch,
    reload: () => route(),
    show: (node) => {
      if (generation === epoch) main.replaceChildren(node);
    },
  };
  activeContext = ctx;
  document.querySelectorAll('nav a').forEach((link) => {
    if (link.hash === `#${parts[0] === 'admin' ? parts.slice(0, 2).join('/') : parts[0]}`)
      link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  main.replaceChildren(empty('در حال دریافت اطلاعات…'));
  try {
    if (parts[0] === 'admin' && !ctx.admin)
      throw new Error('دسترسی به این بخش فقط برای مدیر مجاز است.');
    if (parts[0] === 'catalog') await catalog(ctx);
    else if (parts[0] === 'orders') await orders(ctx);
    else if (['order', 'payment'].includes(parts[0]))
      await order(ctx, parts[1], parts[0] === 'payment');
    else if (parts[0] === 'admin' && parts[1] === 'products') await admin.products(ctx);
    else if (parts[0] === 'admin' && parts[1] === 'product') await admin.product(ctx, parts[2]);
    else if (parts[0] === 'admin' && parts[1] === 'orders') {
      ctx.query = new URLSearchParams(search).get('query') ?? '';
      await orders(ctx, true);
    } else if (parts[0] === 'admin' && parts[1] === 'reviews') await admin.reviews(ctx);
    else if (parts[0] === 'admin' && parts[1] === 'review') await admin.review(ctx, parts[2]);
    else
      ctx.show(
        h(
          'section',
          { class: 'panel' },
          heading('صفحه پیدا نشد', 'از منوی بالا یکی از بخش‌ها را انتخاب کنید.'),
        ),
      );
  } catch (error) {
    if (ctx.valid())
      ctx.show(
        h(
          'section',
          { class: 'panel' },
          heading('دریافت اطلاعات ممکن نشد', error.message),
          button('تلاش دوباره', () => route(), 'primary'),
        ),
      );
  }
}
async function poll() {
  const ctx = activeContext;
  if (
    ctx?.poll &&
    !polling &&
    !document.hidden &&
    Date.now() >= cooldownUntil &&
    !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) &&
    !document.querySelector('dialog[open]')
  ) {
    polling = true;
    try {
      await ctx.poll();
      failures = 0;
    } catch (error) {
      failures = Math.min(failures + 1, 3);
      notice(error.message, 'error');
    } finally {
      polling = false;
    }
  }
  setTimeout(poll, Math.min(60000, 10000 * 2 ** failures));
}
setInterval(() => {
  for (const element of document.querySelectorAll('[data-expires]')) {
    const remaining = Math.max(
      0,
      Math.ceil((new Date(element.dataset.expires) - Date.now()) / 1000),
    );
    element.textContent = remaining
      ? fa(`${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`)
      : 'مهلت تمام شده؛ موجودی دوباره بررسی می‌شود';
  }
}, 1000);
window.addEventListener('hashchange', () => {
  route();
  main.focus({ preventScroll: true });
});
try {
  const authenticated = await auth.initialize();
  auth.onSignOut?.(() => {
    user = undefined;
    setOwner('');
    epoch++;
    activeContext = null;
    document.querySelector('#navigation').hidden = true;
    document.querySelector('#identity').textContent = '';
    session.textContent = 'ورود';
    session.onclick = () => auth.login();
    welcome();
    notice('نشست پایان یافته؛ برای ادامه دوباره وارد شوید.');
  });
  if (authenticated) {
    user = await read('/auth/me');
    setOwner(user.id);
    document.querySelector('#identity').textContent =
      auth.username() ?? (user.roles.includes('admin') ? 'مدیر' : 'مشتری');
    document.querySelector('#navigation').hidden = false;
    document
      .querySelectorAll('[data-admin]')
      .forEach((node) => (node.hidden = !user.roles.includes('admin')));
    session.textContent = 'خروج';
    session.onclick = () => auth.logout();
    if (location.pathname === '/auth/callback') {
      const destination = sessionStorage.getItem('tops:return') || '#catalog';
      sessionStorage.removeItem('tops:return');
      history.replaceState(
        null,
        '',
        '/' + (destination.startsWith('#') ? destination : '#catalog'),
      );
    }
  } else {
    session.textContent = 'ورود';
    session.onclick = () => auth.login();
  }
  session.disabled = false;
  await route();
  setTimeout(poll, 10000);
} catch (error) {
  session.disabled = false;
  session.textContent = 'تلاش دوباره';
  session.onclick = () => location.reload();
  main.replaceChildren(
    h(
      'section',
      { class: 'welcome' },
      heading('اتصال به سامانه برقرار نشد', error.message),
      button('تازه‌سازی صفحه', () => location.reload(), 'primary'),
    ),
  );
}
