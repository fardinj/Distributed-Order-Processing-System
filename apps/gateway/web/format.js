const digits = '۰۱۲۳۴۵۶۷۸۹';
export function ascii(value) {
  return String(value)
    .replace(/[۰-۹٠-٩]/g, (ch) => String(ch.charCodeAt(0) - (ch >= '۰' ? 1776 : 1632)))
    .replace(/[٬,\s]/g, '');
}
export function integer(value) {
  const normalized = ascii(value);
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) throw new Error('عدد صحیح و بدون اعشار وارد کنید.');
  return normalized;
}
export function count(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = ascii(value);
  if (!/^-?(0|[1-9][0-9]*)$/.test(normalized)) throw new Error('تعداد باید عدد صحیح باشد.');
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`تعداد باید بین ${min} و ${max} باشد.`);
  return number;
}
export const fa = (value) => String(value).replace(/[0-9]/g, (ch) => digits[Number(ch)]);
export function moneyText(value) {
  const source = String(value),
    groups = [];
  for (let end = source.length; end > 0; end -= 3)
    groups.push(source.slice(Math.max(0, end - 3), end));
  return fa(groups.reverse().join('٬'));
}
export function date(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
export const statuses = {
  DIGITAL: 'دیجیتال',
  SUBSCRIPTION: 'اشتراک',
  PHYSICAL: 'فیزیکی',
  CHECKOUT_RESERVED: 'آماده پرداخت',
  CHECKOUT_EXPIRED: 'مهلت رزرو تمام شده',
  BASKET_CHANGED: 'سبد تغییر کرده',
  PENDING_PAYMENT: 'در انتظار پرداخت',
  PAYING: 'در حال پرداخت',
  PAYMENT_REVIEW: 'نتیجه پرداخت نامشخص',
  PROCESSING: 'در حال پردازش',
  ATTENTION_REQUIRED: 'نیازمند پیگیری',
  MANUAL_REVIEW: 'نیازمند بررسی دستی',
  CANCELLATION_PENDING: 'در انتظار تکمیل لغو',
  PAYMENT_FAILED: 'پرداخت ناموفق',
  COMPLETED: 'تکمیل شده',
  CANCELLED: 'لغو شده',
  RESOLVED: 'تعیین تکلیف شده',
  PENDING: 'در انتظار',
  SUCCEEDED: 'موفق',
  FAILED: 'ناموفق',
  UNKNOWN: 'نامشخص؛ در حال استعلام',
  NOT_REQUESTED: 'آغاز نشده',
  RETRY_WAIT: 'در انتظار تلاش دوباره',
  NONE: 'بازپرداختی تأیید نشده',
  PARTIALLY_REFUNDED: 'بخشی از مبلغ بازگشته',
  REFUNDED: 'تمام مبلغ بازگشته',
  REVIEW_REQUIRED: 'نیازمند پیگیری بازپرداخت',
  OPEN: 'باز',
  RESOLVED_REVIEW: 'رسیدگی شده',
  ACTIVE: 'رزرو موقت',
  PAYMENT_PENDING: 'رزرو تا تعیین نتیجه پرداخت',
  ALLOCATED: 'تخصیص‌یافته',
  DISPUTED: 'موجودی مورد اختلاف',
  CONSUMED: 'تحویل به ارسال',
  RELEASED: 'آزاد شده',
  EXPIRED: 'منقضی',
  FULFILL: 'انجام سفارش',
  REFUND: 'بازپرداخت',
  CANCEL: 'لغو',
  RECOVERY_COST: 'تلاش‌های پرهزینه و بی‌نتیجه',
  STOCK_REQUIRES_DISPOSITION: 'موجودی نیازمند تعیین تکلیف',
  REFUND_REQUIRES_REVIEW: 'بازپرداخت نیازمند پیگیری',
  PRODUCT_UNAVAILABLE: 'کالا در دسترس نیست',
  STOCK_CHANGED: 'موجودی تغییر کرده',
  CATALOG_CHANGED: 'مشخصات یا قیمت تغییر کرده',
};
export const statusText = (value) => statuses[value] ?? value ?? '—';
const events = {
  ItemProcessingStarted: 'پردازش قلم سفارش آغاز شد',
  ShipmentCreated: 'مرسوله ایجاد شد',
  CheckoutReserved: 'سبد و رزرو اولیه ثبت شد',
  CheckoutRevised: 'نسخه سبد به‌روز شد',
  CheckoutExpired: 'رزرو موقت منقضی شد',
  CheckoutConfirmed: 'سبد جدید تأیید شد',
  PaymentRequested: 'پرداخت درخواست شد',
  PaymentPENDING: 'پرداخت در انتظار است',
  PaymentPROCESSING: 'پرداخت در حال پردازش است',
  PaymentUNKNOWN: 'نتیجه پرداخت در حال استعلام است',
  PaymentSUCCEEDED: 'پرداخت تأیید شد',
  PaymentFAILED: 'پرداخت ناموفق بود',
  RefundPENDING: 'بازپرداخت در انتظار است',
  RefundPROCESSING: 'بازپرداخت در حال انجام است',
  RefundUNKNOWN: 'نتیجه بازپرداخت در حال استعلام است',
  RefundSUCCEEDED: 'بازپرداخت تأیید شد',
  RefundFAILED: 'بازپرداخت ناموفق بود',
  RefundREVIEW_REQUIRED: 'بازپرداخت نیازمند بررسی است',
  OrderStatusChanged: 'وضعیت سفارش به‌روز شد',
  ItemFulfilled: 'قلم سفارش انجام شد',
  ItemFailed: 'قلم سفارش انجام نشد',
  ItemRetryScheduled: 'تلاش دوباره زمان‌بندی شد',
  ItemRefundRequested: 'بازپرداخت قلم درخواست شد',
  CancellationRequested: 'لغو سفارش درخواست شد',
  ManualRetryCycle: 'چرخه تلاش تازه ثبت شد',
  RecoveryReviewRequired: 'بررسی دستی لازم شد',
};
statuses.STOCK_SHORTAGE = 'کسری موجودی انبار';
export const eventText = (value) => events[value] ?? 'رویداد ثبت‌شده';
