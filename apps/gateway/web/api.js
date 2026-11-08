import { token } from './auth.js';
import { notice } from './view.js';
const memory = new Map();
export let owner = '';
export let cooldownUntil = 0;
export function setOwner(value) {
  owner = value;
}
function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key);
  }
}
function storageSet(key, value) {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* current-tab retry still keeps its operation key */
  }
}
function storageRemove(key) {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage can be disabled */
  }
}
export async function read(path) {
  return request(path);
}
async function request(path, method = 'GET', body, key) {
  const bearer = await token();
  let response;
  try {
    response = await fetch(path.startsWith('/auth/') ? path : `/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error(
      'پاسخی از سرور نرسید. ممکن است درخواست ثبت شده باشد؛ همان عملیات را دوباره تلاش کنید یا سفارش‌ها را ببینید.',
    );
  }
  if (response.headers.get('x-rate-limit-mode') === 'local-degraded')
    notice('Redis در دسترس نیست؛ محدودیت درخواست موقتاً روی هر سرور جداگانه اعمال می‌شود.');
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const retry = Math.min(300, Math.max(2, Number(response.headers.get('retry-after')) || 10));
    if ([429, 503].includes(response.status)) cooldownUntil = Date.now() + retry * 1000;
    const messages = {
      400: 'اطلاعات فرم معتبر نیست. نوع، مبلغ، تعداد و دلیل را بررسی کنید.',
      401: 'نشست معتبر نیست؛ دوباره وارد شوید.',
      403: 'این عملیات به دسترسی مدیر نیاز دارد.',
      404: 'موردی پیدا نشد یا اجازه مشاهده آن را ندارید.',
      409: 'وضعیت تغییر کرده یا این عملیات مجاز نیست. صفحه را تازه کنید و دوباره بررسی کنید.',
      413: 'حجم درخواست بیش از ظرفیت مجاز است.',
      429: `درخواست‌ها زیاد است؛ ${retry} ثانیه دیگر دوباره تلاش کنید.`,
      503: `ظرفیت یا اتصال سرور موقتاً محدود است؛ ${retry} ثانیه دیگر همان عملیات را تکرار کنید.`,
    };
    const error = new Error(
      messages[response.status] ?? 'عملیات انجام نشد. کمی بعد دوباره تلاش کنید.',
    );
    error.status = response.status;
    error.requestId = response.headers.get('x-request-id');
    if (error.requestId) error.message += ` شناسه پیگیری: ${error.requestId}`;
    throw error;
  }
  cooldownUntil = 0;
  const area = document.querySelector('#notice');
  if (area?.classList.contains('error')) area.hidden = true;
  return data;
}
export async function write(path, body, method = 'POST') {
  const serialized = JSON.stringify({ owner, path, method, body });
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const storageKey = `tops:pending:${digest}`;
  const key = storageGet(storageKey) || crypto.randomUUID();
  storageSet(storageKey, key);
  try {
    const data = await request(path, method, body, key);
    storageRemove(storageKey);
    return data;
  } catch (error) {
    if (error.status && error.status < 500 && error.status !== 429) storageRemove(storageKey);
    throw error;
  }
}
